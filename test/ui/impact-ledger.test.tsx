/**
 * test/ui/impact-ledger.test.tsx — W4 Impact Ledger render rules (design §5).
 *
 * Covers the honesty rails: MODELED chip label ("MODELED · unverified
 * projection"), OBSERVED SINCE ADOPTION chip, MEASURING clock + probe-check
 * date (never a zero-like placeholder), MEASURED_NO_EFFECT conservative note,
 * confounded-window banner, and the COEFF caveat. Client is mocked.
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "../../src/query/api/recommendations-ledger";
import * as client from "../../src/ui/api/client";
import { mockEfficiencyHeadroom, mockLedger } from "../../src/ui/api/fixtures";
import ImpactLedger from "../../src/ui/recommendations/ImpactLedger";

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
  it("renders the MODELED chip as 'MODELED · unverified projection' next to the cap-weighted figure", async () => {
    mockOk([entryWith({ state: "MEASURED_EFFECTIVE" })]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector(".chip-modeled")).not.toBeNull();
    });
    expect(container.textContent ?? "").toContain("MODELED · unverified projection");
    expect(container.textContent ?? "").toContain("$0.42/wk");
  });

  it("uses the human detector group label in the ledger header", async () => {
    mockOk([entryWith({ detector_id: "D2" })]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector(".ledger-head strong")?.textContent).toContain(
        "Session hygiene",
      );
    });
    expect(container.querySelector(".ledger-head strong")?.textContent).not.toMatch(/^D2\b/);
  });

  it("labels realized deltas 'OBSERVED SINCE ADOPTION' — never 'saved'", async () => {
    mockOk([entryWith({ state: "MEASURED_EFFECTIVE" })]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("OBSERVED SINCE ADOPTION");
    });
    expect(container.textContent ?? "").toContain("-38.0%");
    expect((container.textContent ?? "").toLowerCase()).not.toMatch(/\bsaved\b/);
  });

  it("MEASURING shows the clock + probe-check date, never a zero-like placeholder", async () => {
    const measuring = mockLedger().data?.entries[1];
    if (measuring === undefined) throw new Error("mock ledger missing measuring entry");
    mockOk([measuring]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("Probe checking after");
    });
    expect(container.textContent ?? "").toContain("2026-09-04");
    // No bare em-dash / zero placeholder on the realized line.
    expect(container.textContent ?? "").not.toContain("Realized (observed)—");
    expect(container.textContent ?? "").toContain("Measuring");
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
    expect(container.textContent ?? "").toContain("No signal in this window.");
  });

  it("renders the confounded-window banner when confounded_window is true", async () => {
    mockOk([entryWith({ confounded_window: true })]);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector(".banner-warn")).not.toBeNull();
    });
    expect(container.textContent ?? "").toContain("adopted within 1 day");
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
    expect(container.textContent ?? "").toContain("dollar savings are not asserted");
    expect(container.textContent ?? "").not.toContain("75 tokens");
  });
});
