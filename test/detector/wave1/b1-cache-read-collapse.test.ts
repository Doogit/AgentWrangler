import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { b1Detector } from "../../../src/detector/detectors/b1_cache_read_collapse.js";
import { buildContext, runDetectors } from "../../../src/detector/engine.js";
import { findingIds } from "../../../src/detector/privacy-contract.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";
import { assertV2ProducerBoundary } from "../../fixtures/v2-producer-boundary.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
const PRIOR_READS = 20_001;
let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-b1', 'ws-b1', ?)",
  ).run(CTX.fromIso);
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('session-b1', 'ws-b1', '/fixture/b1.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')`,
  ).run(CTX.fromIso, CTX.toIso);
});

afterEach(() => db.close());

function addTurn(
  messageId: string,
  ts: string,
  cacheRead: number,
  {
    provisional = false,
    sidechain = false,
    cacheWrite5m = 0,
    cacheWrite1h = 0,
  }: {
    provisional?: boolean;
    sidechain?: boolean;
    cacheWrite5m?: number;
    cacheWrite1h?: number;
  } = {},
) {
  db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_claim, provisional, parser_version)
     VALUES (?, 'session-b1', 'ws-b1', ?, 'claude-sonnet-4-6', ?, 0, 0, ?, ?, ?, 0, 'LIST_EQUIV', ?, 'test')`,
  ).run(
    messageId,
    ts,
    sidechain ? 1 : 0,
    cacheRead,
    cacheWrite5m,
    cacheWrite1h,
    provisional ? 1 : 0,
  );
}

describe("B1 CACHE_READ_COLLAPSE V2", () => {
  it("fires only for an in-window current turn while retaining its pre-window predecessor as an anchor", () => {
    // Window starts 2027-01-01T00:00Z; a 2-min gap is inside the 5m TTL.
    addTurn("b1-before", "2026-12-31T23:59:00.000Z", PRIOR_READS);
    addTurn("b1-current", "2027-01-01T00:01:00.000Z", 2_000, { cacheWrite5m: 20_000 });

    const outcome = b1Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, b1Detector);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    const finding = outcome.fired[0]?.payload;
    expect(finding?.routing).toEqual({ tier: "INVESTIGATE" });
    expect(finding?.anchors.map((anchor) => anchor.message_id)).toEqual([
      findingIds.message("b1-before"),
      findingIds.message("b1-current"),
    ]);
    expect(finding?.metrics).toMatchObject({
      PREVIOUS_CACHE_READ_TOKENS: { kind: "TOKENS", value: PRIOR_READS },
      CURRENT_CACHE_READ_TOKENS: { kind: "TOKENS", value: 2_000 },
    });

    runDetectors(db, CTX, [b1Detector]);
    const row = db
      .prepare(
        "SELECT modeled_formula_json, evidence_json FROM recommendations WHERE detector_id = 'B1'",
      )
      .get() as {
      modeled_formula_json: string;
      evidence_json: string;
    };
    const formula = JSON.parse(row.modeled_formula_json) as { estimate: Record<string, unknown> };
    // Re-created tokens on the collapse turn, net of the read price:
    // 20,000 * 0.5 * (3.75 - 0.3) = 34,500 µUSD/wk.
    expect(formula.estimate).toMatchObject({
      basis: "P",
      rank_value_u_per_wk: 34_500,
      summable: true,
    });
    const evidence = JSON.parse(row.evidence_json).session_ids as string[];
    expect(evidence).toEqual(["session-b1"]);
    expect(
      db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(evidence[0]),
    ).toBeDefined();
  });

  it("needs a real re-write: no fire when reads hold, the write is under half the context, the context shrank, or the row is provisional", () => {
    addTurn("b1-prior", "2027-01-02T00:00:00.000Z", 100_000, { cacheWrite5m: 1_000 });
    // Reads held (a big tool result, not a prefix break).
    addTurn("b1-reads-held", "2027-01-02T00:01:00.000Z", 100_000, { cacheWrite5m: 60_000 });
    // Reads fell but only 30% of the previous context was written again.
    addTurn("b1-small-write", "2027-01-02T00:02:00.000Z", 5_000, { cacheWrite5m: 30_000 });
    // Compaction: reads fell and the whole context shrank to a summary.
    addTurn("b1-compaction-prior", "2027-01-02T00:10:00.000Z", 200_000, { cacheWrite5m: 1_000 });
    addTurn("b1-compaction", "2027-01-02T00:11:00.000Z", 5_000, { cacheWrite5m: 120_000 });
    addTurn("b1-provisional", "2027-01-02T00:20:00.000Z", 0, {
      provisional: true,
      cacheWrite5m: 200_000,
    });

    const outcome = b1Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("INACTIVE");
    expect(outcome.fired).toHaveLength(0);
  });

  it("fires on a prefix break that the old reads-fell-10x rule missed (context under 300k)", () => {
    // 100k context; the ~30k system prefix still reads, so reads only fall to 30% of before.
    addTurn("b1-small-prior", "2027-01-02T00:00:00.000Z", 100_000, { cacheWrite5m: 1_000 });
    addTurn("b1-small-current", "2027-01-02T00:02:00.000Z", 30_000, { cacheWrite5m: 71_000 });
    const outcome = b1Detector.evaluate(db, CTX);
    expect(outcome.fired).toHaveLength(1);
    const metrics = outcome.fired[0]?.payload.metrics as Record<string, { value: number }>;
    expect(metrics.COLLAPSE_EVENT_COUNT?.value).toBe(1);
    expect(metrics.RAPID_COLLAPSE_COUNT?.value).toBe(1);
  });

  it("drops an event under 0.1% of the workspace's 7-day spend", () => {
    addTurn("b1-floor-prior", "2027-01-02T00:00:00.000Z", 100_000, { cacheWrite5m: 1_000 });
    addTurn("b1-floor-current", "2027-01-02T00:02:00.000Z", 30_000, { cacheWrite5m: 71_000 });
    // Event = 71,000 tokens * 3.45 µ$ = 244,950 µ$. Spend of 1e9 µ$ makes that 0.024%.
    db.prepare(
      "UPDATE turns SET cost_equiv_u = 1000000000 WHERE message_id = 'b1-floor-prior'",
    ).run();
    expect(b1Detector.evaluate(db, CTX).fired).toHaveLength(0);
    // Spend of 1e8 µ$ makes it 0.245%: kept.
    db.prepare(
      "UPDATE turns SET cost_equiv_u = 100000000 WHERE message_id = 'b1-floor-prior'",
    ).run();
    expect(b1Detector.evaluate(db, CTX).fired).toHaveLength(1);
  });

  it("excludes sidechain turns from both findings and the main-chain predecessor sequence", () => {
    addTurn("b1-main-prior", "2027-01-02T00:00:00.000Z", 30_000);
    addTurn("b1-sidechain", "2027-01-02T00:01:00.000Z", 0, { sidechain: true });
    addTurn("b1-main-current", "2027-01-02T00:02:00.000Z", 2_000, { cacheWrite5m: 30_000 });

    const outcome = b1Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.payload.anchors.map((anchor) => anchor.message_id)).toEqual([
      findingIds.message("b1-main-prior"),
      findingIds.message("b1-main-current"),
    ]);
  });

  it("leaves idle-expiry collapses (gap > thread TTL) to B2/D8", () => {
    // Thread writes 1h tier → TTL 60 min. A 61-min gap is idle expiry, not B1.
    addTurn("b1-idle-prior", "2027-01-02T00:00:00.000Z", 30_000, { cacheWrite1h: 1_000 });
    addTurn("b1-idle-current", "2027-01-02T01:01:00.000Z", 2_000, { cacheWrite1h: 30_000 });
    expect(b1Detector.evaluate(db, CTX).fired).toHaveLength(0);
  });

  it("takes the TTL from the thread's prior write tier, not the collapse turn's", () => {
    // Prior tier 5m → TTL 5 min; the collapse turn writing 1h does not stretch it.
    addTurn("b1-tier-prior", "2027-01-02T00:00:00.000Z", 30_000, { cacheWrite5m: 1_000 });
    addTurn("b1-tier-current", "2027-01-02T00:10:00.000Z", 2_000, { cacheWrite1h: 30_000 });
    expect(b1Detector.evaluate(db, CTX).fired).toHaveLength(0);

    // Same shape at a 60-min gap after a 1h-tier thread is in-TTL.
    addTurn("b1-tier-1h-prior", "2027-01-03T00:00:00.000Z", 30_000, { cacheWrite1h: 1_000 });
    addTurn("b1-tier-1h-current", "2027-01-03T01:00:00.000Z", 2_000, { cacheWrite1h: 30_000 });
    const fired = b1Detector.evaluate(db, CTX).fired;
    expect(fired).toHaveLength(1);
    expect(fired[0]?.payload.anchors.map((anchor) => anchor.message_id)).toEqual([
      findingIds.message("b1-tier-1h-prior"),
      findingIds.message("b1-tier-1h-current"),
    ]);
  });
});
