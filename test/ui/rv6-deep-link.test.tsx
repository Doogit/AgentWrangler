/**
 * test/ui/rv6-deep-link.test.tsx — RV6 "Act on #1" deep link.
 *
 * Covers both ends of the deep link:
 *   - VerdictBand: inline "Copy fix prompt" copies the SAME artifact as the
 *     rec card's Copy-prompt action, and "Open rec →" targets
 *     #/recommendations?focus=<rec_id>.
 *   - RecommendationsPage: arriving with focus=<rec_id> scrolls to, highlights,
 *     and auto-expands the target card (grouped + standalone); a stale focus
 *     degrades to the plain list with a quiet, dismissible notice.
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import * as client from "../../src/ui/api/client";
import {
  mockEfficiencyHeadroom,
  mockLedger,
  mockPractices,
  mockRecommendations,
} from "../../src/ui/api/fixtures";
import VerdictBand from "../../src/ui/overview/VerdictBand";
import RecCard from "../../src/ui/recommendations/RecCard";
import RecommendationsPage from "../../src/ui/recommendations/RecommendationsPage";
import { buildPromptArtifact } from "../../src/ui/recommendations/prompt-templates";

vi.mock("../../src/ui/api/client");

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
});

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
// VerdictBand — inline copy + deep link
// ---------------------------------------------------------------------------
describe("VerdictBand — RV6 deep link", () => {
  it("Copy fix prompt copies the same artifact as the rec card's action", () => {
    const rec = makeD1Rec();
    const expected = buildPromptArtifact(rec);
    if (expected === null) throw new Error("expected a prompt artifact for the fixture rec");

    // The card's own Copy-prompt action renders the same artifact text.
    const card = render(<RecCard rec={rec} />);
    const cardText = card.container.querySelector<HTMLTextAreaElement>(
      ".rec-prompt-artifact textarea",
    )?.value;
    expect(cardText).toBe(expected.text);
    card.unmount();

    const { getByRole } = render(
      <VerdictBand
        preset="7d"
        trend={null}
        priorTrend={null}
        isLoading={false}
        topRecommendation={rec}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Copy fix prompt" }));
    expect(writeText).toHaveBeenCalledWith(expected.text);
  });

  it("Open rec → targets #/recommendations?focus=<rec_id>", () => {
    const rec = makeD1Rec();
    const { getByRole } = render(
      <VerdictBand
        preset="7d"
        trend={null}
        priorTrend={null}
        isLoading={false}
        topRecommendation={rec}
      />,
    );
    const link = getByRole("link", { name: "Open rec →" });
    expect(link.getAttribute("href")).toBe(
      `#/recommendations?focus=${encodeURIComponent(rec.rec_id)}`,
    );
  });

  it("surfaces a measured claim for the top rec", () => {
    const rec = makeD1Rec();
    const { container } = render(
      <VerdictBand
        preset="7d"
        trend={null}
        priorTrend={null}
        isLoading={false}
        topRecommendation={rec}
      />,
    );
    // 21.3K source vs 8K target → concise measured (token) claim, not a dollar figure.
    expect(container.querySelector(".verdict-band-claim")?.textContent ?? "").toContain("21K");
  });

  it("falls back to a plain review link when there is no top rec", () => {
    const { getByRole, container } = render(
      <VerdictBand
        preset="7d"
        trend={null}
        priorTrend={null}
        isLoading={false}
        topRecommendation={null}
      />,
    );
    const link = getByRole("link", { name: "Review recommendations →" });
    expect(link.getAttribute("href")).toBe("#/recommendations");
    expect(container.querySelector(".verdict-band-copy")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RecommendationsPage — focus handling
// ---------------------------------------------------------------------------
describe("RecommendationsPage — RV6 focus handling", () => {
  it("lands on the expanded, highlighted card inside a detector group", async () => {
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

    // Group card is highlighted with a dismissible banner.
    const groupCard = container.querySelector("[data-detector-id='D1']");
    expect(groupCard?.className).toContain("rec-focus-highlight");
    expect(container.querySelector(".rec-focus-banner")).not.toBeNull();

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
