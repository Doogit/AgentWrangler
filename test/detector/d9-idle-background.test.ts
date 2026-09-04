/**
 * test/detector/d9-idle-background.test.ts — D9 IDLE_BACKGROUND_SESSION.
 *
 * Fires per-workspace when is_sidechain turns contribute ≥ 25% of cap-weighted
 * tokens AND ≥ 100k absolute. Savings are DIRECTIONAL: no crisp $ headline.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDetectors } from "../../src/detector/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const TS = "2027-01-02T00:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES ('ws-idle','ws-idle','2027-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags, user_turn_count)
     VALUES ('sess-idle','ws-idle','/fake/sess-idle.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]', 0)`,
  ).run(TS, TS);
});

afterEach(() => db.close());

let seq = 0;
function insTurn(
  inputTokens: number,
  sidechain: number,
  options: { provisional?: number; sessionId?: string; ts?: string } = {},
): void {
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?, ?, 'ws-idle', ?, 'claude-sonnet',
             ?, ?, 0, 0, 0, 0, 0, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', ?, 'test-v1')`,
  ).run(
    `msg-idle-${seq++}`,
    options.sessionId ?? "sess-idle",
    options.ts ?? TS,
    sidechain,
    inputTokens,
    options.provisional ?? 0,
  );
}

function d9Recs(): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM recommendations WHERE detector_id='D9' ORDER BY rec_id")
    .all() as Array<Record<string, unknown>>;
}

describe("D9 — fires on background-heavy fan-out", () => {
  it("fires when sidechain share ≥ 25% and ≥ 100k cap tokens", () => {
    insTurn(120_000, 1); // sidechain: 120k cap tokens
    insTurn(100_000, 0); // foreground: total 220k, share ≈ 0.545

    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D9")?.status).toBe("ACTIVE");

    const recs = d9Recs();
    expect(recs.length).toBe(1);
    const r = recs[0];
    if (!r) throw new Error("expected D9 rec");
    expect(r.category).toBe("SESSION_HYGIENE");
    expect(r.scope_workspace_id).toBe("ws-idle");
    // Directional: no crisp $ headline.
    expect(r.modeled_savings_u_per_wk).toBeNull();

    const formula = JSON.parse(r.modeled_formula_json as string) as Record<string, unknown>;
    expect(formula.kind).toBe("DIRECTIONAL");

    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
    expect(ev.directional).toBe(true);
    expect(ev.sidechain_cap_weighted_tokens).toBe(120_000);
    expect(ev.zero_user_turn_sidechain_cap).toBe(120_000);
    expect(ev.zero_user_turn_sidechain_share).toBe(1);
    expect(ev.zero_user_turn_session_count).toBe(1);
    expect(typeof ev.sidechain_share).toBe("number");
    expect(ev.thresholds_unvalidated).toBe(true);
  });

  it("reports no zero-user-turn facet for genuine user-turn sessions", () => {
    db.prepare("UPDATE sessions SET user_turn_count = 1 WHERE session_id = 'sess-idle'").run();
    insTurn(120_000, 1);
    insTurn(100_000, 0);

    runDetectors(db, { now: NOW });

    const recs = d9Recs();
    expect(recs.length).toBe(1);
    const r = recs[0];
    if (!r) throw new Error("expected D9 rec");
    expect(r.modeled_savings_u_per_wk).toBeNull();
    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
    expect(ev.zero_user_turn_sidechain_cap).toBe(0);
    expect(ev.zero_user_turn_sidechain_share).toBe(0);
    expect(ev.zero_user_turn_session_count).toBe(0);
  });

  it("keeps provisional and out-of-window turns out of the zero-user-turn facet", () => {
    insTurn(120_000, 1);
    insTurn(100_000, 0);
    insTurn(50_000, 1, { provisional: 1 });
    insTurn(60_000, 1, { ts: "2026-12-31T23:59:59.999Z" });
    insTurn(70_000, 1, { ts: "2027-01-08T00:00:00.000Z" });

    runDetectors(db, { now: NOW });

    const recs = d9Recs();
    expect(recs.length).toBe(1);
    const r = recs[0];
    if (!r) throw new Error("expected D9 rec");
    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
    expect(ev.sidechain_cap_weighted_tokens).toBe(120_000);
    expect(ev.zero_user_turn_sidechain_cap).toBe(120_000);
    expect(ev.zero_user_turn_sidechain_share).toBe(1);
    expect(ev.zero_user_turn_session_count).toBe(1);
  });
});

describe("D9 — stays quiet", () => {
  it("does not fire when the sidechain share is below 25%", () => {
    insTurn(120_000, 1); // sidechain ≥ 100k absolute…
    insTurn(1_000_000, 0); // …but share ≈ 0.107 < 0.25
    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D9")?.status).toBe("INACTIVE");
    expect(d9Recs().length).toBe(0);
  });

  it("does not fire when absolute sidechain tokens are below 100k", () => {
    insTurn(50_000, 1); // high share but only 50k absolute
    runDetectors(db, { now: NOW });
    expect(d9Recs().length).toBe(0);
  });
});

describe("D9 — determinism", () => {
  it("two passes over the same frozen DB yield identical rows", () => {
    insTurn(120_000, 1);
    insTurn(100_000, 0);

    runDetectors(db, { now: NOW });
    const first = d9Recs();

    runDetectors(db, { now: NOW });
    expect(d9Recs()).toEqual(first);
  });
});
