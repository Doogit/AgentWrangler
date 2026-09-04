/**
 * test/ui/practices-section.test.tsx — BM1 practice scorecard render tests.
 *
 * Covers:
 *   - Renders 8 rows (one per practice).
 *   - An ATTENTION row with artifact_link exposes a hash-route nav target.
 *   - Trend-only rows (threshold.value === null) show the DIRECTIONAL chip.
 *   - Source link + date present for each row.
 *   - VERIFIED_SOURCE chip present on each citation.
 *   - No authored advice sentences (§0.5.1 parity bar).
 *   - Loading state shows aria-busy; error state shows a banner.
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockPractices } from "../../src/ui/api/fixtures";
import PracticesSection from "../../src/ui/recommendations/PracticesSection";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

describe("PracticesSection — states", () => {
  it("shows aria-busy while loading", () => {
    vi.mocked(client.fetchPractices).mockReturnValue(new Promise(() => {}));
    const { container } = render(<PracticesSection />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(container.querySelector(".banner-error")).toBeNull();
  });

  it("shows an error banner when the fetch fails", async () => {
    vi.mocked(client.fetchPractices).mockRejectedValue(new Error("ECONNREFUSED"));
    const { container } = render(<PracticesSection />);
    await waitFor(() => {
      expect(container.querySelector(".banner-error")).not.toBeNull();
    });
    expect(container.textContent ?? "").toContain("Practices unavailable");
  });
});

describe("PracticesSection — row rendering", () => {
  it("renders 8 practice rows", async () => {
    vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
    const { container } = render(<PracticesSection />);
    await waitFor(() => {
      expect(container.querySelectorAll(".practice-row")).toHaveLength(8);
    });
  });

  it("renders status chips for each row (PASS / ATTENTION / NO DATA)", async () => {
    vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
    const { container } = render(<PracticesSection />);
    await waitFor(() => {
      expect(container.querySelector(".practice-row")).not.toBeNull();
    });
    // At least one PASS, one ATTENTION, one NO DATA
    const text = container.textContent ?? "";
    expect(text).toContain("PASS");
    expect(text).toContain("ATTENTION");
    expect(text).toContain("NO DATA");
  });

  it("renders a VERIFIED SOURCE chip on each row citation", async () => {
    vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
    const { container } = render(<PracticesSection />);
    await waitFor(() => {
      expect(container.querySelectorAll(".practice-row")).toHaveLength(8);
    });
    // Each row has a VERIFIED SOURCE chip
    const verifiedChips = container.querySelectorAll(".practice-citation .chip-list-equiv");
    expect(verifiedChips.length).toBe(8);
  });

  it("renders source link and date for each row", async () => {
    vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
    const { container } = render(<PracticesSection />);
    await waitFor(() => {
      expect(container.querySelectorAll(".practice-source-link")).toHaveLength(8);
    });
    // Each link opens in a new tab
    const links = container.querySelectorAll(".practice-source-link");
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
    }
    // Dates are visible
    const text = container.textContent ?? "";
    expect(text).toContain("2026-04-30");
    expect(text).toContain("2026-09-02");
  });

  it("shows the DIRECTIONAL chip for trend-only rows (threshold.value === null)", async () => {
    vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
    const { container } = render(<PracticesSection />);
    await waitFor(() => {
      expect(container.querySelector(".practice-directional")).not.toBeNull();
    });
    // The fixture has P3, P4, P6, P7, P8 as trend-only (threshold.value === null).
    // DIRECTIONAL chips must be present.
    const directionalChips = container.querySelectorAll(".practice-directional .chip-directional");
    // Exactly the 5 trend-only rows above — not "≥5", so a bug marking PASS/ATTENTION
    // rows DIRECTIONAL is caught.
    expect(directionalChips.length).toBe(5);
  });

  it("exposes a hash-route nav target on ATTENTION rows with artifact_link", async () => {
    vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
    const { container } = render(<PracticesSection />);
    await waitFor(() => {
      expect(container.querySelector(".practice-open-link")).not.toBeNull();
    });
    // P2 has status ATTENTION and artifact_link="/recommendations"
    const p2 = container.querySelector("[data-practice-id='P2']");
    expect(p2).not.toBeNull();
    const link = p2?.querySelector(".practice-open-link");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("#/recommendations");
  });

  it("does not expose a nav link on rows where artifact_link is null", async () => {
    vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
    const { container } = render(<PracticesSection />);
    await waitFor(() => {
      expect(container.querySelectorAll(".practice-row")).toHaveLength(8);
    });
    // P1 has artifact_link null
    const p1 = container.querySelector("[data-practice-id='P1']");
    expect(p1?.querySelector(".practice-open-link")).toBeNull();
  });

  it("renders each practice statement verbatim (no authored advice added)", async () => {
    vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
    const { container } = render(<PracticesSection />);
    await waitFor(() => {
      expect(container.querySelector(".practice-statement")).not.toBeNull();
    });
    // Spot-check: P1 statement is the registry sentence
    const p1 = container.querySelector("[data-practice-id='P1'] .practice-statement");
    expect(p1?.textContent).toContain("cache-read health");
    // No authored "you should" advice sentences
    const text = container.textContent ?? "";
    expect(text.toLowerCase()).not.toContain("you should");
  });
});
