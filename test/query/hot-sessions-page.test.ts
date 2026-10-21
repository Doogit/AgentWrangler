import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { c1FindingDescriptor } from "../../src/detector/detectors/c1_tool_error_rate.js";
import { createFindingEnvelopeV2, findingIds } from "../../src/detector/privacy-contract.js";
import {
  type HotSessionsPageQuery,
  getHotSessionsPage,
  parseHotSessionsPageQuery,
} from "../../src/query/api/hot-sessions.js";
import { getSessionDrivers } from "../../src/query/api/session-drivers.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { seedValidatedRecommendation } from "../fixtures/recommendations.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  setQueryDb(db);
  for (const ws of ["ws-a", "ws-b"]) {
    db.prepare(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')",
    ).run(ws, ws);
  }
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

function session(id: string, ws = "ws-a", title: string | null = null): void {
  db.prepare(
    "INSERT INTO sessions (session_id, workspace_id, file_path, state, title) VALUES (?, ?, 'fixture', 'RECONCILED', ?)",
  ).run(id, ws, title);
}

function turn(
  id: string,
  sessionId: string,
  ts: string,
  costU: number,
  extra: {
    model?: string;
    input?: number;
    cacheRead?: number;
    cacheWrite5m?: number;
    sidechain?: boolean;
    ws?: string;
  } = {},
): void {
  db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version, cost_equiv_u,
       input_tokens, cache_read_tokens, cache_write_5m, is_sidechain)
     VALUES (?, ?, ?, ?, ?, 'fixture-parser', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sessionId,
    extra.ws ?? "ws-a",
    ts,
    extra.model ?? "model-a",
    costU,
    extra.input ?? 0,
    extra.cacheRead ?? 0,
    extra.cacheWrite5m ?? 0,
    extra.sidechain ? 1 : 0,
  );
}

function ids(query: HotSessionsPageQuery = {}): string[] {
  return getHotSessionsPage(query).rows.map((row) => row.session_id);
}

it("orders the page by subagent cost in either direction", () => {
  session("main-only");
  session("side-small");
  session("side-big");
  turn("main", "main-only", "2025-01-01T00:00:00.000Z", 90_000_000);
  turn("small", "side-small", "2025-01-01T00:00:00.000Z", 2_000_000, { sidechain: true });
  turn("big", "side-big", "2025-01-01T00:00:00.000Z", 7_000_000, { sidechain: true });
  expect(ids({ sort: "subagent", direction: "desc" })).toEqual([
    "side-big",
    "side-small",
    "main-only",
  ]);
  expect(ids({ sort: "subagent", direction: "asc" })).toEqual([
    "main-only",
    "side-small",
    "side-big",
  ]);
  expect(parseHotSessionsPageQuery(new URLSearchParams("sort=subagent&direction=desc")).sort).toBe(
    "subagent",
  );
});

function c1Anchor(sessionId: string, recId: string, timestamp: string): void {
  const envelope = createFindingEnvelopeV2(
    {
      version: 2,
      rule_id: c1FindingDescriptor.rule_id,
      label: "TOOL_ERROR_RATE_OUTLIER",
      assessment: c1FindingDescriptor.defaults.assessment,
      routing: c1FindingDescriptor.defaults.routing,
      window: { from: "2024-12-31T00:00:00.000Z", to: "2025-01-02T00:00:00.000Z" },
      anchors: [{ session_id: findingIds.session(sessionId), timestamp }],
      impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
      verdict: { value: "SUPPORTED", method: "RULE" },
      metrics: {
        TOOL_CALL_COUNT: { kind: "COUNT", value: 10 },
        TOOL_ERROR_COUNT: { kind: "COUNT", value: 2 },
        TOOL_ERROR_RATE: { kind: "RATIO", value: 0.2 },
        CORPUS_CALL_COUNT: { kind: "COUNT", value: 20 },
        CORPUS_ERROR_COUNT: { kind: "COUNT", value: 2 },
        CORPUS_ERROR_RATE: { kind: "RATIO", value: 0.1 },
        RATE_MULTIPLE: { kind: "NUMBER", value: 2 },
      },
    },
    c1FindingDescriptor,
  );
  db.prepare(`INSERT INTO recommendations
    (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
     modeled_formula_json, evidence_json, target_metric, state, created_at,
     contract_version, contract_status, rule_id)
    VALUES (?, 'RULE', 'C1', ?, 'ws-a', ?, '{}', ?, ?, 'DISMISSED',
     '2025-01-01T00:00:00.000Z', 2, 'V2_VALIDATED', ?)`).run(
    recId,
    c1FindingDescriptor.presentation.category,
    c1FindingDescriptor.presentation.lever,
    JSON.stringify(envelope),
    c1FindingDescriptor.presentation.target_metric,
    c1FindingDescriptor.rule_id,
  );
}

/** D2 + D7 recs attributing `sess-loop`; D7 flags turns 1–3 (6.0 $), D2 flags turn 3 (3.0 $). */
function loopFixture(): void {
  session("sess-loop");
  const common = { workspace_id: "ws-a", session_ids: ["sess-loop"], session_count: 1 };
  seedValidatedRecommendation(db, {
    recId: "rec-d2",
    templateId: "D2_LONG_FULL_CONTEXT",
    scope: "ws-a",
    savings: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    facts: {
      session_ids: ["sess-loop"],
      qualifying_session_count: 1,
      qualifying_turn_count: 1,
      raw_context_average_tokens_per_turn: 190_000,
      cap_weighted_burn_tokens_per_week: 1,
      cache_read_tokens_per_week: 0,
      cap_read_coefficient: 0,
    },
  });
  seedValidatedRecommendation(db, {
    recId: "rec-d7",
    templateId: "D7_RETRY_LOOP",
    scope: "ws-a",
    savings: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    facts: {
      ...common,
      loop_flagged_event_count: 3,
      loop_flagged_turn_count: 3,
      repeat_excess_event_count: 2,
      repeat_excess_turn_count: 2,
      total_turn_count: 4,
      loop_flagged_turn_share: 0.75,
      owner_turn_metadata_coverage: 1,
      owner_turn_metadata_covered_event_count: 3,
      owner_turn_metadata_denominator_event_count: 3,
      identical_call_event_count: 3,
      test_fail_event_count: 0,
      redundant_read_event_count: 0,
      three_gram_loop_event_count: 0,
      error_loop_event_count: 0,
      edit_without_prior_read_event_count: 0,
      owner_turn_metadata_coverage_floor: 0.8,
      friction_signals_suppressed_below_coverage_floor: false,
      repeat_excess_turn_cap_weighted_tokens: 1,
    },
  });
  turn("loop-1", "sess-loop", "2026-01-10T10:00:00.000Z", 1_000_000, { input: 1_000 });
  turn("loop-2", "sess-loop", "2026-01-10T10:10:00.000Z", 2_000_000, { input: 1_000 });
  turn("loop-3", "sess-loop", "2026-01-10T10:20:00.000Z", 3_000_000, { input: 190_000 });
  turn("loop-4", "sess-loop", "2026-01-10T10:30:00.000Z", 4_000_000, { input: 1_000 });
  for (const [eventId, owner, ts] of [
    ["event-1", "loop-1", "2026-01-10T10:01:00.000Z"],
    ["event-2", "loop-2", "2026-01-10T10:11:00.000Z"],
    ["event-3", "loop-3", "2026-01-10T10:21:00.000Z"],
  ]) {
    db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_hash) VALUES (?, 'sess-loop', ?, 'Glob', 'synthetic-hash')",
    ).run(eventId, ts);
    db.prepare(
      "INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command) VALUES (?, ?, 0, 0)",
    ).run(eventId, owner);
  }
}

describe("getHotSessionsPage", () => {
  it("pages every session exactly once with offset cursors", () => {
    for (let i = 0; i < 5; i++) {
      session(`sess-${i}`);
      turn(`t-${i}`, `sess-${i}`, "2026-01-02T00:00:00.000Z", 1_000 * (i + 1));
    }
    const p1 = getHotSessionsPage({ limit: 2 });
    const p2 = getHotSessionsPage({ limit: 2, cursor: p1.next_cursor ?? "" });
    const p3 = getHotSessionsPage({ limit: 2, cursor: p2.next_cursor ?? "" });
    expect([p1.next_cursor, p2.next_cursor, p3.next_cursor]).toEqual(["2", "4", null]);
    const all = [...p1.rows, ...p2.rows, ...p3.rows].map((row) => row.session_id);
    expect(all).toEqual(["sess-4", "sess-3", "sess-2", "sess-1", "sess-0"]);
  });

  it("computes whole-session aggregates, title and active vs wall time", () => {
    session("sess-agg", "ws-a", "Test session A");
    turn("agg-1", "sess-agg", "2026-01-02T00:00:00.000Z", 100, { input: 800, cacheRead: 200 });
    turn("agg-2", "sess-agg", "2026-01-02T00:02:00.000Z", 200, {
      input: 2_500,
      cacheRead: 500,
      sidechain: true,
    });
    // 20-minute gap (> 300 s) is idle: counted in wall time, not active time.
    turn("agg-3", "sess-agg", "2026-01-02T00:22:00.000Z", 300, { input: 100 });
    const [row] = getHotSessionsPage().rows;
    expect(row).toMatchObject({
      session_id: "sess-agg",
      title: "Test session A",
      turns: 3,
      cost_equiv_u: 600,
      max_context_tokens: 3_000,
      sum_cache_read_tokens: 700,
      total_context_tokens: 4_100,
      sidechain_cost_u: 200,
      wall_time_s: 1_320,
      issues: { top_driver: null, categories: [] },
    });
    expect(row?.active_time_s).toBeCloseTo(120, 0);
  });

  it("date range selects overlapping sessions and keeps full-session cost", () => {
    session("sess-span");
    turn("span-1", "sess-span", "2026-01-01T00:00:00.000Z", 100);
    turn("span-2", "sess-span", "2026-01-05T00:00:00.000Z", 200);
    session("sess-old");
    turn("old-1", "sess-old", "2025-12-01T00:00:00.000Z", 999);
    const page = getHotSessionsPage({
      window: { from: "2026-01-03T00:00:00.000Z", to: "2026-01-10T00:00:00.000Z" },
    });
    expect(page.rows.map((row) => [row.session_id, row.cost_equiv_u])).toEqual([
      ["sess-span", 300],
    ]);
    expect(ids()).toEqual(["sess-old", "sess-span"]);
  });

  it("filters by workspace, model (whole session), and literal id prefix", () => {
    session("ab_one");
    turn("ab1", "ab_one", "2026-01-02T00:00:00.000Z", 10);
    session("abXtwo", "ws-b");
    turn("ab2", "abXtwo", "2026-01-02T00:00:00.000Z", 20, { ws: "ws-b", model: "model-b" });
    turn("ab3", "abXtwo", "2026-01-02T00:01:00.000Z", 5, { ws: "ws-b" });
    expect(ids({ workspace: "ws-b" })).toEqual(["abXtwo"]);
    expect(ids({ q: "ab_" })).toEqual(["ab_one"]);
    expect(ids({ q: "ab" })).toEqual(["abXtwo", "ab_one"]);
    const byModel = getHotSessionsPage({ model: "model-b" }).rows;
    expect(byModel.map((row) => [row.session_id, row.cost_equiv_u])).toEqual([["abXtwo", 25]]);
  });

  it("category chips use all-time anchors of any state and the filter is OR", () => {
    session("sess-err");
    turn("err-1", "sess-err", "2026-01-02T00:00:00.000Z", 10);
    session("sess-clean");
    turn("clean-1", "sess-clean", "2026-01-02T00:00:00.000Z", 20);
    c1Anchor("sess-err", "rec-c1-old", "2024-01-01T00:00:00.000Z");
    const rows = getHotSessionsPage().rows;
    expect(rows.find((row) => row.session_id === "sess-err")?.issues.categories).toEqual([
      "errors",
    ]);
    expect(rows.find((row) => row.session_id === "sess-clean")?.issues.categories).toEqual([]);
    expect(ids({ category: ["errors"] })).toEqual(["sess-err"]);
    expect(ids({ category: ["loops", "errors"] })).toEqual(["sess-err"]);
    expect(ids({ category: ["loops"] })).toEqual([]);
  });

  it("top driver equals the drivers endpoint max session cost; sort=issues puts nulls last", () => {
    loopFixture();
    session("sess-big");
    turn("big-1", "sess-big", "2026-01-11T00:00:00.000Z", 50_000_000);
    const loop = getHotSessionsPage().rows.find((row) => row.session_id === "sess-loop");
    const detail = getSessionDrivers(db, "sess-loop").data?.drivers ?? [];
    const maxCost = Math.max(...detail.map((driver) => driver.session_cost_u ?? 0));
    expect(maxCost).toBe(6_000_000);
    expect(loop?.issues.top_driver).toEqual({
      detector_id: "D7",
      label: "LOOP_RETRY_WASTE",
      session_cost_u: maxCost,
    });
    expect(ids()).toEqual(["sess-big", "sess-loop"]);
    expect(ids({ sort: "issues" })).toEqual(["sess-loop", "sess-big"]);
    expect(ids({ sort: "issues", direction: "asc" })).toEqual(["sess-loop", "sess-big"]);
    const paged = getHotSessionsPage({ sort: "issues", limit: 1 });
    expect(paged.next_cursor).toBe("1");
    expect(getHotSessionsPage({ sort: "issues", limit: 1, cursor: "1" }).rows[0]?.session_id).toBe(
      "sess-big",
    );
  });
});

describe("parseHotSessionsPageQuery", () => {
  it("rejects invalid controls", () => {
    for (const query of [
      "category=private",
      "from=not-a-date",
      "from=2026-01-05&to=2026-01-01",
      "q=%25",
      "q=a%20b",
      "cursor=abc",
      "cursor=-1",
      "limit=0",
      "limit=201",
      "limit=abc",
      "sort=driver_cost",
      "direction=up",
    ]) {
      expect(() => parseHotSessionsPageQuery(new URLSearchParams(query)), query).toThrow(
        RangeError,
      );
    }
  });

  it("parses repeatable and comma-separated categories and date-only bounds", () => {
    const parsed = parseHotSessionsPageQuery(
      new URLSearchParams("category=loops,errors&category=denials&from=2026-01-01&limit=200"),
    );
    expect(parsed.category).toEqual(["loops", "errors", "denials"]);
    expect(parsed.window?.from).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.limit).toBe(200);
  });
});
