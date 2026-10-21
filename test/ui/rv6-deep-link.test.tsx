/**
 * test/ui/rv6-deep-link.test.tsx — RV6 "Act on #1" deep link.
 *
 * Covers both ends of the deep link:
 *   - OverviewPage TopRecommendations: rank-1 content follows active[0], and its Details link
 *     focuses that recommendation on RecommendationsPage.
 *   - RecommendationsPage: arriving with focus=<rec_id> scrolls to, highlights,
 *     and auto-expands the target card (grouped + standalone); a stale focus
 *     degrades to the plain list with a quiet, dismissible notice.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import * as client from "../../src/ui/api/client";
import {
  mockBurnStatus,
  mockCacheWriteTrend,
  mockEfficiencyHeadroom,
  mockFlavorDecomposition,
  mockGlobalOverview,
  mockHeadroomTrend,
  mockHookConfigResponse,
  mockHotSessions,
  mockLedger,
  mockLimits,
  mockLinkageRate,
  mockLiveSessions,
  mockPractices,
  mockRecommendations,
  mockSuccessRate,
  mockTrends,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
import OverviewPage from "../../src/ui/overview/OverviewPage";
import { isQuantified } from "../../src/ui/overview/TopRecommendations";
import RecCard from "../../src/ui/recommendations/RecCard";
import RecommendationsPage from "../../src/ui/recommendations/RecommendationsPage";
import {
  fetchCacheWriteTrend,
  fetchFlavorDecomposition,
  fetchGlobalOverview,
  fetchLiveSessions,
  serveOverviewViewFromLegacyMocks,
} from "./overview/overview-view-from-legacy";

vi.mock("../../src/ui/api/client");
beforeEach(serveOverviewViewFromLegacyMocks);
vi.mock("../../src/ui/api/esf-client", () => ({
  fetchEsfObservations: vi.fn().mockResolvedValue({ data: null }),
}));
// GoalSelector and the recommendation cards mount on RecommendationsPage and call feedback-client
// on load. Mock the module so those calls resolve cleanly without touching global fetch.
vi.mock("../../src/ui/api/feedback-client", () => ({
  FeedbackClientError: class FeedbackClientError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
    ) {
      super(`Feedback request failed (${code}, HTTP ${status}).`);
      this.name = "FeedbackClientError";
    }
  },
  listFeedback: vi.fn().mockResolvedValue({ data: [], meta: { ts: 0 } }),
  setFeedback: vi.fn().mockResolvedValue({ data: {}, meta: { ts: 0 } }),
  undoFeedback: vi.fn().mockResolvedValue({ data: {}, meta: { ts: 0 } }),
  deleteFeedback: vi.fn().mockResolvedValue({ data: {}, meta: { ts: 0 } }),
  getGoal: vi.fn().mockResolvedValue({
    data: { scope_key: "__global__", goal: "PRESERVE_QUALITY" },
    meta: { ts: 0 },
  }),
  setGoal: vi.fn().mockResolvedValue({
    data: { scope_key: "__global__", goal: "PRESERVE_QUALITY" },
    meta: { ts: 0 },
  }),
  resetGoal: vi.fn().mockResolvedValue({
    data: { scope_key: "__global__", goal: "PRESERVE_QUALITY" },
    meta: { ts: 0 },
  }),
}));

const writeText = vi.fn().mockResolvedValue(undefined);

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
  window.location.hash = "";
  vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
  vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
  // OverviewPage API defaults (for tests that render OverviewPage via spotlight tests).
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
  vi.mocked(client.fetchSuccessRate).mockResolvedValue(mockSuccessRate());
  vi.mocked(client.fetchBurnStatus).mockResolvedValue(mockBurnStatus());
  vi.mocked(client.fetchHookConfig).mockResolvedValue(mockHookConfigResponse(false));
  vi.mocked(client.fetchHotSessions).mockResolvedValue(mockHotSessions());
  vi.mocked(client.fetchLimits).mockResolvedValue(mockLimits());
  vi.mocked(client.fetchLinkageRate).mockResolvedValue(mockLinkageRate());
  vi.mocked(client.fetchTrends).mockResolvedValue(mockTrends({ preset: "7d" }));
  fetchFlavorDecomposition.mockResolvedValue(mockFlavorDecomposition({ preset: "7d" }));
  fetchCacheWriteTrend.mockResolvedValue(mockCacheWriteTrend({ preset: "7d" }));
  vi.mocked(client.fetchHeadroomTrend).mockResolvedValue(mockHeadroomTrend({ preset: "7d" }));
});

/** Mocks the three overview fetch calls that require explicit fixture data to render. */
function setupOverviewApis() {
  fetchGlobalOverview.mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  fetchLiveSessions.mockResolvedValue(mockLiveSessions());
}

/** A D1 (artifact/copy-route) rec whose evidence yields a non-null prompt artifact. */
function makeD1Rec(overrides: Partial<RecommendationCard> = {}): RecommendationCard {
  const response = mockRecommendations();
  if (response.data === null) throw new Error("expected recommendations fixture data");
  const base = response.data.active[0];
  if (!base) throw new Error("expected an active recommendation fixture");
  return {
    ...base,
    rec_id: "rec-D1-focus-target",
    detector_id: "D1",
    category: "CONTEXT",
    title: "Trim always-loaded memory",
    modeled_savings_u_per_wk: 5_000_000,
    evidence: {
      source_tokens: 21_300,
      source_target: 8_000,
      delta_context_tokens: 13_300,
      component: "CLAUDE.md",
    },
    file_ref: "/repo/CLAUDE.md",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// OverviewPage rank-1 recommendation — active[0] (U4.2)
// ---------------------------------------------------------------------------
// TopRecommendations preserves active order and links by rec_id focus.
describe("OverviewPage top recommendations — RV6 deep link", () => {
  it("rank-1 row shows the title/lever of active[0]", async () => {
    setupOverviewApis();
    render(<OverviewPage />);
    const row = await screen.findByTestId("top-rec-1");
    expect(row.classList.contains("overview-top-rec-row")).toBe(true);
    const heading = row.querySelector("h3");
    const recs = mockRecommendations();
    if (recs.data === null) throw new Error("expected fixture data");
    // Top-3 eligibility skips unquantified recs; rank 1 is the first quantified active rec.
    const active0 = recs.data.active.find(isQuantified);
    if (!active0) throw new Error("expected active[0] fixture");
    expect(heading?.textContent).toBe(active0.title ?? active0.lever);
  });

  it("rank-1 title link deep-links by rec_id of active[0]", async () => {
    setupOverviewApis();
    render(<OverviewPage />);
    const row = await screen.findByTestId("top-rec-1");
    const link = row.querySelector("h3 a");
    const recs = mockRecommendations();
    if (recs.data === null) throw new Error("expected fixture data");
    const active0 = recs.data.active.find(isQuantified);
    if (!active0) throw new Error("expected active[0] fixture");
    expect(link?.getAttribute("href")).toBe(
      `#/recommendations?focus=${encodeURIComponent(active0.rec_id)}`,
    );
  });

  it("recommendations section shows no raw token counts", async () => {
    // OV-2 intentionally shows modeled dollar savings per week, but not raw evidence token counts.
    setupOverviewApis();
    render(<OverviewPage />);
    const row = await screen.findByTestId("top-rec-1");
    const section = row.closest("section");
    expect(section?.textContent).not.toMatch(/\b(?:21[,.]?300|13[,.]?300|21\.3K)\b/i);
    expect(section?.textContent).not.toMatch(/\b\d[\d,.]*\s*(?:tokens?|tok)\b/i);
  });

  it("shows 'No active recommendations' link when active is empty", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected fixture data");
    response.data.active = [];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
    setupOverviewApis();

    render(<OverviewPage />);
    const link = await screen.findByRole("link", { name: "No active recommendations" });
    expect(link?.textContent).toBe("No active recommendations");
    expect(link?.getAttribute("href")).toBe("#/recommendations");
  });
});

// ---------------------------------------------------------------------------
// RecommendationsPage — focus handling
// ---------------------------------------------------------------------------
describe("RecommendationsPage — RV6 focus handling", () => {
  it("highlights a focused limit warning and allows clearing its focus", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    response.data.limit_warnings = [
      makeD1Rec({
        rec_id: "warning-focus",
        detector_id: "D5",
        modeled_savings_u_per_wk: null,
        modeled_formula: { ...makeD1Rec().modeled_formula, kind: "WARNING" },
      }),
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
    window.location.hash = "#/recommendations?focus=warning-focus";
    const { container } = render(<RecommendationsPage />);
    await waitFor(() => expect(container.querySelector(".limit-warning-strip")).not.toBeNull());
    const warning = container.querySelector(".limit-warning-strip .rec-focus-highlight");
    expect(warning).not.toBeNull();
    const dismiss = warning?.querySelector<HTMLButtonElement>(".rec-focus-dismiss");
    expect(dismiss).toBeTruthy();
    fireEvent.click(dismiss as HTMLButtonElement);
    expect(window.location.hash).not.toContain("focus=");
    await waitFor(() => expect(container.querySelector(".rec-focus-highlight")).toBeNull());
  });

  it("lands on the expanded, highlighted focused card", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const recA = makeD1Rec({ rec_id: "rec-D1-a", title: "Trim A" });
    const recB = makeD1Rec({ rec_id: "rec-D1-b", title: "Trim B" });
    response.data.active = [recA, recB];
    response.data.active_groups = [
      {
        detector_id: "D1",
        label: "CLAUDE.md / memory",
        recs: [recA, recB],
        session_count: 2,
        total_savings_u_per_wk:
          (recA.modeled_savings_u_per_wk ?? 0) + (recB.modeled_savings_u_per_wk ?? 0),
      },
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    window.location.hash = "#/recommendations?focus=rec-D1-b";
    const { container } = render(<RecommendationsPage />);

    await waitFor(() => {
      expect(container.querySelector("[data-detector-id='D1']")).not.toBeNull();
    });

    // The focused member is promoted to the spotlight card (selectedRec), so it
    // is visible at rest — the old collapsing queue is gone (UIP-7).
    const focusedCard = container.querySelector(".rec-focus-highlight");
    expect(focusedCard).not.toBeNull();
    expect(container.querySelector(".recs-remaining-queue")).toBeNull();
    expect(container.querySelector(".rec-focus-banner")).not.toBeNull();
    expect(window.location.hash).toContain("focus=rec-D1-b");

    // Exactly the focused member is auto-expanded.
    const expandedButtons = container.querySelectorAll(
      "button.rec-expand-btn[aria-expanded='true']",
    );
    expect(expandedButtons).toHaveLength(1);
    expect(container.querySelectorAll(".rec-details")).toHaveLength(1);
    // No stale notice on a valid focus.
    expect(container.querySelector(".recs-focus-notice")).toBeNull();
  });

  it("dismissing the highlight clears the focus param", async () => {
    const rec = makeD1Rec({ rec_id: "rec-D1-only" });
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    response.data.active = [rec];
    response.data.active_groups = [
      {
        detector_id: "D1",
        label: "CLAUDE.md / memory",
        recs: [rec],
        session_count: 1,
        total_savings_u_per_wk: rec.modeled_savings_u_per_wk ?? 0,
      },
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    window.location.hash = "#/recommendations?focus=rec-D1-only";
    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelector(".rec-focus-banner")).not.toBeNull();
    });

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".rec-focus-dismiss") as HTMLElement,
    );
    expect(window.location.hash).not.toContain("focus=");
  });

  it("degrades a stale focus id to the plain list with a quiet, dismissible notice", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    window.location.hash = "#/recommendations?focus=rec-does-not-exist";
    const { container } = render(<RecommendationsPage />);

    await waitFor(() => {
      expect(container.querySelector(".recs-focus-notice")).not.toBeNull();
    });
    // Plain list still renders; nothing highlighted.
    expect(container.querySelector(".rec-card")).not.toBeNull();
    expect(container.querySelector(".rec-focus-highlight")).toBeNull();
    expect(container.querySelector(".rec-focus-banner")).toBeNull();

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".recs-focus-notice-dismiss") as HTMLElement,
    );
    expect(window.location.hash).not.toContain("focus=");
  });
});

// ---------------------------------------------------------------------------
// RecCard — standalone (ungrouped) focus
// ---------------------------------------------------------------------------
describe("RecCard — RV6 standalone focus", () => {
  it("highlights and auto-expands a standalone card when it is the focus target", () => {
    const rec = makeD1Rec({ rec_id: "rec-standalone" });
    const { container } = render(<RecCard rec={rec} focusRecId="rec-standalone" />);

    const card = container.querySelector(".rec-card");
    expect(card?.className).toContain("rec-focus-highlight");
    expect(container.querySelector(".rec-focus-banner")).not.toBeNull();
    expect(container.querySelector("button.rec-expand-btn[aria-expanded='true']")).not.toBeNull();
    expect(container.querySelector(".rec-details")).not.toBeNull();
  });

  it("does not highlight a standalone card when it is not the focus target", () => {
    const rec = makeD1Rec({ rec_id: "rec-standalone" });
    const { container } = render(<RecCard rec={rec} focusRecId="some-other-rec" />);
    expect(container.querySelector(".rec-focus-highlight")).toBeNull();
    expect(container.querySelector(".rec-focus-banner")).toBeNull();
    expect(container.querySelector("button.rec-expand-btn[aria-expanded='true']")).toBeNull();
  });
});
