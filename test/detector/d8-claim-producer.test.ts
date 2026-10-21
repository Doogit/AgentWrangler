/**
 * test/detector/d8-claim-producer.test.ts — d8ClaimProducer ledger claims (P3.L L4).
 *
 * D8 is a repricing claim: raw tokens are the event's net-of-base creation split to the
 * cw5m/cw1h cells, priced by the ledger at (cell price − turn's cacheRead price). Fixture
 * mirrors d8-cache-write-churn.test.ts's insChurnSession (uniform sonnet pricing, so the
 * sum is exact, not just within tolerance).
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaimLedger, conservationReport } from "../../src/detector/claim-ledger.js";
import { d8ClaimProducer } from "../../src/detector/detectors/d8_cache_write_churn.js";
import { buildContext } from "../../src/detector/engine.js";
import { runDetectors } from "../../src/detector/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const BASE = new Date("2027-01-02T00:00:00.000Z").getTime();
const CTX = buildContext(NOW);

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  seq = 0;
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES ('ws-d8c','ws-d8c','2027-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO pricing_snapshots
       (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES ('snap-d8c', 'sonnet-4', '[3,15,0.3,3.75,6]', '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z')`,
  ).run();
});

afterEach(() => db.close());

function mkSession(id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, 'ws-d8c', ?, '2027-01-02T00:00:00.000Z', '2027-01-02T00:00:00.000Z',
             'RECONCILED', 0, 0, '[]')`,
  ).run(id, `/fake/${id}.jsonl`);
}

function insTurn(
  sessionId: string,
  offsetMin: number,
  f: { input?: number; cr?: number; cw5m?: number },
): void {
  const { input = 0, cr = 0, cw5m = 0 } = f;
  const ts = new Date(BASE + offsetMin * 60_000).toISOString();
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?, ?, 'ws-d8c', ?, 'claude-sonnet-4-6',
             0, ?, 0, ?, ?, 0, 0, NULL, 'snap-d8c', 0, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(`msg-d8c-${seq++}`, sessionId, ts, input, cr, cw5m);
}

/** A warm anchor turn + `n` resume-spike churn events (10-min gaps, 5m-dominant). */
function addChurnFixture(sessionId: string, n: number): void {
  mkSession(sessionId);
  insTurn(sessionId, 0, { input: 2000, cr: 5000 }); // warm anchor → base = 7000
  for (let i = 1; i <= n; i++) {
    insTurn(sessionId, i * 10, { cw5m: 60_000, cr: 0 }); // gap 10min > 5min TTL
  }
}

describe("d8ClaimProducer", () => {
  it("sums exactly to the detector's modeled_savings_u_per_wk (uniform price); recId matches", () => {
    addChurnFixture("sess-d8c-fire", 3);
    runDetectors(db, { now: NOW });
    const rec = db.prepare("SELECT * FROM recommendations WHERE detector_id = 'D8'").get() as
      | { rec_id: string; modeled_savings_u_per_wk: number }
      | undefined;
    expect(rec).toBeDefined();
    const savingsU = (rec as { modeled_savings_u_per_wk: number }).modeled_savings_u_per_wk;
    expect(savingsU).toBeGreaterThan(0);

    const ledger = buildClaimLedger(db, CTX, [d8ClaimProducer]);
    const d8Claims = ledger.claims.filter((claim) => claim.detectorId === "D8");
    // 3 churn events, each netting 53,000 tokens entirely on the cw5m cell.
    expect(d8Claims).toHaveLength(3);
    for (const claim of d8Claims) {
      expect(claim.component).toBe("cw5m");
      expect(claim.recId).toBe((rec as { rec_id: string }).rec_id);
    }

    const totalValueU = d8Claims.reduce((sum, claim) => sum + claim.value_u, 0);
    // Within (#claims × max cell price) µ$ of the card — exact here since the fixture's
    // per-event net creation and price are uniform (round() introduces no drift).
    const maxCellPriceUsdPerMtok = 3.75;
    expect(Math.abs(totalValueU - savingsU)).toBeLessThanOrEqual(
      d8Claims.length * maxCellPriceUsdPerMtok,
    );
    expect(totalValueU).toBe(savingsU);

    expect(conservationReport(ledger)).toEqual({ doubleOwned: [], overbilled: [], overvalued: [] });
  });

  it("yields nothing for a workspace below both the count and share gates", () => {
    // 1 churn event, diluted by a huge non-churn turn so neither the ≥3-events count gate
    // nor the ≥15%-share gate is met (mirrors d8-cache-write-churn.test.ts's sess-dilute).
    mkSession("sess-d8c-quiet");
    insTurn("sess-d8c-quiet", 0, { input: 10_000_000 });
    insTurn("sess-d8c-quiet", 10, { cw5m: 60_000, cr: 0 });
    runDetectors(db, { now: NOW });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM recommendations WHERE detector_id = 'D8'").get(),
    ).toEqual({ n: 0 });

    const ledger = buildClaimLedger(db, CTX, [d8ClaimProducer]);
    expect(ledger.claims.filter((claim) => claim.detectorId === "D8")).toHaveLength(0);
  });
});
