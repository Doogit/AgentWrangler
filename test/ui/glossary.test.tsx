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
const TIER_CHIP_LABELS = [
  "EXACT",
  "LIST_EQUIV",
  "MODELED",
  "PROXY",
  "OBS PROXY ±9% BPE",
  "DIRECTIONAL",
  "EXPERIMENTAL",
];

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

  it("renders the honesty-tier chips with verbatim labels", () => {
    render(<GlossaryPage />);
    // The tier chips share the same labels used everywhere else in the UI.
    for (const label of TIER_CHIP_LABELS) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    // LOW CONFIDENCE is a literal chip, verbatim with BurnForecastCard/Settings.
    expect(screen.getByText("LOW CONFIDENCE")).toBeTruthy();
  });

  it("parses the #/glossary route", () => {
    expect(parseHash("#/glossary").route).toBe("glossary");
  });

  it("is reachable from the sidebar", () => {
    const onNavigate = vi.fn();
    render(<Sidebar active="overview" onNavigate={onNavigate} />);
    const link = screen.getByRole("button", { name: /how to read this dashboard/i });
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
