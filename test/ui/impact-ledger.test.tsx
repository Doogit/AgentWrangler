/**
 * test/ui/impact-ledger.test.tsx — W4 Impact Ledger render rules (design §5).
 *
 * Covers the honesty rails: MODELED chip label ("MODELED · unverified
 * projection"), OBSERVED AFTER ADOPTION chip, MEASURING clock + probe-check
 * date (never a zero-like placeholder), MEASURED_NO_EFFECT conservative note,
 * confounded-window banner, and the COEFF caveat. Client is mocked.
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObservationBundle } from "../../src/effects/types";
import type { LedgerEntry } from "../../src/query/api/recommendations-ledger";
import * as client from "../../src/ui/api/client";
import { mockEfficiencyHeadroom, mockLedger } from "../../src/ui/api/fixtures";
import ImpactLedger from "../../src/ui/recommendations/ImpactLedger";
import { makeEffectCycle } from "./effect-cycle-fixture";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
});

/** Clone a fixture entry with partial overrides (deep where needed). */
function entryWith(overrides: Partial<LedgerEntry>): LedgerEntry {
  const base = mockLedger().data?.entries[0];
  if (base === undefined) throw new Error("mock ledger missing entries");
  return { ...base, ...overrides };
}

function mockOk(entries: LedgerEntry[]): void {
  const resp = mockLedger();
  vi.mocked(client.fetchLedger).mockResolvedValue({
    ...resp,
    data: { entries, cap_read_coeff: resp.data?.cap_read_coeff ?? 0.1 },
  });
}

describe("ImpactLedger — states", () => {
  it("shows aria-busy while loading", () => {
    vi.mocked(client.fetchLedger).mockReturnValue(new Promise(() => {}));
    const { container } = render(<ImpactLedger />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
  });

  it("shows an error banner when the daemon is unreachable", async () => {
    vi.mocked(client.fetchLedger).mockRejectedValue(new Error("ECONNREFUSED"));
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector(".banner-error")).not.toBeNull();
    });
  });
});

describe("ImpactLedger — honesty rails", () => {
  it("renders the projected-value chip next to the cap-weighted figure", async () => {
    mockOk([entryWith({ state: "MEASURED_EFFECTIVE" })]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector(".chip-modeled")).not.toBeNull();
    });
    expect(container.textContent ?? "").toContain("PROJECTED · not yet verified");
    expect(container.textContent ?? "").toContain("$0.42/wk");
  });

  it("uses the plain-language detector label in the ledger header", async () => {
    mockOk([entryWith({ detector_id: "D2" })]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector(".ledger-head strong")?.textContent).toContain(
        "Long sessions",
      );
    });
    expect(container.querySelector(".ledger-head strong")?.textContent).not.toMatch(/^D2\b/);
  });

  it("labels realized deltas 'OBSERVED AFTER ADOPTION' — never 'saved'", async () => {
    mockOk([entryWith({ state: "MEASURED_EFFECTIVE" })]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("OBSERVED AFTER ADOPTION");
    });
    expect(container.textContent ?? "").toContain("-38.0%");
    expect((container.textContent ?? "").toLowerCase()).not.toMatch(/\bsaved\b/);
  });

  it("legacy measuring rows stay read-only and never invent a deadline", async () => {
    const measuring = mockLedger().data?.entries[1];
    if (measuring === undefined) throw new Error("mock ledger missing measuring entry");
    mockOk([measuring]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("Legacy measurement (read-only)");
    });
    expect(container.textContent ?? "").not.toContain("Local check due after");
    expect(container.textContent ?? "").toContain("[MEASURING]");
  });

  it("gives a versioned cycle precedence over legacy state and effects", async () => {
    const entry = entryWith({ state: "ADOPTED" });
    entry.effect_cycle = makeEffectCycle({ state: "OPEN_MEASURING" });
    mockOk([entry]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => expect(container.textContent ?? "").toContain("OPEN MEASURING"));
    expect(container.textContent ?? "").toContain("Scheduled check: 2026-09-30");
    expect(container.textContent ?? "").not.toContain("Legacy target-metric result");
  });

  it("renders final versioned evidence, guardrails, comparison and lifecycle state", async () => {
    const mix = { available: true, total: 1, counts: {} };
    const aggregate = { value: 100, denominator: null, exposureN: 3, sessionN: 3, excluded: {} };
    const finalEvidence: ObservationBundle = {
      metricId: "avg_context_per_turn",
      methodVersion: "esf-1",
      queryDefinitionVersion: "esf-1",
      scopeFingerprint: "opaque",
      parserVersions: [],
      parserMix: { before: mix, after: mix },
      before: aggregate,
      after: { ...aggregate, value: 80 },
      modelMix: { before: mix, after: mix },
      toolMix: { before: mix, after: mix },
      taskMix: { before: mix, after: mix },
      guardrails: [
        {
          guardrailId: "latency",
          methodVersion: "esf-1",
          availability: "SUPPORTED",
          unit: "ms",
          before: aggregate,
          after: aggregate,
          direction: "ADVERSE",
          reasonCodes: [],
          evidence: {},
        },
        {
          guardrailId: "cost",
          methodVersion: "esf-1",
          availability: "UNSUPPORTED",
          unit: "usd",
          before: aggregate,
          after: aggregate,
          direction: "INSUFFICIENT_DATA",
          reasonCodes: [],
          evidence: {},
        },
        {
          guardrailId: "quality",
          methodVersion: "esf-1",
          availability: "SUPPORTED",
          unit: "score",
          before: aggregate,
          after: aggregate,
          direction: "INSUFFICIENT_DATA",
          reasonCodes: [],
          evidence: {},
        },
      ],
    };
    const entry = entryWith({ state: "ADOPTED", effects: [] });
    entry.effect_cycle = makeEffectCycle({
      state: "FINALIZED",
      finalEvidence,
      guardrailDefinitions: [
        { guardrailId: "latency", methodVersion: "esf-1", unit: "ms" },
        { guardrailId: "cost", methodVersion: "esf-1", unit: "usd" },
        { guardrailId: "quality", methodVersion: "esf-1", unit: "score" },
        { guardrailId: "coverage", methodVersion: "esf-1", unit: "ratio" },
      ],
      targetDirection: "IMPROVED",
      comparisonStatus: "CONFOUNDED",
      comparisonReasons: ["ROLLBACK_IN_WINDOW"],
      rollbackStatus: "USER_ATTESTED",
      rollbackAt: "2026-09-16T00:00:00.000Z",
      attributionClosedAt: "2026-09-17T00:00:00.000Z",
    });
    mockOk([entry]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => expect(container.textContent ?? "").toContain("Follow-up: 80 tokens"));
    expect(container.textContent ?? "").toContain("latency: adverse");
    expect(container.textContent ?? "").toContain("cost: unsupported");
    expect(container.textContent ?? "").toContain("quality: insufficient data");
    expect(container.textContent ?? "").toContain("coverage: visibility unavailable");
    expect(container.textContent ?? "").toContain("CONFOUNDED · ROLLBACK_IN_WINDOW");
    expect(container.textContent ?? "").toContain(
      "Rollback: USER_ATTESTED (2026-09-16) · Attribution: closed 2026-09-17",
    );
  });

  it("keeps unsupported versioned evidence read-only without interpreting it", async () => {
    const entry = entryWith({ effects: [] });
    entry.effect_cycle = makeEffectCycle({
      versionStatus: "UNSUPPORTED_VERSION",
      state: "FINALIZED",
    });
    mockOk([entry]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() =>
      expect(container.textContent ?? "").toContain("unsupported version (read-only)"),
    );
    expect(container.textContent ?? "").not.toContain("Target direction");
  });

  it("labels D5 acknowledgments as not measured and suppresses measurement rows", async () => {
    mockOk([entryWith({ detector_id: "D5", state: "ADOPTED", effects: [] })]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() =>
      expect(container.textContent ?? "").toContain("Acknowledged \u2014 not measured"),
    );
    expect(container.textContent ?? "").not.toContain("Measuring");
    expect(container.textContent ?? "").not.toContain("Baseline:");
  });

  it("MEASURED_NO_EFFECT carries the conservative-measurement note", async () => {
    const noEffect = entryWith({ state: "MEASURED_NO_EFFECT" });
    const baseEffect = noEffect.effects[0];
    if (baseEffect === undefined) throw new Error("mock entry missing effect");
    noEffect.effects = [{ ...baseEffect, verdict: "NO_EFFECT", delta_pct: -0.4 }];
    mockOk([noEffect]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("conservative");
    });
    expect(container.textContent ?? "").toContain(
      "No reliable reduction was detected in this period.",
    );
  });

  it("renders the confounded-window banner when confounded_window is true", async () => {
    mockOk([entryWith({ confounded_window: true })]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector(".banner-warn")).not.toBeNull();
    });
    expect(container.textContent ?? "").toContain("adopted within one day");
  });

  it("appends the COEFF caveat when cap_read_coeff < 1", async () => {
    mockOk([entryWith({})]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("COEFF=0.1");
    });
    expect(container.textContent ?? "").toContain("unverified");
  });

  it("shows 'Not enough data yet' instead of figures when before_n < 3", async () => {
    const thin = entryWith({
      detector_id: "D2",
      state: "MEASURED_NO_EFFECT",
      target_metric: "avg_context_per_turn",
    });
    const baseEffect = thin.effects[0];
    if (baseEffect === undefined) throw new Error("mock entry missing effect");
    thin.effects = [{ ...baseEffect, before_n: 2, qualification: "NOT_ENOUGH_DATA" }];
    mockOk([thin]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("Not enough data yet (need ≥3 observations)");
    });
  });

  it("renders D8 cache recs as a read/creation ratio line with a DIRECTIONAL chip (RI9)", async () => {
    const cache = entryWith({
      detector_id: "D8",
      state: "MEASURED_EFFECTIVE",
      target_metric: "cache_read_to_creation_ratio",
      modeled_savings_u_per_wk: null,
      modeled_cap_weighted_u_per_wk: null,
    });
    const baseEffect = cache.effects[0];
    if (baseEffect === undefined) throw new Error("mock entry missing effect");
    cache.effects = [
      {
        ...baseEffect,
        before_value: 1.0,
        after_value: 2.0,
        delta_pct: 100,
        verdict: "EFFECTIVE",
        qualification: null,
      },
    ];
    mockOk([cache]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("Cache read/creation ratio");
    });
    expect(container.textContent ?? "").toContain("1.00 → 2.00 (+100.0%)");
    expect(container.querySelector(".chip-directional")).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("tokens");
  });

  it("renders current D4 model_mix_opus_fraction rows as routing adherence points, not tokens", async () => {
    const routing = entryWith({
      detector_id: "D4",
      state: "MEASURED_EFFECTIVE",
      target_metric: "model_mix_opus_fraction",
      modeled_savings_u_per_wk: null,
      modeled_cap_weighted_u_per_wk: null,
    });
    const baseEffect = routing.effects[0];
    if (baseEffect === undefined) throw new Error("mock entry missing effect");
    routing.effects = [
      {
        ...baseEffect,
        before_value: 62,
        after_value: 75,
        delta_pct: 13,
        verdict: "EFFECTIVE",
      },
    ];
    mockOk([routing]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("Routing adherence");
    });
    expect(container.textContent ?? "").toContain("62% → 75% (+13 pts)");
    expect(container.textContent ?? "").toContain("does not claim dollar savings");
    expect(container.textContent ?? "").not.toContain("75 tokens");
  });
});
