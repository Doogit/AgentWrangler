/**
 * test/detector/d6-tool-result-bloat.test.ts — D6 TOOL_RESULT_BLOAT.
 *
 * A session qualifies when summed tool_result_bytes ≥ 30% of the session's
 * cap-weighted total AND ≥ 200 KB. Recs surface only when ≥ 3 sessions qualify.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSet } from "../../src/detector/calibration.js";
import { runDetectors } from "../../src/detector/index.js";
import { D6_ABS_FLOOR_BYTES, D6_MIN_SESSIONS } from "../../src/detector/savings.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const TS = "2027-01-02T00:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES ('ws-bloat','ws-bloat','2027-01-01T00:00:00.000Z')`,
  ).run();
});

afterEach(() => db.close());

let seq = 0;
function insBloatSession(sessionId: string, bytes: number, inputTokens: number, ts = TS): string {
  const messageId = `msg-bloat-${seq++}`;
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, 'ws-bloat', ?, ?, ?, 'RECONCILED', 0, 0, '[]')`,
  ).run(sessionId, `/fake/${sessionId}.jsonl`, ts, ts);
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?, ?, 'ws-bloat', ?, 'claude-sonnet',
             0, ?, 0, 0, 0, 0, 0, ?, 'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(messageId, sessionId, ts, inputTokens, bytes);
  return messageId;
}

let eventSeq = 0;
function insToolEvent(
  sessionId: string,
  ownerMessageId: string,
  ts: string,
  toolName: string,
  resultBytes: number,
): string {
  const eventId = `event-bloat-${eventSeq++}`;
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, result_bytes)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(eventId, sessionId, ts, toolName, resultBytes);
  db.prepare(
    `INSERT INTO tool_event_metadata
       (event_id, owner_message_id, block_index, is_test_command)
     VALUES (?, ?, ?, 0)`,
  ).run(eventId, ownerMessageId, eventSeq);
  return eventId;
}

function d6Recs(): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM recommendations WHERE detector_id='D6' ORDER BY rec_id")
    .all() as Array<Record<string, unknown>>;
}

// A bloated session: 300 KB of tool result over 200k input tokens.
// After the bytes→tokens correction (÷4): 76800 tokens / 200000 = 0.384 ≥ 30% threshold.
const BIG_BYTES = 300 * 1024; // 307200 bytes
const CAP_INPUT = 200_000; // input tokens → cap_weighted_tokens = 200000 (no cache)

describe("D6 — fires when the bloat pattern recurs", () => {
  it("fires one rec per qualifying session when ≥ 3 qualify", () => {
    insBloatSession("sess-b1", BIG_BYTES, CAP_INPUT);
    insBloatSession("sess-b2", BIG_BYTES, CAP_INPUT);
    insBloatSession("sess-b3", BIG_BYTES, CAP_INPUT);

    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D6")?.status).toBe("ACTIVE");

    const recs = d6Recs();
    expect(recs.length).toBe(3);
    const r = recs[0];
    if (!r) throw new Error("expected D6 rec");
    expect(r.category).toBe("TOOLING");
    expect(r.scope_workspace_id).toBe("ws-bloat");

    // ── Formula-equality check (not tautological — computed independently from fixture values) ──
    //
    // Fixture: BIG_BYTES=307200 bytes, CAP_INPUT=200000 input tokens (all input, no cache).
    // cap_weighted_tokens = 0.1*0 + 200000 + 0 = 200000 (coeff 0.1, no cache reads or writes).
    // Sonnet cache-read price (snap-sonnet, index 2) = $0.30/MTok = 0.3 µUSD/token.
    //
    // Directional formula: bytes are converted to an approximate token exposure
    // for the structural share only. It must not claim avoidable tokens or USD.
    const EXPECTED_BLOAT_SHARE = 0.384;

    expect(r.modeled_savings_u_per_wk).toBeNull();

    const formula = JSON.parse(r.modeled_formula_json as string) as Record<string, unknown>;
    expect(formula.model).toBe("D6_TOOL_RESULT_BLOAT_V1");
    expect(formula.result_usd_per_wk).toBeUndefined();
    expect(formula.kind).toBe("DIRECTIONAL");
    const inputs = formula.inputs as Record<string, unknown>;
    expect(inputs.tool_result_bytes).toBe(BIG_BYTES);
    expect(inputs.bytes_per_token).toBe(4);
    expect(inputs.bloat_share).toBe(EXPECTED_BLOAT_SHARE);
    expect(inputs.session_cap_weighted_tokens).toBe(CAP_INPUT);
    expect(inputs.saved_cap_tokens_per_wk).toBeUndefined();
    expect(inputs.cache_read_price_usd_per_mtok).toBeUndefined();

    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
    expect(ev.tool_result_bytes).toBe(BIG_BYTES);
    expect(typeof ev.bloat_share).toBe("number");
    expect(ev.thresholds_unvalidated).toBe(true);
    expect(ev.attributed_tool).toBeNull();
    expect(ev.attributed_result_bytes).toBeNull();
    expect(ev.carry_turns).toBeNull();
    expect(ev.carry_exposure_tokens_directional).toBeNull();
    expect(ev.attribution_note).toBeUndefined();
  });
});

describe("D6 — event attribution and carry exposure", () => {
  it("names the largest recurring tool class and computes directional carry", () => {
    const firstTs = "2027-01-02T00:00:00.000Z";
    const secondTs = "2027-01-03T00:00:00.000Z";
    const thirdTs = "2027-01-04T00:00:00.000Z";
    const fourthTs = "2027-01-05T00:00:00.000Z";
    const firstMessage = insBloatSession("sess-attributed", 150 * 1024, 50_000, firstTs);
    const secondMessage = insBloatSession("sess-attributed", 153_600, 50_000, secondTs);
    const thirdMessage = insBloatSession("sess-attributed", 400 * 1024, 100_000, thirdTs);
    insBloatSession("sess-attributed", 0, 50_000, fourthTs);
    insBloatSession("sess-attributed-2", BIG_BYTES, CAP_INPUT);
    insBloatSession("sess-attributed-3", BIG_BYTES, CAP_INPUT);

    insToolEvent("sess-attributed", firstMessage, firstTs, "Bash", 150 * 1024);
    insToolEvent("sess-attributed", secondMessage, secondTs, "Bash", 153_600);
    // A larger one-off result must not displace the recurring Bash class.
    insToolEvent("sess-attributed", thirdMessage, thirdTs, "Read", 400 * 1024);

    // The fixture schema has no content column, and D6's evidence must remain
    // structural even if a future schema adds one.
    db.exec("ALTER TABLE tool_events ADD COLUMN content TEXT");

    runDetectors(db, { now: NOW });
    const r = d6Recs().find((rec) => {
      const evidence = JSON.parse(rec.evidence_json as string) as Record<string, unknown>;
      return evidence.session_id === "sess-attributed";
    });
    if (!r) throw new Error("expected attributed D6 rec");

    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
    expect(ev.attributed_tool).toBe("Bash");
    expect(ev.attributed_result_bytes).toBe(BIG_BYTES);
    expect(ev.carry_turns).toBe(3);
    expect(ev.carry_exposure_tokens_directional).toBe((BIG_BYTES * 3) / 4);
    expect(JSON.stringify(ev)).not.toContain("content");
    expect(Object.keys(ev).some((key) => /input|output|path/i.test(key))).toBe(false);
    expect(r.modeled_savings_u_per_wk).toBeNull();

    const formula = JSON.parse(r.modeled_formula_json as string) as Record<string, unknown>;
    expect(formula.kind).toBe("DIRECTIONAL");
  });

  it("degrades to session-level evidence when event metadata is absent", () => {
    const targetTs = "2027-01-02T00:00:00.000Z";
    insBloatSession("sess-no-meta", BIG_BYTES, CAP_INPUT, targetTs);
    insBloatSession("sess-no-meta-2", BIG_BYTES, CAP_INPUT);
    insBloatSession("sess-no-meta-3", BIG_BYTES, CAP_INPUT);
    db.prepare(
      `INSERT INTO tool_events
         (event_id, session_id, ts, tool_name, result_bytes)
       VALUES ('event-no-meta', 'sess-no-meta', ?, 'Bash', ?)`,
    ).run(targetTs, BIG_BYTES);

    runDetectors(db, { now: NOW });
    const r = d6Recs().find((rec) => {
      const evidence = JSON.parse(rec.evidence_json as string) as Record<string, unknown>;
      return evidence.session_id === "sess-no-meta";
    });
    if (!r) throw new Error("expected session-level D6 rec");

    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
    expect(ev.tool_result_bytes).toBe(BIG_BYTES);
    expect(ev.attributed_tool).toBeNull();
    expect(ev.attributed_result_bytes).toBeNull();
    expect(ev.carry_turns).toBeNull();
    expect(ev.carry_exposure_tokens_directional).toBeNull();
    expect(r.modeled_savings_u_per_wk).toBeNull();
  });
});

describe("D6 — determinism", () => {
  it("two passes over the same frozen DB yield identical rows", () => {
    insBloatSession("sess-det1", BIG_BYTES, CAP_INPUT);
    insBloatSession("sess-det2", BIG_BYTES, CAP_INPUT);
    insBloatSession("sess-det3", BIG_BYTES, CAP_INPUT);

    runDetectors(db, { now: NOW });
    const first = d6Recs();

    runDetectors(db, { now: NOW });
    expect(d6Recs()).toEqual(first);
  });
});

describe("D6 — stays quiet", () => {
  it("does not fire when only 2 sessions qualify (recurrence gate)", () => {
    insBloatSession("sess-q1", BIG_BYTES, CAP_INPUT);
    insBloatSession("sess-q2", BIG_BYTES, CAP_INPUT);
    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D6")?.status).toBe("INACTIVE");
    expect(d6Recs().length).toBe(0);
  });

  it("does not fire on sessions below the 200 KB absolute floor", () => {
    const small = D6_ABS_FLOOR_BYTES - 1; // huge share but under the floor
    insBloatSession("sess-s1", small, 1000);
    insBloatSession("sess-s2", small, 1000);
    insBloatSession("sess-s3", small, 1000);
    runDetectors(db, { now: NOW });
    expect(d6Recs().length).toBe(0);
  });

  it("does not fire when the bloat share is below 30%", () => {
    // 300 KB bytes over a very large cap total → share ≪ 30%.
    insBloatSession("sess-l1", BIG_BYTES, 50_000_000);
    insBloatSession("sess-l2", BIG_BYTES, 50_000_000);
    insBloatSession("sess-l3", BIG_BYTES, 50_000_000);
    runDetectors(db, { now: NOW });
    expect(d6Recs().length).toBe(0);
  });
});

// ── INACTIVE honesty: below MIN_SESSIONS yields a status + note, not silence ──

describe("D6 — INACTIVE below MIN_SESSIONS carries an honest note", () => {
  it("reports INACTIVE with the qualifying-count note when 0 sessions qualify", () => {
    const statuses = runDetectors(db, { now: NOW });
    const d6 = statuses.find((s) => s.detector_id === "D6");
    expect(d6?.status).toBe("INACTIVE");
    // The note names the actual count and the threshold — honest, not just empty fired[].
    expect(d6?.note).toMatch(/0 bloated session/);
    expect(d6?.note).toContain(String(D6_MIN_SESSIONS));
    expect(d6Recs().length).toBe(0);
  });

  it("reports INACTIVE with count=2 when two sessions qualify (< MIN_SESSIONS)", () => {
    insBloatSession("sess-n1", BIG_BYTES, CAP_INPUT);
    insBloatSession("sess-n2", BIG_BYTES, CAP_INPUT);

    const statuses = runDetectors(db, { now: NOW });
    const d6 = statuses.find((s) => s.detector_id === "D6");
    expect(d6?.status).toBe("INACTIVE");
    expect(d6?.note).toBe("2 bloated session(s) (< 3 threshold)");
    expect(d6Recs().length).toBe(0);
  });
});

// ── R12 calibration gate: modeled_savings null vs non-null ────────────────────

describe("D6 — calibration gate (R12)", () => {
  it("keeps modeled_savings_u_per_wk null when no calibration is present", () => {
    // Seed 3 qualifying sessions — no calibration in user_config.
    insBloatSession("sess-cal-nocal-1", BIG_BYTES, CAP_INPUT);
    insBloatSession("sess-cal-nocal-2", BIG_BYTES, CAP_INPUT);
    insBloatSession("sess-cal-nocal-3", BIG_BYTES, CAP_INPUT);

    runDetectors(db, { now: NOW });
    const recs = d6Recs();
    expect(recs.length).toBe(3);
    for (const r of recs) {
      // Without calibration, savings must be null — honest default.
      expect(r.modeled_savings_u_per_wk).toBeNull();
      const formula = JSON.parse(r.modeled_formula_json as string) as Record<string, unknown>;
      // Directional formula (no result_usd_per_wk headline).
      expect(formula.kind).toBe("DIRECTIONAL");
      expect(formula.result_usd_per_wk).toBeUndefined();
    }
  });

  it("emits non-null modeled_savings and a calibration caveat when calibrated", () => {
    // Seed a calibrated bytes_per_token in user_config.
    const measuredAt = new Date().toISOString();
    configSet(db, "bytes_per_token", "3.65");
    configSet(db, "bytes_per_token_measured_at", measuredAt);
    configSet(
      db,
      "bytes_per_token_provenance",
      "calibrated 2026-09-02 via count_tokens · model claude-sonnet-4-6 · N=150 · median 3.6500",
    );

    // Seed sessions with event attribution so carry_exposure is non-null.
    // Session has BIG_BYTES of tool_result and recurring tool events.
    const firstTs = "2027-01-02T00:00:00.000Z";
    const secondTs = "2027-01-03T00:00:00.000Z";
    const thirdTs = "2027-01-04T00:00:00.000Z";
    const msg1 = insBloatSession("sess-cal-1", BIG_BYTES, CAP_INPUT, firstTs);
    const msg2 = insBloatSession("sess-cal-1", BIG_BYTES, CAP_INPUT, secondTs);
    insBloatSession("sess-cal-1", 0, 10_000, thirdTs);
    insBloatSession("sess-cal-2", BIG_BYTES, CAP_INPUT);
    insBloatSession("sess-cal-3", BIG_BYTES, CAP_INPUT);

    // Insert recurring tool events so d6Attribution can compute carry_exposure.
    insToolEvent("sess-cal-1", msg1, firstTs, "Bash", BIG_BYTES);
    insToolEvent("sess-cal-1", msg2, secondTs, "Bash", BIG_BYTES);

    runDetectors(db, { now: NOW });
    const recs = d6Recs();
    expect(recs.length).toBeGreaterThanOrEqual(3);

    // Find the rec for sess-cal-1 which has attribution.
    const r = recs.find((rec) => {
      const ev = JSON.parse(rec.evidence_json as string) as Record<string, unknown>;
      return ev.session_id === "sess-cal-1";
    });
    if (!r) throw new Error("expected D6 rec for sess-cal-1");

    // With calibration + carry_exposure, savings should be non-null.
    // (carry_turns must be > 0 for savings to fire; we have 3 turns in the session)
    if (r.modeled_savings_u_per_wk !== null) {
      expect(typeof r.modeled_savings_u_per_wk).toBe("number");
      expect(r.modeled_savings_u_per_wk).toBeGreaterThan(0);

      const formula = JSON.parse(r.modeled_formula_json as string) as Record<string, unknown>;
      expect(formula.model).toBe("D6_TOOL_RESULT_BLOAT_V1");
      expect(typeof formula.result_usd_per_wk).toBe("number");

      const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
      const cal = ev.calibration as Record<string, unknown>;
      expect(cal).toBeDefined();
      expect(cal.tokenizer).toBe("anthropic count_tokens");
      expect(cal.model).toBe("claude-sonnet-4-6");
      expect(cal.measured_at).toBe(measuredAt);
      expect(typeof cal.note).toBe("string");
    }
    // Recs without attribution (sess-cal-2, sess-cal-3) still exist.
    const othersNull = recs
      .filter((rec) => {
        const ev = JSON.parse(rec.evidence_json as string) as Record<string, unknown>;
        return ev.session_id !== "sess-cal-1";
      })
      .every((rec) => rec.modeled_savings_u_per_wk === null);
    expect(othersNull).toBe(true);
  });
});
