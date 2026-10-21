/**
 * test/detector/d6-tool-result-bloat.test.ts — D6 TOOL_RESULT_BLOAT (U7: A1's complement).
 *
 * D6 prices the tool results at or under A1's 25,600 B floor (minus TaskOutput results over
 * 10 KiB, which are A2's), each carried along its owner chain: one cache write plus a read on
 * every later turn. Recs surface when ≥ 3 sessions carry such results and a workspace's carry
 * cost reaches 1% of its spend in the window.
 *
 * U7 replaced the old turn-level share gate (bytes-as-tokens vs cap-weighted tokens, never
 * reachable on real data) and the null-when-uncalibrated $; these fixtures are event-based.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSet } from "../../src/detector/calibration.js";
import { runDetectors } from "../../src/detector/index.js";
import { D6_MIN_SESSIONS } from "../../src/detector/savings.js";
import { D6_READ_RULE } from "../../src/query/api/rec-actions/families/context.js";
import { buildCardActions } from "../../src/query/api/rec-actions/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const START = Date.parse("2027-01-02T00:00:00.000Z");

// claude-sonnet-4-6 list prices ($/MTok): cache read 0.30, 5-minute cache write 3.75.
const READ = 0.3;
const WRITE = 3.75;
// Uncalibrated point: the mean of 2.7 and 4 bytes/token (RR U13). Results are priced above 10 KiB,
// so SIZE carries 3,722 excess bytes = the 1,111 tokens the old 3,000 B at 2.7 B/token carried.
const BPT = 3.35;
const SIZE = 13_962;
const EXCESS = SIZE - 10_240;

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  seq = 0;
});

afterEach(() => db.close());

/** One session of `turns` main turns, a minute apart, each re-reading ~100k cached tokens. */
function insSession(
  sessionId: string,
  turns: number,
  opts: { workspaceId?: string; startMs?: number; costU?: number } = {},
): string[] {
  const workspaceId = opts.workspaceId ?? "ws-bloat";
  const startMs = opts.startMs ?? START;
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, '2027-01-01T00:00:00.000Z')`,
  ).run(workspaceId, workspaceId);
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, ?, ?, 'RECONCILED', ?, 0, '[]')`,
  ).run(
    sessionId,
    workspaceId,
    `/fake/${sessionId}.jsonl`,
    new Date(startMs).toISOString(),
    new Date(startMs + turns * 60_000).toISOString(),
    turns,
  );
  const insert = db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', 0, 10, 200, 100000, 2000, 0, 0, 0, ?,
             'LIST_EQUIV', 0, 'test-v1')`,
  );
  const ids: string[] = [];
  for (let i = 0; i < turns; i++) {
    const messageId = `msg-d6-${seq++}`;
    insert.run(
      messageId,
      sessionId,
      workspaceId,
      new Date(startMs + i * 60_000).toISOString(),
      opts.costU ?? 37_500,
    );
    ids.push(messageId);
  }
  return ids;
}

/** A tool result owned by `ownerMessageId` (same ts as its owner turn). */
function insResult(
  sessionId: string,
  ownerMessageId: string,
  toolName: string,
  bytes: number,
  withMetadata = true,
): void {
  const eventId = `event-d6-${seq++}`;
  const ts = (
    db.prepare("SELECT ts FROM turns WHERE message_id = ?").get(ownerMessageId) as { ts: string }
  ).ts;
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, result_bytes)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(eventId, sessionId, ts, toolName, bytes);
  db.prepare("UPDATE turns SET tool_result_bytes = tool_result_bytes + ? WHERE message_id = ?").run(
    bytes,
    ownerMessageId,
  );
  if (withMetadata) {
    db.prepare(
      `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
       VALUES (?, ?, 0, 0)`,
    ).run(eventId, ownerMessageId);
  }
}

/**
 * Audit-shaped session: 60 turns, a 3,000 B result (Read/Bash/Grep in turn) on each of the
 * first 30 turns. Each result is re-sent on every later turn of the session.
 */
function insAuditSession(sessionId: string, workspaceId = "ws-bloat", startMs = START): string[] {
  const ids = insSession(sessionId, 60, { workspaceId, startMs });
  const tools = ["Read", "Bash", "Grep"];
  for (let i = 0; i < 30; i++) {
    insResult(sessionId, ids[i] as string, tools[i % 3] as string, SIZE);
  }
  return ids;
}

/** Independent oracle: one audit session's carry cost, µ$ (result i is sent by 59 − i turns). */
function auditSessionCarryU(bpt = BPT): number {
  let total = 0;
  for (let i = 0; i < 30; i++) {
    const carry = 59 - i;
    total += (EXCESS / bpt) * (WRITE + READ * (carry - 1));
  }
  return total;
}

function d6Recs(): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM recommendations WHERE detector_id='D6' ORDER BY rec_id")
    .all() as Array<Record<string, unknown>>;
}

function facts(rec: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(rec.evidence_json as string).facts as Record<string, unknown>;
}

describe("D6 — fires on many mid-size results carried over long sessions (audit shape)", () => {
  it("fires one rolled-up rec per workspace, priced on the results' carry", () => {
    insAuditSession("sess-d6-1");
    insAuditSession("sess-d6-2", "ws-bloat", START + 86_400_000);
    insAuditSession("sess-d6-3", "ws-bloat", START + 2 * 86_400_000);

    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D6")?.status).toBe("ACTIVE");

    const recs = d6Recs();
    expect(recs.length).toBe(1);
    const r = recs[0];
    if (!r) throw new Error("expected D6 rec");
    expect(r.category).toBe("TOOLING");
    expect(r.scope_workspace_id).toBe("ws-bloat");

    // $ = 0.5 × carry, emitted even uncalibrated (2.7 bytes/token, labelled an estimate).
    const carryU = 3 * auditSessionCarryU();
    expect(r.modeled_savings_u_per_wk).toBe(Math.round(carryU * 0.5));

    const formula = JSON.parse(r.modeled_formula_json as string) as Record<string, unknown>;
    expect(formula.formula_id).toBe("D6_TOOL_RESULT_BLOAT_V1");
    expect(formula.estimate).toMatchObject({
      basis: "E",
      rank_value_u_per_wk: r.modeled_savings_u_per_wk,
      summable: true,
    });
    expect((formula.estimate as { label: string }).label).toMatch(/estimate/);

    const ev = facts(r);
    expect(ev.tool_result_bytes).toBe(3 * 30 * SIZE);
    expect(ev.session_count).toBe(3);
    expect((ev.session_ids as string[]).sort()).toEqual(["sess-d6-1", "sess-d6-2", "sess-d6-3"]);
    expect(ev.bytes_per_token).toBe(BPT);
    expect(ev.turn_count).toBe(180);
    // Carry share of those sessions' spend: within the audit's observed 15–30% band.
    const share = carryU / (180 * 37_500);
    expect(ev.bloat_share).toBeCloseTo(share, 4);
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.3);
  });

  it("U9: ranks sessions by result bytes and records the Read share", () => {
    insAuditSession("sess-d6-a");
    insAuditSession("sess-d6-b", "ws-bloat", START + 86_400_000);
    const big = insAuditSession("sess-d6-c", "ws-bloat", START + 2 * 86_400_000);
    // The last session by id carries extra Read results, so it is the largest.
    for (let i = 30; i < 40; i++) insResult("sess-d6-c", big[i] as string, "Read", 20_000);
    runDetectors(db, { now: NOW });
    const r = d6Recs()[0];
    if (!r) throw new Error("expected D6 rec");
    const ev = facts(r);
    expect(ev.session_ids).toEqual(["sess-d6-c", "sess-d6-a", "sess-d6-b"]);
    expect(ev.read_result_bytes).toBe(3 * 10 * SIZE + 10 * 20_000);
    expect(ev.read_call_count).toBe(40);
    expect(ev.top_sessions).toEqual([
      "sess-d6-c|618860|60",
      "sess-d6-a|418860|60",
      "sess-d6-b|418860|60",
    ]);
    const actions = buildCardActions({ detector_id: "D6", lever: "x", facts: ev });
    const prompt = actions.primary.copy_text;
    // D6 sizes are 1,024-based and labelled so (U9 r4): 290,000 B = 283 KiB, 470,000 B = 459 KiB.
    expect(prompt).toContain("Read returned 604 KiB of the 1.4 MiB (42%) in 40 calls");
    expect(prompt.indexOf("sess-d6-c")).toBeLessThan(prompt.indexOf("sess-d6-a"));
    expect(prompt).toContain(D6_READ_RULE);
  });

  it("U9 r5: a session's turn count includes its provisional turns, not 0", () => {
    insAuditSession("sess-p-a");
    insAuditSession("sess-p-b", "ws-bloat", START + 86_400_000);
    insAuditSession("sess-p-c", "ws-bloat", START + 2 * 86_400_000);
    // The last 20 turns of one session are still provisional (the file is being read).
    db.prepare(
      `UPDATE turns SET provisional = 1 WHERE session_id = 'sess-p-c'
         AND ts >= ?`,
    ).run(new Date(START + 2 * 86_400_000 + 40 * 60_000).toISOString());
    runDetectors(db, { now: NOW });
    const r = d6Recs()[0];
    if (!r) throw new Error("expected D6 rec");
    const labels = facts(r).top_sessions as string[];
    expect(labels.find((label) => label.startsWith("sess-p-c|"))?.split("|")[2]).toBe("60");
  });

  it("U9 r3: records the tools behind the bytes, Bash included", () => {
    insAuditSession("sess-t-a");
    insAuditSession("sess-t-b", "ws-bloat", START + 86_400_000);
    const big = insAuditSession("sess-t-c", "ws-bloat", START + 2 * 86_400_000);
    for (let i = 30; i < 40; i++) insResult("sess-t-c", big[i] as string, "Bash", 20_000);
    runDetectors(db, { now: NOW });
    const r = d6Recs()[0];
    if (!r) throw new Error("expected D6 rec");
    // Bash: 3 sessions x 10 audit results x SIZE + 10 x 20,000 B; Read and Grep: 3 x 10 x SIZE each.
    expect(facts(r).top_tools).toEqual(["Bash|618860|40", "Grep|418860|30", "Read|418860|30"]);
    const prompt = buildCardActions({ detector_id: "D6", lever: "x", facts: facts(r) }).primary
      .copy_text;
    expect(prompt).toContain("By tool: Bash 604 KiB in 40 calls");
  });

  it("keeps evidence structural (no content, input, output or path keys)", () => {
    insAuditSession("sess-s1");
    insAuditSession("sess-s2");
    insAuditSession("sess-s3");
    // The fixture schema has no content column; D6's evidence must stay structural even if one
    // is added.
    db.exec("ALTER TABLE tool_events ADD COLUMN content TEXT");

    runDetectors(db, { now: NOW });
    const r = d6Recs()[0];
    if (!r) throw new Error("expected D6 rec");
    const ev = facts(r);
    expect(JSON.stringify(ev)).not.toContain("content");
    expect(Object.keys(ev).some((key) => /input|output|path/i.test(key))).toBe(false);
  });
});

describe("D6 — one owner per result (no double count with A1 or A2)", () => {
  it("leaves results over 25,600 B to A1 and TaskOutput results over 10 KiB to A2", () => {
    for (const sessionId of ["sess-o1", "sess-o2", "sess-o3"]) {
      const ids = insAuditSession(sessionId);
      insResult(sessionId, ids[0] as string, "Read", 25_601); // A1's
      insResult(sessionId, ids[1] as string, "TaskOutput", 10_241); // A2's
      insResult(sessionId, ids[2] as string, "TaskOutput", 10_240); // D6's (at A2's floor)
      insResult(sessionId, ids[3] as string, "Read", 25_600); // D6's (at A1's floor)
    }

    runDetectors(db, { now: NOW });
    const r = d6Recs()[0];
    if (!r) throw new Error("expected D6 rec");
    expect(facts(r).tool_result_bytes).toBe(3 * (30 * SIZE + 10_240 + 25_600));
  });
});

describe("D6 — needs owner metadata to price carry", () => {
  it("stays quiet when results have no owner turn (carry cannot be priced)", () => {
    for (const sessionId of ["sess-nm1", "sess-nm2", "sess-nm3"]) {
      const ids = insSession(sessionId, 60);
      for (let i = 0; i < 30; i++) insResult(sessionId, ids[i] as string, "Read", SIZE, false);
    }
    runDetectors(db, { now: NOW });
    expect(d6Recs().length).toBe(0);
  });
});

describe("D6 — determinism", () => {
  it("two passes over the same frozen DB yield identical rows", () => {
    insAuditSession("sess-det1");
    insAuditSession("sess-det2");
    insAuditSession("sess-det3");

    runDetectors(db, { now: NOW });
    const first = d6Recs();

    runDetectors(db, { now: NOW });
    expect(d6Recs()).toEqual(first);
  });
});

describe("D6 — multi-workspace rollup", () => {
  it("emits one rec per qualifying workspace when sessions span multiple workspaces", () => {
    // 2 sessions in ws-a + 1 in ws-b → 3 carrying sessions (recurrence gate passes).
    insAuditSession("sess-mw-a1", "ws-a");
    insAuditSession("sess-mw-a2", "ws-a");
    insAuditSession("sess-mw-b1", "ws-b");

    runDetectors(db, { now: NOW });
    const recs = d6Recs();
    expect(recs.length).toBe(2);

    const recA = recs.find((r) => r.scope_workspace_id === "ws-a");
    const recB = recs.find((r) => r.scope_workspace_id === "ws-b");
    if (!recA) throw new Error("expected rec for ws-a");
    if (!recB) throw new Error("expected rec for ws-b");

    const evA = facts(recA);
    expect(evA.session_count).toBe(2);
    expect(evA.tool_result_bytes).toBe(2 * 30 * SIZE);
    expect((evA.session_ids as string[]).sort()).toEqual(["sess-mw-a1", "sess-mw-a2"]);

    const evB = facts(recB);
    expect(evB.session_count).toBe(1);
    expect(evB.tool_result_bytes).toBe(30 * SIZE);
    expect(evB.session_ids).toContain("sess-mw-b1");
  });
});

describe("D6 — stays quiet", () => {
  it("does not fire when only 2 sessions carry results (recurrence gate)", () => {
    insAuditSession("sess-q1");
    insAuditSession("sess-q2");
    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D6")?.status).toBe("INACTIVE");
    expect(d6Recs().length).toBe(0);
  });

  it("does not fire when the carry cost is under 1% of the workspace's spend", () => {
    insAuditSession("sess-l1");
    insAuditSession("sess-l2");
    insAuditSession("sess-l3");
    // ~$1,000 of other spend in the workspace: the ~$1.7 carry is ~0.17% of it.
    insSession("sess-l-big", 10, { costU: 100_000_000 });

    const statuses = runDetectors(db, { now: NOW });
    const d6 = statuses.find((s) => s.detector_id === "D6");
    expect(d6?.status).toBe("INACTIVE");
    expect(d6?.note).toMatch(/under 1% of workspace spend/);
    expect(d6Recs().length).toBe(0);
  });
});

// ── INACTIVE honesty: below MIN_SESSIONS yields a status + note, not silence ──

describe("D6 — INACTIVE below MIN_SESSIONS carries an honest note", () => {
  it("reports INACTIVE with the qualifying-count note when 0 sessions qualify", () => {
    const statuses = runDetectors(db, { now: NOW });
    const d6 = statuses.find((s) => s.detector_id === "D6");
    expect(d6?.status).toBe("INACTIVE");
    expect(d6?.note).toMatch(/0 bloated session/);
    expect(d6?.note).toContain(String(D6_MIN_SESSIONS));
    expect(d6Recs().length).toBe(0);
  });

  it("reports INACTIVE with count=2 when two sessions qualify (< MIN_SESSIONS)", () => {
    insAuditSession("sess-n1");
    insAuditSession("sess-n2");

    const statuses = runDetectors(db, { now: NOW });
    const d6 = statuses.find((s) => s.detector_id === "D6");
    expect(d6?.status).toBe("INACTIVE");
    expect(d6?.note).toBe("2 bloated session(s) (< 3 threshold)");
    expect(d6Recs().length).toBe(0);
  });
});

// ── Calibration: modeled (basis P) when calibrated, estimate (basis E) otherwise ──

describe("D6 — calibration", () => {
  it("prices at the calibrated ratio and stamps a modeled (basis P) figure when calibrated", () => {
    configSet(db, "bytes_per_token", "3.65");
    configSet(db, "bytes_per_token_measured_at", new Date().toISOString());
    configSet(
      db,
      "bytes_per_token_provenance",
      "calibrated 2026-09-02 via count_tokens · model claude-sonnet-4-6 · N=150 · median 3.6500",
    );
    insAuditSession("sess-cal-1");
    insAuditSession("sess-cal-2");
    insAuditSession("sess-cal-3");

    runDetectors(db, { now: NOW });
    const r = d6Recs()[0];
    if (!r) throw new Error("expected D6 rec");
    expect(r.modeled_savings_u_per_wk).toBe(Math.round(3 * auditSessionCarryU(3.65) * 0.5));
    const formula = JSON.parse(r.modeled_formula_json as string) as Record<string, unknown>;
    expect(formula.estimate).toMatchObject({
      basis: "P",
      rank_value_u_per_wk: r.modeled_savings_u_per_wk,
      summable: true,
    });
    expect(facts(r).bytes_per_token).toBe(3.65);
  });
});
