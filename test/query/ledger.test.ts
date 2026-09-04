/**
 * test/query/ledger.test.ts — W4 Impact Ledger write + read paths (§7a, §7c, §7d).
 *
 * Covers: adoptRecommendation's transactional baseline snapshot (with and
 * without a history signal), the double-adopt guard, listLedger's cap-weighted
 * modeled figure vs realized after_value separation, COEFF resolution from
 * user_config, effects=[] for recs without rows yet, and the confounded-window
 * flag for same-day adoptions.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMeasurementPass } from "../../src/detector/measurement.js";
import { listLedger } from "../../src/query/api/recommendations-ledger.js";
import { adoptRecommendation } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

function insertHistoryRow(tokens: number, observedAtMs: number): void {
  db.prepare(
    `INSERT INTO context_inventory_history
       (workspace_id, component, file_ref, file_hash, tokens, attribution_version, observed_at)
     VALUES ('ws-alpha', 'CLAUDE_MD', '/fake/CLAUDE.md', ?, ?, 'chars4-v1', ?)`,
  ).run(`hash-${tokens}-${observedAtMs}`, tokens, new Date(observedAtMs).toISOString());
}

function insertProposedRec(
  recId: string,
  opts?: { scopeWorkspaceId?: string | null; evidence?: Record<string, unknown> },
): void {
  db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, analysis_run_id, category, scope_workspace_id,
        lever, modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
        state, created_at)
     VALUES (?, 'RULE', 'D1', NULL, 'CONTEXT', ?, 'test lever', ?, '{}', ?, 'avg_context_per_turn',
             'PROPOSED', ?)`,
  ).run(
    recId,
    opts?.scopeWorkspaceId ?? null,
    10_000_000, // $10/wk modeled — distinct from any token figure
    JSON.stringify(opts?.evidence ?? { component: "CLAUDE_MD", file_ref: "/fake/CLAUDE.md" }),
    new Date(T0 - MS_PER_DAY).toISOString(),
  );
}

// ---------------------------------------------------------------------------
// §7a — schema / write path
// ---------------------------------------------------------------------------

describe("adoptRecommendation — W4 baseline snapshot", () => {
  it("writes a recommendation_effects row with non-null before_value when a history baseline exists", () => {
    insertHistoryRow(3200, T0 - MS_PER_DAY);
    insertProposedRec("rec-ledger-a", { scopeWorkspaceId: "ws-alpha" });

    adoptRecommendation("rec-ledger-a", T0);

    const eff = db
      .prepare("SELECT before_value, before_n, verdict FROM recommendation_effects WHERE rec_id=?")
      .get("rec-ledger-a") as
      | { before_value: number | null; before_n: number | null; verdict: string | null }
      | undefined;
    expect(eff).toBeDefined();
    expect(eff?.before_value).toBe(3200); // observed history tokens
    expect(eff?.before_n).toBe(1);
    expect(eff?.verdict).toBeNull(); // open until the measurement pass closes it
  });

  it("still writes the effect row (before_value = null) when no baseline exists", () => {
    // No history rows seeded.
    insertProposedRec("rec-ledger-b", { scopeWorkspaceId: "ws-alpha" });

    const resp = adoptRecommendation("rec-ledger-b", T0);

    expect(resp.data?.ok).toBe(true);
    const eff = db
      .prepare("SELECT before_value FROM recommendation_effects WHERE rec_id=?")
      .get("rec-ledger-b") as { before_value: number | null } | undefined;
    expect(eff).toBeDefined();
    expect(eff?.before_value).toBeNull();
  });

  it("guard: double-adopt throws on the second attempt and never duplicates the effect row", () => {
    insertHistoryRow(3000, T0 - MS_PER_DAY);
    insertProposedRec("rec-ledger-c", { scopeWorkspaceId: "ws-alpha" });

    adoptRecommendation("rec-ledger-c", T0);
    expect(() => adoptRecommendation("rec-ledger-c", T0 + 1000)).toThrow();

    const count = (
      db
        .prepare("SELECT COUNT(*) AS n FROM recommendation_effects WHERE rec_id=?")
        .get("rec-ledger-c") as { n: number }
    ).n;
    expect(count).toBe(1);
    // State unchanged by the failed second attempt.
    const state = (
      db.prepare("SELECT state AS s FROM recommendations WHERE rec_id=?").get("rec-ledger-c") as {
        s: string;
      }
    ).s;
    expect(state).toBe("ADOPTED");
  });
});

// ---------------------------------------------------------------------------
// §7d — API / ledger read
// ---------------------------------------------------------------------------

describe("listLedger", () => {
  it("returns distinct cap-weighted modeled and realized after_value fields (never summed)", () => {
    insertHistoryRow(1000, T0 - MS_PER_DAY);
    insertProposedRec("rec-led-d1", { scopeWorkspaceId: "ws-alpha" });
    adoptRecommendation("rec-led-d1", T0);
    // Close the measurement with an observed reduction.
    db.prepare(
      `INSERT INTO context_inventory_history
         (workspace_id, component, file_ref, file_hash, tokens, attribution_version, observed_at)
       VALUES ('ws-alpha', 'CLAUDE_MD', '/fake/CLAUDE.md', 'hash-after', 500, 'chars4-v1', ?)`,
    ).run(new Date(T0 + MS_PER_DAY).toISOString());
    runMeasurementPass(db, new Date(T0 + 15 * MS_PER_DAY), { force: true });

    const resp = listLedger();
    const entry = resp.data?.entries.find((e) => e.rec_id === "rec-led-d1");
    expect(entry).toBeDefined();
    expect(entry?.modeled_savings_u_per_wk).toBe(10_000_000); // raw modeled returned
    expect(entry?.modeled_cap_weighted_u_per_wk).toBeCloseTo(1_000_000, 6); // ×0.1
    expect(entry?.effects[0]?.after_value).toBe(500); // realized ≠ any modeled field
    expect(entry?.effects[0]?.verdict).toBe("EFFECTIVE");
    expect(entry?.effects[0]?.qualification).toBeNull(); // D1 n=1 is a point-in-time file snapshot
    // The API emits no combined "total saved" aggregate.
    const json = JSON.stringify(resp.data);
    expect(json).not.toContain("total_saved");
    expect(json).not.toContain("achieved");
  });

  it("applies the default COEFF=0.1 to modeled_savings_u_per_wk", () => {
    insertProposedRec("rec-led-coeff-default", { scopeWorkspaceId: "ws-alpha" });
    adoptRecommendation("rec-led-coeff-default", T0);

    const resp = listLedger();
    expect(resp.data?.cap_read_coeff).toBe(0.1);
    const entry = resp.data?.entries.find((e) => e.rec_id === "rec-led-coeff-default");
    expect(entry?.modeled_cap_weighted_u_per_wk).toBeCloseTo(
      0.1 * (entry?.modeled_savings_u_per_wk ?? 0),
      6,
    );
  });

  it("honors a user_config COEFF override of 1.0", () => {
    db.prepare(
      `INSERT INTO user_config (key, value, updated_at) VALUES ('cap_read_coeff', '1.0', ?)`,
    ).run(new Date(T0).toISOString());
    insertProposedRec("rec-led-coeff-one", { scopeWorkspaceId: "ws-alpha" });
    adoptRecommendation("rec-led-coeff-one", T0);

    const resp = listLedger();
    const entry = resp.data?.entries.find((e) => e.rec_id === "rec-led-coeff-one");
    expect(resp.data?.cap_read_coeff).toBe(1.0);
    expect(entry?.modeled_cap_weighted_u_per_wk).toBe(entry?.modeled_savings_u_per_wk);
  });

  it("includes adopted recs with no effect rows yet (effects = [])", () => {
    // Warning-class (D5/LIMIT) recs skip measurement entirely: they appear in the
    // ledger as ADOPTED with no recommendation_effects row (design §2d).
    db.prepare(
      `INSERT INTO recommendations
         (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
          modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
          state, created_at)
       VALUES ('rec-led-noeff', 'RULE', 'D5', 'LIMIT', NULL, 'warning-class rec',
               NULL, '{}', '{}', 'forecast_margin', 'PROPOSED', ?)`,
    ).run(new Date(T0 - MS_PER_DAY).toISOString());
    adoptRecommendation("rec-led-noeff", T0);

    const resp = listLedger();
    const entry = resp.data?.entries.find((e) => e.rec_id === "rec-led-noeff");
    expect(entry).toBeDefined();
    expect(entry?.state).toBe("ADOPTED");
    expect(entry?.adopted_at).not.toBeNull(); // W1 marker contract
    expect(entry?.effects).toEqual([]);
  });

  it("flags confounded_window on both recs adopted within one calendar day (§7c)", () => {
    insertHistoryRow(2000, T0 - MS_PER_DAY);
    insertProposedRec("rec-cf-a", { scopeWorkspaceId: "ws-alpha" });
    insertProposedRec("rec-cf-b", { scopeWorkspaceId: "ws-alpha" });

    adoptRecommendation("rec-cf-a", T0);
    adoptRecommendation("rec-cf-b", T0 + 3600_000); // 1h later — same day

    const resp = listLedger();
    const a = resp.data?.entries.find((e) => e.rec_id === "rec-cf-a");
    const b = resp.data?.entries.find((e) => e.rec_id === "rec-cf-b");
    expect(a?.confounded_window).toBe(true);
    expect(b?.confounded_window).toBe(true);

    // Both keep separate effect rows with their own before snapshots (per-source isolation).
    expect(a?.effects.length).toBe(1);
    expect(b?.effects.length).toBe(1);
    expect(a?.effects[0]?.before_value).toBe(2000);
    expect(b?.effects[0]?.before_value).toBe(2000);
  });

  it("excludes PROPOSED and DISMISSED recs from the ledger", () => {
    insertProposedRec("rec-led-proposed", { scopeWorkspaceId: "ws-alpha" }); // stays PROPOSED
    const resp = listLedger();
    expect(resp.data?.entries.find((e) => e.rec_id === "rec-led-proposed")).toBeUndefined();
    expect(resp.meta.claim_kind).toBe("EXPERIMENTAL");
  });
});
