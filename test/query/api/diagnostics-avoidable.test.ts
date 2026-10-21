/**
 * test/query/api/diagnostics-avoidable.test.ts — P4 U8: the real ledger provider behind the
 * Diagnostics Avoidable-spend section (spec 2026-09-29-u8-ledger-swap-spec.md).
 *
 * Expected values are derived by hand from the fixture below, not by running the code.
 * Prices are 1000 µ$ per token, so a claim of N tokens is worth N × 1000 µ$.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HandoffCandidate,
  createHandoffSource,
} from "../../../src/daemon/diagnostics-snapshot.js";
import type { RecsSnapshotService } from "../../../src/daemon/recs-snapshot.js";
import type { Claim, ClaimProducer } from "../../../src/detector/claim-ledger.js";
import { writeLedgerDaily } from "../../../src/detector/ledger-daily.js";
import { findingIds } from "../../../src/detector/privacy-contract.js";
import {
  type AvoidableRow,
  buildDiagnosticsTriage,
} from "../../../src/query/api/diagnostics-triage.js";
import { ledgerDailyProvider } from "../../../src/query/api/ledger-daily-provider.js";
import type { RecommendationsView } from "../../../src/query/api/recommendations.js";
import { buildResponse } from "../../../src/query/envelope.js";
import { migratedMemDb } from "../../ingest/dbutil.js";

const WS = "ws-u8";
// E = 2027-03-01T00:00Z. 7d ledger window = [02-22, 03-01); asOf is 10h later.
const AS_OF = new Date("2027-03-01T10:00:00.000Z");
const E_ISO = "2027-03-01T00:00:00.000Z";
const COST = 100_000_000; // µ$ billed per fixture turn

let db: Database.Database;

function addSession(id: string, title: string | null): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags, title)
     VALUES (?, ?, '/f.jsonl', '2027-02-01T00:00:00.000Z', '2027-03-01T05:00:00.000Z', 'RECONCILED', 0, 0, '[]', ?)`,
  ).run(id, WS, title);
}

function addTurn(session: string, message: string, ts: string, cost = COST): void {
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, tool_result_bytes,
        pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-5', 0, 1000, 1000, 1000, 0, 0, 0, NULL, 'snap-u8', ?, 'LIST_EQUIV', 0, 'v1')`,
  ).run(message, session, WS, ts, cost);
}

const producer = (
  detectorId: string,
  recId: string,
  list: Array<[session: string, message: string, tokens: number]>,
): ClaimProducer => ({
  detectorId,
  produce: (): Claim[] =>
    list.map(([sessionId, message, tokens]) => ({
      detectorId,
      workspaceId: WS,
      sessionId,
      turnKey: `${sessionId}|${message}`,
      component: "cacheRead",
      slice: `${detectorId}.md`,
      tokens,
      recId,
    })),
});

beforeEach(() => {
  db = migratedMemDb();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, 'u8', '2027-01-01T00:00:00.000Z')",
  ).run(WS);
  db.prepare(
    `INSERT INTO pricing_snapshots (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES ('snap-u8', 'sonnet', '[1000,1000,1000,1000,1000]', '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z')`,
  ).run();
  for (const [id, title] of [
    ["s1", "Alpha"],
    ["s2", "Beta"],
    ["s3", "Gamma"],
    ["s4", "Delta"],
    ["s5", "Epsilon"],
  ] as const)
    addSession(id, title);
  // s1: six turns in the window, then one after E (between E and asOf) that must not count.
  for (let i = 0; i < 6; i++) addTurn("s1", `t${i}`, `2027-02-23T0${i + 1}:00:00.000Z`);
  addTurn("s1", "tx", "2027-03-01T05:00:00.000Z", 10 * COST);
  addTurn("s2", "x0", "2027-02-24T01:00:00.000Z");
  addTurn("s3", "y0", "2027-02-25T01:00:00.000Z");
  addTurn("s4", "z0", "2027-02-26T01:00:00.000Z");
  addTurn("s4", "b0", "2027-02-26T02:00:00.000Z");
  // Previous 7d window [02-15, 02-22), and history before it.
  addTurn("s5", "p0", "2027-02-18T01:00:00.000Z");
  addTurn("s5", "old", "2027-02-10T01:00:00.000Z");
  // In [E-7d, E): 10 turns = 1_000_000_000 µ$. In [asOf-7d, asOf): 2_000_000_000.
  writeLedgerDaily(db, AS_OF, [
    // ALWAYS_LOADED_TOO_BIG, one rec: 1000 + 800 + 700 + 300 tokens, plus 200 in the previous window.
    producer("D1", "rec-a", [
      ["s1", "t0", 1000],
      ["s1", "t5", 800],
      ["s2", "x0", 700],
      ["s5", "p0", 200],
    ]),
    producer("D10", "rec-a", [["s2", "x0", 300]]),
    // CONTEXT_TOO_LARGE, one rec, 400 tokens.
    producer("D2", "rec-c", [["s3", "y0", 400]]),
    // MODEL_BIGGER_THAN_NEEDED, one token (far below the fold threshold).
    producer("D4", "rec-d", [["s4", "z0", 1]]),
    // CACHE_REBUILT_MID_SESSION: B1 has a producer, B2 and B4 do not, so PARTIAL.
    producer("B1", "rec-e", [["s4", "b0", 50]]),
  ]);
});
afterEach(() => db.close());

const build = (w: 7 | 14 | 30 = 7, asOf = AS_OF) =>
  buildDiagnosticsTriage(db, w, asOf, { warn: () => {} });
const rowOf = (view: ReturnType<typeof build>, id: string): AvoidableRow | undefined =>
  view.avoidable.causes.find((r) => r.cause_id === id);

describe("Diagnostics Avoidable-spend from the ledger", () => {
  it("a single-rec cause's avoidable_u equals that rec's ledger sum over the window", () => {
    const view = build();
    const rec = db
      .prepare(
        `SELECT SUM(value_u) AS v FROM ledger_daily
          WHERE lane = 'spend' AND rec_id = 'rec-c' AND day >= '2027-02-22' AND day < '2027-03-01'`,
      )
      .get() as { v: number };
    expect(rec.v).toBe(400_000);
    expect(rowOf(view, "CONTEXT_TOO_LARGE")?.avoidable_u).toBe(400_000);
    expect(rowOf(view, "ALWAYS_LOADED_TOO_BIG")?.avoidable_u).toBe(2_800_000);
  });

  it("tile = Σ causes, and tile <= spend over [E-w, E)", () => {
    const view = build();
    const sum = view.avoidable.causes.reduce((t, r) => t + (r.avoidable_u ?? 0), 0);
    expect(view.tiles.avoidable_u).toBe(sum);
    expect(sum).toBe(2_800_000 + 400_000 + 1_000 + 50_000);
    const spend = db
      .prepare(
        "SELECT SUM(cost_equiv_u) AS s FROM turns WHERE ts >= '2027-02-22T00:00:00.000Z' AND ts < ?",
      )
      .get(E_ISO) as { s: number };
    expect(spend.s).toBe(1_000_000_000);
    expect(sum).toBeLessThanOrEqual(spend.s);
    expect(view.tiles.avoidable_through).toBe(E_ISO);
  });

  it("a cause with a producer-less detector reports PARTIAL; D12/D9 stays null", () => {
    const view = build();
    expect(rowOf(view, "CACHE_REBUILT_MID_SESSION")).toMatchObject({
      avoidable_u: 50_000,
      coverage: "PARTIAL",
    });
    expect(rowOf(view, "ALWAYS_LOADED_TOO_BIG")?.coverage).toBe("ALL");
    expect(rowOf(view, "SUBAGENTS_COST_MORE_THAN_RETURN")?.avoidable_u ?? null).toBeNull();
    const figure = ledgerDailyProvider(db)(7, AS_OF).causes.get("SUBAGENTS_COST_MORE_THAN_RETURN");
    expect(figure).toMatchObject({ avoidable_u: null, basis: null, coverage: "PARTIAL" });
  });

  it("the share denominator is [E-w, E) spend, not [asOf-w, asOf)", () => {
    const view = build();
    // The turn between E and asOf makes the asOf-window spend 2e9; only 1e9 counts.
    expect(view.tiles.spend_u).toBe(2_000_000_000);
    expect(rowOf(view, "ALWAYS_LOADED_TOO_BIG")?.share).toBeCloseTo(2_800_000 / 1e9, 12);
    expect(view.tiles.avoidable_share).toBeCloseTo(3_251_000 / 1e9, 12);
  });

  it("folding (<0.5%) and the banner (<1%) switch on with real figures", () => {
    const view = build();
    const rows = view.avoidable.causes;
    expect(rows[0]).toMatchObject({ cause_id: "ALWAYS_LOADED_TOO_BIG", featured: true });
    expect(rows[0]?.folded).toBe(false);
    for (const r of rows.slice(1)) expect(r.folded).toBe(true);
    expect(view.avoidable.banner).toEqual({ not_estimated_count: 0 });
  });

  it("sessions list is the ledger set sorted by $, count matches, not a lower bound", () => {
    const row = rowOf(build(), "ALWAYS_LOADED_TOO_BIG");
    expect(row?.sessions).toEqual([
      { session_id: "s1", title: "Alpha", occurrences: 0, avoidable_u: 1_800_000 },
      { session_id: "s2", title: "Beta", occurrences: 0, avoidable_u: 1_000_000 },
    ]);
    expect(row?.sessions_affected).toBe(2);
    expect(row?.sessions_affected_is_lower_bound).toBe(false);
  });

  it("when uses position_u with weight spend", () => {
    // s1 has 7 turns: t0 -> bucket 0, t5 (index 5) -> floor(5*6/7) = 4. s2 has one turn -> bucket 0.
    expect(rowOf(build(), "ALWAYS_LOADED_TOO_BIG")?.when).toEqual({
      buckets: [2_000_000, 0, 0, 0, 800_000, 0],
      weight: "spend",
      heaviest: "early",
    });
  });

  it("example comes from top_claim with the figure line", () => {
    expect(rowOf(build(), "ALWAYS_LOADED_TOO_BIG")?.example).toEqual({
      session_id: "s1",
      title: "Alpha",
      message_id: "t0",
      turn_index: 0,
      text: null,
      figure_line: "$1.00 avoidable in this turn",
    });
  });

  it("incomplete marks give every figure null and a null avoidable_through", () => {
    const view = build(7, new Date("2027-03-02T10:00:00.000Z"));
    expect(view.tiles.avoidable_u).toBeNull();
    expect(view.tiles.avoidable_share).toBeNull();
    expect(view.tiles.avoidable_through).toBeNull();
    for (const r of view.avoidable.causes) expect(r.avoidable_u).toBeNull();
  });

  it("a DB with no marks builds like the old not-estimated default", () => {
    db.prepare("DELETE FROM ledger_daily_marks").run();
    const view = build();
    expect(view.tiles.avoidable_u).toBeNull();
    expect(view.tiles.avoidable_through ?? null).toBeNull();
  });
});

let seq = 0;
function addV1Finding(detectorId: string, templateId: string, sessionIds: string[]): void {
  db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
        modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric, state,
        created_at, contract_version, template_id, contract_status)
     VALUES (?, 'RULE', ?, 'CONTEXT', ?, 'x', NULL, '{}', ?, 'x', 'PROPOSED', '2027-01-01',
             1, ?, 'V1_VALIDATED')`,
  ).run(
    `rec-v1-${seq++}`,
    detectorId,
    WS,
    JSON.stringify({ version: 1, template_id: templateId, facts: { session_ids: sessionIds } }),
    templateId,
  );
  db.prepare(
    `INSERT INTO detector_week_results
       (detector_id, scope_key, week_start, scope_workspace_id, fired, evaluated_at)
     VALUES (?, ?, '2027-02-22T00:00:00.000Z', ?, 1, '2027-03-01T00:00:00.000Z')`,
  ).run(detectorId, `key-${seq++}`, WS);
}

function addV2Finding(detectorId: string, ruleId: string, session: string, message: string): void {
  const evidence = {
    rule_id: ruleId,
    anchors: [
      {
        session_id: findingIds.session(session),
        timestamp: "2027-02-24T01:00:00.000Z",
        message_id: findingIds.message(message),
      },
    ],
  };
  db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
        modeled_formula_json, evidence_json, target_metric, state, created_at,
        contract_version, rule_id, contract_status)
     VALUES (?, 'RULE', ?, 'CONTEXT', ?, 'x', '{}', ?, 'x', 'PROPOSED', '2027-01-01',
             2, ?, 'V2_VALIDATED')`,
  ).run(`rec-v2-${seq++}`, detectorId, WS, JSON.stringify(evidence), ruleId);
}

describe("U8 review fixes", () => {
  it("avoidable_through is E, also when asOf is exactly E", () => {
    expect(build(7, new Date(E_ISO)).tiles.avoidable_through).toBe(E_ISO);
    expect(build().tiles.avoidable_through).toBe(E_ISO);
  });

  it("figure_line reads 'under $0.01' when the top claim is under half a cent", () => {
    // D4: one token = 1000 µ$.
    expect(rowOf(build(), "MODEL_BIGGER_THAN_NEEDED")?.example?.figure_line).toBe(
      "under $0.01 avoidable in this turn",
    );
    // B1: 50 tokens = 50_000 µ$ stays in dollars.
    expect(rowOf(build(), "CACHE_REBUILT_MID_SESSION")?.example?.figure_line).toBe(
      "$0.05 avoidable in this turn",
    );
  });

  it("sessions tie on $ break by session id in code-point order, not locale order", () => {
    addSession("Bs", "Upper");
    addSession("as", "Lower");
    addTurn("Bs", "q0", "2027-02-27T01:00:00.000Z");
    addTurn("as", "q1", "2027-02-27T02:00:00.000Z");
    writeLedgerDaily(db, AS_OF, [
      producer("D4", "rec-d", [
        ["as", "q1", 100],
        ["Bs", "q0", 100],
      ]),
    ]);
    const ids = rowOf(build(), "MODEL_BIGGER_THAN_NEEDED")?.sessions.map((s) => s.session_id);
    expect(ids).toEqual(["Bs", "as"]);
  });

  it("a mixed sort puts the null-basis D12/D9 row last; only the featured row stays unfolded", () => {
    addV1Finding("D12", "D12_SUBAGENT_OVERSPAWN", ["s2"]);
    const view = build();
    const rows = view.avoidable.causes;
    expect(rows.map((r) => r.cause_id)).toEqual([
      "ALWAYS_LOADED_TOO_BIG",
      "CONTEXT_TOO_LARGE",
      "CACHE_REBUILT_MID_SESSION",
      "MODEL_BIGGER_THAN_NEEDED",
      "SUBAGENTS_COST_MORE_THAN_RETURN",
    ]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((r) => r.featured)).toEqual([true, false, false, false, false]);
    expect(rows.map((r) => r.folded)).toEqual([false, true, true, true, false]);
    expect(rows[4]?.avoidable_u).toBeNull();
    expect(rows[4]?.share).toBeNull();
    expect(view.avoidable.banner).toEqual({ not_estimated_count: 1 });
  });

  it("a ledger row with no claims falls back to the occurrence strip and the finding example", () => {
    // D7 has a ledger producer but no claims: the figure is 0, position_u sums to 0.
    addV2Finding("D7", "D7_CROSS_SESSION_REREAD", "s2", "x0");
    const row = rowOf(build(), "SAME_FILES_REREAD_ACROSS_SESSIONS");
    expect(row?.avoidable_u).toBe(0);
    expect(row?.occurrences).toBe(1);
    expect(row?.when).toEqual({
      buckets: [1, 0, 0, 0, 0, 0],
      weight: "occurrences",
      heaviest: "early",
    });
    expect(row?.example).toMatchObject({ session_id: "s2", message_id: "x0", turn_index: 0 });
    expect(row?.example?.figure_line).toMatch(/context tokens in this turn$/);
  });

  it("14d window: 4-block grid, ledger sums over [E-14d, E), spend-share trend", () => {
    const view = build(14);
    const row = rowOf(view, "ALWAYS_LOADED_TOO_BIG");
    expect(view.tiles.avoidable_through).toBe(E_ISO);
    // The previous-7d claim (s5/p0, 200 tokens) now falls inside [02-15, 03-01).
    expect(row?.avoidable_u).toBe(3_000_000);
    // Spend over [02-15, 03-01): ten turns plus p0 = 1.1e9.
    expect(row?.share).toBeCloseTo(3_000_000 / 1.1e9, 12);
    expect(row?.trend_basis).toBe("spend_share");
    // Earliest turn is 02-10, after E-28d = 02-01: no history, so steady.
    expect(row?.trend).toBe("steady");
  });
});

describe("hand-off headline", () => {
  const cardsStub = (cards: Array<Record<string, unknown>>): RecsSnapshotService => ({
    get: () =>
      Promise.resolve(
        buildResponse({ active: cards } as unknown as RecommendationsView, {
          claim_kind: "OBS_PROXY",
        }),
      ),
    peek: () => ({ state: "cold" }),
    peekCard: () => null,
    coldBuild: () => null,
    invalidate() {},
    revision: () => 0,
    markStale() {},
    stop() {},
  });
  const headlines = async (cards: Array<Record<string, unknown>>) =>
    ((await createHandoffSource(cardsStub(cards), db).get()) as HandoffCandidate[]).map(
      (c) => c.headline_u,
    );

  it("reads allocated_u_per_wk (even null) and falls back only when the field is absent", async () => {
    const base = { detector_id: "D2", evidence: {}, modeled_savings_u_per_wk: 7 };
    expect(
      await headlines([
        { ...base, rec_id: "a", allocated_u_per_wk: 5 },
        { ...base, rec_id: "b", allocated_u_per_wk: null },
        { ...base, rec_id: "c" },
      ]),
    ).toEqual([5, null, 7]);
  });
});
