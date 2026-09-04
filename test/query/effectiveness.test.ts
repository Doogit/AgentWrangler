/**
 * test/query/effectiveness.test.ts — EF1 delivery-path metrics.
 *
 * Covers: turns_to_first_commit (including sidechain exclusion), deep_abandoned
 * classification, abandoned-spend split vs RV9a total, getSession integration
 * with gap columns, and SEC-101 privacy constraints.
 *
 * Time window: 2027-08-01 → 2027-09-01, distinct from fixture 2026-01-01 timestamps.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDeliveryMetrics } from "../../src/query/api/delivery.js";
import {
  computeSessionDelivery,
  getAbandonedSpendSplit,
} from "../../src/query/api/effectiveness.js";
import { getSession } from "../../src/query/api/overview.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const FROM = "2027-08-01T00:00:00.000Z";
const TO = "2027-09-01T00:00:00.000Z";

/** Timestamps inside [FROM, TO), at offset minutes from FROM. */
function ts(offsetMinutes: number): string {
  const d = new Date(FROM);
  d.setMinutes(d.getMinutes() + offsetMinutes);
  return d.toISOString();
}

const TS_IN = ts(60 * 24 * 7); // ~7 days in, safely inside the window

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

function insWs(wsId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?,?,?)`,
  ).run(wsId, wsId, FROM);
}

interface InsSessOpts {
  ts?: string;
  state?: "LIVE" | "RECONCILED";
  userTurnCount?: number;
  gapMedianS?: number | null;
  gapP90S?: number | null;
  longGapCount?: number;
  gapN?: number;
}

function insSess(sessId: string, wsId: string, opts: InsSessOpts = {}): void {
  const {
    ts: sessTs = TS_IN,
    state = "RECONCILED",
    userTurnCount = 0,
    gapMedianS = null,
    gapP90S = null,
    longGapCount = 0,
    gapN = 0,
  } = opts;
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags, user_turn_count,
        gap_median_s, gap_p90_s, long_gap_count, gap_n)
     VALUES (?,?,?,?,?,?,1,0,'[]',?,?,?,?,?)`,
  ).run(
    sessId,
    wsId,
    `/fake/${sessId}.jsonl`,
    sessTs,
    sessTs,
    state,
    userTurnCount,
    gapMedianS,
    gapP90S,
    longGapCount,
    gapN,
  );
}

function insTurn(
  msgId: string,
  sessId: string,
  wsId: string,
  turnTs: string,
  costU: number,
  isSidechain = 0,
  provisional = 0,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens, cache_write_5m,
        cache_write_1h, cache_write_other, tool_result_bytes,
        pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?,?,?,?,'claude-sonnet',?,100,10,0,0,0,0,NULL,NULL,?,'LIST_EQUIV',?,'test-v1')`,
  ).run(msgId, sessId, wsId, turnTs, isSidechain, costU, provisional);
}

function insToolEvent(
  eventId: string,
  sessId: string,
  eventTs: string,
  toolName: string,
  commitSha: string | null = null,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO tool_events (event_id, session_id, ts, tool_name, commit_sha)
     VALUES (?,?,?,?,?)`,
  ).run(eventId, sessId, eventTs, toolName, commitSha);
}

// ── turns_to_first_commit ─────────────────────────────────────────────────────

describe("computeSessionDelivery — turns_to_first_commit", () => {
  it("counts non-sidechain turns up to and including the commit turn's ts", () => {
    insWs("ws-ttfc");
    insSess("sess-ttfc", "ws-ttfc", { userTurnCount: 8 });

    // 8 non-sidechain turns at offsets 1..8
    for (let i = 1; i <= 8; i++) {
      insTurn(`msg-ttfc-${i}`, "sess-ttfc", "ws-ttfc", ts(i), 100);
    }
    // 1 sidechain turn before the commit (offset 2) — must NOT be counted
    insTurn("msg-ttfc-sc", "sess-ttfc", "ws-ttfc", ts(2), 50, 1 /* is_sidechain */);

    // Commit at offset 7 (the 7th non-sidechain turn's ts)
    insToolEvent("evt-ttfc-commit", "sess-ttfc", ts(7), "Bash", "aaaa1111bbbb2222");

    const result = computeSessionDelivery(db, "sess-ttfc");
    // Non-sidechain turns with ts <= ts(7): offsets 1,2,3,4,5,6,7 = 7
    expect(result.turns_to_first_commit).toBe(7);
  });

  it("returns null when no commit event exists", () => {
    insWs("ws-ttfc-nc");
    insSess("sess-ttfc-nc", "ws-ttfc-nc", { userTurnCount: 5 });
    for (let i = 1; i <= 5; i++) {
      insTurn(`msg-ttfc-nc-${i}`, "sess-ttfc-nc", "ws-ttfc-nc", ts(i), 100);
    }
    insToolEvent("evt-ttfc-nc-write", "sess-ttfc-nc", ts(3), "Write", null);

    const result = computeSessionDelivery(db, "sess-ttfc-nc");
    expect(result.turns_to_first_commit).toBeNull();
  });

  it("sidechain turn at same ts as commit is not counted", () => {
    insWs("ws-ttfc-sc2");
    insSess("sess-ttfc-sc2", "ws-ttfc-sc2", { userTurnCount: 3 });

    // 3 non-sidechain turns at offsets 1, 2, 3
    insTurn("msg-ttfc-sc2-1", "sess-ttfc-sc2", "ws-ttfc-sc2", ts(1), 100);
    insTurn("msg-ttfc-sc2-2", "sess-ttfc-sc2", "ws-ttfc-sc2", ts(2), 100);
    insTurn("msg-ttfc-sc2-3", "sess-ttfc-sc2", "ws-ttfc-sc2", ts(3), 100);
    // Sidechain turn at commit ts (offset 2) — must NOT be counted
    insTurn("msg-ttfc-sc2-sc", "sess-ttfc-sc2", "ws-ttfc-sc2", ts(2), 50, 1);

    insToolEvent("evt-ttfc-sc2-commit", "sess-ttfc-sc2", ts(2), "Bash", "cccc3333dddd4444");

    const result = computeSessionDelivery(db, "sess-ttfc-sc2");
    // Non-sidechain turns with ts <= ts(2): offsets 1,2 = 2
    expect(result.turns_to_first_commit).toBe(2);
  });
});

// ── deep_abandoned ────────────────────────────────────────────────────────────

describe("computeSessionDelivery — deep_abandoned", () => {
  it("is true for RECONCILED with user_turn_count >= 10, no commit, has Write event", () => {
    insWs("ws-da");
    insSess("sess-da-true", "ws-da", { state: "RECONCILED", userTurnCount: 12 });
    insTurn("msg-da-true-1", "sess-da-true", "ws-da", ts(1), 100);
    insToolEvent("evt-da-true-write", "sess-da-true", ts(2), "Write", null);

    const result = computeSessionDelivery(db, "sess-da-true");
    expect(result.deep_abandoned).toBe(true);
  });

  it("is false when state is LIVE (even if user_turn_count >= 10 and no commit)", () => {
    insWs("ws-da-live");
    insSess("sess-da-live", "ws-da-live", { state: "LIVE", userTurnCount: 12 });
    insTurn("msg-da-live-1", "sess-da-live", "ws-da-live", ts(1), 100);
    insToolEvent("evt-da-live-write", "sess-da-live", ts(2), "Write", null);

    const result = computeSessionDelivery(db, "sess-da-live");
    expect(result.deep_abandoned).toBe(false);
  });

  it("is false when user_turn_count < 10 (early abandoned boundary)", () => {
    insWs("ws-da-early");
    insSess("sess-da-early", "ws-da-early", { state: "RECONCILED", userTurnCount: 9 });
    insTurn("msg-da-early-1", "sess-da-early", "ws-da-early", ts(1), 100);
    insToolEvent("evt-da-early-write", "sess-da-early", ts(2), "Write", null);

    const result = computeSessionDelivery(db, "sess-da-early");
    expect(result.deep_abandoned).toBe(false);
  });

  it("is false when a commit exists (regardless of user_turn_count)", () => {
    insWs("ws-da-commit");
    insSess("sess-da-commit", "ws-da-commit", { state: "RECONCILED", userTurnCount: 12 });
    insTurn("msg-da-commit-1", "sess-da-commit", "ws-da-commit", ts(1), 100);
    insToolEvent("evt-da-commit", "sess-da-commit", ts(2), "Bash", "eeee5555ffff6666");

    const result = computeSessionDelivery(db, "sess-da-commit");
    expect(result.deep_abandoned).toBe(false);
  });
});

// ── abandoned-spend split sums to RV9a total ──────────────────────────────────

describe("getAbandonedSpendSplit — sums to RV9a abandoned_spend_u", () => {
  it("deep + early === getDeliveryMetrics abandoned_spend_u, each in the correct bucket", () => {
    insWs("ws-split");

    // Deep abandoned: user_turn_count=12, Write event, no commit, spend=5000
    insSess("sess-split-deep", "ws-split", { state: "RECONCILED", userTurnCount: 12 });
    insTurn("msg-split-deep-1", "sess-split-deep", "ws-split", TS_IN, 5000);
    insToolEvent("evt-split-deep-write", "sess-split-deep", TS_IN, "Write", null);

    // Early abandoned: user_turn_count=5, Edit event, no commit, spend=3000
    insSess("sess-split-early", "ws-split", { state: "RECONCILED", userTurnCount: 5 });
    insTurn("msg-split-early-1", "sess-split-early", "ws-split", TS_IN, 3000);
    insToolEvent("evt-split-early-edit", "sess-split-early", TS_IN, "Edit", null);

    // Commit session: spend=2000 (should NOT appear in abandoned)
    insSess("sess-split-commit", "ws-split", { state: "RECONCILED", userTurnCount: 8 });
    insTurn("msg-split-commit-1", "sess-split-commit", "ws-split", TS_IN, 2000);
    insToolEvent("evt-split-commit", "sess-split-commit", TS_IN, "Bash", "1234567890abcdef");

    const split = getAbandonedSpendSplit(db, { workspaceId: null, from: FROM, to: TO });
    const delivery = getDeliveryMetrics(db, { workspaceId: null, from: FROM, to: TO });
    const totalAbandoned = delivery.data?.abandoned_spend_u ?? -1;

    // The split must sum to the RV9a total.
    expect(split.deep_abandoned_spend_u + split.early_abandoned_spend_u).toBe(totalAbandoned);

    // Each session's spend landed in the correct bucket.
    expect(split.deep_abandoned_spend_u).toBe(5000);
    expect(split.early_abandoned_spend_u).toBe(3000);
  });

  it("returns zeros when no abandoned sessions exist", () => {
    insWs("ws-split-zero");
    insSess("sess-split-zero-commit", "ws-split-zero", { state: "RECONCILED", userTurnCount: 3 });
    insTurn("msg-split-zero-1", "sess-split-zero-commit", "ws-split-zero", TS_IN, 1000);
    insToolEvent(
      "evt-split-zero-commit",
      "sess-split-zero-commit",
      TS_IN,
      "Bash",
      "aabbccdd11223344",
    );

    const split = getAbandonedSpendSplit(db, { workspaceId: null, from: FROM, to: TO });
    expect(split.deep_abandoned_spend_u).toBe(0);
    expect(split.early_abandoned_spend_u).toBe(0);
  });
});

// ── getSession integration ─────────────────────────────────────────────────────

describe("getSession — EF1 + EF3 field integration", () => {
  it("surfaces turns_to_first_commit, deep_abandoned, and gap_* columns", () => {
    insWs("ws-gs-int");
    // Seed a session with gap columns populated and a commit
    insSess("sess-gs-int", "ws-gs-int", {
      state: "RECONCILED",
      userTurnCount: 6,
      gapMedianS: 45.5,
      gapP90S: 120.0,
      longGapCount: 2,
      gapN: 5,
    });

    // 3 non-sidechain turns
    insTurn("msg-gs-int-1", "sess-gs-int", "ws-gs-int", ts(1), 100);
    insTurn("msg-gs-int-2", "sess-gs-int", "ws-gs-int", ts(2), 100);
    insTurn("msg-gs-int-3", "sess-gs-int", "ws-gs-int", ts(3), 100);

    // Commit at offset 2 (second turn's ts)
    insToolEvent("evt-gs-int-commit", "sess-gs-int", ts(2), "Bash", "deadbeef12345678");

    const res = getSession("sess-gs-int");
    const d = res.data;
    if (d === null) throw new Error("expected data, got null");

    // EF3 gap fields come from the sessions row
    expect(d.gap_median_s).toBe(45.5);
    expect(d.gap_p90_s).toBe(120.0);
    expect(d.long_gap_count).toBe(2);
    expect(d.gap_n).toBe(5);

    // EF1 delivery fields: commit at ts(2), non-sidechain turns at ts(1) and ts(2) = 2
    expect(d.turns_to_first_commit).toBe(2);
    // deep_abandoned: user_turn_count=6 < 10, so false
    expect(d.deep_abandoned).toBe(false);
  });

  it("deep_abandoned is true for a deep abandoned RECONCILED session surfaced via getSession", () => {
    insWs("ws-gs-da");
    insSess("sess-gs-da", "ws-gs-da", {
      state: "RECONCILED",
      userTurnCount: 15,
      gapMedianS: null,
      gapP90S: null,
      longGapCount: 0,
      gapN: 0,
    });
    insTurn("msg-gs-da-1", "sess-gs-da", "ws-gs-da", ts(1), 100);
    insToolEvent("evt-gs-da-write", "sess-gs-da", ts(2), "Write", null);

    const res = getSession("sess-gs-da");
    const d = res.data;
    if (d === null) throw new Error("expected data, got null");

    expect(d.deep_abandoned).toBe(true);
    expect(d.turns_to_first_commit).toBeNull();
    expect(d.gap_median_s).toBeNull();
    expect(d.gap_p90_s).toBeNull();
    expect(d.long_gap_count).toBe(0);
    expect(d.gap_n).toBe(0);
  });
});

// ── SEC-101 privacy constraint ─────────────────────────────────────────────────

describe("SEC-101 — effectiveness payloads contain no raw ids, SHAs, or tool names", () => {
  it("computeSessionDelivery payload has no commit SHA, session id, or tool name", () => {
    const COMMIT_SHA = "abcdef1234567890abcdef1234567890";
    const SESSION_ID = "sess-sec101-ef1-private";
    const TOOL_NAME = "Write";

    insWs("ws-sec101-ef1");
    insSess(SESSION_ID, "ws-sec101-ef1", { state: "RECONCILED", userTurnCount: 5 });
    insTurn(`msg-${SESSION_ID}`, SESSION_ID, "ws-sec101-ef1", ts(1), 100);
    insToolEvent(`evt-${SESSION_ID}`, SESSION_ID, ts(2), TOOL_NAME, null);

    const result = computeSessionDelivery(db, SESSION_ID);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(COMMIT_SHA);
    expect(serialized).not.toContain(SESSION_ID);
    expect(serialized).not.toContain(TOOL_NAME);

    // Return type is {turns_to_first_commit: number|null, deep_abandoned: boolean}
    const turnType =
      result.turns_to_first_commit === null || typeof result.turns_to_first_commit === "number";
    expect(turnType).toBe(true);
    expect(typeof result.deep_abandoned).toBe("boolean");
  });

  it("getAbandonedSpendSplit payload has no commit SHA, session id, or tool name", () => {
    const COMMIT_SHA = "1111222233334444aaaabbbbccccdddd";
    const SESSION_ID = "sess-sec101-split-private";
    const TOOL_NAME = "Edit";

    insWs("ws-sec101-split");
    insSess(SESSION_ID, "ws-sec101-split", { state: "RECONCILED", userTurnCount: 3 });
    insTurn(`msg-${SESSION_ID}`, SESSION_ID, "ws-sec101-split", TS_IN, 2000);
    insToolEvent(`evt-${SESSION_ID}`, SESSION_ID, TS_IN, TOOL_NAME, null);

    const split = getAbandonedSpendSplit(db, { workspaceId: null, from: FROM, to: TO });
    const serialized = JSON.stringify(split);

    expect(serialized).not.toContain(COMMIT_SHA);
    expect(serialized).not.toContain(SESSION_ID);
    expect(serialized).not.toContain(TOOL_NAME);

    // Return type is {deep_abandoned_spend_u: number, early_abandoned_spend_u: number}
    expect(typeof split.deep_abandoned_spend_u).toBe("number");
    expect(typeof split.early_abandoned_spend_u).toBe("number");
  });
});
