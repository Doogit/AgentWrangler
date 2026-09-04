/**
 * test/ui/efficiency-headroom.test.tsx — BM2 efficiency headroom in ImpactLedger.
 *
 * Covers:
 *   - null headroom_pct renders the honest empty state (no NaN / ∞).
 *   - A known fixture renders the expected percentage.
 *   - No "$X wasted" / "$X saved" headline (INT-5 guard).
 *   - Framed as "Modeled headroom" / "modeled ceiling".
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "../../src/query/api/recommendations-ledger";
import * as client from "../../src/ui/api/client";
import {
  mockEfficiencyHeadroom,
  mockEfficiencyHeadroomNull,
  mockLedger,
} from "../../src/ui/api/fixtures";
import ImpactLedger from "../../src/ui/recommendations/ImpactLedger";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());

function entryWith(overrides: Partial<LedgerEntry>): LedgerEntry {
  const base = mockLedger().data?.entries[0];
  if (base === undefined) throw new Error("mock ledger missing entries");
  return { ...base, ...overrides };
}

function mockLedgerOk(entries: LedgerEntry[]): void {
  const resp = mockLedger();
  vi.mocked(client.fetchLedger).mockResolvedValue({
    ...resp,
    data: { entries, cap_read_coeff: resp.data?.cap_read_coeff ?? 0.1 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLedgerOk([entryWith({})]);
});

describe("HeadroomSummary — known fixture", () => {
  it("renders the headroom percentage from the fixture (~35%)", async () => {
    vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='headroom-summary']")).not.toBeNull();
    });
    const text = container.textContent ?? "";
    // headroom_u_per_wk / actual_u_per_wk = 2_450_000 / 7_000_000 ≈ 35%
    // Exact phrase, not bare "35%", so a unit-scale bug rendering "135%" is caught.
    expect(text).toContain("35% of trailing spend");
  });

  it("caps the display at '>100%' when modeled savings exceed trailing spend", async () => {
    const over = mockEfficiencyHeadroom();
    if (over.data === null) throw new Error("fixture must have data");
    over.data = { ...over.data, headroom_pct: 3.0 }; // 300% — modeled > actual
    vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(over);
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='headroom-summary']")).not.toBeNull();
    });
    const text = container.textContent ?? "";
    expect(text).toContain(">100% of trailing spend");
    expect(text).not.toContain("300%");
  });

  it("frames output as 'Modeled headroom' — never a dollar-headline (INT-5)", async () => {
    vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='headroom-summary']")).not.toBeNull();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Modeled headroom");
    // INT-5: never a bare $X wasted / $X saved headline
    expect(text.toLowerCase()).not.toMatch(/\$[\d.]+\s*wasted/);
    expect(text.toLowerCase()).not.toMatch(/\$[\d.]+\s*saved/);
  });

  it("shows the open rec count from the fixture", async () => {
    vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='headroom-summary']")).not.toBeNull();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("3 open recs");
  });
});

describe("HeadroomSummary — null headroom_pct", () => {
  it("renders the honest empty state when headroom_pct is null — no NaN or ∞", async () => {
    vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroomNull());
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='headroom-summary']")).not.toBeNull();
    });
    const text = container.textContent ?? "";
    // Must not produce NaN or ∞
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
    expect(text).not.toContain("∞");
    // Must render an honest empty state
    expect(text).toContain("not enough data to estimate");
  });

  it("zero-spend scenario does not divide by zero", async () => {
    vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroomNull());
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='headroom-summary']")).not.toBeNull();
    });
    const summaryEl = container.querySelector("[data-testid='headroom-summary']");
    const summaryText = summaryEl?.textContent ?? "";
    // The headroom row must render without crashing
    expect(summaryText).toContain("Modeled headroom");
    // pctDisplay for null case renders the empty-state, not a numeric percentage
    expect(summaryText).not.toMatch(/\d+%/);
    expect(summaryText).toContain("not enough data to estimate");
  });
});

describe("HeadroomSummary — fetch failure", () => {
  it("silently hides the headroom row when the endpoint is unavailable", async () => {
    vi.mocked(client.fetchEfficiencyHeadroom).mockRejectedValue(new Error("network error"));
    const { container } = render(<ImpactLedger />);
    // Ledger renders ok; headroom row just doesn't appear
    await waitFor(() => {
      expect(container.querySelector(".impact-ledger")).not.toBeNull();
    });
    // No headroom summary should be present on fetch error
    expect(container.querySelector("[data-testid='headroom-summary']")).toBeNull();
  });
});
