import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { checkD2Quantity } from "./d2-quantity-oracle.js";

const WINDOW = { from: "2026-09-27T00:00:00.000Z", to: "2026-10-04T00:00:00.000Z" };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d2-oracle-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

interface Fx {
  db: Database.Database;
  readRawSum: number;
}

// Hand-set numbers: A and B qualify (160 turns, ~200K context), S is short (20 turns, huge context).
// Cache-read per qualifying turn: A 190000, B 185000. First-turn contexts: A 60000, B 70000, S 80000 -> median 70000.
function build(
  opts: {
    storedScale?: number;
    storedIds?: string[];
    basePrefix?: number;
    rawCacheReadOffset?: number;
  } = {},
): Fx {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, file_path TEXT NOT NULL);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL, ts TEXT NOT NULL,
      is_sidechain INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_5m INTEGER NOT NULL DEFAULT 0,
      cache_write_1h INTEGER NOT NULL DEFAULT 0, cache_write_other INTEGER NOT NULL DEFAULT 0,
      context_tokens AS (input_tokens + cache_read_tokens + cache_write_5m + cache_write_1h + cache_write_other) STORED);
    CREATE TABLE recommendations (rec_id TEXT PRIMARY KEY, detector_id TEXT, scope_workspace_id TEXT, evidence_json TEXT NOT NULL);
  `);
  const specs = [
    { id: "A", n: 160, read: 190000, firstRead: 50000 },
    { id: "B", n: 160, read: 185000, firstRead: 60000 },
    { id: "S", n: 20, read: 300000, firstRead: 70000 },
  ];
  let qualifyingRead = 0;
  for (const s of specs) {
    const lines: string[] = [];
    const sessFile = path.join(dir, `${s.id}.jsonl`);
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(s.id, "ws", sessFile);
    for (let i = 0; i < s.n; i++) {
      const read = i === 0 ? s.firstRead : s.read;
      const mid = `msg_${s.id}_${i}`;
      const ts = new Date(Date.parse("2026-09-30T00:00:00.000Z") + i * 60000).toISOString();
      db.prepare(
        "INSERT INTO turns (message_id,session_id,workspace_id,ts,input_tokens,cache_read_tokens,cache_write_1h) VALUES (?,?,?,?,?,?,?)",
      ).run(mid, s.id, "ws", ts, 2, read, 10000);
      if (s.id !== "S") qualifyingRead += read;
      const rawRead = i === 4 ? read + (opts.rawCacheReadOffset ?? 0) : read;
      lines.push(
        JSON.stringify({
          type: "assistant",
          uuid: `u-${mid}`,
          message: {
            id: mid,
            usage: {
              input_tokens: 2,
              cache_read_input_tokens: rawRead,
              cache_creation_input_tokens: 10000,
              cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10000 },
            },
          },
        }),
      );
    }
    fs.writeFileSync(sessFile, lines.join("\n"));
  }
  const facts = {
    session_ids: opts.storedIds ?? ["A", "B"],
    qualifying_session_count: (opts.storedIds ?? ["A", "B"]).length,
    cache_read_tokens_per_week: Math.round(qualifyingRead * (opts.storedScale ?? 1)),
    base_prefix_tokens: opts.basePrefix ?? 70000,
    last_seen_week_start: "2026-09-27T00:00:00.000Z",
  };
  db.prepare("INSERT INTO recommendations VALUES (?,?,?,?)").run(
    "rec-D2",
    "D2",
    null,
    JSON.stringify({ facts }),
  );
  return { db, readRawSum: qualifyingRead };
}

describe("D2 quantity oracle", () => {
  it("PASS on a consistent fixture", () => {
    const r = checkD2Quantity(build().db, WINDOW);
    expect(r.issues).toEqual([]);
    expect(r.verdict).toBe("PASS");
    expect(r.counts.raw_matched).toBe(160); // 320 qualifying turns, sampled every 2nd to stay under 200
    expect(r.counts.raw_mismatched).toBe(0);
  });

  it("tolerates a stored quantity 5% off", () => {
    expect(checkD2Quantity(build({ storedScale: 1.05 }).db, WINDOW).verdict).toBe("PASS");
  });

  it("MUTATION: stored quantity +20% -> FAIL", () => {
    const r = checkD2Quantity(build({ storedScale: 1.2 }).db, WINDOW);
    expect(r.verdict).toBe("FAIL");
    expect(r.issues.some((i) => i.kind === "quantity-mismatch")).toBe(true);
  });

  it("MUTATION: short session counted as qualifying -> FAIL", () => {
    const r = checkD2Quantity(build({ storedIds: ["A", "B", "S"] }).db, WINDOW);
    expect(r.verdict).toBe("FAIL");
    expect(r.issues.some((i) => i.kind === "session-set-mismatch")).toBe(true);
  });

  it("MUTATION: qualifying session dropped from the stored set -> FAIL", () => {
    expect(checkD2Quantity(build({ storedIds: ["A"] }).db, WINDOW).verdict).toBe("FAIL");
  });

  it("MUTATION: cache-read in transcript differs from DB -> FAIL", () => {
    const r = checkD2Quantity(build({ rawCacheReadOffset: 1 }).db, WINDOW);
    expect(r.verdict).toBe("FAIL");
    expect(r.counts.raw_mismatched).toBe(2);
  });

  it("MUTATION: base prefix wrong (not subtracted / zero) -> FAIL", () => {
    const r = checkD2Quantity(build({ basePrefix: 0 }).db, WINDOW);
    expect(r.verdict).toBe("FAIL");
    expect(r.issues.some((i) => i.kind === "base-prefix-mismatch")).toBe(true);
  });

  it("MUTATION: DB turn deleted so a session drops under 150 turns -> FAIL", () => {
    const { db } = build();
    db.prepare("DELETE FROM turns WHERE session_id = 'B' AND message_id > 'msg_B_15'").run();
    expect(checkD2Quantity(db, WINDOW).verdict).toBe("FAIL");
  });

  it("missing transcript files are skipped, not failures", () => {
    const { db } = build();
    db.prepare("UPDATE sessions SET file_path = ?").run(path.join(dir, "nope", "x.jsonl"));
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
    const r = checkD2Quantity(db, WINDOW);
    expect(r.counts.raw_file_missing).toBe(160);
    expect(r.verdict).toBe("PASS");
  });

  it("UNPROVEN when nothing can be checked", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT, file_path TEXT);
      CREATE TABLE turns (message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, is_sidechain INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cache_write_5m INTEGER DEFAULT 0,
        cache_write_1h INTEGER DEFAULT 0, cache_write_other INTEGER DEFAULT 0, context_tokens INTEGER DEFAULT 0);
      CREATE TABLE recommendations (rec_id TEXT, detector_id TEXT, scope_workspace_id TEXT, evidence_json TEXT);
    `);
    expect(checkD2Quantity(db, WINDOW).verdict).toBe("UNPROVEN");
  });
});
