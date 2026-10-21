/**
 * test/detector/a1-claim-producer.test.ts — a1ClaimProducer ledger claims (P3.L L3).
 *
 * A1's own carry loop (a1_tool_result_bloat.ts evaluate()) ignores agent_id and mixes
 * subagents; the producer is narrower (same session, same is_sidechain, same agent_id as the
 * owner turn) — see result-claims.ts. Fixture helpers follow d1-per-source.test.ts /
 * d2-claim-producer.test.ts style.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaimLedger, conservationReport } from "../../src/detector/claim-ledger.js";
import {
  A1_RESULT_BYTES_THRESHOLD,
  a1ClaimProducer,
  a1Detector,
} from "../../src/detector/detectors/a1_tool_result_bloat.js";
import { buildContext } from "../../src/detector/engine.js";
import { recId } from "../../src/detector/rec-id.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX = buildContext(NOW);
const WS = "ws-a1c";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
  ).run(WS, WS, CTX.fromIso);
});

afterEach(() => db.close());

function insertSession(sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, ?, ?, 'RECONCILED', 0, 0, '[]')`,
  ).run(sessionId, WS, `/fake/${sessionId}.jsonl`, CTX.fromIso, CTX.toIso);
}

interface TurnOpts {
  isSidechain?: number;
  agentId?: string | null;
  cacheRead?: number;
  cw5m?: number;
  cw1h?: number;
  contextExtra?: number;
  provisional?: number;
}

/** Inserts a turn; context_tokens is generated from input+cacheRead+cw5m+cw1h+other. */
function insertTurn(messageId: string, sessionId: string, ts: string, opts: TurnOpts = {}): void {
  const {
    isSidechain = 0,
    agentId = null,
    cacheRead = 0,
    cw5m = 0,
    cw1h = 0,
    contextExtra = 0,
    provisional = 0,
  } = opts;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
        cache_write_other, pricing_snapshot_id, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', ?, ?, ?, 0, ?, ?, ?, 0, 'snap-sonnet',
             'LIST_EQUIV', ?, 'test-v1')`,
  ).run(
    messageId,
    sessionId,
    WS,
    ts,
    isSidechain,
    agentId,
    contextExtra,
    cacheRead,
    cw5m,
    cw1h,
    provisional,
  );
}

/** A tool event with `raw = round((resultBytes - THRESHOLD) / 2.7)` tokens over the boundary. */
function addToolEvent(
  eventId: string,
  sessionId: string,
  ts: string,
  resultBytes: number,
  ownerMessageId: string | null,
): void {
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
       input_hash, exit_class, commit_sha)
     VALUES (?, ?, ?, 'Bash', 0, ?, NULL, 'OK', NULL)`,
  ).run(eventId, sessionId, ts, resultBytes);
  if (ownerMessageId !== null) {
    db.prepare(
      `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
       VALUES (?, ?, 0, 0)`,
    ).run(eventId, ownerMessageId);
  }
}

function claimsFor(sessionId: string) {
  const ledger = buildClaimLedger(db, CTX, [a1ClaimProducer]);
  return ledger.claims.filter((claim) => claim.sessionId === sessionId);
}

describe("a1ClaimProducer", () => {
  it("writes to the first later turn of the SAME agent chain; another subagent's turn in between is skipped", () => {
    insertSession("s1");
    insertTurn("own-1", "s1", "2027-01-02T00:00:00.000Z", { isSidechain: 1, agentId: "agent-A" });
    addToolEvent(
      "ev-1",
      "s1",
      "2027-01-02T00:00:00.000Z",
      A1_RESULT_BYTES_THRESHOLD + 2_700,
      "own-1",
    );
    // Different subagent, sits chronologically between the event and agent-A's next turn.
    insertTurn("side-B", "s1", "2027-01-02T00:05:00.000Z", { isSidechain: 1, agentId: "agent-B" });
    insertTurn("later-A", "s1", "2027-01-02T00:10:00.000Z", {
      isSidechain: 1,
      agentId: "agent-A",
      cw5m: 1_000,
    });

    const claims = claimsFor("s1");
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim.turnKey).toBe("s1|later-A");
      expect(claim.turnKey).not.toBe("s1|side-B");
    }
  });

  it("splits the write claim across cw5m/cw1h by the write turn's own mix", () => {
    insertSession("s2");
    insertTurn("own-2", "s2", "2027-01-02T00:00:00.000Z");
    addToolEvent(
      "ev-2",
      "s2",
      "2027-01-02T00:00:00.000Z",
      A1_RESULT_BYTES_THRESHOLD + 2_700,
      "own-2",
    );
    insertTurn("later-2", "s2", "2027-01-02T00:10:00.000Z", { cw5m: 300, cw1h: 700 });

    const claims = claimsFor("s2");
    // raw = round(2700 / 2.7) = 1000; cw = 300 + 700 = 1000; r5 = round(1000*300/1000) = 300.
    const byComponent = new Map(claims.map((c) => [c.component, c.raw_tokens]));
    expect(byComponent.get("cw5m")).toBe(300);
    expect(byComponent.get("cw1h")).toBe(700);
    expect(claims.every((c) => c.turnKey === "s2|later-2")).toBe(true);
    expect(claims).toHaveLength(2);
  });

  it("carry stops at a verified compaction boundary", () => {
    insertSession("s3");
    insertTurn("own-3", "s3", "2027-01-02T00:00:00.000Z");
    addToolEvent(
      "ev-3",
      "s3",
      "2027-01-02T00:00:00.000Z",
      A1_RESULT_BYTES_THRESHOLD + 2_700,
      "own-3",
    );
    insertTurn("l3-1", "s3", "2027-01-02T00:10:00.000Z", { cw5m: 1_000 });
    insertTurn("l3-2", "s3", "2027-01-02T00:20:00.000Z", { cacheRead: 100_000 });
    insertTurn("l3-3", "s3", "2027-01-02T00:30:00.000Z", { cacheRead: 100_000 });
    db.prepare(
      `INSERT INTO ingest_metric_events
         (event_id, session_id, is_user_turn, is_compact_summary, is_api_error, is_interrupt,
          event_ts, boundary_kind, boundary_verification)
       VALUES ('compact-3', 's3', 0, 0, 0, 0, '2027-01-02T00:25:00.000Z',
               'compact-boundary', 'VERIFIED')`,
    ).run();

    const claims = claimsFor("s3");
    const carryKeys = claims.filter((c) => c.component === "cacheRead").map((c) => c.turnKey);
    expect(carryKeys).toEqual(["s3|l3-2"]);
    expect(carryKeys).not.toContain("s3|l3-3");
  });

  it("carry stops at a context collapse (>50k then <0.5x)", () => {
    insertSession("s4");
    insertTurn("own-4", "s4", "2027-01-02T00:00:00.000Z");
    addToolEvent(
      "ev-4",
      "s4",
      "2027-01-02T00:00:00.000Z",
      A1_RESULT_BYTES_THRESHOLD + 2_700,
      "own-4",
    );
    insertTurn("l4-1", "s4", "2027-01-02T00:10:00.000Z", { cw5m: 1_000, cacheRead: 60_000 });
    insertTurn("l4-2", "s4", "2027-01-02T00:20:00.000Z", { cacheRead: 65_000 });
    // Collapses relative to l4-2 (65,000 > 50,000; 20,000 < 0.5 * 65,000).
    insertTurn("l4-3", "s4", "2027-01-02T00:30:00.000Z", { cacheRead: 20_000 });

    const claims = claimsFor("s4");
    const carryKeys = claims.filter((c) => c.component === "cacheRead").map((c) => c.turnKey);
    expect(carryKeys).toEqual(["s4|l4-2"]);
    expect(carryKeys).not.toContain("s4|l4-3");
  });

  it("caps the carry walk at 75 later turns", () => {
    insertSession("s5");
    insertTurn("own-5", "s5", "2027-01-02T00:00:00.000Z");
    addToolEvent("ev-5", "s5", "2027-01-02T00:00:00.000Z", A1_RESULT_BYTES_THRESHOLD + 3, "own-5");
    for (let i = 0; i < 80; i++) {
      const ts = new Date(Date.parse("2027-01-02T00:10:00.000Z") + i * 60_000).toISOString();
      insertTurn(`l5-${i}`, "s5", ts, i === 0 ? { cw5m: 10 } : { cacheRead: 10 });
    }

    const claims = claimsFor("s5");
    const carryTurnKeys = new Set(
      claims.filter((c) => c.component === "cacheRead").map((c) => c.turnKey),
    );
    // 75 included turns total (l5-0..l5-74): l5-0 writes, l5-1..l5-74 carry (74 turns).
    expect(carryTurnKeys.size).toBe(74);
    expect(carryTurnKeys.has("s5|l5-74")).toBe(true); // turn 75 (last included) carries
    expect(carryTurnKeys.has("s5|l5-75")).toBe(false); // turn 76 excluded by the cap
    expect(claims.some((c) => c.component !== "cacheRead" && c.turnKey === "s5|l5-0")).toBe(true);
  });

  it("clamps a producer's own claims at the cell's raw token budget", () => {
    insertSession("s6");
    // One owner turn, two oversized results in it; both events' first later turn is the same
    // write turn, so its cw5m cell (1,000) must be shared between the two claims.
    insertTurn("own-6", "s6", "2027-01-02T00:00:00.000Z");
    addToolEvent(
      "ev-6a",
      "s6",
      "2027-01-02T00:00:00.000Z",
      A1_RESULT_BYTES_THRESHOLD + 2_430,
      "own-6",
    );
    addToolEvent(
      "ev-6b",
      "s6",
      "2027-01-02T00:00:30.000Z",
      A1_RESULT_BYTES_THRESHOLD + 2_430,
      "own-6",
    );
    insertTurn("later-6", "s6", "2027-01-02T00:10:00.000Z", { cw5m: 1_000 });

    const claims = claimsFor("s6").filter((c) => c.component === "cw5m");
    expect(claims).toHaveLength(2);
    const byEvent = new Map(claims.map((c) => [c.slice, c.raw_tokens]));
    expect(byEvent.get("result:ev-6a")).toBe(900);
    expect(byEvent.get("result:ev-6b")).toBe(100); // clamped: only 100 of 1,000 cell left
    expect(conservationReport(buildClaimLedger(db, CTX, [a1ClaimProducer])).overbilled).toEqual([]);
  });

  it("skips claims on turns the ledger doesn't bill, without blocking other turns in the same chain", () => {
    insertSession("s7");
    insertTurn("own-7", "s7", "2027-01-02T00:00:00.000Z");
    addToolEvent(
      "ev-7",
      "s7",
      "2027-01-02T00:00:00.000Z",
      A1_RESULT_BYTES_THRESHOLD + 2_700,
      "own-7",
    );
    // The write turn is provisional: unbilled, no write claim.
    insertTurn("l7-1", "s7", "2027-01-02T00:10:00.000Z", { cw5m: 1_000, provisional: 1 });
    // The carry turn is billed normally.
    insertTurn("l7-2", "s7", "2027-01-02T00:20:00.000Z", { cacheRead: 100_000 });

    const claims = claimsFor("s7");
    expect(claims.some((c) => c.turnKey === "s7|l7-1")).toBe(false);
    expect(claims.some((c) => c.turnKey === "s7|l7-2" && c.component === "cacheRead")).toBe(true);
  });

  it("stamps slice, fraction, fractionRange, assumed and the detector's own recId", () => {
    insertSession("s9");
    insertTurn("own-9", "s9", "2027-01-02T00:00:00.000Z");
    addToolEvent(
      "ev-9",
      "s9",
      "2027-01-02T00:00:00.000Z",
      A1_RESULT_BYTES_THRESHOLD + 2_700,
      "own-9",
    );
    insertTurn("later-9", "s9", "2027-01-02T00:10:00.000Z", { cw5m: 1_000 });

    const claims = claimsFor("s9");
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim.slice).toBe("result:ev-9");
      expect(claim.fraction).toBe(0.5);
      expect(claim.fractionRange).toEqual([0.33, 0.7]);
      expect(claim.assumed).toBe(true);
      expect(claim.recId).toBe(recId("A1", WS, `A1|${WS}`));
      expect(claim.detectorId).toBe("A1");
    }
  });

  it("U9: the standalone estimate prices a 1h-cache write turn as the ledger does (share never above estimate)", () => {
    // Real-shape: the turn after the read wrote to the 1-hour cache, then later turns read it back.
    insertSession("s10");
    insertTurn("own-10", "s10", "2027-01-02T00:00:00.000Z");
    addToolEvent(
      "ev-10",
      "s10",
      "2027-01-02T00:00:00.000Z",
      A1_RESULT_BYTES_THRESHOLD + 27_000,
      "own-10",
    );
    insertTurn("l10-1", "s10", "2027-01-02T00:10:00.000Z", { cw1h: 50_000 });
    insertTurn("l10-2", "s10", "2027-01-02T00:20:00.000Z", { cacheRead: 100_000 });
    insertTurn("l10-3", "s10", "2027-01-02T00:30:00.000Z", { cacheRead: 100_000 });

    const ledgerU = buildClaimLedger(db, CTX, [a1ClaimProducer])
      .claims.filter((c) => c.lane === "spend")
      .reduce((sum, c) => sum + c.value_u, 0);
    const fired = a1Detector.evaluate(db, CTX).fired[0];
    const rank = (fired?.payload as { estimate: { rank_value_u_per_wk: number } }).estimate
      .rank_value_u_per_wk;
    expect(ledgerU).toBeGreaterThan(0);
    expect(rank).toBeGreaterThanOrEqual(Math.floor(ledgerU));
    expect(Math.abs(rank - ledgerU)).toBeLessThanOrEqual(1);
  });

  it("claims large results in sessions D6 also fires on (U7: D6 owns only results ≤ 25,600 B)", () => {
    // Three sessions each with a large result (A1's) and a small one (D6's), and a later turn.
    const bytes = 250_000;
    for (const id of ["d6-a", "d6-b", "d6-c"]) {
      insertSession(id);
      insertTurn(`${id}-own`, id, "2027-01-02T00:00:00.000Z", { cacheRead: 100 });
      addToolEvent(`${id}-ev`, id, "2027-01-02T00:00:00.000Z", bytes, `${id}-own`);
      addToolEvent(`${id}-ev2`, id, "2027-01-02T00:00:30.000Z", 1_024, `${id}-own`);
      insertTurn(`${id}-later`, id, "2027-01-02T00:10:00.000Z", { cw5m: 1_000, cacheRead: 100 });
      db.prepare("UPDATE turns SET tool_result_bytes = ? WHERE message_id = ?").run(
        bytes,
        `${id}-own`,
      );
    }
    db.prepare(
      `INSERT INTO user_config (key, value, updated_at) VALUES ('bytes_per_token', '4', ?)`,
    ).run(CTX.fromIso);

    const claims = claimsFor("d6-a");
    expect(claims.some((c) => c.component === "cw5m")).toBe(true);
  });
});
