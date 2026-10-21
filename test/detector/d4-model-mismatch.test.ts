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
  options: { isSidechain?: boolean; provisional?: boolean; agentId?: string } = {},
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
        provisional, parser_version, agent_id)
     VALUES (?, ?, ?, ?, 'claude-opus-4', ?, ?, ?, 0, 0, 0, 0,
             NULL, 'snap-opus', 0, 'LIST_EQUIV', ?, 'test-v1', ?)`,
  ).run(
    msgId,
    sessionId,
    workspaceId,
    ts,
    options.isSidechain ? 1 : 0,
    inputTokens,
    outputTokens,
    options.provisional ? 1 : 0,
    options.agentId ?? null,
  );
}

/** Insert N mismatch turns (high context, low output) from one Opus lookup subagent. */
function insMismatchTurns(n: number, workspaceId: string, agentId = `lookup-${workspaceId}`): void {
  for (let i = 0; i < n; i++) {
    insOpusTurn(
      `msg-d4-mismatch-${agentId}-${i}`,
      workspaceId,
      D4_MISMATCH_MIN_CONTEXT_TOKENS + 10_000, // context > threshold
      Math.floor(D4_MISMATCH_MAX_OUTPUT_TOKENS / 2), // output < threshold
      "2026-01-02T00:00:00.000Z",
      { isSidechain: true, agentId },
    );
  }
}

/** Insert N legitimate turns (large output) from one Opus working subagent. */
function insLegitTurns(n: number, workspaceId: string): void {
  for (let i = 0; i < n; i++) {
    insOpusTurn(
      `msg-d4-legit-${workspaceId}-${i}`,
      workspaceId,
      D4_MISMATCH_MIN_CONTEXT_TOKENS + 10_000, // high context
      5_000, // large output — Opus is doing real work
      "2026-01-02T00:00:00.000Z",
      { isSidechain: true, agentId: `work-${workspaceId}` },
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
    const evidence = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;

    expect(evidence.workspace_id).toBe("ws-sonnet-bind");
    expect(evidence.cap_attribution).toBe("sonnet_binds");
    expect(evidence).not.toHaveProperty("withheld_reason");
    expect(evidence).not.toHaveProperty("title");
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
    const evidence = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;

    expect(evidence.workspace_id).toBe("ws-opus-bind");
    // U7: the cap read is now surfaced in the payload (it was computed and dropped).
    expect(evidence.cap_attribution).toBe("all_models_or_opus_binds");
    expect(evidence.withheld).toBeUndefined();
  });

  it("keeps advisory evidence unchanged when no snapshot row exists", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-no-snapshot");

    runDetectors(db, { now: NOW });
    const r = d4Recs()[0];
    if (!r) throw new Error("expected D4 rec");
    const evidence = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;

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
    const evidence = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;

    expect(evidence.withheld).toBeUndefined();
    expect(evidence.cap_attribution).toBeUndefined();
  });

  it("rec output ignores captured_at (while fresh) and five_hour_util (recs ingest mark relies on this)", () => {
    const evidenceFor = (extra: Record<string, unknown>): string => {
      db.close();
      db = createInMemoryFixtureDb();
      db.prepare(
        `INSERT OR IGNORE INTO pricing_snapshots
           (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
         VALUES ('snap-opus', 'opus', ?, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`,
      ).run(JSON.stringify([15, 75, 1.5, 18.75, 30]));
      insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-mark");
      seedPerModelSnapshot({
        captured_at: NOW.toISOString(),
        seven_day_util: 0.72,
        five_hour_util: 0.1,
        per_model: [{ model: "claude-sonnet-4", utilization: 0.72 }],
        ...extra,
      });
      runDetectors(db, { now: NOW });
      const r = d4Recs()[0];
      if (!r) throw new Error("expected D4 rec");
      return JSON.stringify(r);
    };
    const base = evidenceFor({});
    expect(base).toContain("sonnet_binds");
    expect(evidenceFor({ captured_at: "2026-01-07T06:00:00.000Z", five_hour_util: 0.9 })).toBe(
      base,
    );
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
    const evidence = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;

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
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;

    expect(ev.workspace_id).toBe("ws-ev");
    expect(typeof ev.total_opus_turns_per_week).toBe("number");
    expect(typeof ev.mismatch_turns_per_week).toBe("number");
    expect(typeof ev.mismatch_fraction).toBe("number");
    expect(typeof ev.avg_input_tokens).toBe("number");
    expect(typeof ev.avg_output_tokens).toBe("number");
  });

  it("evidence.mismatch_fraction matches the actual ratio", () => {
    // 5 mismatch out of 5 total = 1.0
    insMismatchTurns(5, "ws-frac");

    runDetectors(db, { now: NOW });
    const evRow = d4Recs()[0];
    if (!evRow) throw new Error("expected D4 rec");
    const ev = JSON.parse(evRow.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.mismatch_turns_per_week).toBe(5);
    expect(ev.total_opus_turns_per_week).toBe(5);
    expect(ev.mismatch_fraction).toBe(1.0);
  });

  it("counts only non-provisional Opus subagents in the half-open window", () => {
    const workspaceId = "ws-sidechain";
    insMismatchTurns(D4_OPUS_MIN_TURNS, workspaceId);

    insOpusTurn("msg-sidechain-in-window", workspaceId, 1_000, 1_000, "2026-01-07T23:59:59.999Z", {
      isSidechain: true,
      agentId: "agent-in-window",
    });
    insOpusTurn(
      "msg-sidechain-provisional",
      workspaceId,
      1_000,
      1_000,
      "2026-01-07T23:59:59.999Z",
      { isSidechain: true, provisional: true, agentId: "agent-provisional" },
    );
    insOpusTurn("msg-sidechain-at-upper-bound", workspaceId, 1_000, 1_000, NOW.toISOString(), {
      isSidechain: true,
      agentId: "agent-upper-bound",
    });

    runDetectors(db, { now: NOW });
    const row = d4Recs()[0];
    if (!row) throw new Error("expected D4 rec");
    const evidence = JSON.parse(row.evidence_json as string).facts as Record<string, unknown>;

    expect(evidence.opus_subagent_count).toBe(2);
    expect(evidence.lookup_subagent_count).toBe(1);
    expect(evidence.total_opus_turns_per_week).toBe(D4_OPUS_MIN_TURNS + 1);
  });
});

/** An Edit tool call in the workspace's D4 session: marks the main thread as an editing session. */
function insEditEvent(workspaceId: string): void {
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name)
     VALUES (?, ?, '2026-01-02T00:00:00.000Z', 'Edit')`,
  ).run(`evt-edit-${workspaceId}`, `sess-${workspaceId}-d4`);
}

describe("D4 — lookup agents (U7: 80% of turns, main thread included)", () => {
  it("ignores main-thread turns in a session that edits files", () => {
    for (let i = 0; i < 20; i++) {
      insOpusTurn(`msg-main-${i}`, "ws-main", D4_MISMATCH_MIN_CONTEXT_TOKENS + 10_000, 100);
    }
    insEditEvent("ws-main");
    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D4")?.status).toBe("INACTIVE");
    expect(d4Recs()).toHaveLength(0);
  });

  it("fires on a lookup-shaped main thread in a session with no Edit/Write", () => {
    for (let i = 0; i < 20; i++) {
      insOpusTurn(`msg-main-${i}`, "ws-main-ro", D4_MISMATCH_MIN_CONTEXT_TOKENS + 10_000, 100);
    }
    runDetectors(db, { now: NOW });
    const r = d4Recs()[0];
    if (!r) throw new Error("expected D4 rec");
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.main_thread_turns).toBe(20);
    expect(ev.lookup_subagent_count).toBe(1);
  });

  it("keeps an agent in when only its cold first turn is small (>= 80% lookup-shaped)", () => {
    // Shape of the real data: every agent opens with a cold, small-context turn, which the old
    // every-turn rule used to disqualify (it kept 1 of 26 agents).
    for (let a = 0; a < 3; a++) {
      const agentId = `agent-cold-${a}`;
      insOpusTurn(`msg-cold-${a}`, "ws-cold", 1_000, 100, "2026-01-02T00:00:00.000Z", {
        isSidechain: true,
        agentId,
      });
      for (let i = 0; i < 4; i++) {
        insOpusTurn(
          `msg-cold-${a}-${i}`,
          "ws-cold",
          D4_MISMATCH_MIN_CONTEXT_TOKENS + 10_000,
          100,
          "2026-01-02T00:00:00.000Z",
          { isSidechain: true, agentId },
        );
      }
    }
    runDetectors(db, { now: NOW });
    const r = d4Recs()[0];
    if (!r) throw new Error("expected D4 rec");
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.lookup_subagent_count).toBe(3);
    expect(ev.total_opus_turns_per_week).toBe(15);
    expect(ev.mismatch_turns_per_week).toBe(15);
  });

  it("keeps a subagent out when too many of its turns wrote a lot", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-mixed", "agent-mixed");
    for (let i = 0; i < 2; i++) {
      insOpusTurn(
        `msg-mixed-edit-${i}`,
        "ws-mixed",
        D4_MISMATCH_MIN_CONTEXT_TOKENS + 10_000,
        D4_MISMATCH_MAX_OUTPUT_TOKENS + 1,
        "2026-01-02T00:00:00.000Z",
        { isSidechain: true, agentId: "agent-mixed" },
      );
    }
    runDetectors(db, { now: NOW });
    expect(d4Recs()).toHaveLength(0);
  });

  it("keeps a subagent out when too many of its turns read a small context", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-small", "agent-small");
    for (let i = 0; i < 2; i++) {
      insOpusTurn(`msg-small-ctx-${i}`, "ws-small", 1_000, 100, "2026-01-02T00:00:00.000Z", {
        isSidechain: true,
        agentId: "agent-small",
      });
    }
    runDetectors(db, { now: NOW });
    expect(d4Recs()).toHaveLength(0);
  });

  it("does not fire when the saving is under 0.25% of the workspace's 7-day spend", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-tiny");
    // The workspace spent $1000 (priced work) in the window; the modeled saving is about $2.
    db.prepare("UPDATE turns SET cost_equiv_u = 1000000000 WHERE message_id = ?").run(
      "msg-d4-mismatch-lookup-ws-tiny-0",
    );
    runDetectors(db, { now: NOW });
    expect(d4Recs()).toHaveLength(0);
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
    expect(formula.formula_id).toBe("D4_MODEL_MISMATCH_V1");
  });

  it("formula inputs contain only registered measured facts", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-formula");

    runDetectors(db, { now: NOW });
    const fiRow = d4Recs()[0];
    if (!fiRow) throw new Error("expected D4 rec");
    const formula = JSON.parse(fiRow.modeled_formula_json as string) as Record<string, unknown>;
    expect(formula.inputs).toBeDefined();
    const inputs = formula.inputs as Record<string, unknown>;
    expect(typeof inputs.avg_input_tokens).toBe("number");
    expect(typeof inputs.avg_output_tokens).toBe("number");
    expect(typeof inputs.mismatch_turns_per_week).toBe("number");
  });

  it("ADVISORY-GATED: modeled_savings headline is suppressed", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-savings");

    runDetectors(db, { now: NOW });
    const r = d4Recs()[0];
    if (!r) throw new Error("expected D4 rec");

    // W0.3 advisory gate: no crisp $/wk headline emitted from transcripts alone.
    expect(r.modeled_savings_u_per_wk).toBeNull();
    const formula = JSON.parse(r.modeled_formula_json as string) as Record<string, unknown>;
    expect(formula.formula_id).toBe("D4_MODEL_MISMATCH_V1");

    // P3.1 review 1 (R1.12): the card shows no limits, so its title does not promise them.
    expect((r.lever as string).toLowerCase()).not.toContain("usage limits");

    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev).not.toHaveProperty("diagnostic_savings_u_per_wk_if_all_models_cap_binds");
    expect(ev).not.toHaveProperty("requires_usage_cap_data");
  });

  it("P2 estimate prices only the lookup subagents' turns (D4 knob, AV 0.5)", () => {
    insMismatchTurns(D4_OPUS_MIN_TURNS, "ws-savings");
    // Main-thread lookup-shaped turns in an editing session are out of scope and add nothing.
    insEditEvent("ws-savings");
    for (const i of [0, 1]) {
      insOpusTurn(
        `msg-d4-main-${i}`,
        "ws-savings",
        D4_MISMATCH_MIN_CONTEXT_TOKENS + 10_000,
        Math.floor(D4_MISMATCH_MAX_OUTPUT_TOKENS / 2),
      );
    }

    runDetectors(db, { now: NOW });
    const r = d4Recs()[0];
    if (!r) throw new Error("expected D4 rec");
    expect(r.modeled_savings_u_per_wk).toBeNull();

    // Hand-computed per subagent turn vs the sonnet-5 target (LIST [2,10]; PRICE-O55-F1, was
    // sonnet-4): 60,000 in x (15 - 2) + 250 out x (75 - 10) = 796,250 uUSD differential,
    // x 0.5 AV = 398,125. Five turns = 1,990,625.
    const formula = JSON.parse(r.modeled_formula_json as string) as Record<string, unknown>;
    expect(formula.estimate).toMatchObject({ basis: "E", rank_value_u_per_wk: 1_990_625 });

    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.mismatch_turns_per_week).toBe(D4_OPUS_MIN_TURNS);
    expect(ev.session_ids).toEqual(["sess-ws-savings-d4"]);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?")
        .get("sess-ws-savings-d4"),
    ).toEqual({ n: 1 });
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
