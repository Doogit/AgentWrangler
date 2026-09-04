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
  } = usage;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?, ?, 'ws-d2', ?, 'claude-sonnet',
             0, ?, ?, ?, ?, ?, ?, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', ?, 'test-v1')`,
  ).run(
    `msg-d2-${messageSequence++}`,
    sessionId,
    timestamp,
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
    evidence: JSON.parse(row.evidence_json as string) as Record<string, unknown>,
  };
}

function addThreeQualifyingSessions(usage: Parameters<typeof insertTurn>[2]): void {
  for (let i = 1; i <= QUALIFYING_SESSIONS; i++) {
    addSession(`sess-d2-${i}`, QUALIFYING_TURNS, usage, { startOffset: i * 200 });
  }
}

describe("D2 — raw-context hygiene role", () => {
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
    expect(evidence.raw_context_basis).toBe("RAW_USAGE");
    expect(evidence.cap_weighted_burn_tokens_per_week).toBe(90_600_000);
    expect(evidence.cap_weighted_burn_basis).toBe("CAP_PROXY");
    expect(evidence.cache_read_exposure_tokens_per_week).toBe(0);
    expect(evidence.cache_read_exposure_spend_basis).toBe("LIST_EQUIV");
    expect(evidence.billed_cost_claim).toBe("UNAVAILABLE");
    expect(evidence.thresholds_unvalidated).toBe(true);
    expect(evidence.cap_read_coefficient_unvalidated).toBe(true);
  });

  it("classifies read-heavy sessions from raw context even when cap burn is lower", () => {
    addThreeQualifyingSessions({ cacheRead: 200_000 });

    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((status) => status.detector_id === "D2")?.status).toBe("ACTIVE");

    const { row, evidence } = d2Recommendation();
    expect(evidence.raw_context_average_tokens_per_turn).toBe(200_000);
    expect(evidence.raw_context_basis).toBe("RAW_USAGE");
    expect(evidence.cap_weighted_burn_tokens_per_week).toBe(9_060_000);
    expect(evidence.cap_weighted_burn_basis).toBe("CAP_PROXY");
    expect(evidence.cache_read_exposure_tokens_per_week).toBe(90_600_000);
    expect(evidence.cache_read_exposure_spend_u_per_week).toBe(27_180_000);
    expect(evidence.cache_read_exposure_spend_basis).toBe("LIST_EQUIV");
    expect(evidence.modeled_savings_basis).toBe("LIST_EQUIV");
    expect(evidence.billed_cost_claim).toBe("UNAVAILABLE");
    expect(row.target_metric).toBe("avg_context_per_turn");
    expect(row.modeled_savings_u_per_wk).toBe(8_969_400);
  });
});
