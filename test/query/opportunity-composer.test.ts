/**
 * RIQ2 opportunity composer tests.
 * SEC-101: synthetic data only — no operator DB, no raw tool names, no transcript content.
 * Fixtures built via the real builder on in-memory DBs AND hand-constructed packet literals.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvidencePacket } from "../../src/query/api/evidence-packet-types.js";
import { buildEvidencePacket } from "../../src/query/api/evidence-packet.js";
import type {
  FamilyEntry,
  InsufficientEvidenceEntry,
  OpportunityEntry,
  UsageChangeDetail,
} from "../../src/query/api/opportunity-composer-types.js";
import { composeOpportunities } from "../../src/query/api/opportunity-composer.js";
import { RIQ6_CASES, createRiq6Db } from "../fixtures/riq6/cases.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findFamily(families: FamilyEntry[], id: FamilyEntry["family"]): FamilyEntry | undefined {
  return families.find((f) => f.family === id);
}

function asOpportunity(entry: FamilyEntry | undefined): OpportunityEntry {
  if (!entry || entry.outcome !== "OPPORTUNITY") {
    throw new Error(
      `Expected OPPORTUNITY for family ${entry?.family ?? "??"}, got ${entry?.outcome ?? "missing"}`,
    );
  }
  return entry;
}

function asInsufficient(entry: FamilyEntry | undefined): InsufficientEvidenceEntry {
  if (!entry || entry.outcome !== "INSUFFICIENT_EVIDENCE") {
    throw new Error(`Expected INSUFFICIENT_EVIDENCE, got ${entry?.outcome ?? "missing"}`);
  }
  return entry;
}

describe("composeOpportunities — evidence eligibility", () => {
  it("withholds all families for the frozen expired-evidence case", () => {
    const definition = RIQ6_CASES.find((entry) => entry.case_id === "stale-capability");
    if (!definition) throw new Error("Missing stale-capability fixture");
    const db = createRiq6Db(definition);
    try {
      const packet = buildEvidencePacket(db, definition.scope);
      expect(packet.freshness.status).toBe("EXPIRED");
      const result = composeOpportunities(packet);
      expect(result.families).toHaveLength(3);
      for (const family of result.families) {
        expect(family).toMatchObject({
          outcome: "INSUFFICIENT_EVIDENCE",
          unavailable_reason: "EVIDENCE_PREDATES_METHOD_REVISION",
        });
        expect(family).not.toHaveProperty("next_step");
      }
    } finally {
      db.close();
    }
  });

  it.each([1, 1_000_000])(
    "withholds tool conclusions when later identities are omitted (first bytes=%i)",
    (firstBytes) => {
      const db = createInMemoryFixtureDb();
      try {
        db.prepare("DELETE FROM tool_events").run();
        const insert = db.prepare(
          "INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class, commit_sha) VALUES (?, 'sess-a1', '2026-01-01T00:05:00.000Z', ?, 1, ?, NULL, ?, NULL)",
        );
        for (let i = 0; i < 32; i++) {
          insert.run(
            `evt-bounded-${i}`,
            `a-tool-${String(i).padStart(2, "0")}`,
            i === 0 ? firstBytes : 1,
            "OK",
          );
        }
        for (let i = 0; i < 2; i++) insert.run(`evt-omitted-${i}`, "z-tool", 2_000_000, "ERROR");
        const packet = buildEvidencePacket(db, {
          workspaceId: "ws-alpha",
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-01T03:00:00.000Z",
        });
        expect(packet.facts.tool_observations).toHaveProperty("value.length", 32);
        expect(
          findFamily(composeOpportunities(packet).families, "TOOL_OUTPUT_RETRY_CONCENTRATION"),
        ).toMatchObject({
          outcome: "INSUFFICIENT_EVIDENCE",
          unavailable_reason: "INCOMPLETE_TOOL_OBSERVATIONS",
        });
      } finally {
        db.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Minimal valid packet literal factory.
// All IDs are opaque/synthetic; no raw tool names, paths, or content.
// ---------------------------------------------------------------------------

function makeBasePacket(overrides: Partial<EvidencePacket["facts"]> = {}): EvidencePacket {
  return {
    packet_version: "riq1-2",
    query_definition_version: "riq1-query-2",
    packet_identity_hash: "aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233",
    evidence_as_of: "2026-06-01T00:00:00.000Z",
    source_revision: "src-rev-synthetic-001",
    scope: {
      workspace_id: "ws-synthetic",
      tool_class: null,
      current_window: { from: "2026-05-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" },
      prior_window: { from: "2026-04-01T00:00:00.000Z", to: "2026-05-01T00:00:00.000Z" },
      maturity_filters: { session_state: "RECONCILED", provisional_turns_excluded: true },
    },
    freshness: { status: "CURRENT", reason: null },
    coverage: {
      eligible_session_count: 10,
      excluded_live_session_count: 1,
      unpriced_turn_count: 0,
      tool_observations_truncated: false,
      exclusions: [],
    },
    facts: {
      current_list_price_equivalent_u: {
        value: 120_000,
        unit: "micro_usd_list_equivalent",
        denominator: 40,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_aabb0000111122223333"],
        evidence_ids: ["ev_aabb0000111122223333"],
      },
      prior_list_price_equivalent_u: {
        value: 80_000,
        unit: "micro_usd_list_equivalent",
        denominator: 40,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_ccdd0000111122223333"],
        evidence_ids: ["ev_ccdd0000111122223333"],
      },
      comparison: {
        value: { delta: 40_000, direction: "INCREASE" },
        unit: "micro_usd_list_equivalent_delta",
        denominator: 10,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_aabb0000111122223333", "ev_ccdd0000111122223333"],
        evidence_ids: ["ev_aabb0000111122223333", "ev_ccdd0000111122223333"],
      },
      raw_token_buckets: {
        value: {
          input_tokens: 50_000,
          output_tokens: 10_000,
          cache_read_tokens: 25_000,
          cache_write_5m: 5_000,
          cache_write_1h: 0,
          cache_write_other: 0,
        },
        unit: "tokens",
        denominator: 40,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_aabb0000111122223333"],
        evidence_ids: ["ev_aabb0000111122223333"],
      },
      session_cost_distribution_u: {
        value: { min: 2_000, median: 8_000, max: 30_000 },
        unit: "micro_usd_list_equivalent_per_session",
        denominator: 10,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_aabb0000111122223333"],
        evidence_ids: ["ev_aabb0000111122223333"],
      },
      model_mix: {
        value: [
          { model_id: "model_synthetic_aaa001", turn_count: 30 },
          { model_id: "model_synthetic_bbb002", turn_count: 10 },
        ],
        unit: "turns",
        denominator: 40,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_aabb0000111122223333"],
        evidence_ids: ["ev_aabb0000111122223333"],
      },
      task_mix: { state: "UNKNOWN", reason: "NOT_REPORTED", method: "riq1-evidence-packet-2" },
      modeled_cap_headroom: {
        state: "UNAVAILABLE",
        reason: "UNSUPPORTED",
        method: "riq1-evidence-packet-2",
      },
      tool_observations: {
        value: [
          {
            tool_id: "tool_synthetic_aaa111",
            tool_class: "FILE_READ",
            event_count: 20,
            result_bytes_total: 400_000,
            failure_event_count: 0,
            recovered_after_failure_count: 0,
          },
          {
            tool_id: "tool_synthetic_bbb222",
            tool_class: "SEARCH",
            event_count: 5,
            result_bytes_total: 50_000,
            failure_event_count: 0,
            recovered_after_failure_count: 0,
          },
        ],
        unit: "tool_events",
        denominator: 10,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_aabb0000111122223333"],
        evidence_ids: ["ev_aabb0000111122223333"],
      },
      target_observations: {
        state: "UNAVAILABLE",
        reason: "UNSUPPORTED",
        method: "riq1-evidence-packet-2",
      },
      guardrail_observations: {
        state: "UNAVAILABLE",
        reason: "UNSUPPORTED",
        method: "riq1-evidence-packet-2",
      },
      ...overrides,
    },
    related_actions: { active_rec_ids: [], completed_rec_ids: [] },
    overlap_groups: [],
  };
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe("composeOpportunities — decomposition exactness", () => {
  it("terms sum exactly to observed_delta (zero residual, equal turn counts)", () => {
    // n_cur=40, n_prior=40, cur=120_000, prior=80_000
    // mean_cur=3000, mean_prior=2000
    // volume_term = (40-40)*2000 = 0
    // intensity_term = 40*(3000-2000) = 40_000
    // residual = 40_000 - 0 - 40_000 = 0
    const packet = makeBasePacket();
    const result = composeOpportunities(packet);
    const family1 = asOpportunity(findFamily(result.families, "EXPLAIN_USAGE_CHANGE"));
    const decomp = (family1.detail as UsageChangeDetail).decomposition;
    expect(decomp.decomposition_version).toBe("riq2-decomp-1");
    const sum = decomp.volume_term + decomp.intensity_term + decomp.UNATTRIBUTED_RESIDUAL;
    expect(sum).toBeCloseTo(decomp.observed_delta_u, 6);
    expect(decomp.UNATTRIBUTED_RESIDUAL).toBe(0);
    expect(decomp.observed_delta_u).toBe(40_000);
  });

  it("residual is exactly zero when the cost facts are internally consistent (hand-constructed literal)", () => {
    // volume + intensity = (n_cur-n_prior)*mean_prior + n_cur*(mean_cur-mean_prior)
    //                    = n_cur*mean_cur - n_prior*mean_prior = cur_total - prior_total,
    // so whenever comparison.delta equals cur_total - prior_total the residual is 0
    // by algebra. Here: n_cur=3, cur=30_000, n_prior=7, prior=21_000, delta=9_000;
    // volume_term=(3-7)*3000=-12_000, intensity_term=3*(10_000-3_000)=21_000.
    // (The nonzero-residual path is pinned by the next test via an inconsistent delta.)
    const packet = makeBasePacket({
      current_list_price_equivalent_u: {
        value: 30_000,
        unit: "micro_usd_list_equivalent",
        denominator: 3,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_aabb0000111122223333"],
        evidence_ids: ["ev_aabb0000111122223333"],
      },
      prior_list_price_equivalent_u: {
        value: 21_000,
        unit: "micro_usd_list_equivalent",
        denominator: 7,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_ccdd0000111122223333"],
        evidence_ids: ["ev_ccdd0000111122223333"],
      },
      comparison: {
        value: { delta: 9_000, direction: "INCREASE" },
        unit: "micro_usd_list_equivalent_delta",
        denominator: 5,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_aabb0000111122223333", "ev_ccdd0000111122223333"],
        evidence_ids: ["ev_aabb0000111122223333", "ev_ccdd0000111122223333"],
      },
    });
    const result = composeOpportunities(packet);
    const family1 = asOpportunity(findFamily(result.families, "EXPLAIN_USAGE_CHANGE"));
    const decomp = (family1.detail as UsageChangeDetail).decomposition;
    const sum = decomp.volume_term + decomp.intensity_term + decomp.UNATTRIBUTED_RESIDUAL;
    expect(sum).toBeCloseTo(decomp.observed_delta_u, 6);
    // volume_term = (3-7)*3000 = -12_000
    expect(decomp.volume_term).toBeCloseTo(-12_000, 6);
    // intensity_term = 3*(10000-3000) = 21_000
    expect(decomp.intensity_term).toBeCloseTo(21_000, 6);
    expect(decomp.UNATTRIBUTED_RESIDUAL).toBeCloseTo(0, 6);
  });

  it("nonzero residual when delta differs from computed cost totals (floating-point literal)", () => {
    // Inject a delta that doesn't match cur-prior, forcing a residual.
    const packet = makeBasePacket({
      current_list_price_equivalent_u: {
        value: 100_003,
        unit: "micro_usd_list_equivalent",
        denominator: 10,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_aabb0000111122223333"],
        evidence_ids: ["ev_aabb0000111122223333"],
      },
      prior_list_price_equivalent_u: {
        value: 60_000,
        unit: "micro_usd_list_equivalent",
        denominator: 10,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_ccdd0000111122223333"],
        evidence_ids: ["ev_ccdd0000111122223333"],
      },
      comparison: {
        // delta deliberately set to 40_003 (not 100003-60000=40003, actually exact here).
        // To get a residual: set delta to 40_100 vs actual 40_003.
        value: { delta: 40_100, direction: "INCREASE" },
        unit: "micro_usd_list_equivalent_delta",
        denominator: 10,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_aabb0000111122223333", "ev_ccdd0000111122223333"],
        evidence_ids: ["ev_aabb0000111122223333", "ev_ccdd0000111122223333"],
      },
    });
    const result = composeOpportunities(packet);
    const family1 = asOpportunity(findFamily(result.families, "EXPLAIN_USAGE_CHANGE"));
    const decomp = (family1.detail as UsageChangeDetail).decomposition;
    // observed_delta_u = 40_100 (from comparison fact)
    // volume_term = 0 (equal turn counts)
    // intensity_term = 10 * (10000.3 - 6000) = 10 * 4000.3 = 40003
    // residual = 40100 - 40003 = 97
    expect(decomp.UNATTRIBUTED_RESIDUAL).not.toBe(0);
    const sum = decomp.volume_term + decomp.intensity_term + decomp.UNATTRIBUTED_RESIDUAL;
    expect(sum).toBeCloseTo(decomp.observed_delta_u, 6);
  });
});

describe("composeOpportunities — healthy and no-change outcomes", () => {
  it("family 1 → NO_CHANGE when comparison direction is UNCHANGED", () => {
    const packet = makeBasePacket({
      comparison: {
        value: { delta: 0, direction: "UNCHANGED" },
        unit: "micro_usd_list_equivalent_delta",
        denominator: 10,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_aabb0000111122223333"],
        evidence_ids: ["ev_aabb0000111122223333"],
      },
    });
    const result = composeOpportunities(packet);
    const f1 = findFamily(result.families, "EXPLAIN_USAGE_CHANGE");
    expect(f1?.outcome).toBe("NO_CHANGE");
  });

  it("family 2 → HEALTHY when no tool exceeds concentration threshold and no repeated failures", () => {
    // Three tools with roughly equal bytes (each ~33%) — none exceeds 50%.
    const packet = makeBasePacket({
      tool_observations: {
        value: [
          {
            tool_id: "tool_synthetic_xxx111",
            tool_class: "FILE_READ",
            event_count: 10,
            result_bytes_total: 100_000,
            failure_event_count: 0,
            recovered_after_failure_count: 0,
          },
          {
            tool_id: "tool_synthetic_yyy222",
            tool_class: "SEARCH",
            event_count: 10,
            result_bytes_total: 100_000,
            failure_event_count: 0,
            recovered_after_failure_count: 0,
          },
          {
            tool_id: "tool_synthetic_zzz333",
            tool_class: "SHELL",
            event_count: 5,
            result_bytes_total: 100_000,
            failure_event_count: 1,
            recovered_after_failure_count: 1,
          },
        ],
        unit: "tool_events",
        denominator: 10,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_aabb0000111122223333"],
        evidence_ids: ["ev_aabb0000111122223333"],
      },
    });
    const result = composeOpportunities(packet);
    const f2 = findFamily(result.families, "TOOL_OUTPUT_RETRY_CONCENTRATION");
    expect(f2?.outcome).toBe("HEALTHY");
  });

  it("family 3 → HEALTHY when cache hit ratio is high (efficient cached context)", () => {
    const packet = makeBasePacket({
      raw_token_buckets: {
        value: {
          input_tokens: 10_000,
          output_tokens: 5_000,
          cache_read_tokens: 90_000,
          cache_write_5m: 10_000,
          cache_write_1h: 0,
          cache_write_other: 0,
        },
        unit: "tokens",
        denominator: 40,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_aabb0000111122223333"],
        evidence_ids: ["ev_aabb0000111122223333"],
      },
    });
    const result = composeOpportunities(packet);
    const f3 = findFamily(result.families, "CONTEXT_CACHE_BEHAVIOR");
    expect(f3?.outcome).toBe("HEALTHY");
  });
});

describe("composeOpportunities — sparse history → INSUFFICIENT_EVIDENCE everywhere", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryFixtureDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns INSUFFICIENT_EVIDENCE for all families on a future-window packet with no data", () => {
    // Build a real packet from a window with no eligible data — far future.
    const sparsePacket = buildEvidencePacket(db, {
      workspaceId: "ws-alpha",
      from: "2031-01-01T00:00:00.000Z",
      to: "2031-01-01T03:00:00.000Z",
    });

    const result = composeOpportunities(sparsePacket);
    expect(result.families).toHaveLength(3);
    for (const family of result.families) {
      expect(family.outcome).toBe("INSUFFICIENT_EVIDENCE");
    }
    // Zero fabricated candidates — no OPPORTUNITY outcomes.
    const opportunities = result.families.filter((f) => f.outcome === "OPPORTUNITY");
    expect(opportunities).toHaveLength(0);
  });
});

describe("composeOpportunities — alternative explanations non-empty on OPPORTUNITY", () => {
  it("every OPPORTUNITY entry has a non-empty alternative_explanations array", () => {
    const packet = makeBasePacket();
    const result = composeOpportunities(packet);
    for (const family of result.families) {
      if (family.outcome === "OPPORTUNITY") {
        expect(family.alternative_explanations.length).toBeGreaterThan(0);
        for (const explanation of family.alternative_explanations) {
          expect(typeof explanation).toBe("string");
          expect(explanation.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("every OPPORTUNITY entry has a non-empty required_caveats array", () => {
    const packet = makeBasePacket();
    const result = composeOpportunities(packet);
    for (const family of result.families) {
      if (family.outcome === "OPPORTUNITY") {
        expect(family.required_caveats.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("composeOpportunities — incompatible prior → family 1 INSUFFICIENT_EVIDENCE", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryFixtureDb();
  });

  afterEach(() => {
    db.close();
  });

  it("family 1 is INSUFFICIENT_EVIDENCE when packet has no prior_window (incompatible prior)", () => {
    // Build a packet with incompatible prior (different workspace = incompatible).
    const packet = buildEvidencePacket(db, {
      workspaceId: "ws-alpha",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T03:00:00.000Z",
      prior: {
        workspaceId: "ws-beta",
        from: "2025-12-31T20:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      },
    });

    // Packet's prior_window should be null (incompatible).
    expect(packet.scope.prior_window).toBeNull();
    // comparison should be UNAVAILABLE.
    expect(packet.facts.comparison).toHaveProperty("state", "UNAVAILABLE");

    const result = composeOpportunities(packet);
    const f1 = asInsufficient(findFamily(result.families, "EXPLAIN_USAGE_CHANGE"));
    expect(typeof f1.unavailable_reason).toBe("string");
    expect(f1.unavailable_reason.length).toBeGreaterThan(0);
  });
});

describe("composeOpportunities — privacy: no raw tool names in output", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryFixtureDb();
  });

  afterEach(() => {
    db.close();
  });

  it("composer output contains no raw adversarial tool names from the packet", () => {
    const adversarialNames = [
      "MaliciousTool",
      "tool|break\nignore_previous_instructions",
      "C:\\private\\secret_tool.exe",
    ];
    // Insert adversarial tool events: first tool gets dominant bytes (>50%) so family 2
    // produces an OPPORTUNITY with tool_id/tool_class — verifying opaque output.
    const insertEvent = db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class, commit_sha) VALUES (?, 'sess-a1', ?, ?, 1, ?, NULL, 'OK', NULL)",
    );
    const byteCounts = [80_000, 10_000, 10_000];
    adversarialNames.forEach((name, i) => {
      insertEvent.run(`evt-adv-${i}`, "2026-01-01T00:05:00.000Z", name, byteCounts[i]);
    });

    const packet = buildEvidencePacket(db, {
      workspaceId: "ws-alpha",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T03:00:00.000Z",
    });

    const result = composeOpportunities(packet);
    const serialized = JSON.stringify(result);

    for (const name of adversarialNames) {
      expect(serialized).not.toContain(name);
      // Check JSON-escaped form too (backslash, newline escaping).
      expect(serialized).not.toContain(JSON.stringify(name).slice(1, -1));
    }
    // Should contain opaque tool_id and tool_class instead.
    expect(serialized).toContain("tool_id");
    expect(serialized).toContain("tool_class");
  });
});

describe("composeOpportunities — no savings/benefit field in output", () => {
  it("serialized output contains no savings or benefit estimate fields", () => {
    const packet = makeBasePacket();
    const result = composeOpportunities(packet);
    const serialized = JSON.stringify(result);

    const forbidden = [
      "savings",
      "benefit",
      "estimated_savings",
      "cost_saving",
      "roi",
      "projected",
    ];
    for (const field of forbidden) {
      // Check both camelCase and snake_case variants.
      expect(serialized.toLowerCase()).not.toContain(field);
    }
  });

  it("OpportunityEntry type has no savings or benefit field at runtime", () => {
    // Force a tool concentration OPPORTUNITY by adding a dominant tool.
    const packet = makeBasePacket({
      tool_observations: {
        value: [
          {
            tool_id: "tool_synthetic_dominant",
            tool_class: "FILE_READ",
            event_count: 50,
            result_bytes_total: 900_000,
            failure_event_count: 3,
            recovered_after_failure_count: 2,
          },
          {
            tool_id: "tool_synthetic_minor",
            tool_class: "SEARCH",
            event_count: 5,
            result_bytes_total: 10_000,
            failure_event_count: 0,
            recovered_after_failure_count: 0,
          },
        ],
        unit: "tool_events",
        denominator: 10,
        method: "riq1-evidence-packet-2",
        provenance: ["ev_aabb0000111122223333"],
        evidence_ids: ["ev_aabb0000111122223333"],
      },
    });
    const result = composeOpportunities(packet);
    const f2 = asOpportunity(findFamily(result.families, "TOOL_OUTPUT_RETRY_CONCENTRATION"));
    const keys = Object.keys(f2);
    expect(keys).not.toContain("savings");
    expect(keys).not.toContain("benefit");
    expect(keys).not.toContain("estimated_savings");
  });
});

describe("composeOpportunities — determinism", () => {
  it("produces deep-equal output on repeated calls with identical packet", () => {
    const packet = makeBasePacket();
    const first = composeOpportunities(packet);
    const second = composeOpportunities(packet);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("produces deep-equal output from a real builder packet on repeated calls", () => {
    const db = createInMemoryFixtureDb();
    try {
      const packet = buildEvidencePacket(db, {
        workspaceId: "ws-alpha",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-01T03:00:00.000Z",
      });
      const first = composeOpportunities(packet);
      const second = composeOpportunities(packet);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    } finally {
      db.close();
    }
  });
});

describe("composeOpportunities — output shape", () => {
  it("emits exactly 3 family entries (families 1–3 only)", () => {
    const packet = makeBasePacket();
    const result = composeOpportunities(packet);
    expect(result.families).toHaveLength(3);
    expect(result.families.map((f) => f.family)).toEqual([
      "EXPLAIN_USAGE_CHANGE",
      "TOOL_OUTPUT_RETRY_CONCENTRATION",
      "CONTEXT_CACHE_BEHAVIOR",
    ]);
  });

  it("echoes packet_identity_hash and scope in the composition", () => {
    const packet = makeBasePacket();
    const result = composeOpportunities(packet);
    expect(result.packet_identity_hash).toBe(packet.packet_identity_hash);
    expect(result.scope.workspace_id).toBe(packet.scope.workspace_id);
    expect(result.scope.current_window).toEqual(packet.scope.current_window);
    expect(result.composer_version).toBe("riq2-composer-1");
  });

  it("every OPPORTUNITY evidence_id exists in the packet overlap_groups or fact evidence_ids", () => {
    const packet = makeBasePacket();
    // Collect all evidence IDs from the packet.
    const packetEvidenceIds = new Set<string>();
    for (const fact of Object.values(packet.facts)) {
      if ("evidence_ids" in fact) {
        for (const id of (fact as { evidence_ids: string[] }).evidence_ids) {
          packetEvidenceIds.add(id);
        }
      }
    }
    for (const group of packet.overlap_groups) {
      packetEvidenceIds.add(group.evidence_id);
    }

    const result = composeOpportunities(packet);
    for (const family of result.families) {
      if (family.outcome === "OPPORTUNITY") {
        for (const eid of family.evidence_ids) {
          expect(packetEvidenceIds.has(eid)).toBe(true);
        }
      }
    }
  });
});
