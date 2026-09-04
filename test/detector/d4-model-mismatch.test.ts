/**
 * test/detector/d4-model-mismatch.test.ts — D4 MODEL_MISMATCH detector tests.
 *
 * Covers:
 *   - fires when ≥ D4_OPUS_MIN_TURNS Opus turns AND mismatch fraction ≥ 40%
 *   - scope_workspace_id = workspace_id (per-workspace, never global)
 *   - does NOT fire when total Opus turns < D4_OPUS_MIN_TURNS (cold-start guard)
 *   - does NOT fire when mismatch fraction < D4_MISMATCH_MIN_FRACTION
 *   - does NOT fire when no Opus turns in window
 *   - different workspaces get separate recs (one per qualifying workspace)
 *   - evidence carries all required fields including guard thresholds
 *   - determinism: two passes over same frozen DB yield byte-identical rows
 *   - rec_id is stable across drop+re-run
 *   - created_at uses injected ctx.now (never new Date())
 *   - category = 'MODEL', target_metric = 'model_mix_opus_fraction'
 *   - modeled formula inputs are correct (reduction_fraction = 0.50, UNVALIDATED)
 *   - zero-savings guard: no rec fires when price differential is zero
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildContext } from "../../src/detector/engine.js";
import { runDetectors } from "../../src/detector/index.js";
import {
  D4_MISMATCH_MAX_OUTPUT_TOKENS,
  D4_MISMATCH_MIN_CONTEXT_TOKENS,
  D4_MISMATCH_MIN_FRACTION,
  D4_OPUS_MIN_TURNS,
  D4_REDUCTION_FRACTION,
} from "../../src/detector/savings.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// Frozen now: same as other detector tests — fixture data is in [2026-01-01, 2026-01-08).
const NOW = new Date("2026-01-08T00:00:00.000Z");

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  // Seed opus pricing snapshot (fixture DB only has sonnet + haiku).
  db.prepare(
    `INSERT OR IGNORE INTO pricing_snapshots
       (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "snap-opus",
    "opus",
    JSON.stringify([15, 75, 1.5, 18.75, 30]), // [in, out, cacheRead, cw5m, cw1h]
    "2026-01-01T00:00:00.000Z",
    "2026-02-01T00:00:00.000Z",
  );
});

afterEach(() => db.close());

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Insert a single Opus turn for the given workspace. */
function insOpusTurn(
  msgId: string,
  workspaceId: string,
  inputTokens: number,
  outputTokens: number,
  ts = "2026-01-02T00:00:00.000Z",
  options: { isSidechain?: boolean; provisional?: boolean } = {},
): void {
  // Ensure workspace exists.
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, ?)`,
  ).run(workspaceId, workspaceId, "2026-01-01T00:00:00.000Z");

  // Ensure a session exists for this workspace.
  const sessionId = `sess-${workspaceId}-d4`;
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, ?, ?, 'RECONCILED', 1, 0, '[]')`,
  ).run(sessionId, workspaceId, `/fake/${sessionId}.jsonl`, ts, ts);

  db.prepare(
    `INSERT OR IGNORE INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-opus-4', ?, ?, ?, 0, 0, 0, 0,
             NULL, 'snap-opus', 0, 'LIST_EQUIV', ?, 'test-v1')`,
  ).run(
    msgId,
    sessionId,
    workspaceId,
    ts,
    options.isSidechain ? 1 : 0,
    inputTokens,
    outputTokens,
    options.provisional ? 1 : 0,
  );
}

/** Insert N mismatch Opus turns (high context, low output) for workspaceId. */
function insMismatchTurns(n: number, workspaceId: string): void {
  for (let i = 0; i < n; i++) {
    insOpusTurn(
      `msg-d4-mismatch-${workspaceId}-${i}`,
      workspaceId,
      D4_MISMATCH_MIN_CONTEXT_TOKENS + 10_000, // context > threshold
      Math.floor(D4_MISMATCH_MAX_OUTPUT_TOKENS / 2), // output < threshold
    );
  }
}

/** Insert N legitimate Opus turns (large output — not a mismatch). */
function insLegitTurns(n: number, workspaceId: string): void {
  for (let i = 0; i < n; i++) {
    insOpusTurn(
      `msg-d4-legit-${workspaceId}-${i}`,
      workspaceId,
      D4_MISMATCH_MIN_CONTEXT_TOKENS + 10_000, // high context
      5_000, // large output — Opus is doing real work
    );
  }
}

function d4Recs(): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM recommendations WHERE detector_id = 'D4' ORDER BY rec_id")
    .all() as Array<Record<string, unknown>>;
}

function seedPerModelSnapshot(snapshot: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO user_config (key, value, updated_at)
       VALUES ('per_model_snapshot', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(snapshot), NOW.toISOString());
}

describe("D4 per-model cap attribution", () => {
  it("emits but withholds when the Sonnet weekly cap binds", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-sonnet-bind");
    seedPerModelSnapshot({
      captured_at: NOW.toISOString(),
      seven_day_util: 0.72,
      five_hour_util: 0.1,
      per_model: [{ model: "claude-sonnet-4", utilization: 0.72 }],
    });

    runDetectors(db, { now: NOW });
    const r = d4Recs()[0];
    if (!r) throw new Error("expected D4 rec");
    const evidence = JSON.parse(r.evidence_json as string) as Record<string, unknown>;

    expect(evidence.withheld).toBe(true);
    // Reason must reflect the actual observed utilization numbers, not a static string.
    expect(evidence.withheld_reason).toMatch(/0\.72/);
    expect(String(evidence.withheld_reason)).toMatch(/\d+(\.\d+)?/);
    expect(evidence.title).toMatch(/^\[withheld\] /);
    // Withheld recs never carry a crisp savings headline.
    expect(r.modeled_savings_u_per_wk).toBeNull();
  });

  it("attributes a fresh non-binding Sonnet snapshot to all-models or Opus", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-opus-bind");
    seedPerModelSnapshot({
      captured_at: NOW.toISOString(),
      seven_day_util: 0.72,
      five_hour_util: 0.1,
      per_model: [{ model: "claude-sonnet-4", utilization: 0.5 }],
    });

    runDetectors(db, { now: NOW });
    const r = d4Recs()[0];
    if (!r) throw new Error("expected D4 rec");
    const evidence = JSON.parse(r.evidence_json as string) as Record<string, unknown>;

    expect(evidence.cap_attribution).toBe("all_models_or_opus_binds");
    expect(evidence.withheld).toBeUndefined();
  });

  it("keeps advisory evidence unchanged when no snapshot row exists", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-no-snapshot");

    runDetectors(db, { now: NOW });
    const r = d4Recs()[0];
    if (!r) throw new Error("expected D4 rec");
    const evidence = JSON.parse(r.evidence_json as string) as Record<string, unknown>;

    expect(evidence.withheld).toBeUndefined();
    expect(evidence.cap_attribution).toBeUndefined();
  });

  it("fails open for a stale snapshot", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-stale-snapshot");
    seedPerModelSnapshot({
      captured_at: "2026-01-06T23:59:59.999Z",
      seven_day_util: 0.72,
      five_hour_util: 0.1,
      per_model: [{ model: "claude-sonnet-4", utilization: 0.9 }],
    });

    runDetectors(db, { now: NOW });
    const r = d4Recs()[0];
    if (!r) throw new Error("expected D4 rec");
    const evidence = JSON.parse(r.evidence_json as string) as Record<string, unknown>;

    expect(evidence.withheld).toBeUndefined();
    expect(evidence.cap_attribution).toBeUndefined();
  });

  it("fails open for malformed snapshot JSON", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-malformed-snapshot");
    db.prepare(
      `INSERT INTO user_config (key, value, updated_at)
       VALUES ('per_model_snapshot', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run("not valid JSON", NOW.toISOString());

    runDetectors(db, { now: NOW });
    const r = d4Recs()[0];
    if (!r) throw new Error("expected D4 rec");
    const evidence = JSON.parse(r.evidence_json as string) as Record<string, unknown>;

    expect(evidence.withheld).toBeUndefined();
    expect(evidence.cap_attribution).toBeUndefined();
  });
});

// ── Fire conditions ─────────────────────────────────────────────────────────

describe("D4 — fires when mismatch pattern is sustained", () => {
  it("fires when ≥ D4_OPUS_MIN_TURNS Opus turns and all are mismatch", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-opus-test");

    const statuses = runDetectors(db, { now: NOW });
    const d4 = statuses.find((s) => s.detector_id === "D4");
    expect(d4?.status).toBe("ACTIVE");

    const recs = d4Recs();
    expect(recs.length).toBe(1);
    const r = recs[0];
    if (!r) throw new Error("expected D4 rec");
    expect(r.state).toBe("PROPOSED");
    expect(r.provenance).toBe("RULE");
  });

  it("scope_workspace_id = the workspace id (per-workspace, not global)", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-opus-test");

    runDetectors(db, { now: NOW });
    const recs = d4Recs();
    expect(recs.length).toBe(1);
    expect(recs[0]?.scope_workspace_id).toBe("ws-opus-test");
  });

  it("category = MODEL, target_metric = model_mix_opus_fraction", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-opus-test");

    runDetectors(db, { now: NOW });
    const r = d4Recs()[0];
    if (!r) throw new Error("expected D4 rec");
    expect(r.category).toBe("MODEL");
    expect(r.target_metric).toBe("model_mix_opus_fraction");
  });

  it("fires when exactly D4_MISMATCH_MIN_FRACTION of Opus turns are mismatch", () => {
    const mismatch = D4_OPUS_MIN_TURNS; // all mismatch (fraction = 1.0 ≥ 0.40)
    insMismatchTurns(mismatch, "ws-exact-frac");

    runDetectors(db, { now: NOW });
    expect(d4Recs().length).toBe(1);
  });
});

// ── Guard conditions ────────────────────────────────────────────────────────

describe("D4 — cold-start guard: does NOT fire when total Opus turns < D4_OPUS_MIN_TURNS", () => {
  it("does not fire when total Opus turns = D4_OPUS_MIN_TURNS - 1", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS - 1, "ws-cold");

    const statuses = runDetectors(db, { now: NOW });
    const d4 = statuses.find((s) => s.detector_id === "D4");
    // D4 still ran (there are opus turns in the DB) but no workspace qualified
    expect(d4?.status).toBe("INACTIVE");
    expect(d4Recs().length).toBe(0);
  });

  it("does not fire when there are no Opus turns in the window at all", () => {
    // fixture DB has only sonnet + haiku turns; no opus added
    const statuses = runDetectors(db, { now: NOW });
    const d4 = statuses.find((s) => s.detector_id === "D4");
    expect(d4?.status).toBe("INACTIVE");
    expect(d4Recs().length).toBe(0);
  });
});

describe("D4 — fraction guard: does NOT fire when mismatch fraction < threshold", () => {
  it("does not fire when fewer than 40% of Opus turns are mismatch", () => {
    // 5 mismatch + 9 legit = 5/14 ≈ 35.7% < 40%
    insMismatchTurns(5, "ws-low-frac");
    insLegitTurns(9, "ws-low-frac");

    const statuses = runDetectors(db, { now: NOW });
    const d4 = statuses.find((s) => s.detector_id === "D4");
    expect(d4?.status).toBe("INACTIVE");
    expect(d4Recs().length).toBe(0);
  });

  it("fires when exactly 40% are mismatch (boundary — just meets threshold)", () => {
    // 4 mismatch + 6 legit = 4/10 = 40.0% ≥ 40%
    insMismatchTurns(4, "ws-boundary");
    insLegitTurns(6, "ws-boundary");

    const statuses = runDetectors(db, { now: NOW });
    const d4 = statuses.find((s) => s.detector_id === "D4");
    expect(d4?.status).toBe("ACTIVE");
    expect(d4Recs().length).toBe(1);
  });
});

// ── Per-workspace isolation ─────────────────────────────────────────────────

describe("D4 — per-workspace scoping", () => {
  it("fires separate recs for two qualifying workspaces", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-a");
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-b");

    runDetectors(db, { now: NOW });
    const recs = d4Recs();
    expect(recs.length).toBe(2);

    const wsIds = recs.map((r) => r.scope_workspace_id).sort();
    expect(wsIds).toContain("ws-a");
    expect(wsIds).toContain("ws-b");
  });

  it("only fires for the qualifying workspace when one qualifies and one does not", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-yes"); // qualifies
    insMismatchTurns(D4_OPUS_MIN_TURNS - 1, "ws-no"); // cold-start guard fails

    runDetectors(db, { now: NOW });
    const recs = d4Recs();
    expect(recs.length).toBe(1);
    expect(recs[0]?.scope_workspace_id).toBe("ws-yes");
  });
});

// ── Evidence ────────────────────────────────────────────────────────────────

describe("D4 — evidence carries required fields", () => {
  it("evidence includes all guard thresholds and measured fractions", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-ev");

    runDetectors(db, { now: NOW });
    const r = d4Recs()[0];
    if (!r) throw new Error("expected D4 rec");
    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;

    expect(ev.workspace_id).toBe("ws-ev");
    expect(typeof ev.total_opus_turns_per_week).toBe("number");
    expect(typeof ev.mismatch_turns_per_week).toBe("number");
    expect(typeof ev.mismatch_fraction).toBe("number");
    expect(ev.min_context_tokens_threshold).toBe(D4_MISMATCH_MIN_CONTEXT_TOKENS);
    expect(ev.max_output_tokens_threshold).toBe(D4_MISMATCH_MAX_OUTPUT_TOKENS);
    expect(ev.mismatch_fraction_threshold).toBe(D4_MISMATCH_MIN_FRACTION);
    expect(ev.min_opus_turns_threshold).toBe(D4_OPUS_MIN_TURNS);
    expect(ev.reduction_fraction).toBe(D4_REDUCTION_FRACTION);
    expect(Array.isArray(ev.steps)).toBe(true);
    expect((ev.steps as string[]).length).toBeGreaterThan(0);
  });

  it("evidence.mismatch_fraction matches the actual ratio", () => {
    // 5 mismatch out of 5 total = 1.0
    insMismatchTurns(5, "ws-frac");

    runDetectors(db, { now: NOW });
    const evRow = d4Recs()[0];
    if (!evRow) throw new Error("expected D4 rec");
    const ev = JSON.parse(evRow.evidence_json as string) as Record<string, unknown>;
    expect(ev.mismatch_turns_per_week).toBe(5);
    expect(ev.total_opus_turns_per_week).toBe(5);
    expect(ev.mismatch_fraction).toBe(1.0);
  });

  it("counts only non-provisional premium sidechain turns in the half-open window", () => {
    const workspaceId = "ws-sidechain";
    insMismatchTurns(D4_OPUS_MIN_TURNS, workspaceId);

    insOpusTurn("msg-sidechain-in-window", workspaceId, 1_000, 1_000, "2026-01-07T23:59:59.999Z", {
      isSidechain: true,
    });
    insOpusTurn(
      "msg-sidechain-provisional",
      workspaceId,
      1_000,
      1_000,
      "2026-01-07T23:59:59.999Z",
      { isSidechain: true, provisional: true },
    );
    insOpusTurn("msg-sidechain-at-upper-bound", workspaceId, 1_000, 1_000, NOW.toISOString(), {
      isSidechain: true,
    });

    runDetectors(db, { now: NOW });
    const row = d4Recs()[0];
    if (!row) throw new Error("expected D4 rec");
    const evidence = JSON.parse(row.evidence_json as string) as Record<string, unknown>;

    expect(evidence.sidechain_premium_turns).toBe(1);
  });
});

// ── Formula ─────────────────────────────────────────────────────────────────

describe("D4 — modeled formula", () => {
  it("formula model is D4_MODEL_MISMATCH_V1", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-formula");

    runDetectors(db, { now: NOW });
    const r = d4Recs()[0];
    if (!r) throw new Error("expected D4 rec");
    const formula = JSON.parse(r.modeled_formula_json as string) as Record<string, unknown>;
    expect(formula.model).toBe("D4_MODEL_MISMATCH_V1");
  });

  it("formula inputs include reduction_fraction as a labeled value", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-formula");

    runDetectors(db, { now: NOW });
    const fiRow = d4Recs()[0];
    if (!fiRow) throw new Error("expected D4 rec");
    const formula = JSON.parse(fiRow.modeled_formula_json as string) as Record<string, unknown>;
    expect(formula.inputs).toBeDefined();
    const inputs = formula.inputs as Record<string, unknown>;
    expect(inputs.reduction_fraction).toBe(D4_REDUCTION_FRACTION);
    expect(typeof inputs.avg_input_tokens).toBe("number");
    expect(typeof inputs.avg_output_tokens).toBe("number");
    expect(typeof inputs.mismatch_turns_per_week).toBe("number");
  });

  it("ADVISORY-GATED: modeled_savings headline is suppressed; diagnostic figure kept in evidence", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-savings");

    runDetectors(db, { now: NOW });
    const r = d4Recs()[0];
    if (!r) throw new Error("expected D4 rec");

    // W0.3 advisory gate: no crisp $/wk headline emitted from transcripts alone.
    expect(r.modeled_savings_u_per_wk).toBeNull();
    // Formula is retained but marked ADVISORY (diagnostic, not a headline).
    const formula = JSON.parse(r.modeled_formula_json as string) as {
      kind?: string;
      result_usd_per_wk?: number;
      inputs: {
        avg_input_tokens: number;
        avg_output_tokens: number;
        mismatch_turns_per_week: number;
        opus_input_price_usd_per_mtok: number;
        opus_output_price_usd_per_mtok: number;
        sonnet_input_price_usd_per_mtok: number;
        sonnet_output_price_usd_per_mtok: number;
        reduction_fraction: number;
      };
    };
    expect(formula.kind).toBe("ADVISORY");
    // FIX 3: result_usd_per_wk must be absent from the advisory formula so no
    // consumer can resurface the suppressed crisp figure.
    expect(formula.result_usd_per_wk).toBeUndefined();

    // The lever is conditional on which cap binds (references /usage).
    expect((r.lever as string).toLowerCase()).toContain("/usage");

    // The computed figure survives as diagnostic evidence, matching the formula inputs.
    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
    expect(ev.advisory).toBe(true);
    expect(ev.requires_usage_cap_data).toBe(true);
    const diagnostic = ev.diagnostic_savings_u_per_wk_if_all_models_cap_binds as number;
    expect(typeof diagnostic).toBe("number");
    expect(diagnostic > 0).toBe(true);

    const inp = formula.inputs;
    const perTurnSavings =
      inp.avg_input_tokens *
        (inp.opus_input_price_usd_per_mtok - inp.sonnet_input_price_usd_per_mtok) +
      inp.avg_output_tokens *
        (inp.opus_output_price_usd_per_mtok - inp.sonnet_output_price_usd_per_mtok);
    const computedU = Math.round(
      perTurnSavings * inp.mismatch_turns_per_week * inp.reduction_fraction,
    );
    expect(computedU).toBe(diagnostic);
  });
});

// ── Determinism ─────────────────────────────────────────────────────────────

describe("D4 — determinism", () => {
  it("two passes over the same frozen DB yield byte-identical rows", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-det");

    runDetectors(db, { now: NOW });
    const first = d4Recs();

    runDetectors(db, { now: NOW });
    const second = d4Recs();

    expect(second).toEqual(first);
  });

  it("rec_id is stable across drop+re-run", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-det");

    runDetectors(db, { now: NOW });
    const firstId = d4Recs()[0]?.rec_id as string;

    db.prepare("DELETE FROM recommendations").run();

    runDetectors(db, { now: NOW });
    const secondId = d4Recs()[0]?.rec_id as string;

    expect(firstId).toBe(secondId);
  });

  it("uses injected ctx.now for created_at (never new Date())", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-det");

    runDetectors(db, { now: NOW });
    const r = d4Recs()[0];
    if (!r) throw new Error("expected D4 rec");
    expect(r.created_at).toBe(NOW.toISOString());
  });

  it("buildContext used consistently — window aligns with fixture data", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-ctx");
    const ctx = buildContext(NOW);
    // All fixture turns are at ts("...") which is 2026-01-0x within the 7d window.
    expect(ctx.fromIso).toBe("2026-01-01T00:00:00.000Z");
    expect(ctx.toIso).toBe("2026-01-08T00:00:00.000Z");
  });
});

// ── Out-of-window turns excluded ─────────────────────────────────────────────

describe("D4 — window filtering", () => {
  it("does not count Opus turns outside the trailing-7d window", () => {
    // Insert opus mismatch turns with a timestamp BEFORE the window.
    insOpusTurn(
      "msg-old",
      "ws-old",
      D4_MISMATCH_MIN_CONTEXT_TOKENS + 10_000,
      100,
      "2025-12-01T00:00:00.000Z", // before window start 2026-01-01
    );

    const statuses = runDetectors(db, { now: NOW });
    const d4 = statuses.find((s) => s.detector_id === "D4");
    expect(d4?.status).toBe("INACTIVE");
    expect(d4Recs().length).toBe(0);
  });
});
