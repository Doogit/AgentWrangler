/**
 * test/detector/measurement.test.ts — W4 measurement pass (design §7b, §7c).
 *
 * Covers: D1 realized-signal verdicts (EFFECTIVE / NO_EFFECT / INCONCLUSIVE),
 * the after_value ≠ modeled_savings honesty rail, threshold boundary cases
 * (−5% exclusive), D2 floor-context signal + EXPERIMENTAL qualification,
 * D5 skip behavior, and unknown target_metric staying MEASURING.
 * In-memory fixture DB; adoptRecommendation drives the baseline snapshot.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_WORKSPACE_ID } from "../../src/detector/context-probe.js";
import {
  isD1SourceBackedRecommendation,
  parseD1SourceIdentity,
} from "../../src/detector/d1-source-identity.js";
import {
  AFTER_WINDOW_DAYS,
  MIN_SETTLING_DAYS,
  runMeasurementPass,
} from "../../src/detector/measurement.js";
import { listLedger } from "../../src/query/api/recommendations-ledger.js";
import { adoptRecommendation } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Fixed base instant: 2026-06-15T00:00:00Z — far from the fixture DB's own
// seeded sessions (2026-01-01) so D2 window aggregates only see test-seeded rows.
const T0 = Date.UTC(2026, 5, 15);

let db: Database.Database;

beforeEach(() => {
  vi.restoreAllMocks();
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

function insertProposedRec(
  recId: string,
  opts: {
    detectorId: string;
    category?: string;
    scopeWorkspaceId?: string | null;
    evidence?: Record<string, unknown>;
    targetMetric?: string;
    modeledSavings?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, analysis_run_id, category, scope_workspace_id,
        lever, modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
        state, created_at)
     VALUES (?, 'RULE', ?, NULL, ?, ?, 'test lever', ?, '{}', ?, ?, 'PROPOSED', ?)`,
  ).run(
    recId,
    opts.detectorId,
    opts.category ?? "CONTEXT",
    opts.scopeWorkspaceId ?? null,
    opts.modeledSavings ?? null,
    JSON.stringify(opts.evidence ?? {}),
    opts.targetMetric ?? "avg_context_per_turn",
    new Date(T0).toISOString(),
  );
}

function insertHistoryRow(o: {
  workspaceId: string;
  component: string;
  fileRef: string;
  hash: string;
  tokens: number;
  observedAtMs: number;
}): void {
  db.prepare(
    `INSERT INTO context_inventory_history
       (workspace_id, component, file_ref, file_hash, tokens, attribution_version, observed_at)
     VALUES (?, ?, ?, ?, ?, 'chars4-v1', ?)`,
  ).run(
    o.workspaceId,
    o.component,
    o.fileRef,
    o.hash,
    o.tokens,
    new Date(o.observedAtMs).toISOString(),
  );
}

function effectRow(recId: string) {
  return db
    .prepare(
      `SELECT before_from, before_to, after_from, after_to,
              before_value, after_value, delta_pct, verdict
         FROM recommendation_effects WHERE rec_id = ?`,
    )
    .get(recId) as
    | {
        before_from: string;
        before_to: string;
        after_from: string;
        after_to: string;
        before_value: number | null;
        after_value: number | null;
        delta_pct: number | null;
        verdict: string | null;
      }
    | undefined;
}

describe("D1 source identity compatibility", () => {
  it("parses the exact component/file_ref tuple without tightening string validity", () => {
    expect(
      parseD1SourceIdentity(
        JSON.stringify({ component: "CLAUDE_MD", file_ref: "/fake/CLAUDE.md", extra: true }),
      ),
    ).toEqual({ component: "CLAUDE_MD", fileRef: "/fake/CLAUDE.md" });
    expect(parseD1SourceIdentity('{"component":"","file_ref":""}')).toEqual({
      component: "",
      fileRef: "",
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["JSON null", "null"],
    ["an array", "[]"],
    ["a missing field", '{"component":"CLAUDE_MD"}'],
    ["a non-string field", '{"component":"CLAUDE_MD","file_ref":42}'],
  ])("returns null for %s", (_label, evidenceJson) => {
    expect(parseD1SourceIdentity(evidenceJson)).toBeNull();
  });

  it("classifies detector D1 and the legacy CONTEXT_TOKENS target as source-backed", () => {
    expect(isD1SourceBackedRecommendation({ detector_id: "D1", target_metric: "anything" })).toBe(
      true,
    );
    expect(
      isD1SourceBackedRecommendation({
        detector_id: "legacy",
        target_metric: "CONTEXT_TOKENS:CLAUDE_MD:/fake/CLAUDE.md",
      }),
    ).toBe(true);
    expect(
      isD1SourceBackedRecommendation({ detector_id: "D2", target_metric: "avg_context_per_turn" }),
    ).toBe(false);
  });
});

function recState(recId: string): string | undefined {
  const row = db.prepare("SELECT state FROM recommendations WHERE rec_id = ?").get(recId) as
    | { state: string }
    | undefined;
  return row?.state;
}

/** Standard D1 scenario: CLAUDE_MD source on ws-alpha with a pre-adoption history row. */
function seedD1Rec(recId: string, baselineTokens: number, adoptedMs: number): void {
  insertHistoryRow({
    workspaceId: "ws-alpha",
    component: "CLAUDE_MD",
    fileRef: "/fake/CLAUDE.md",
    hash: "hash-baseline",
    tokens: baselineTokens,
    observedAtMs: adoptedMs - MS_PER_DAY,
  });
  insertProposedRec(recId, {
    detectorId: "D1",
    scopeWorkspaceId: "ws-alpha",
    evidence: { component: "CLAUDE_MD", file_ref: "/fake/CLAUDE.md" },
    modeledSavings: 500_000_000,
  });
  adoptRecommendation(recId, adoptedMs);
}

describe("W4 measurement pass — D1 (probe/history signal)", () => {
  it("keeps the global scope and D1 history window/tie boundaries unchanged", () => {
    const adoptedMs = T0;
    const deadlineMs = adoptedMs + AFTER_WINDOW_DAYS * MS_PER_DAY;
    const source = {
      workspaceId: GLOBAL_WORKSPACE_ID,
      component: "CLAUDE_MD",
      fileRef: "/fake/global-CLAUDE.md",
    };
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
       VALUES (?, 'global-measurement-fixture', ?)`,
    ).run(GLOBAL_WORKSPACE_ID, new Date(adoptedMs).toISOString());

    insertHistoryRow({ ...source, hash: "before-tie-1", tokens: 1000, observedAtMs: adoptedMs });
    insertHistoryRow({ ...source, hash: "before-tie-2", tokens: 900, observedAtMs: adoptedMs });
    insertProposedRec("rec-D1-global-bounds", {
      detectorId: "D1",
      scopeWorkspaceId: null,
      evidence: { component: source.component, file_ref: source.fileRef },
    });
    adoptRecommendation("rec-D1-global-bounds", adoptedMs);

    // The after window is (adopted_at, deadline]; exact-adoption is excluded.
    insertHistoryRow({ ...source, hash: "after-from", tokens: 50, observedAtMs: adoptedMs });
    insertHistoryRow({ ...source, hash: "after-tie-1", tokens: 700, observedAtMs: deadlineMs });
    insertHistoryRow({ ...source, hash: "after-tie-2", tokens: 600, observedAtMs: deadlineMs });
    insertHistoryRow({
      ...source,
      hash: "after-deadline",
      tokens: 100,
      observedAtMs: deadlineMs + 1,
    });

    runMeasurementPass(db, new Date(deadlineMs + MS_PER_DAY), { force: true });

    const adoptedIso = new Date(adoptedMs).toISOString();
    const deadlineIso = new Date(deadlineMs).toISOString();
    const eff = effectRow("rec-D1-global-bounds");
    expect(eff).toMatchObject({
      before_from: adoptedIso,
      before_to: adoptedIso,
      after_from: adoptedIso,
      after_to: deadlineIso,
      before_value: 900,
      after_value: 600,
      verdict: "EFFECTIVE",
    });
    expect(recState("rec-D1-global-bounds")).toBe("MEASURED_EFFECTIVE");
  });

  it("measures a legacy CONTEXT_TOKENS target through the D1 handler", () => {
    const adoptedMs = T0;
    insertHistoryRow({
      workspaceId: "ws-alpha",
      component: "CLAUDE_MD",
      fileRef: "/fake/legacy.md",
      hash: "legacy-before",
      tokens: 1000,
      observedAtMs: adoptedMs - MS_PER_DAY,
    });
    insertProposedRec("rec-D1-legacy", {
      detectorId: "legacy",
      scopeWorkspaceId: "ws-alpha",
      evidence: { component: "CLAUDE_MD", file_ref: "/fake/legacy.md" },
      targetMetric: "CONTEXT_TOKENS:CLAUDE_MD:/fake/legacy.md",
    });
    adoptRecommendation("rec-D1-legacy", adoptedMs);
    insertHistoryRow({
      workspaceId: "ws-alpha",
      component: "CLAUDE_MD",
      fileRef: "/fake/legacy.md",
      hash: "legacy-after",
      tokens: 400,
      observedAtMs: adoptedMs + MS_PER_DAY,
    });

    runMeasurementPass(db, new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY), {
      force: true,
    });

    expect(effectRow("rec-D1-legacy")).toMatchObject({
      before_value: 1000,
      after_value: 400,
      verdict: "EFFECTIVE",
    });
    expect(recState("rec-D1-legacy")).toBe("MEASURED_EFFECTIVE");
  });

  it("keeps malformed D1 evidence unmeasurable and closes it INCONCLUSIVE", () => {
    const adoptedMs = T0;
    insertProposedRec("rec-D1-malformed", { detectorId: "D1" });
    db.prepare("UPDATE recommendations SET evidence_json = ? WHERE rec_id = ?").run(
      "{",
      "rec-D1-malformed",
    );
    adoptRecommendation("rec-D1-malformed", adoptedMs);

    runMeasurementPass(db, new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY), {
      force: true,
    });

    expect(effectRow("rec-D1-malformed")).toMatchObject({
      before_value: null,
      after_value: null,
      verdict: "INCONCLUSIVE",
    });
    expect(recState("rec-D1-malformed")).toBe("MEASURED_NO_EFFECT");
  });

  it("computes after_value from the history table and verdict EFFECTIVE when reduction > 5%", () => {
    const adoptedMs = T0;
    seedD1Rec("rec-D1-effective", 1000, adoptedMs);
    // Source trimmed 12h into the after-window: 1000 → 400 (−60%).
    insertHistoryRow({
      workspaceId: "ws-alpha",
      component: "CLAUDE_MD",
      fileRef: "/fake/CLAUDE.md",
      hash: "hash-trimmed",
      tokens: 400,
      observedAtMs: adoptedMs + MS_PER_DAY,
    });

    const result = runMeasurementPass(
      db,
      new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY),
      { force: true },
    );

    expect(result.to_measuring).toBe(1);
    expect(result.verdicts).toBe(1);
    expect(recState("rec-D1-effective")).toBe("MEASURED_EFFECTIVE");
    const eff = effectRow("rec-D1-effective");
    expect(eff?.after_value).toBe(400); // observed history tokens, not a modeled figure
    expect(eff?.verdict).toBe("EFFECTIVE");
    expect(eff?.delta_pct).toBeCloseTo(-60, 5);
  });

  it("returns NO_EFFECT when the reduction is under 5%", () => {
    const adoptedMs = T0;
    seedD1Rec("rec-D1-small", 1000, adoptedMs);
    insertHistoryRow({
      workspaceId: "ws-alpha",
      component: "CLAUDE_MD",
      fileRef: "/fake/CLAUDE.md",
      hash: "hash-tiny",
      tokens: 980, // −2%
      observedAtMs: adoptedMs + MS_PER_DAY,
    });

    runMeasurementPass(db, new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY), {
      force: true,
    });

    expect(recState("rec-D1-small")).toBe("MEASURED_NO_EFFECT");
    expect(effectRow("rec-D1-small")?.verdict).toBe("NO_EFFECT");
  });

  it("returns INCONCLUSIVE when no post-adoption history row arrives within 14 days", () => {
    const adoptedMs = T0;
    seedD1Rec("rec-D1-inconcl", 1000, adoptedMs);

    runMeasurementPass(db, new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY), {
      force: true,
    });

    expect(recState("rec-D1-inconcl")).toBe("MEASURED_NO_EFFECT");
    const eff = effectRow("rec-D1-inconcl");
    expect(eff?.verdict).toBe("INCONCLUSIVE");
    expect(eff?.after_value).toBeNull();
  });

  it("never derives after_value from modeled_savings_u_per_wk", () => {
    const adoptedMs = T0;
    seedD1Rec("rec-D1-honest", 1000, adoptedMs); // modeled_savings = 500_000_000
    insertHistoryRow({
      workspaceId: "ws-alpha",
      component: "CLAUDE_MD",
      fileRef: "/fake/CLAUDE.md",
      hash: "hash-x",
      tokens: 700,
      observedAtMs: adoptedMs + MS_PER_DAY,
    });

    runMeasurementPass(db, new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY), {
      force: true,
    });

    const eff = effectRow("rec-D1-honest");
    expect(eff?.after_value).toBe(700);
    expect(eff?.after_value).not.toBe(500_000_000);
  });

  it("waits MIN_SETTLING_DAYS before entering MEASURING", () => {
    const adoptedMs = T0;
    seedD1Rec("rec-D1-settling", 1000, adoptedMs);

    runMeasurementPass(db, new Date(adoptedMs + Math.floor((MIN_SETTLING_DAYS * MS_PER_DAY) / 2)), {
      force: true,
    });
    expect(recState("rec-D1-settling")).toBe("ADOPTED");

    runMeasurementPass(db, new Date(adoptedMs + Math.floor(MIN_SETTLING_DAYS * MS_PER_DAY * 1.5)), {
      force: true,
    });
    expect(recState("rec-D1-settling")).toBe("MEASURING"); // window still open → stays
  });
});

describe("W4 measurement pass — D1 threshold boundaries (§7c)", () => {
  it("treats delta_pct exactly −5% as NO_EFFECT (threshold is exclusive)", () => {
    const adoptedMs = T0;
    seedD1Rec("rec-D1-boundary", 1000, adoptedMs);
    insertHistoryRow({
      workspaceId: "ws-alpha",
      component: "CLAUDE_MD",
      fileRef: "/fake/CLAUDE.md",
      hash: "hash-b5",
      tokens: 950, // exactly −5%
      observedAtMs: adoptedMs + MS_PER_DAY,
    });

    runMeasurementPass(db, new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY), {
      force: true,
    });
    expect(effectRow("rec-D1-boundary")?.verdict).toBe("NO_EFFECT");
  });

  it("treats delta_pct −5.01% as EFFECTIVE", () => {
    const adoptedMs = T0;
    seedD1Rec("rec-D1-b501", 100000, adoptedMs);
    insertHistoryRow({
      workspaceId: "ws-alpha",
      component: "CLAUDE_MD",
      fileRef: "/fake/CLAUDE.md",
      hash: "hash-b501",
      tokens: 94990, // −5.01%
      observedAtMs: adoptedMs + MS_PER_DAY,
    });

    runMeasurementPass(db, new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY), {
      force: true,
    });
    expect(effectRow("rec-D1-b501")?.verdict).toBe("EFFECTIVE");
  });

  it("returns NO_EFFECT when the source grew (positive delta)", () => {
    const adoptedMs = T0;
    seedD1Rec("rec-D1-grew", 1000, adoptedMs);
    insertHistoryRow({
      workspaceId: "ws-alpha",
      component: "CLAUDE_MD",
      fileRef: "/fake/CLAUDE.md",
      hash: "hash-grew",
      tokens: 1500,
      observedAtMs: adoptedMs + MS_PER_DAY,
    });

    runMeasurementPass(db, new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY), {
      force: true,
    });
    const eff = effectRow("rec-D1-grew");
    expect(eff?.verdict).toBe("NO_EFFECT");
    expect(eff?.delta_pct).toBeCloseTo(50, 5);
  });
});

describe("W4 measurement pass — D2 / D5 / unknown metrics", () => {
  function seedFloorSession(sessionId: string, lastTurnAtMs: number, floorTokens: number): void {
    const iso = new Date(lastTurnAtMs).toISOString();
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
         state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?, 'ws-alpha', ?, ?, ?, 'RECONCILED', 1, 0, '[]')`,
    ).run(sessionId, `/fake/${sessionId}.jsonl`, iso, iso);
    db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
         input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
         cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
         provisional, parser_version)
       VALUES (?, ?, 'ws-alpha', ?, 'claude-sonnet', 0,
         ?, 0, 0, 0, 0, 0, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
    ).run(`msg-${sessionId}`, sessionId, iso, floorTokens);
  }

  it("D2: avg floor context improving > 15% yields EFFECTIVE", () => {
    const adoptedMs = T0;
    // Before-window floors: 3 × 200k.
    for (let i = 0; i < 3; i++) {
      seedFloorSession(`sess-d2-before-${i}`, adoptedMs - (i + 1) * MS_PER_DAY, 200_000);
    }
    insertProposedRec("rec-D2-floor", {
      detectorId: "D2",
      modeledSavings: 800_000_000,
    });
    adoptRecommendation("rec-D2-floor", adoptedMs);
    // After-window floors: 3 × 140k → −30%.
    for (let i = 0; i < 3; i++) {
      seedFloorSession(`sess-d2-after-${i}`, adoptedMs + (i + 1) * MS_PER_DAY, 140_000);
    }

    runMeasurementPass(db, new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY), {
      force: true,
    });

    expect(recState("rec-D2-floor")).toBe("MEASURED_EFFECTIVE");
    const eff = effectRow("rec-D2-floor");
    expect(eff?.verdict).toBe("EFFECTIVE");
    expect(eff?.after_value).toBeCloseTo(140_000, 0);
    // D2 rows are labeled EXPERIMENTAL in the ledger read path.
    const entry = listLedger().data?.entries.find((e) => e.rec_id === "rec-D2-floor");
    expect(entry?.effects[0]?.qualification).toBe("EXPERIMENTAL");
  });

  it("D2: before_n < 3 carries qualification NOT_ENOUGH_DATA in the returned row", () => {
    const adoptedMs = T0;
    seedFloorSession("sess-d2-one", adoptedMs - MS_PER_DAY, 200_000);
    insertProposedRec("rec-D2-few", { detectorId: "D2" });
    adoptRecommendation("rec-D2-few", adoptedMs);
    seedFloorSession("sess-d2-two", adoptedMs + MS_PER_DAY, 100_000);

    runMeasurementPass(db, new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY), {
      force: true,
    });

    const entry = listLedger().data?.entries.find((e) => e.rec_id === "rec-D2-few");
    expect(entry?.effects[0]?.qualification).toBe("NOT_ENOUGH_DATA");
  });

  it("D5 warning-class recs skip the lifecycle entirely (stay ADOPTED, no effect rows)", () => {
    const adoptedMs = T0;
    insertProposedRec("rec-D5-warn", {
      detectorId: "D5",
      category: "LIMIT",
      targetMetric: "forecast_margin",
      modeledSavings: null,
    });
    adoptRecommendation("rec-D5-warn", adoptedMs);

    const result = runMeasurementPass(
      db,
      new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY),
      { force: true },
    );

    expect(recState("rec-D5-warn")).toBe("ADOPTED");
    expect(effectRow("rec-D5-warn")).toBeUndefined();
    expect(result.to_measuring).toBe(0);
  });

  it("unknown target_metric transitions to MEASURING but never closes (logs handler-miss)", () => {
    const adoptedMs = T0;
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    insertProposedRec("rec-DX-unknown", { detectorId: "DX", targetMetric: "some_future_metric" });
    adoptRecommendation("rec-DX-unknown", adoptedMs);

    runMeasurementPass(db, new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY), {
      force: true,
    });

    expect(recState("rec-DX-unknown")).toBe("MEASURING");
    expect(
      infoSpy.mock.calls.some((c) =>
        String(c[0]).includes("no measurement handler for target_metric some_future_metric"),
      ),
    ).toBe(true);
  });
});

describe("W4 measurement pass — D8 cache read/creation ratio (RI9)", () => {
  function ensureCacheSession(): void {
    // OR IGNORE: idempotent per test; the fixture DB is recreated in beforeEach.
    db.prepare(
      `INSERT OR IGNORE INTO sessions (session_id, workspace_id, file_path, first_turn_at,
         last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES ('sess-cache', 'ws-alpha', '/fake/cache.jsonl', ?, ?, 'RECONCILED', 1, 0, '[]')`,
    ).run(new Date(T0).toISOString(), new Date(T0).toISOString());
  }
  function seedCacheTurn(id: string, tsMs: number, read: number, creation: number): void {
    ensureCacheSession();
    db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
         input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
         cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
         provisional, parser_version)
       VALUES (?, 'sess-cache', 'ws-alpha', ?, 'claude-sonnet', 0,
         0, 0, ?, ?, 0, 0, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
    ).run(id, new Date(tsMs).toISOString(), read, creation);
  }

  it("rising read/creation ratio > 15% yields EFFECTIVE with an effect row", () => {
    const adoptedMs = T0;
    // Before window: 3 turns at ratio 1.0 (read=creation=100k).
    for (let i = 0; i < 3; i++) {
      seedCacheTurn(`t-before-${i}`, adoptedMs - (i + 1) * MS_PER_DAY, 100_000, 100_000);
    }
    insertProposedRec("rec-D8-churn", {
      detectorId: "D8",
      category: "CACHE",
      scopeWorkspaceId: "ws-alpha",
      targetMetric: "cache_read_to_creation_ratio",
      modeledSavings: 600_000_000,
    });
    adoptRecommendation("rec-D8-churn", adoptedMs);
    // After window: 3 turns at ratio 2.0 (read=200k, creation=100k) → +100%.
    for (let i = 0; i < 3; i++) {
      seedCacheTurn(`t-after-${i}`, adoptedMs + (i + 1) * MS_PER_DAY, 200_000, 100_000);
    }

    runMeasurementPass(db, new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY), {
      force: true,
    });

    expect(recState("rec-D8-churn")).toBe("MEASURED_EFFECTIVE");
    const eff = effectRow("rec-D8-churn");
    expect(eff?.verdict).toBe("EFFECTIVE");
    expect(eff?.before_value).toBeCloseTo(1.0, 3);
    expect(eff?.after_value).toBeCloseTo(2.0, 3);
    // The realized ratio is NOT the modeled savings figure (honesty rail).
    expect(eff?.after_value).not.toBe(600_000_000);
  });

  it("flat ratio yields NO_EFFECT", () => {
    const adoptedMs = T0;
    for (let i = 0; i < 3; i++) {
      seedCacheTurn(`t-b-${i}`, adoptedMs - (i + 1) * MS_PER_DAY, 100_000, 100_000);
    }
    insertProposedRec("rec-D8-flat", {
      detectorId: "D8",
      category: "CACHE",
      scopeWorkspaceId: "ws-alpha",
      targetMetric: "cache_read_to_creation_ratio",
    });
    adoptRecommendation("rec-D8-flat", adoptedMs);
    for (let i = 0; i < 3; i++) {
      seedCacheTurn(`t-a-${i}`, adoptedMs + (i + 1) * MS_PER_DAY, 100_000, 100_000);
    }

    runMeasurementPass(db, new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY), {
      force: true,
    });

    expect(recState("rec-D8-flat")).toBe("MEASURED_NO_EFFECT");
    expect(effectRow("rec-D8-flat")?.verdict).toBe("NO_EFFECT");
  });

  it("before_n < 3 carries qualification NOT_ENOUGH_DATA in the ledger row", () => {
    const adoptedMs = T0;
    seedCacheTurn("t-solo-before", adoptedMs - MS_PER_DAY, 100_000, 100_000);
    insertProposedRec("rec-D8-few", {
      detectorId: "D8",
      category: "CACHE",
      scopeWorkspaceId: "ws-alpha",
      targetMetric: "cache_read_to_creation_ratio",
    });
    adoptRecommendation("rec-D8-few", adoptedMs);
    seedCacheTurn("t-solo-after", adoptedMs + MS_PER_DAY, 200_000, 100_000);

    runMeasurementPass(db, new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * MS_PER_DAY), {
      force: true,
    });

    const entry = listLedger().data?.entries.find((e) => e.rec_id === "rec-D8-few");
    expect(entry?.effects[0]?.qualification).toBe("NOT_ENOUGH_DATA");
  });
});
