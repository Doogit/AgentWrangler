/**
 * test/detector/d2-session-long-full-context.test.ts — D2 raw-context hygiene.
 *
 * The trigger uses only reconciled raw context in the evaluation window.
 * Cap-weighted burn and cache-read exposure are separate annotations.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDetectors } from "../../src/detector/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const BASE = new Date("2027-01-02T00:00:00.000Z").getTime();
const QUALIFYING_TURNS = 151;
const QUALIFYING_SESSIONS = 3;

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES ('ws-d2','ws-d2','2027-01-01T00:00:00.000Z')`,
  ).run();
});

afterEach(() => db.close());

function insertSession(sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, 'ws-d2', ?, '2027-01-02T00:00:00.000Z', '2027-01-02T00:00:00.000Z',
             'RECONCILED', 0, 0, '[]')`,
  ).run(sessionId, `/fake/${sessionId}.jsonl`);
}

let messageSequence = 0;

function insertTurn(
  sessionId: string,
  timestamp: string,
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite5m?: number;
    cacheWrite1h?: number;
    cacheWriteOther?: number;
    provisional?: number;
    sidechain?: number;
  } = {},
): void {
  const {
    input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite5m = 0,
    cacheWrite1h = 0,
    cacheWriteOther = 0,
    provisional = 0,
    sidechain = 0,
  } = usage;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?, ?, 'ws-d2', ?, 'claude-sonnet',
             ?, ?, ?, ?, ?, ?, ?, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', ?, 'test-v1')`,
  ).run(
    `msg-d2-${messageSequence++}`,
    sessionId,
    timestamp,
    sidechain,
    input,
    output,
    cacheRead,
    cacheWrite5m,
    cacheWrite1h,
    cacheWriteOther,
    provisional,
  );
}

function timestamp(offsetMinutes: number): string {
  return new Date(BASE + offsetMinutes * 60_000).toISOString();
}

function addSession(
  sessionId: string,
  turnCount: number,
  usage: Parameters<typeof insertTurn>[2],
  options: { startOffset?: number; provisionalTail?: boolean } = {},
): void {
  insertSession(sessionId);
  const startOffset = options.startOffset ?? 0;
  for (let turn = 0; turn < turnCount; turn++) {
    insertTurn(sessionId, timestamp(startOffset + turn), usage);
  }
  if (options.provisionalTail) {
    insertTurn(sessionId, timestamp(startOffset + turnCount), {
      ...usage,
      provisional: 1,
    });
  }
}

function d2Recommendation(): { row: Record<string, unknown>; evidence: Record<string, unknown> } {
  const row = db.prepare("SELECT * FROM recommendations WHERE detector_id = 'D2'").get() as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) throw new Error("expected D2 recommendation");
  return {
    row,
    evidence: JSON.parse(row.evidence_json as string).facts as Record<string, unknown>,
  };
}

function addThreeQualifyingSessions(usage: Parameters<typeof insertTurn>[2]): void {
  for (let i = 1; i <= QUALIFYING_SESSIONS; i++) {
    addSession(`sess-d2-${i}`, QUALIFYING_TURNS, usage, { startOffset: i * 200 });
  }
}

describe("D2 — raw-context hygiene role", () => {
  it("review 6 R6-02: counts only main-thread turns, not subagent (sidechain) turns", () => {
    const run = (withSubagents: boolean) => {
      for (let i = 1; i <= QUALIFYING_SESSIONS; i++) {
        addSession(`sess-mixed-${i}`, 160, { cacheRead: 200_000 }, { startOffset: i * 400 });
        // Subagent turns interleaved with the main ones, as a workflow's are.
        for (let turn = 0; withSubagents && turn < 100; turn++) {
          insertTurn(`sess-mixed-${i}`, timestamp(i * 400 + turn + 0.5), {
            cacheRead: 30_000,
            sidechain: 1,
          });
        }
      }
      const statuses = runDetectors(db, { now: NOW });
      return statuses.find((status) => status.detector_id === "D2")?.status === "ACTIVE"
        ? d2Recommendation().evidence
        : null;
    };
    const mainOnly = run(false);
    db.close();
    db = createInMemoryFixtureDb();
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
       VALUES ('ws-d2','ws-d2','2027-01-01T00:00:00.000Z')`,
    ).run();
    // Mixed average (160 × 200K + 100 × 30K) / 260 = 134.6K would miss the 180K gate.
    const mixed = run(true);

    expect(mainOnly?.cache_read_tokens_per_week).toBe(3 * 160 * 200_000);
    expect(mixed).toEqual(mainOnly);
  });

  it("does not classify all-time history outside the evaluation window", () => {
    for (let i = 1; i <= QUALIFYING_SESSIONS; i++) {
      addSession(
        `sess-old-${i}`,
        QUALIFYING_TURNS,
        { cacheRead: 200_000 },
        { startOffset: -4_000 },
      );
      insertTurn(`sess-old-${i}`, "2027-01-08T00:00:00.000Z", { cacheRead: 200_000 });
    }

    const statuses = runDetectors(db, { now: NOW });

    expect(statuses.find((status) => status.detector_id === "D2")?.status).toBe("INACTIVE");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM recommendations WHERE detector_id = 'D2'").get(),
    ).toEqual({ n: 0 });
  });

  it("does not classify a provisional tail as reconciled qualifying turns", () => {
    for (let i = 1; i <= QUALIFYING_SESSIONS; i++) {
      addSession(
        `sess-provisional-${i}`,
        150,
        { cacheRead: 200_000 },
        { startOffset: i * 200, provisionalTail: true },
      );
    }

    const statuses = runDetectors(db, { now: NOW });

    expect(statuses.find((status) => status.detector_id === "D2")?.status).toBe("INACTIVE");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM recommendations WHERE detector_id = 'D2'").get(),
    ).toEqual({ n: 0 });
  });

  it("classifies write-heavy sessions from raw context while exposing a separate cap burn", () => {
    addThreeQualifyingSessions({ cacheWrite5m: 200_000 });

    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((status) => status.detector_id === "D2")?.status).toBe("ACTIVE");

    const { evidence } = d2Recommendation();
    expect(evidence.raw_context_average_tokens_per_turn).toBe(200_000);
    expect(evidence.cap_weighted_burn_tokens_per_week).toBe(90_600_000);
    expect(evidence.cache_read_tokens_per_week).toBe(0);
    expect(evidence.cap_read_coefficient).toBeGreaterThanOrEqual(0);
  });

  it("classifies read-heavy sessions from raw context even when cap burn is lower", () => {
    addThreeQualifyingSessions({ cacheRead: 200_000 });

    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((status) => status.detector_id === "D2")?.status).toBe("ACTIVE");

    const { row, evidence } = d2Recommendation();
    expect(evidence.raw_context_average_tokens_per_turn).toBe(200_000);
    expect(evidence.cap_weighted_burn_tokens_per_week).toBe(9_060_000);
    expect(evidence.cache_read_tokens_per_week).toBe(90_600_000);
    expect(evidence.cap_read_coefficient).toBe(0.1);
    expect(row.target_metric).toBe("avg_context_per_turn");
    // Review 3 B5: the reduction is derived from context growth. Context is flat at the 200,000
    // base (every session opens there), so a split resets nothing: fraction 0, gross 0.
    // Netted (P3.1-T9 S6): 3 splits (one inside each 151-call session), each writing the base
    // plus a 2,000 summary at the 5m write price 3.75: 3 × 202,000 × 3.75 = 2,272,500 → net 0.
    expect(evidence.base_prefix_tokens).toBe(200_000);
    expect(evidence.reduction_fraction).toBe(0);
    expect(evidence.cache_read_spend_u_per_wk).toBe(27_180_000);
    expect(evidence.gross_savings_u_per_wk).toBe(0);
    expect(evidence.rebuild_u_per_wk).toBe(2_272_500);
    expect(row.modeled_savings_u_per_wk).toBe(0);
    const formula = JSON.parse(row.modeled_formula_json as string) as {
      estimate: Record<string, unknown>;
    };
    expect(formula.estimate).toMatchObject({
      basis: "P",
      rank_value_u_per_wk: 0,
      summable: true,
    });
    const sessionIds = evidence.session_ids as string[];
    expect(sessionIds).toHaveLength(3);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id IN (?, ?, ?)")
        .get(...sessionIds),
    ).toEqual({ count: 3 });
  });

  it("derives the reduction from how context grows past each split (review 3 B5)", () => {
    // 3 sessions × 300 calls; call i reads 40,000 + 1,000·i (average 189,500 > 180K).
    for (let s = 1; s <= QUALIFYING_SESSIONS; s++) {
      insertSession(`sess-grow-${s}`);
      for (let i = 0; i < 300; i++) {
        insertTurn(`sess-grow-${s}`, timestamp(s * 400 + i), { cacheRead: 40_000 + 1_000 * i });
      }
    }
    runDetectors(db, { now: NOW });
    const { row, evidence } = d2Recommendation();
    // One split inside each session, after call 149 (context 189,000). Each of calls 150–299
    // then re-reads 40,000 base + 2,000 summary + its growth since, so it avoids
    // 189,000 − 42,000 = 147,000: 150 × 147,000 = 22,050,000 of 56,850,000 read per session.
    // Fraction 22.05 / 56.85 = 0.387862… → 0.3879.
    expect(evidence.base_prefix_tokens).toBe(40_000);
    expect(evidence.suggested_split_count).toBe(3);
    expect(evidence.reduction_fraction).toBe(0.3879);
    // Spend: 3 × 56,850,000 × $0.3/MTok = 51,165,000 µUSD. Gross = spend × 0.3879.
    expect(evidence.cache_read_spend_u_per_wk).toBe(51_165_000);
    expect(evidence.gross_savings_u_per_wk).toBe(Math.round(51_165_000 * 0.3879));
    // Rebuild: 3 × 42,000 × 3.75 (no writes, 5m price) = 472,500.
    expect(evidence.rebuild_u_per_wk).toBe(472_500);
    expect(row.modeled_savings_u_per_wk).toBe(Math.round(51_165_000 * 0.3879) - 472_500);
  });

  it("F3: the range re-runs the model at the bounds of the split cadence and summary size", () => {
    for (let s = 1; s <= QUALIFYING_SESSIONS; s++) {
      insertSession(`sess-range-${s}`);
      for (let i = 0; i < 300; i++) {
        insertTurn(`sess-range-${s}`, timestamp(s * 400 + i), { cacheRead: 40_000 + 1_000 * i });
      }
    }
    runDetectors(db, { now: NOW });
    const { row, evidence } = d2Recommendation();
    // Low: a split every 300 calls used to rule out every split in a 300-call session, so the
    // low end was 0 for a structural reason. U7: the cadence is capped so each session still gets
    // one split; with the 10,000-token summary that is the smallest saving, but a real one.
    expect(evidence.savings_low_u_per_wk as number).toBeGreaterThan(0);
    expect(evidence.savings_low_u_per_wk as number).toBeLessThan(
      row.modeled_savings_u_per_wk as number,
    );
    // High: every 75 calls with a 1,000-token summary. Splits after calls 74, 149, 224 (context
    // 114,000 / 189,000 / 264,000); each later call avoids that − 41,000: 75 × (73,000 + 148,000
    // + 223,000) = 33,300,000 of 56,850,000 → 0.5858. Gross 51,165,000 × 0.5858 = 29,972,457;
    // rebuild 9 splits × 41,000 × 3.75 = 1,383,750.
    expect(evidence.savings_high_u_per_wk).toBe(29_972_457 - 1_383_750);
    expect(row.modeled_savings_u_per_wk).toBeGreaterThan(0);
    expect(row.modeled_savings_u_per_wk).toBeLessThan(29_972_457 - 1_383_750);
  });

  it("U7: moves each split onto a nearby commit boundary and reports it", () => {
    for (let s = 1; s <= QUALIFYING_SESSIONS; s++) {
      insertSession(`sess-commit-${s}`);
      for (let i = 0; i < 300; i++) {
        insertTurn(`sess-commit-${s}`, timestamp(s * 400 + i), { cacheRead: 40_000 + 1_000 * i });
      }
      // A commit lands between call 140 and call 141, near the even split after call 149.
      db.prepare(
        `INSERT INTO tool_events (event_id, session_id, ts, tool_name, commit_sha)
         VALUES (?, ?, ?, 'Bash', ?)`,
      ).run(
        `evt-commit-${s}`,
        `sess-commit-${s}`,
        new Date(Date.parse(timestamp(s * 400 + 140)) + 30_000).toISOString(),
        `sha${s}`,
      );
    }
    runDetectors(db, { now: NOW });
    const { evidence } = d2Recommendation();
    expect(evidence.commit_boundary_count).toBe(3);
    expect(evidence.commit_anchored_splits).toBe(3);
    expect(evidence.suggested_split_count).toBe(3);
    // The split now follows call 140 (context 180,000): calls 141-299 avoid 180,000 - 42,000.
    // 159 x 138,000 = 21,942,000 of 56,850,000 per session → 0.3860 (was 0.3879 at call 149).
    expect(evidence.reduction_fraction).toBe(0.386);
  });

  it("U9 r6: records per session the calls, average and peak context, and the call context first passed 180K", () => {
    for (let s = 1; s <= QUALIFYING_SESSIONS; s++) {
      insertSession(`sess-stats-${s}`);
      for (let i = 0; i < 300; i++) {
        insertTurn(`sess-stats-${s}`, timestamp(s * 400 + i), { cacheRead: 40_000 + 1_000 * i });
      }
    }
    runDetectors(db, { now: NOW });
    const { evidence } = d2Recommendation();
    const stats = evidence.session_stats as string[];
    expect(stats).toHaveLength(QUALIFYING_SESSIONS);
    // Context is 40,000 + 1,000 x i before call i+1: average 189,500, peak 339,000, and it first
    // exceeds 180,000 at index 141, which is call 142.
    expect(stats[0]).toBe("sess-stats-1|300|189500|339000|142");
  });

  it("U7: stays quiet when the saving is under 1% of the week's spend", () => {
    for (let s = 1; s <= QUALIFYING_SESSIONS; s++) {
      insertSession(`sess-gate-${s}`);
      for (let i = 0; i < 300; i++) {
        insertTurn(`sess-gate-${s}`, timestamp(s * 400 + i), { cacheRead: 40_000 + 1_000 * i });
      }
    }
    // A priced turn elsewhere makes the week's spend large against a ~$15 saving.
    db.prepare(
      "UPDATE turns SET cost_equiv_u = 1000000000000 WHERE session_id = 'sess-gate-1' AND ts = ?",
    ).run(timestamp(400));
    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D2")?.status).toBe("INACTIVE");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM recommendations WHERE detector_id = 'D2'").get(),
    ).toEqual({ n: 0 });
  });
});
