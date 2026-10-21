/**
 * test/ui/glossary.test.tsx — NU5 "How to read this dashboard" glossary page.
 *
 * Asserts: all 8 concept sections render; the honesty-tier chips appear
 * verbatim (same labels the rest of the UI uses); the #/glossary route parses;
 * the page is reachable from the Sidebar; and the page renders in both themes.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHash } from "../../src/ui/App";
import GlossaryPage from "../../src/ui/glossary/GlossaryPage";
import Sidebar from "../../src/ui/nav/Sidebar";

// Verbatim chip labels as rendered elsewhere in the UI (Chip.KIND_LABEL).
// LIST_EQUIV and OBS_PROXY both render as "Estimate" after the foundation relabel;
// they share an aria-label, so they are checked separately with getAllByLabelText.
const TIER_CHIP_LABELS = ["MEASURED", "PROJECTED", "ESTIMATE", "TREND ONLY", "EARLY ESTIMATE"];

vi.mock("../../src/ui/api/client", () => ({
  fetchStatus: vi.fn().mockResolvedValue({ sessions: 3, files_seen: 1, files_parsed: 1 }),
  getLastFetchTimestamp: vi.fn().mockReturnValue(undefined),
}));

afterEach(() => cleanup());

const EXPECTED_SECTIONS = [
  "glossary-list-equiv",
  "glossary-honesty-tiers",
  "glossary-cache",
  "glossary-verdict",
  "glossary-friction",
  "glossary-offload",
  "glossary-percentiles",
  "glossary-linkage",
];

describe("NU5 — glossary page", () => {
  it("renders all 8 concept sections", () => {
    render(<GlossaryPage />);
    for (const id of EXPECTED_SECTIONS) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(EXPECTED_SECTIONS).toHaveLength(8);
  });

  it("returns from each definition to its specific hash-routed task surface", () => {
    render(<GlossaryPage />);

    const expectedDestinations = new Map([
      ["glossary-list-equiv", "#/overview"],
      ["glossary-honesty-tiers", "#/overview"],
      ["glossary-cache", "#/overview"],
      ["glossary-verdict", "#/overview"],
      ["glossary-friction", "#/sessions"],
      ["glossary-offload", "#/sessions"],
      ["glossary-percentiles", "#/sessions"],
      ["glossary-linkage", "#/workspaces"],
    ]);

    for (const [sectionId, href] of expectedDestinations) {
      const section = screen.getByTestId(sectionId);
      expect(section.querySelector("a")?.getAttribute("href")).toBe(href);
    }
  });

  it("renders the honesty-tier chips with verbatim labels", () => {
    render(<GlossaryPage />);
    // The tier chips share the same labels used everywhere else in the UI.
    for (const label of TIER_CHIP_LABELS) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    // LIST_EQUIV and OBS_PROXY both render as "Estimate" after the relabel — two chips share
    // this aria-label, so use getAllByLabelText.
    expect(screen.getAllByLabelText("Estimate").length).toBeGreaterThanOrEqual(2);
    // LOW CONFIDENCE is a literal chip, verbatim with BurnForecastCard/Settings.
    expect(screen.getByText("LOW CONFIDENCE")).toBeTruthy();
  });

  it("parses the #/glossary route", () => {
    expect(parseHash("#/glossary").route).toBe("glossary");
  });

  it("is reachable from the sidebar", () => {
    const onNavigate = vi.fn();
    render(<Sidebar active="overview" onNavigate={onNavigate} />);
    const link = screen.getByRole("link", { name: /how to read this dashboard/i });
    expect(link.getAttribute("href")).toBe("#/glossary");
    link.click();
    expect(onNavigate).toHaveBeenCalledWith("glossary");
  });

  it("renders in both themes", () => {
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.theme = theme;
      const { unmount } = render(<GlossaryPage />);
      expect(screen.getByTestId("glossary-honesty-tiers")).toBeTruthy();
      unmount();
    }
    document.documentElement.removeAttribute("data-theme");
  });
});
