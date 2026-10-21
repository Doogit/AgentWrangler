import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  type TranscriptReader,
  type Usage,
  checkD8Quantity,
  fileReader,
} from "./d8-quantity-oracle.js";

const WINDOW = { from: "2026-09-27T00:00:00.000Z", to: "2026-10-04T00:00:00.000Z" };
const WS = "ws-a";

type T = {
  id: string;
  session: string;
  ts: string;
  side?: number;
  agent?: string | null;
  r?: number;
  w5?: number;
  w1?: number;
};

function makeDb(
  turns: T[],
  facts: Record<string, unknown> | null,
  filePath = "/nonexistent/x.jsonl",
) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, file_path TEXT NOT NULL);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL, ts TEXT NOT NULL,
      is_sidechain INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_5m INTEGER NOT NULL DEFAULT 0,
      cache_write_1h INTEGER NOT NULL DEFAULT 0, cache_write_other INTEGER NOT NULL DEFAULT 0,
      context_tokens AS (input_tokens + cache_read_tokens + cache_write_5m + cache_write_1h + cache_write_other) STORED,
      provisional INTEGER NOT NULL DEFAULT 0, agent_id TEXT);
    CREATE TABLE recommendations (rec_id TEXT PRIMARY KEY, detector_id TEXT, scope_workspace_id TEXT, evidence_json TEXT NOT NULL);
  `);
  const sessions = new Set(turns.map((t) => t.session));
  for (const s of sessions) db.prepare("INSERT INTO sessions VALUES (?,?)").run(s, filePath);
  const ins = db.prepare(
    "INSERT INTO turns (message_id,session_id,workspace_id,ts,is_sidechain,cache_read_tokens,cache_write_5m,cache_write_1h,agent_id) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  for (const t of turns)
    ins.run(
      t.id,
      t.session,
      WS,
      t.ts,
      t.side ?? 0,
      t.r ?? 0,
      t.w5 ?? 0,
      t.w1 ?? 0,
      t.agent ?? null,
    );
  if (facts)
    db.prepare("INSERT INTO recommendations VALUES (?,?,?,?)").run(
      "rec-1",
      "D8",
      WS,
      JSON.stringify({ facts: { workspace_id: WS, last_seen_week_start: WINDOW.from, ...facts } }),
    );
  return db;
}

// S1: fresh start (60k, 1h tier), then 2h idle gap -> 120k rewrite = ONE churn event (net 60k over base 60k).
// S2: fresh start (60k), then 30 min gap with a 100k rewrite = within the 1h TTL -> B1's, NOT counted.
// S3: fresh start (60k); a sidechain thread (5m tier) rewrites 100k after a 10 min gap -> sidechain, NOT counted.
const TURNS: T[] = [
  { id: "m1", session: "S1", ts: "2026-09-28T10:00:00.000Z", w1: 60000 },
  { id: "m2", session: "S1", ts: "2026-09-28T12:00:00.000Z", w1: 120000 },
  { id: "m3", session: "S2", ts: "2026-09-29T10:00:00.000Z", w1: 60000 },
  { id: "m4", session: "S2", ts: "2026-09-29T10:30:00.000Z", w1: 100000 },
  { id: "m5", session: "S3", ts: "2026-09-30T10:00:00.000Z", w1: 60000 },
  { id: "a1", session: "S3", ts: "2026-09-30T10:01:00.000Z", side: 1, agent: "ag1", w5: 20000 },
  { id: "a2", session: "S3", ts: "2026-09-30T10:11:00.000Z", side: 1, agent: "ag1", w5: 100000 },
];
const GOOD = {
  churn_event_count: 1,
  total_churn_creation_tokens: 120000,
  net_churn_creation_tokens: 60000,
};

const rawFor = (turns: T[]): TranscriptReader => {
  const m = new Map<string, Usage[]>();
  for (const t of turns) m.set(t.id, [{ read: t.r ?? 0, w5: t.w5 ?? 0, w1: t.w1 ?? 0 }]);
  return () => m;
};

describe("d8 quantity oracle", () => {
  it("PASS: stored quantities match, billing matches raw usage", () => {
    const r = checkD8Quantity(makeDb(TURNS, GOOD), WINDOW, { reader: rawFor(TURNS) });
    expect(r.issues).toEqual([]);
    expect(r.verdict).toBe("PASS");
    expect(r.counts.churn_events).toBe(1);
    expect(r.counts.billing_matched).toBe(1);
  });

  it("tolerates +-10% on the stored quantity", () => {
    const f = { ...GOOD, net_churn_creation_tokens: 64000 };
    expect(checkD8Quantity(makeDb(TURNS, f), WINDOW, { reader: rawFor(TURNS) }).verdict).toBe(
      "PASS",
    );
  });

  it("FAIL mutation 1: stored net +20%", () => {
    const f = { ...GOOD, net_churn_creation_tokens: 72000 };
    const r = checkD8Quantity(makeDb(TURNS, f), WINDOW, { reader: rawFor(TURNS) });
    expect(r.verdict).toBe("FAIL");
    expect(r.counts.recs_out_of_tolerance).toBe(1);
  });

  it("FAIL mutation 2: a cache-write field differs from the raw usage", () => {
    const wrong: TranscriptReader = () => new Map([["m2", [{ read: 0, w5: 0, w1: 119000 }]]]);
    const r = checkD8Quantity(makeDb(TURNS, GOOD), WINDOW, { reader: wrong });
    expect(r.verdict).toBe("FAIL");
    expect(r.counts.billing_mismatched).toBe(1);
  });

  it("FAIL mutation 3: a gap <= TTL counted as churn", () => {
    const f = {
      churn_event_count: 2,
      total_churn_creation_tokens: 220000,
      net_churn_creation_tokens: 100000,
    };
    expect(checkD8Quantity(makeDb(TURNS, f), WINDOW, { reader: rawFor(TURNS) }).verdict).toBe(
      "FAIL",
    );
  });

  it("FAIL mutation 4: a sidechain turn counted as churn", () => {
    const f = {
      churn_event_count: 2,
      total_churn_creation_tokens: 220000,
      net_churn_creation_tokens: 100000,
    };
    const turns = TURNS.filter((t) => t.id !== "m4"); // only the sidechain rewrite could add the extra event
    expect(checkD8Quantity(makeDb(turns, f), WINDOW, { reader: rawFor(turns) }).verdict).toBe(
      "FAIL",
    );
  });

  it("FAIL mutation 5: a gap that is within TTL for the prior 5m tier is not churn, but 6 min is", () => {
    // main thread whose prior write was 5m tier: TTL 5. Gap of 6 min => churn, so a stored count of 0 is wrong.
    const turns: T[] = [
      { id: "x1", session: "S9", ts: "2026-09-28T10:00:00.000Z", w5: 60000 },
      { id: "x2", session: "S9", ts: "2026-09-28T10:06:00.000Z", w5: 120000 },
    ];
    const f = {
      churn_event_count: 0,
      total_churn_creation_tokens: 0,
      net_churn_creation_tokens: 0,
    };
    expect(checkD8Quantity(makeDb(turns, f), WINDOW, { reader: rawFor(turns) }).verdict).toBe(
      "FAIL",
    );
    const ok = {
      churn_event_count: 1,
      total_churn_creation_tokens: 120000,
      net_churn_creation_tokens: 60000,
    };
    expect(checkD8Quantity(makeDb(turns, ok), WINDOW, { reader: rawFor(turns) }).verdict).toBe(
      "PASS",
    );
  });

  it("UNPROVEN: no D8 recs to check", () => {
    expect(checkD8Quantity(makeDb(TURNS, null), WINDOW, { reader: rawFor(TURNS) }).verdict).toBe(
      "UNPROVEN",
    );
  });

  it("missing transcript files are skipped, not failures", () => {
    const r = checkD8Quantity(makeDb(TURNS, GOOD), WINDOW, { reader: () => null });
    expect(r.verdict).toBe("PASS");
    expect(r.counts.billing_file_missing).toBe(1);
  });

  it("reads a real JSONL transcript file (match, then mismatch)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d8-oracle-"));
    const file = path.join(dir, "S1.jsonl");
    const line = (w1: number) =>
      JSON.stringify({
        message: {
          id: "m2",
          usage: {
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: w1,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: w1 },
          },
        },
      });
    fs.writeFileSync(file, `${line(120000)}\n`);
    const good = checkD8Quantity(makeDb(TURNS, GOOD, file), WINDOW, { reader: fileReader });
    expect(good.verdict).toBe("PASS");
    expect(good.counts.billing_matched).toBe(1);
    fs.writeFileSync(file, `${line(90000)}\n`);
    const bad = checkD8Quantity(makeDb(TURNS, GOOD, file), WINDOW, { reader: fileReader });
    expect(bad.verdict).toBe("FAIL");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
