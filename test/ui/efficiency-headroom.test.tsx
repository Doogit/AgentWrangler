/**
 * test/ui/efficiency-headroom.test.tsx — BM2 efficiency headroom in ImpactLedger.
 *
 * Covers:
 *   - Individual modeled opportunities render without a misleading combined percentage.
 *   - Missing opportunity coverage renders the honest empty state (no NaN / ∞).
 *   - No "$X wasted" / "$X saved" headline (INT-5 guard).
 *   - Framed as "Possible improvement" / "early upper estimate".
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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

describe("HeadroomSummary — individual opportunities", () => {
  it("renders individual modeled opportunities without a combined percentage", async () => {
    const response = mockEfficiencyHeadroom();
    if (response.data === null) throw new Error("fixture must have data");
    response.data = {
      ...response.data,
      opportunities: [
        { rec_id: "rec-a", modeled_savings_u_per_wk: 2_450_000 },
        { rec_id: "rec-b", modeled_savings_u_per_wk: 500_000 },
      ],
      headroom_pct: null,
    };
    vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(response);
    const { container, getByRole } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='headroom-summary']")).not.toBeNull();
    });
    expect(container.querySelector("table")).toBeNull();
    fireEvent.click(getByRole("button", { name: "See breakdown →" }));
    const text = getByRole("table").textContent ?? "";
    expect(text).toContain("rec-a");
    expect(text).toContain("rec-b");
    expect(text).toContain("$2.45/wk");
    expect(text).toContain("$0.50/wk");
    expect(text).not.toMatch(/\d+% of trailing spend/);
  });

  it("explains when an empty opportunity list has no breakdown", async () => {
    const over = mockEfficiencyHeadroom();
    if (over.data === null) throw new Error("fixture must have data");
    over.data = { ...over.data, opportunities: [], headroom_pct: 3.0, open_rec_count: 0 };
    vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(over);
    const { container, queryByRole } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='headroom-summary']")).not.toBeNull();
    });
    const text = container.textContent ?? "";
    expect(text).not.toContain("300%");
    expect(text).toContain("No individual modeled opportunities are available");
    expect(queryByRole("button", { name: "See breakdown →" })).toBeNull();
  });

  it("frames output as 'Possible improvement' — never a dollar-headline (INT-5)", async () => {
    vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='headroom-summary']")).not.toBeNull();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Possible improvement");
    // INT-5: never a bare $X wasted / $X saved headline
    expect(text.toLowerCase()).not.toMatch(/\$[\d.]+\s*wasted/);
    expect(text.toLowerCase()).not.toMatch(/\$[\d.]+\s*saved/);
  });

  it("counts the open modeled opportunities in the summary line", async () => {
    vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
    const { container } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='headroom-summary']")).not.toBeNull();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("1 open modeled opportunity");
  });
});

describe("HeadroomSummary — unavailable opportunity coverage", () => {
  it("renders unavailable coverage when opportunities are absent — no NaN or ∞", async () => {
    vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroomNull());
    const { container, queryByRole } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='headroom-summary']")).not.toBeNull();
    });
    const text = container.textContent ?? "";
    // Must not produce NaN or ∞
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
    expect(text).not.toContain("∞");
    expect(text).toContain("Individual modeled estimates were not provided");
    expect(queryByRole("button", { name: "See breakdown →" })).toBeNull();
  });

  it("zero-spend scenario does not divide by zero", async () => {
    vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroomNull());
    const { container, queryByRole } = render(<ImpactLedger />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='headroom-summary']")).not.toBeNull();
    });
    const summaryEl = container.querySelector("[data-testid='headroom-summary']");
    const summaryText = summaryEl?.textContent ?? "";
    // The headroom row must render without crashing
    expect(summaryText).toContain("Possible improvement");
    // Missing legacy opportunity coverage never renders a numeric percentage.
    expect(summaryText).not.toMatch(/\d+%/);
    expect(summaryText).toContain("Individual modeled estimates were not provided");
    expect(queryByRole("button", { name: "See breakdown →" })).toBeNull();
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
