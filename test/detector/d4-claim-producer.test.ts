/**
 * test/detector/d4-claim-producer.test.ts — d4ClaimProducer ledger claims (P3.L L5).
 *
 * D4 is the residual `model:*` repricing claim: every lookup-subagent turn's nonzero token
 * components are claimed at the sonnet-5 target price (PRICE-O55-F1), and the ledger only credits whatever D2/B1/B3/D8
 * didn't already remove or reprice for that turn (RESIDUAL_SLICES + LEDGER_PRIORITY put D4 last
 * among the spend-lane producers).
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Claim, ClaimProducer } from "../../src/detector/claim-ledger.js";
import { buildClaimLedger, conservationReport } from "../../src/detector/claim-ledger.js";
import {
  D4_FRACTION_RANGE,
  d4ClaimProducer,
} from "../../src/detector/detectors/d4_model_mismatch.js";
import { buildContext } from "../../src/detector/engine.js";
import { runDetectors } from "../../src/detector/index.js";
import {
  D4_MISMATCH_MAX_OUTPUT_TOKENS,
  D4_MISMATCH_MIN_CONTEXT_TOKENS,
  D4_OPUS_MIN_TURNS,
  D4_REALIZABLE_AVOIDANCE_FRACTION,
} from "../../src/detector/savings.js";
import { turnKey } from "../../src/detector/turn-claim.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// Frozen now: fixture data is in [2026-01-01, 2026-01-08), same window as d4-model-mismatch.test.ts.
const NOW = new Date("2026-01-08T00:00:00.000Z");
const CTX = buildContext(NOW);
// D4's target tier is sonnet-5; the fixture DB has no sonnet-5 snapshot, so LIST_PRICES["sonnet-5"]
// applies: [in, out, cacheRead, cw5m, cw1h].
const SONNET_PRICES = [2, 10, 0.2, 2.5, 4] as const;

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    `INSERT OR IGNORE INTO pricing_snapshots
       (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES ('snap-opus', 'opus', '[15,75,1.5,18.75,30]', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`,
  ).run();
});

afterEach(() => db.close());

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureWorkspaceAndSession(workspaceId: string, sessionId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, '2026-01-01T00:00:00.000Z')`,
  ).run(workspaceId, workspaceId);
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
             'RECONCILED', 1, 0, '[]')`,
  ).run(sessionId, workspaceId, `/fake/${sessionId}.jsonl`);
}

interface OpusTurnSpec {
  msgId: string;
  workspaceId: string;
  sessionId: string;
  agentId: string;
  input?: number;
  output?: number;
  cr?: number;
  cw5m?: number;
  cw1h?: number;
  pricingSnapshotId?: string;
}

/** Insert one Opus-model sidechain turn, ensuring its workspace + session exist. */
function insOpusTurn(spec: OpusTurnSpec): void {
  const {
    msgId,
    workspaceId,
    sessionId,
    agentId,
    input = 0,
    output = 0,
    cr = 0,
    cw5m = 0,
    cw1h = 0,
    pricingSnapshotId = "snap-opus",
  } = spec;
  ensureWorkspaceAndSession(workspaceId, sessionId);
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version, agent_id)
     VALUES (?, ?, ?, '2026-01-02T00:00:00.000Z', 'claude-opus-4',
             1, ?, ?, ?, ?, ?, 0, NULL, ?, 0, 'LIST_EQUIV', 0, 'test-v1', ?)`,
  ).run(msgId, sessionId, workspaceId, input, output, cr, cw5m, cw1h, pricingSnapshotId, agentId);
}

/** Insert N mismatch turns (high context, low output) for one lookup subagent. */
function insLookupTurns(
  n: number,
  workspaceId: string,
  agentId: string,
  extra: (index: number) => Partial<OpusTurnSpec> = () => ({}),
): void {
  const sessionId = `sess-${workspaceId}`;
  for (let i = 0; i < n; i++) {
    insOpusTurn({
      msgId: `msg-${agentId}-${i}`,
      workspaceId,
      sessionId,
      agentId,
      input: D4_MISMATCH_MIN_CONTEXT_TOKENS,
      output: Math.floor(D4_MISMATCH_MAX_OUTPUT_TOKENS / 2),
      ...extra(i),
    });
  }
}

function d4Claims(db: Database.Database, producers: readonly ClaimProducer[]) {
  return buildClaimLedger(db, CTX, producers).claims.filter((claim) => claim.detectorId === "D4");
}

describe("d4ClaimProducer", () => {
  it("claims every nonzero component of every lookup-agent turn; excludes a non-lookup agent", () => {
    insLookupTurns(D4_OPUS_MIN_TURNS, "ws-a", "lookup-a", () => ({
      cr: 1000,
      cw5m: 2000,
      cw1h: 3000,
    }));
    // A non-lookup agent: one turn writes a lot of output, so the whole agent is excluded.
    insOpusTurn({
      msgId: "msg-work-a-0",
      workspaceId: "ws-a",
      sessionId: "sess-ws-a",
      agentId: "work-a",
      input: D4_MISMATCH_MIN_CONTEXT_TOKENS,
      output: D4_MISMATCH_MAX_OUTPUT_TOKENS + 1,
    });

    runDetectors(db, { now: NOW });
    const rec = db.prepare("SELECT rec_id FROM recommendations WHERE detector_id = 'D4'").get() as
      | { rec_id: string }
      | undefined;
    expect(rec).toBeDefined();

    const claims = d4Claims(db, [d4ClaimProducer]);
    // 5 turns x 5 nonzero components (input, output, cacheRead, cw5m, cw1h).
    expect(claims).toHaveLength(D4_OPUS_MIN_TURNS * 5);

    const excludedKey = turnKey("sess-ws-a", "msg-work-a-0");
    expect(claims.some((claim) => claim.turnKey === excludedKey)).toBe(false);

    const priceByComponent: Record<string, number> = {
      input: SONNET_PRICES[0],
      output: SONNET_PRICES[1],
      cacheRead: SONNET_PRICES[2],
      cw5m: SONNET_PRICES[3],
      cw1h: SONNET_PRICES[4],
    };
    for (const claim of claims) {
      expect(claim.slice).toBe("model:*");
      expect(claim.fraction).toBe(0.5);
      expect(claim.fractionRange).toEqual(D4_FRACTION_RANGE);
      expect(claim.assumed).toBe(true);
      expect(claim.recId).toBe((rec as { rec_id: string }).rec_id);
      expect(claim.counterfactualPriceU).toBe(priceByComponent[claim.component]);
    }
  });

  it("yields nothing when the workspace does not fire (below the opus-turn-count gate)", () => {
    insLookupTurns(D4_OPUS_MIN_TURNS - 1, "ws-b", "lookup-b");

    const claims = d4Claims(db, [d4ClaimProducer]);
    expect(claims).toHaveLength(0);
  });

  it("yields nothing when the mismatch share is below the fraction gate", () => {
    // 2 mismatch + 4 legit (large-output) turns from a distinct agent = fraction < 40%.
    insLookupTurns(2, "ws-b2", "lookup-b2");
    for (let i = 0; i < 4; i++) {
      insOpusTurn({
        msgId: `msg-legit-b2-${i}`,
        workspaceId: "ws-b2",
        sessionId: "sess-ws-b2",
        agentId: "legit-b2",
        input: D4_MISMATCH_MIN_CONTEXT_TOKENS,
        output: 5_000,
      });
    }

    const claims = d4Claims(db, [d4ClaimProducer]);
    expect(claims).toHaveLength(0);
  });

  describe("ledger-level: D4 owns only what a higher-priority residual claim left", () => {
    const T = 100_000;

    function setup(x: number): { sessionId: string; msgId: string; stub: ClaimProducer } {
      const workspaceId = "ws-c";
      const sessionId = `sess-${workspaceId}`;
      const targetMsgId = "msg-lookup-c-0";
      insLookupTurns(D4_OPUS_MIN_TURNS, workspaceId, "lookup-c", (i) => (i === 0 ? { cr: T } : {}));

      const stub: ClaimProducer = {
        detectorId: "D2",
        *produce(): Iterable<Claim> {
          yield {
            detectorId: "D2",
            workspaceId,
            sessionId,
            turnKey: turnKey(sessionId, targetMsgId),
            component: "cacheRead",
            slice: "history:*",
            tokens: x,
            recId: "rec-stub-d2",
          };
        },
      };
      return { sessionId, msgId: targetMsgId, stub };
    }

    it("D2 removes more than half the cell: D4 owns exactly T − X", () => {
      const X = 70_000;
      const { sessionId, msgId, stub } = setup(X);
      const ledger = buildClaimLedger(db, CTX, [stub, d4ClaimProducer]);

      const tk = turnKey(sessionId, msgId);
      const d4CacheRead = ledger.claims.find(
        (claim) =>
          claim.detectorId === "D4" && claim.turnKey === tk && claim.component === "cacheRead",
      );
      expect(d4CacheRead).toBeDefined();
      expect(d4CacheRead?.tokens).toBe(T - X);
      const p = 1.5; // this turn's own cacheRead price (snap-opus).
      const pPrime = SONNET_PRICES[2];
      expect(d4CacheRead?.value_u).toBeCloseTo((T - X) * (p - pPrime), 6);

      expect(conservationReport(ledger)).toEqual({
        doubleOwned: [],
        overbilled: [],
        overvalued: [],
      });
    });

    it("D2 removes less than half the cell: D4 owns round(T × 0.5)", () => {
      const X = 30_000;
      const { sessionId, msgId, stub } = setup(X);
      const ledger = buildClaimLedger(db, CTX, [stub, d4ClaimProducer]);

      const tk = turnKey(sessionId, msgId);
      const d4CacheRead = ledger.claims.find(
        (claim) =>
          claim.detectorId === "D4" && claim.turnKey === tk && claim.component === "cacheRead",
      );
      expect(d4CacheRead).toBeDefined();
      const expectedTokens = Math.round(T * D4_REALIZABLE_AVOIDANCE_FRACTION);
      expect(d4CacheRead?.tokens).toBe(expectedTokens);
      const p = 1.5;
      const pPrime = SONNET_PRICES[2];
      expect(d4CacheRead?.value_u).toBeCloseTo(expectedTokens * (p - pPrime), 6);

      expect(conservationReport(ledger)).toEqual({
        doubleOwned: [],
        overbilled: [],
        overvalued: [],
      });
    });
  });

  it("rejects a cacheRead claim priced at or below the sonnet-5 counterfactual; owns input/output", () => {
    const workspaceId = "ws-d";
    const sessionId = `sess-${workspaceId}`;
    const targetMsgId = "msg-lookup-d-0";
    db.prepare(
      `INSERT OR IGNORE INTO pricing_snapshots
         (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
       VALUES ('snap-opus-5-5', 'opus-5-5', '[15,75,0.2,18.75,30]', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`,
    ).run();

    insLookupTurns(D4_OPUS_MIN_TURNS, workspaceId, "lookup-d", (i) =>
      i === 0 ? { cr: 50_000, pricingSnapshotId: "snap-opus-5-5" } : {},
    );

    const ledger = buildClaimLedger(db, CTX, [d4ClaimProducer]);
    const tk = turnKey(sessionId, targetMsgId);

    const rejectedCacheRead = ledger.rejected.find(
      (claim) =>
        claim.detectorId === "D4" && claim.turnKey === tk && claim.component === "cacheRead",
    );
    expect(rejectedCacheRead).toBeDefined();

    const ownedCacheRead = ledger.claims.find(
      (claim) =>
        claim.detectorId === "D4" && claim.turnKey === tk && claim.component === "cacheRead",
    );
    expect(ownedCacheRead).toBeUndefined();

    const ownedInput = ledger.claims.find(
      (claim) => claim.detectorId === "D4" && claim.turnKey === tk && claim.component === "input",
    );
    const ownedOutput = ledger.claims.find(
      (claim) => claim.detectorId === "D4" && claim.turnKey === tk && claim.component === "output",
    );
    expect(ownedInput).toBeDefined();
    expect(ownedOutput).toBeDefined();
  });
});
