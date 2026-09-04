/**
 * test/ui/settings-bm4.test.tsx — BM4: Benchmark anchors panel.
 *
 * Covers:
 *   - Avg anchor ($13/day) renders with citation + date
 *   - P90 anchor ($30/day) renders with citation + date
 *   - Not-like-for-like caveat is present
 *   - Own $/active-day is derived correctly from trend fixture (deterministic)
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockSettings } from "../../src/ui/api/fixtures";
import AnchorsPanel from "../../src/ui/settings/AnchorsPanel";

vi.mock("../../src/ui/api/client");

// Deterministic trend buckets:
// active days: 2026-08-17 (1_200_000 µUSD, 45 turns), 2026-08-19 (2_100_000, 72), 2026-08-21 (1_560_000, 59)
// inactive day: 2026-08-20 (750_000, turns=0 — excluded by turns>0 filter)
// Wait — the fixture has turns > 0 for all days. Let's make our own controlled fixture.
const TREND_BUCKETS = [
  { bucket: "2026-08-17", cost_equiv_u: 1_200_000, turns: 45 },
  { bucket: "2026-08-18", cost_equiv_u: 2_400_000, turns: 72 },
  { bucket: "2026-08-19", cost_equiv_u: 0, turns: 0 }, // inactive — excluded
];
// active buckets: [1_200_000, 2_400_000] → mean = 1_800_000 µUSD → $1.80/day
const EXPECTED_OWN_USD = (1_200_000 + 2_400_000) / 2 / 1_000_000; // 1.80

function mockTrendFixture() {
  vi.mocked(client.fetchTrends).mockResolvedValue({
    data: {
      bucket: "day",
      buckets: TREND_BUCKETS,
      by_model: [],
      by_workspace: [],
      sessions: [],
      cap_weighted: [],
      cap_read_coeff: 1,
      adoption_markers: [],
    },
    meta: mockSettings().meta,
  });
}

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  mockTrendFixture();
});

describe("AnchorsPanel — benchmark anchors", () => {
  it("renders avg anchor with value, citation and fetched date", async () => {
    render(<AnchorsPanel />);
    await waitFor(() => {
      const text = document.body.textContent ?? "";
      // $13/day value
      expect(text).toMatch(/\$13\/day/);
      // citation date
      expect(text).toMatch(/2026-09-02/);
    });
    // citation link present
    const links = screen.getAllByRole("link");
    const citationLink = links.find((l) => l.getAttribute("href")?.includes("code.claude.com"));
    expect(citationLink).not.toBeUndefined();
  });

  it("renders p90 anchor with value, citation and fetched date", async () => {
    render(<AnchorsPanel />);
    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/\$30\/day/);
      expect(text).toMatch(/2026-09-02/);
    });
  });

  it("renders the not-like-for-like caveat", async () => {
    render(<AnchorsPanel />);
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/not a like-for-like/i);
    });
  });

  it("derives own $/active-day correctly from trend fixture", async () => {
    render(<AnchorsPanel />);
    // EXPECTED_OWN_USD = $1.80
    await waitFor(() => {
      const el = screen.getByLabelText("own active day cost value");
      expect(el.textContent).toBe(`$${EXPECTED_OWN_USD.toFixed(2)}`);
    });
  });
});
