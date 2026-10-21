import { afterEach, describe, expect, it } from "vitest";
import {
  CLAIM_PRODUCERS,
  type Claim,
  type ClaimProducer,
  buildClaimLedger,
  conservationReport,
  ledgerTotals,
} from "../../src/detector/claim-ledger.js";
import { wastedTurnClaims } from "../../src/detector/turn-claim.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const ctx: DetectorContext = {
  now: new Date("2026-01-02T00:00:00.000Z"),
  fromIso: "2026-01-01T00:00:00.000Z",
  toIso: "2026-01-02T00:00:00.000Z",
};
const base: Claim = {
  detectorId: "D1",
  workspaceId: "ws-alpha",
  sessionId: "sess-a1",
  turnKey: "sess-a1|msg-a1-2",
  component: "cacheRead",
  slice: "MEMORY.md",
  tokens: 600,
  recId: "rec-base",
};
const CLEAN = { doubleOwned: [], overbilled: [], overvalued: [] };
const producer = (claim: Claim): ClaimProducer => ({
  detectorId: claim.detectorId,
  produce: () => [claim],
});

describe("claim ledger", () => {
  const dbs: ReturnType<typeof createInMemoryFixtureDb>[] = [];
  const fixture = () => {
    const db = createInMemoryFixtureDb();
    dbs.push(db);
    return db;
  };
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it("resolves priority conflicts regardless of producer order", () => {
    const db = fixture();
    const ledger = buildClaimLedger(db, ctx, [
      producer(base),
      producer({ ...base, detectorId: "C7", tokens: 400 }),
    ]);
    expect(ledger.claims).toMatchObject([{ detectorId: "C7", tokens: 400 }]);
    expect(ledger.rejected).toMatchObject([{ detectorId: "D1" }]);
    expect(conservationReport(ledger)).toEqual(CLEAN);
  });

  it("conflicts wildcard and named slices in either order", () => {
    const db = fixture();
    for (const first of ["*", "MEMORY.md"]) {
      const ledger = buildClaimLedger(db, ctx, [
        producer({ ...base, slice: first, tokens: 100 }),
        producer({
          ...base,
          detectorId: "D2",
          slice: first === "*" ? "MEMORY.md" : "*",
          tokens: 100,
        }),
      ]);
      expect(ledger.claims).toHaveLength(1);
      expect(ledger.rejected).toHaveLength(1);
    }
  });

  it("keeps subordinate claims out of totals and ownership", () => {
    const db = fixture();
    const ledger = buildClaimLedger(db, ctx, [
      producer({
        ...base,
        component: "cw5m",
        tokens: 500,
        derivedFrom: "prefix",
        assumed: true,
      }),
    ]);
    expect(ledger.subordinate).toHaveLength(1);
    expect(ledger.claims).toHaveLength(0);
    expect(
      ledgerTotals(ledger, [{ rec_id: "r", detector_id: "D1", scope_workspace_id: "ws-alpha" }])
        .sum_u,
    ).toBe(0);
  });

  it("caps named slices together at billed tokens and reports the raw overage", () => {
    const db = fixture();
    const ledger = buildClaimLedger(db, ctx, [
      producer(base),
      producer({ ...base, slice: "CLAUDE.md", tokens: 600 }),
    ]);
    expect(ledger.claims.map((claim) => claim.tokens)).toEqual([600, 400]);
    expect(conservationReport(ledger).overbilled).toEqual([
      JSON.stringify(["spend", base.turnKey, "cacheRead"]),
    ]);
  });

  // Spec F2 v2 item 5: a namespace wildcard covers its own namespace only.
  it("treats a namespace wildcard as covering only its namespace", () => {
    const db = fixture();
    const ledger = buildClaimLedger(db, ctx, [
      producer({ ...base, detectorId: "C7", slice: "prefix:*", tokens: 100 }),
      producer({ ...base, slice: "prefix:MEMORY.md", tokens: 100 }),
      producer({ ...base, detectorId: "A1", slice: "result:ev-1", tokens: 100 }),
    ]);
    expect(ledger.claims).toMatchObject([{ detectorId: "C7" }, { detectorId: "A1" }]);
    expect(ledger.rejected).toMatchObject([{ detectorId: "D1" }]);
  });

  it("keeps a claim on an unpriced turn at value 0", () => {
    const db = fixture();
    db.prepare("UPDATE turns SET pricing_snapshot_id = NULL WHERE message_id = 'msg-a1-2'").run();
    const ledger = buildClaimLedger(db, ctx, [producer(base)]);
    expect(ledger.claims).toMatchObject([{ unpriced: true, value_u: 0, tokens: 600 }]);
    expect(ledger.rejected).toHaveLength(0);
  });

  it("evaluates wastedTurnClaims once per ledger build", () => {
    const db = fixture();
    let calls = 0;
    const prepare = db.prepare.bind(db);
    // The D14 query runs exactly once per wastedTurnClaims call.
    db.prepare = ((sql: string) => {
      if (sql.includes("interrupt_classifier_version")) calls++;
      return prepare(sql);
    }) as typeof db.prepare;
    buildClaimLedger(db, ctx);
    expect(calls).toBe(1);
  });

  it("values each component with its turn pricing snapshot", () => {
    const db = fixture();
    const ledger = buildClaimLedger(db, ctx, [
      producer({ ...base, component: "cacheRead", tokens: 1000 }),
      producer({ ...base, component: "cw5m", tokens: 500 }),
    ]);
    expect(ledger.claims.reduce((sum, claim) => sum + claim.value_u, 0)).toBe(2175);
  });

  it("registers C7 and adapts claimed turns to component claims", () => {
    const db = fixture();
    expect(CLAIM_PRODUCERS.map((item) => item.detectorId)).toEqual([
      "C7",
      "C3",
      "C4",
      "C1",
      "C2",
      "C9",
      "D14",
      "D11",
      "C6",
      "C11",
      "D1",
      "D10",
      "A1",
      "D6",
      "A2",
      "D7",
      "D2",
      "D8",
      "B1",
      "B3",
      "D4",
    ]);
    // The fixture has no qualifying C7 cluster, so add a qualifying Bash error run.
    const addEvent = db.prepare(`INSERT INTO tool_events
      (event_id, session_id, ts, tool_name, exit_class, input_hash, bash_command_family)
      VALUES (?, 'sess-a1', ?, 'Bash', 'ERROR', ?, 'BASH_TEST')`);
    const addMeta = db.prepare(`INSERT INTO tool_event_metadata
      (event_id, owner_message_id, block_index, is_test_command) VALUES (?, ?, ?, 1)`);
    // U7: a failure with no kept error text joins no cluster, so each run carries its error.
    const addContent = db.prepare(
      "INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)",
    );
    for (let i = 0; i < 3; i++) {
      const id = `ledger-c7-${i}`;
      addEvent.run(id, `2026-01-01T00:0${i}:00.000Z`, null);
      addMeta.run(id, `msg-a1-${i + 1}`, i);
      addContent.run(
        id,
        JSON.stringify({ command: "node build.js", error: "Exit code 1\nsame failure" }),
      );
    }
    expect([...(wastedTurnClaims(db, ctx).get("C7") ?? [])]).toContain("sess-a1|msg-a1-1");
    const ledger = buildClaimLedger(db, ctx);
    // L8: the claim sits on the recovery turn (msg-a1-2), not the issuing turn. D7's loop
    // matcher excludes the repeat turns (msg-a1-2, msg-a1-3), so msg-a1-1 is the only issuing turn.
    const c7 = ledger.claims.filter((claim) => claim.detectorId === "C7");
    expect(new Set(c7.map((claim) => claim.turnKey))).toEqual(new Set(["sess-a1|msg-a1-2"]));
    expect(c7).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: "input",
          tokens: 2000,
          assumed: true,
          lane: "reliability",
        }),
      ]),
    );
  });

  it("attributes only to matching open recommendations", () => {
    const db = fixture();
    const ledger = buildClaimLedger(db, ctx, [
      producer({ ...base, recId: "r-one", tokens: 100 }),
      producer({ ...base, detectorId: "D2", slice: "other", tokens: 100 }),
    ]);
    const totals = ledgerTotals(ledger, [
      { rec_id: "r-one", detector_id: "D1", scope_workspace_id: "ws-alpha" },
      { rec_id: "r-other", detector_id: "D1", scope_workspace_id: "ws-beta" },
    ]);
    expect(totals.byRec.get("r-one")).toBe(30);
    expect(totals.byDetector.get("D1")).toBe(30);
    expect(totals.sum_u).toBe(30);
  });
});

// Spec F2 amendment (ledger v2). Fixture turn msg-a1-2 bills in=2000 out=400 cacheRead=1000
// cw5m=500 at Sonnet prices [3, 15, 0.3, 3.75, 4.5] µ$/token.
describe("claim ledger v2", () => {
  const dbs: ReturnType<typeof createInMemoryFixtureDb>[] = [];
  const fixture = () => {
    const db = createInMemoryFixtureDb();
    dbs.push(db);
    return db;
  };
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  // A $0 repricing on a priced turn owns nothing, so it cannot starve lower priorities.
  it("values a repricing claim at unit price minus the counterfactual; $0 repricing owns nothing", () => {
    const ledger = buildClaimLedger(fixture(), ctx, [
      producer({
        ...base,
        detectorId: "D8",
        component: "cw5m",
        slice: "cache:*",
        tokens: 500,
        counterfactualPriceU: 0.3,
      }),
      producer({
        ...base,
        detectorId: "D4",
        slice: "model:*",
        tokens: 1000,
        counterfactualPriceU: 5,
      }),
    ]);
    expect(ledger.claims).toMatchObject([
      { detectorId: "D8", tokens: 500, value_u: 500 * (3.75 - 0.3) },
    ]);
    expect(ledger.rejected).toMatchObject([{ detectorId: "D4" }]);
  });

  it("gives a lower priority the tokens a $0 repricing would have taken", () => {
    const ledger = buildClaimLedger(fixture(), ctx, [
      producer({
        ...base,
        detectorId: "D4",
        slice: "model:*",
        counterfactualPriceU: 0.3,
        tokens: 1000,
      }),
      producer({ ...base, detectorId: "D9", slice: "idle:x", tokens: 500 }),
    ]);
    expect(ledger.claims).toMatchObject([{ detectorId: "D9", tokens: 500 }]);
  });

  it("rejects a fraction that rounds to zero tokens", () => {
    const ledger = buildClaimLedger(fixture(), ctx, [
      producer({ ...base, tokens: 1, fraction: 0.4, fractionRange: [0.3, 0.5] }),
    ]);
    expect(ledger.claims).toHaveLength(0);
    expect(ledger.rejected).toHaveLength(1);
  });

  it("does not depend on emission order when one detector emits the same slice twice", () => {
    const a = { ...base, recId: "rec-a", tokens: 400 };
    const b = { ...base, recId: "rec-b", tokens: 900 };
    const run = (claims: Claim[]) =>
      buildClaimLedger(fixture(), ctx, [{ detectorId: "D1", produce: () => claims }]).claims;
    expect(run([a, b])).toEqual(run([b, a]));
  });

  it("reports overbilling by a non-residual wildcard, per lane", () => {
    const ledger = buildClaimLedger(fixture(), ctx, [
      producer({ ...base, detectorId: "D10", slice: "prefix:*", tokens: 999_999 }),
      producer({ ...base, detectorId: "C7", slice: "turn:*", tokens: 1000, lane: "reliability" }),
    ]);
    expect(conservationReport(ledger).overbilled).toEqual([
      JSON.stringify(["spend", base.turnKey, "cacheRead"]),
    ]);
  });

  it("claims the fraction of the request and keeps the raw request", () => {
    const ledger = buildClaimLedger(fixture(), ctx, [
      producer({ ...base, tokens: 601, fraction: 0.5, fractionRange: [0.33, 0.7] }),
    ]);
    expect(ledger.claims).toMatchObject([
      {
        tokens: 301,
        raw_tokens: 601,
        requested_tokens: 301,
        value_u: 301 * 0.3,
        fraction: 0.5,
        fractionRange: [0.33, 0.7],
      },
    ]);
  });

  it("rejects malformed fractions and counterfactual prices", () => {
    const bad: Array<Partial<Claim>> = [
      { fraction: 0 },
      { fraction: 1.5 },
      { fraction: Number.NaN },
      { fraction: 0.5, fractionRange: [0.6, 0.9] },
      { fraction: 0.5, fractionRange: [0.4, 0.3] },
      { fractionRange: [0.4, 0.6] },
      { counterfactualPriceU: -1 },
      { counterfactualPriceU: Number.POSITIVE_INFINITY },
      { assumed: true, fraction: 0.5 },
      { lane: "Spend" as NonNullable<Claim["lane"]> },
      { recId: " " },
      { derivedFrom: "" },
    ];
    for (const fields of bad) {
      const ledger = buildClaimLedger(fixture(), ctx, [producer({ ...base, ...fields })]);
      expect(ledger.claims, JSON.stringify(fields)).toHaveLength(0);
      expect(ledger.rejected, JSON.stringify(fields)).toHaveLength(1);
    }
  }, 30_000); // 12 full ledger builds; times out at 5 s under full-suite load

  it("requires a rec id on spend claims only", () => {
    const { recId: _, ...anonymous } = base;
    const ledger = buildClaimLedger(fixture(), ctx, [
      producer(anonymous),
      producer({ ...anonymous, detectorId: "C7", slice: "turn:*", lane: "reliability" }),
    ]);
    expect(ledger.claims).toMatchObject([{ detectorId: "C7", lane: "reliability" }]);
    expect(ledger.rejected).toMatchObject([{ detectorId: "D1" }]);
  });

  it("allocates each lane separately", () => {
    const ledger = buildClaimLedger(fixture(), ctx, [
      producer({ ...base, detectorId: "C7", slice: "turn:*", tokens: 1000, lane: "reliability" }),
      producer({ ...base, slice: "prefix:MEMORY.md", tokens: 600 }),
    ]);
    expect(ledger.claims).toMatchObject([
      { detectorId: "C7", lane: "reliability", tokens: 1000 },
      { detectorId: "D1", lane: "spend", tokens: 600 },
    ]);
    expect(conservationReport(ledger)).toEqual(CLEAN);
    // Headroom sums the spend lane only: lanes overlap by design.
    const totals = ledgerTotals(ledger, [
      { rec_id: "rec-base", detector_id: "D1", scope_workspace_id: "ws-alpha" },
      { rec_id: "rec-c7", detector_id: "C7", scope_workspace_id: "ws-alpha" },
    ]);
    expect(totals.sum_u).toBe(600 * 0.3);
    expect(totals.byDetector.has("C7")).toBe(false);
  });

  it("gives general claims what specific claims left: removal, then repricing", () => {
    // A1 removes 400 of 1000 read tokens, D2 removes 300 more, D4 reprices the remaining 300.
    const ledger = buildClaimLedger(fixture(), ctx, [
      producer({
        ...base,
        detectorId: "D4",
        slice: "model:*",
        tokens: 1000,
        counterfactualPriceU: 0.1,
      }),
      producer({ ...base, detectorId: "D2", slice: "history:*", tokens: 300 }),
      producer({ ...base, detectorId: "A1", slice: "result:ev-1", tokens: 400 }),
    ]);
    expect(ledger.claims).toMatchObject([
      { detectorId: "A1", tokens: 400, value_u: 400 * 0.3 },
      { detectorId: "D2", tokens: 300, value_u: 300 * 0.3 },
      { detectorId: "D4", tokens: 300, requested_tokens: 1000, value_u: 300 * (0.3 - 0.1) },
    ]);
    expect(ledger.rejected).toHaveLength(0);
    expect(conservationReport(ledger).overvalued).toEqual([]);
  });

  it("reports a cell whose claimed value exceeds its billed value", () => {
    const ledger = buildClaimLedger(fixture(), ctx, [producer(base)]);
    const [entry] = ledger.claims;
    if (entry === undefined) throw new Error("expected a claim");
    entry.value_u = 1000 * 0.3 + 1;
    expect(conservationReport(ledger).overvalued).toEqual([
      JSON.stringify(["spend", base.turnKey, "cacheRead"]),
    ]);
  });

  describe("metamorphic properties over generated claim pools", () => {
    const SPEND = ["D1", "D10", "A1", "A2", "D7", "D12", "D6", "D2", "D8", "B1", "B3", "D4"];
    const sliceFor = (detectorId: string, n: number) =>
      ({ D1: `prefix:p${n}`, D10: `prefix:p${n}`, D12: `return:a${n}`, D2: "history:*" })[
        detectorId
      ] ??
      (["D8", "B1", "B3"].includes(detectorId)
        ? "cache:*"
        : detectorId === "D4"
          ? "model:*"
          : `result:e${n}`);

    /** Deterministic pseudo-random claims over every billed cell of the fixture window. */
    function pool(db: ReturnType<typeof createInMemoryFixtureDb>, seed: number): Claim[] {
      let state = seed;
      const next = () => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state / 2_147_483_648;
      };
      const turns = db
        .prepare(
          `SELECT session_id, message_id, workspace_id, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_5m, cache_write_1h
             FROM turns WHERE ts >= ? AND ts < ? AND provisional = 0`,
        )
        .all(ctx.fromIso, ctx.toIso) as Array<Record<string, string | number>>;
      const columns = {
        input: "input_tokens",
        output: "output_tokens",
        cacheRead: "cache_read_tokens",
        cw5m: "cache_write_5m",
        cw1h: "cache_write_1h",
      } as const;
      const claims: Claim[] = [];
      for (const turn of turns)
        for (const [component, column] of Object.entries(columns)) {
          const billedTokens = Number(turn[column]);
          if (billedTokens <= 0) continue;
          for (let i = 0; i < 6; i++) {
            const detectorId = SPEND[Math.floor(next() * SPEND.length)] as string;
            claims.push({
              detectorId,
              workspaceId: String(turn.workspace_id),
              sessionId: String(turn.session_id),
              turnKey: `${turn.session_id}|${turn.message_id}`,
              component: component as Claim["component"],
              slice: sliceFor(detectorId, Math.floor(next() * 3)),
              tokens: 1 + Math.floor(next() * billedTokens * 0.8),
              recId: `rec-${detectorId}`,
              ...(next() < 0.4 ? { fraction: 0.25 + next() * 0.75 } : {}),
              ...(next() < 0.3 ? { counterfactualPriceU: next() * 4 } : {}),
            });
          }
        }
      return claims;
    }
    const producersFor = (claims: Claim[]): ClaimProducer[] =>
      [...new Set(claims.map((claim) => claim.detectorId))].map((detectorId) => ({
        detectorId,
        produce: () => claims.filter((claim) => claim.detectorId === detectorId),
      }));
    const SEEDS = [1, 7, 42, 1234, 99_991];

    it("keeps each cell's claimed tokens and value within what was billed", () => {
      for (const seed of SEEDS) {
        const db = fixture();
        const ledger = buildClaimLedger(db, ctx, producersFor(pool(db, seed)));
        expect(ledger.claims.length, `seed ${seed}`).toBeGreaterThan(0);
        const report = conservationReport(ledger);
        expect(report.doubleOwned, `seed ${seed}`).toEqual([]);
        expect(report.overvalued, `seed ${seed}`).toEqual([]);
        const owned = new Map<string, number>();
        for (const claim of ledger.claims) {
          const cell = JSON.stringify([claim.turnKey, claim.component]);
          owned.set(cell, (owned.get(cell) ?? 0) + claim.tokens);
        }
        for (const [cell, tokens] of owned)
          expect(tokens, cell).toBeLessThanOrEqual(ledger.billed.get(cell) ?? 0);
      }
    });

    it("gives a duplicated producer nothing", () => {
      for (const seed of SEEDS) {
        const db = fixture();
        const producers = producersFor(pool(db, seed));
        const once = buildClaimLedger(db, ctx, producers);
        for (const duplicate of producers) {
          const twice = buildClaimLedger(db, ctx, [...producers, duplicate]);
          expect(twice.claims, `${seed} ${duplicate.detectorId}`).toEqual(once.claims);
        }
      }
    });

    it("never changes higher-priority claims when a lower-priority producer is dropped", () => {
      for (const seed of SEEDS) {
        const db = fixture();
        const producers = producersFor(pool(db, seed));
        const full = buildClaimLedger(db, ctx, producers);
        for (const dropped of producers) {
          const rank = SPEND.indexOf(dropped.detectorId);
          const higher = (claims: typeof full.claims) =>
            claims.filter((claim) => SPEND.indexOf(claim.detectorId) < rank);
          const without = buildClaimLedger(
            db,
            ctx,
            producers.filter((item) => item !== dropped),
          );
          expect(higher(without.claims), `${seed} drop ${dropped.detectorId}`).toEqual(
            higher(full.claims),
          );
        }
      }
    });
  });
});
