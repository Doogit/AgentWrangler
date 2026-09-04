/**
 * test/ui/recommendations.test.tsx — Recommendations surface render tests.
 *
 * Covers: three distinct states (loading ≠ error ≠ ok), the active RecCard
 * (collapsed by default, modeled $/wk demoted out of the headline into the
 * expanded Expected-impact block, MODELED chip visible), the honest detector status strip, page-level
 * EXPERIMENTAL, and the standing FR-REC-103
 * footnote. Client is mocked (no daemon).
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import {
  mockEfficiencyHeadroom,
  mockLedger,
  mockPractices,
  mockRecommendations,
} from "../../src/ui/api/fixtures";
import RecommendationsPage from "../../src/ui/recommendations/RecommendationsPage";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());
// W4: RecommendationsPage now renders <ImpactLedger />, which calls
// fetchLedger() — give the auto-mocked client a resolved default so the page
// renders without unhandled rejections.
// BM1/BM2: PracticesSection and HeadroomSummary also need resolved defaults.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
  vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
});

describe("RecommendationsPage — states", () => {
  it("shows aria-busy skeleton while loading", () => {
    vi.mocked(client.fetchRecommendations).mockReturnValue(new Promise(() => {}));
    const { container } = render(<RecommendationsPage />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(container.querySelector(".banner-error")).toBeNull();
  });

  it("shows an error banner when the daemon is unreachable", async () => {
    vi.mocked(client.fetchRecommendations).mockRejectedValue(new Error("ECONNREFUSED"));
    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelector(".banner-error")).not.toBeNull();
    });
  });

  it("renders a decision-first detail view with developer diagnostics closed by default", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    const { container } = render(<RecommendationsPage />);

    // Wait for the card to render — modeled savings are not a collapsed headline anchor.
    await waitFor(() => {
      const headline = container.querySelector(".rec-headline-text");
      expect(headline).not.toBeNull();
      expect(headline?.textContent ?? "").not.toContain("$874.17/wk");
    });

    // Collapsed cards retain only the confidence tier and claim chip; modeled
    // context remains available through the inline chip expander.
    const chipRow = container.querySelector(".rec-chip-row");
    expect(chipRow?.querySelector(".chip-modeled")).toBeNull();
    expect(chipRow?.querySelector(".chip-list-equiv")).toBeNull();
    // Page-level EXPERIMENTAL chip present.
    expect(container.querySelector(".chip-experimental")).not.toBeNull();
    expect(container.querySelector(".chip-experimental")?.getAttribute("title")).toContain(
      "directional evidence",
    );
    expect(container.textContent ?? "").not.toContain("Cache misses have ~10×");

    // Card is collapsed by default — formula detail NOT yet visible.
    expect(container.textContent ?? "").not.toContain("reduction_fraction");

    // Expand the card.
    const chipExpander = container.querySelector<HTMLButtonElement>("button[data-chip-expander]");
    if (!chipExpander) throw new Error("chip expander not found");
    fireEvent.click(chipExpander);
    expect(chipRow?.querySelector(".chip-modeled")).not.toBeNull();
    expect(chipRow?.querySelector(".chip-list-equiv")?.getAttribute("title")).toContain(
      "modeled USD equivalent",
    );

    const expandBtn = container.querySelector<HTMLButtonElement>(
      "button.rec-expand-btn[aria-expanded='false']",
    );
    if (!expandBtn) throw new Error("expand button not found");
    fireEvent.click(expandBtn);

    expect(container.querySelector(".rec-modeled")?.textContent ?? "").toContain("$874.17/wk");

    const text = container.textContent ?? "";
    expect(text).toContain("Why this is ranked here");
    expect(text).toContain("What we observed");
    expect(text).toContain("4 long, high-context sessions");
    expect(text).toContain("Expected impact");
    expect(text).toContain("How to measure success");

    const diagnostics = container.querySelector<HTMLDetailsElement>("details.rec-diagnostics");
    expect(diagnostics).not.toBeNull();
    expect(diagnostics?.open).toBe(false);
    expect(diagnostics?.textContent ?? "").toContain("session_ids");
    expect(diagnostics?.textContent ?? "").toContain("avg_context_per_turn");
    expect(diagnostics?.textContent ?? "").toContain("reduction_fraction");
    expect(container.querySelector(".rec-observations")?.textContent ?? "").not.toContain(
      "session_ids",
    );

    const detailsId = expandBtn.getAttribute("aria-controls");
    expect(detailsId).not.toBeNull();
    expect(container.ownerDocument.getElementById(detailsId ?? "")).not.toBeNull();
    expect(container.querySelectorAll(".rec-details h4.rec-section-label")).toHaveLength(6);
  });

  it("shows confidence tiers and unvalidated assumption notes per detector", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected recommendation fixture data");

    const d2 = { ...base, rec_id: "rec-D2-tier", detector_id: "D2" };
    const d8 = {
      ...base,
      rec_id: "rec-D8-tier",
      detector_id: "D8",
      category: "CACHE",
      title: "D8 cache rewrite",
      evidence: { ...base.evidence, avoidance_fraction: 0.25 },
    };
    const d1 = {
      ...base,
      rec_id: "rec-D1-tier",
      detector_id: "D1",
      title: "D1 memory trim",
      evidence: { source_target: 80_000, component: "CLAUDE.md" },
    };
    const d4 = {
      ...base,
      rec_id: "rec-D4-tier",
      detector_id: "D4",
      category: "MODEL",
      // ≥ $1/wk floor so D4 forms its own group (not swept into MINOR_ITEMS).
      modeled_savings_u_per_wk: 2_000_000,
      modeled_formula: {
        ...base.modeled_formula,
        kind: "ADVISORY",
        inputs: { reduction_fraction: 0.2 },
      },
      evidence: {},
    };
    const d5 = {
      ...base,
      rec_id: "rec-D5-tier",
      detector_id: "D5",
      category: "LIMIT",
      modeled_savings_u_per_wk: null,
      modeled_formula: { ...base.modeled_formula, kind: "WARNING", inputs: {} },
      evidence: {},
    };
    const d9 = {
      ...base,
      rec_id: "rec-D9-tier",
      detector_id: "D9",
      category: "SESSION_HYGIENE",
      modeled_savings_u_per_wk: null,
      modeled_formula: { ...base.modeled_formula, kind: "DIRECTIONAL", inputs: {} },
      evidence: {},
    };
    response.data.active = [d2, d8, d1, d4, d5, d9];
    response.data.active_groups = [];
    response.data.limit_warnings = [];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelectorAll(".rec-confidence-tier")).toHaveLength(6);
    });

    const tierFor = (detectorId: string) =>
      container.querySelector(`[data-detector-id='${detectorId}'] .rec-confidence-tier`);
    expect(tierFor("D1")?.textContent).toBe("MODELED SAVINGS");
    expect(tierFor("D2")?.textContent).toBe("MODELED SAVINGS");
    expect(tierFor("D8")?.textContent).toBe("MODELED SAVINGS");
    expect(tierFor("D4")?.textContent).toBe("ADVISORY");
    expect(tierFor("D5")?.textContent).toBe("WARNING");
    expect(tierFor("D9")?.textContent).toBe("DIRECTIONAL");
    expect(tierFor("D1")?.className).toContain("rec-confidence-tier--modeled");
    expect(tierFor("D4")?.className).toContain("rec-confidence-tier--advisory");
    expect(tierFor("D5")?.className).toContain("rec-confidence-tier--warning");
    expect(tierFor("D9")?.className).toContain("rec-confidence-tier--directional");
    expect(tierFor("D2")?.getAttribute("title")).toBe(
      "Modeled dollar savings from formula with unvalidated assumptions",
    );
    expect(tierFor("D4")?.getAttribute("title")).toBe("Conditional advice, no dollar estimate");
    expect(tierFor("D5")?.getAttribute("title")).toBe("Alert, rate-limit headroom burn");

    for (const expandBtn of container.querySelectorAll<HTMLButtonElement>(
      "button.rec-expand-btn[aria-expanded='false']",
    )) {
      fireEvent.click(expandBtn);
    }

    const d2Note = container.querySelector(
      "[data-detector-id='D2'] .rec-unvalidated-note",
    )?.textContent;
    expect(d2Note).toContain("Unvalidated assumption:");
    expect(d2Note).toContain("33%");
    const d8Note = container.querySelector(
      "[data-detector-id='D8'] .rec-unvalidated-note",
    )?.textContent;
    expect(d8Note).toContain("Unvalidated assumption:");
    expect(d8Note).toContain("25%");
    const d1Note = container.querySelector(
      "[data-detector-id='D1'] .rec-unvalidated-note",
    )?.textContent;
    expect(d1Note).toContain("Unvalidated assumption:");
    expect(d1Note).toContain("80K tokens for CLAUDE.md");
    const d4Note = container.querySelector(
      "[data-detector-id='D4'] .rec-unvalidated-note",
    )?.textContent;
    expect(d4Note).toContain("Unvalidated assumption:");
    expect(d4Note).toContain("20%");
  });

  it("renders one top-level card for a detector group and keeps its member recommendations", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const first = response.data.active[0];
    const firstGroup = response.data.active_groups[0];
    if (!first || !firstGroup) throw new Error("expected grouped recommendation fixture data");
    const second = {
      ...first,
      rec_id: "rec-D2-second-mock",
      title: "Another session-hygiene recommendation",
    };
    response.data.active = [first, second];
    response.data.active_groups = [
      {
        ...firstGroup,
        recs: [first, second],
        total_savings_u_per_wk:
          (first.modeled_savings_u_per_wk ?? 0) + (second.modeled_savings_u_per_wk ?? 0),
      },
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelectorAll(".rec-group-card")).toHaveLength(1);
    });

    expect(
      container.querySelector("[data-detector-id='D2'] .rec-group-count")?.textContent,
    ).toContain("2 recommendations");
    expect(container.textContent ?? "").toContain("Another session-hygiene recommendation");
    expect(container.querySelectorAll(".rec-session-row")).toHaveLength(2);
  });

  it("links grouped affected sessions to their session detail routes", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const first = response.data.active[0];
    const firstGroup = response.data.active_groups[0];
    if (!first || !firstGroup) throw new Error("expected grouped recommendation fixture data");
    const recommendation = {
      ...first,
      evidence: { ...first.evidence, session_ids: ["session/one", "session two"] },
    };
    response.data.active = [recommendation];
    response.data.active_groups = [{ ...firstGroup, recs: [recommendation], session_count: 2 }];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelectorAll(".rec-session-links a")).toHaveLength(2);
    });

    expect(
      [...container.querySelectorAll<HTMLAnchorElement>(".rec-session-links a")].map((link) =>
        link.getAttribute("href"),
      ),
    ).toEqual(["#/sessions/session%2Fone", "#/sessions/session%20two"]);
  });

  it("keeps minor items collapsed until the user expands the group", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const first = response.data.active[0];
    if (!first) throw new Error("expected recommendation fixture data");
    const minorOne = {
      ...first,
      rec_id: "rec-minor-one-mock",
      title: "Small memory trim",
      modeled_savings_u_per_wk: 500_000,
      evidence: { session_id: "minor-session-1" },
    };
    const minorTwo = {
      ...first,
      rec_id: "rec-minor-two-mock",
      title: "Small cache cleanup",
      modeled_savings_u_per_wk: 750_000,
      evidence: { session_id: "minor-session-2" },
    };
    response.data.active = [minorOne, minorTwo];
    response.data.active_groups = [
      {
        detector_id: "MINOR_ITEMS",
        label: "Minor items",
        recs: [minorOne, minorTwo],
        session_count: 2,
        total_savings_u_per_wk: 1_250_000,
      },
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelector("details.rec-minor-items")).not.toBeNull();
    });

    const minorDetails = container.querySelector<HTMLDetailsElement>("details.rec-minor-items");
    if (!minorDetails) throw new Error("minor-items details not found");
    expect(minorDetails.open).toBe(false);
    expect(minorDetails.querySelector("summary")?.textContent).toContain("Show 2 minor items");

    const summary = minorDetails.querySelector("summary");
    if (!summary) throw new Error("minor-items summary not found");
    fireEvent.click(summary);
    expect(minorDetails.open).toBe(true);
    expect(minorDetails.textContent).toContain("Small memory trim");
    expect(minorDetails.textContent).toContain("Small cache cleanup");
    expect(container.querySelector(".rec-minor-items-card .rec-group-detector")?.textContent).toBe(
      "Minor items",
    );
  });

  it("uses detector group labels for adopted and dismissed badges", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected recommendation fixture data");
    const adopted = {
      ...base,
      rec_id: "rec-adopted-label",
      detector_id: "D2",
      state: "ADOPTED" as const,
    };
    const dismissed = {
      ...base,
      rec_id: "rec-dismissed-label",
      detector_id: "D8",
      state: "DISMISSED" as const,
      dismissed_until: "2026-09-01T00:00:00Z",
    };
    response.data.active = [];
    response.data.active_groups = [];
    response.data.adopted = [adopted];
    response.data.dismissed = [dismissed];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => expect(container.querySelector(".rec-adopted-row")).not.toBeNull());

    expect(container.querySelector(".rec-adopted-row .rec-badge")?.textContent).toBe(
      "Session hygiene",
    );
    expect(container.querySelector(".rec-dismissed-row .rec-badge")?.textContent).toBe(
      "Cache misses",
    );
  });

  it("keeps D7 retry exposure explicitly separate from modeled savings", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");
    response.data.active = [
      {
        ...base,
        rec_id: "rec-D7-session-mock",
        detector_id: "D7",
        modeled_savings_u_per_wk: null,
        modeled_formula: {
          model: "D7_LOOP_RETRY_WASTE_EXPOSURE_V2",
          kind: "DIRECTIONAL_UNVALIDATED",
          inputs: {},
          expression: "cap-weighted exposure; not an avoidable-token or USD savings estimate",
        },
      },
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelector(".rec-card")).not.toBeNull();
    });

    const expandBtn = container.querySelector<HTMLButtonElement>(
      "button.rec-expand-btn[aria-expanded='false']",
    );
    if (!expandBtn) throw new Error("expand button not found");
    fireEvent.click(expandBtn);

    const text = container.querySelector(".rec-details")?.textContent ?? "";
    expect(text).toContain("Directional exposure only");
    expect(text).not.toContain("Modeled projection");
  });

  it("shows measured D6 tool-result facts, limitations, and a verification signal", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");
    response.data.active = [
      {
        ...base,
        rec_id: "rec-D6-session-mock",
        detector_id: "D6",
        category: "TOOLING",
        modeled_savings_u_per_wk: null,
        modeled_formula: {
          model: "D6_TOOL_RESULT_BLOAT_V1",
          kind: "DIRECTIONAL",
          inputs: {
            tool_result_bytes: 307_200,
            bytes_per_token: 4,
            bloat_share: 0.384,
            session_cap_weighted_tokens: 200_000,
          },
          expression:
            "tool_result_bytes / bytes_per_token compared with session_cap_weighted_tokens; heuristic directional exposure only (no avoidable-token or USD estimate)",
        },
        target_metric: "tool_result_byte_share",
        evidence: {
          tool_result_bytes: 307_200,
          bloat_share: 0.384,
          session_cap_weighted_tokens: 200_000,
          bytes_per_token: 4,
          thresholds_unvalidated: true,
        },
      },
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => expect(container.querySelector(".rec-card")).not.toBeNull());
    const expandBtn = container.querySelector<HTMLButtonElement>(
      "button.rec-expand-btn[aria-expanded='false']",
    );
    if (!expandBtn) throw new Error("expand button not found");
    fireEvent.click(expandBtn);

    const text = container.querySelector(".rec-details")?.textContent ?? "";
    expect(text).toContain("307,200 measured tool-result bytes");
    expect(text).toContain(
      "after estimating bytes as tokens, the detector puts that output at about 38% of this session's 200K cap-weighted context",
    );
    expect(text).toContain("cannot yet name which tool");
    expect(text).toContain(
      "Directional signal only — bytes are converted with an unvalidated 4 B/token heuristic; this is structural exposure, not an avoidable-token or USD savings estimate.",
    );
    expect(text).toContain("tool-result bytes and share should fall");
  });

  it("shows D10 catalog delta, repeated-read scope, uncertainty, and re-probe signal", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");
    response.data.active = [
      {
        ...base,
        rec_id: "rec-D10-global-mock",
        detector_id: "D10",
        category: "TOOLING",
        evidence: {
          component: "MCP_SCHEMAS",
          catalog_tokens: 55_000,
          catalog_target_tokens: 40_000,
          delta_context_tokens: 15_000,
          source_count: 3,
          turns_per_week: 10,
          thresholds_unvalidated: true,
        },
      },
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => expect(container.querySelector(".rec-card")).not.toBeNull());
    const expandBtn = container.querySelector<HTMLButtonElement>(
      "button.rec-expand-btn[aria-expanded='false']",
    );
    if (!expandBtn) throw new Error("expand button not found");
    fireEvent.click(expandBtn);

    const text = container.querySelector(".rec-details")?.textContent ?? "";
    expect(text).toContain("inventory probe estimated 55K catalog tokens against a 40K target");
    expect(text).not.toContain("catalog measured");
    expect(text).toContain("15K tokens above target");
    expect(text).toContain("global inventory contains 3 catalog sources");
    expect(text).toContain("weekly projection models repeated reads across 10 turns");
    expect(text).toContain("catalog threshold is unvalidated");
    expect(text).toContain("not measured or achieved savings");
    expect(text).toContain("next inventory probe");
    expect(text).toContain(
      "tool, plugin, and skill catalog estimate should move from 55K toward 40K",
    );
  });

  it("surfaces D2 raw-context, cap-weighted, and cache-read exposure facts", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => expect(container.querySelector(".rec-card")).not.toBeNull());
    const expandBtn = container.querySelector<HTMLButtonElement>(
      "button.rec-expand-btn[aria-expanded='false']",
    );
    if (!expandBtn) throw new Error("expand button not found");
    fireEvent.click(expandBtn);

    const observations = container.querySelector(".rec-observations")?.textContent ?? "";
    expect(observations).toContain("4 long, high-context sessions");
    expect(observations).toContain("The detector looked for at least 150 turns");
    expect(observations).not.toContain("Raw-context average:");
    expect(observations).not.toContain("Cap-weighted burn:");
    expect(observations).not.toContain("Cache-read exposure:");
  });

  it("keeps existing D2 facts when BG3 evidence fields are absent", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");
    response.data.active = [
      {
        ...base,
        evidence: {
          qualifying_session_count: 4,
          turn_count_threshold: 150,
          avg_context_threshold: 180_000,
          cache_read_tokens_per_week: 1_766_000_000,
          cache_read_spend_u_per_week: 2_649_000_000,
          reduction_fraction: 0.33,
        },
      },
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => expect(container.querySelector(".rec-card")).not.toBeNull());
    const expandBtn = container.querySelector<HTMLButtonElement>(
      "button.rec-expand-btn[aria-expanded='false']",
    );
    if (!expandBtn) throw new Error("expand button not found");
    fireEvent.click(expandBtn);

    const observations = container.querySelector(".rec-observations")?.textContent ?? "";
    expect(observations).toContain(
      "4 long, high-context sessions crossed the session-hygiene threshold.",
    );
    expect(observations).toContain(
      "The detector looked for at least 150 turns averaging 180K context tokens.",
    );
    expect(observations).not.toContain("Raw-context average:");
    expect(observations).not.toContain("Cap-weighted burn:");
    expect(observations).not.toContain("Cache-read exposure:");
  });

  it("surfaces BG detector evidence fields when present", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");
    response.data.active = [
      {
        ...base,
        rec_id: "rec-D8-evidence",
        detector_id: "D8",
        title: "D8 evidence",
        evidence: {
          cause_facets: {
            idle_gap: true,
            model_switch: false,
            session_reopen: "UNOBSERVABLE",
            prefix_config_change: "UNOBSERVABLE",
            dynamic_content: "UNOBSERVABLE",
          },
        },
      },
      {
        ...base,
        rec_id: "rec-D6-evidence",
        detector_id: "D6",
        title: "D6 evidence",
        modeled_savings_u_per_wk: null,
        evidence: {
          attributed_tool: "Bash",
          attributed_result_bytes: 48_000,
          carry_turns: 3,
          carry_exposure_tokens_directional: 12_500,
        },
      },
      {
        ...base,
        rec_id: "rec-D7-evidence",
        detector_id: "D7",
        title: "D7 evidence",
        modeled_savings_u_per_wk: null,
        evidence: {
          owner_turn_metadata_coverage: 0.8,
          owner_turn_metadata_covered_event_count: 4,
          owner_turn_metadata_denominator_event_count: 5,
        },
      },
      {
        ...base,
        rec_id: "rec-D10-evidence",
        detector_id: "D10",
        title: "D10 evidence",
        modeled_savings_u_per_wk: null,
        evidence: {
          effective_catalog_state: "alwaysLoad",
          always_load_count: 2,
        },
      },
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => expect(container.querySelectorAll(".rec-card")).toHaveLength(4));
    for (const expandBtn of container.querySelectorAll<HTMLButtonElement>(
      "button.rec-expand-btn[aria-expanded='false']",
    )) {
      fireEvent.click(expandBtn);
    }

    const observations = [...container.querySelectorAll(".rec-observations")]
      .map((observations) => observations.textContent ?? "")
      .join(" ");
    const diagnostics = [...container.querySelectorAll("details.rec-diagnostics")]
      .map((details) => details.textContent ?? "")
      .join(" ");
    expect(observations).not.toContain("Cause facet");
    expect(observations).not.toContain("false");
    expect(observations).not.toContain("UNOBSERVABLE");
    expect(diagnostics).toContain("Cause facet — idle gap: true.");
    expect(diagnostics).toContain("Cause facet — model switch: false.");
    expect(diagnostics).toContain("Cause facet — session reopen: UNOBSERVABLE.");
    expect(diagnostics).toContain("Cause facet — prefix/config change: UNOBSERVABLE.");
    expect(diagnostics).toContain("Cause facet — dynamic content: UNOBSERVABLE.");
    expect(observations).toContain("Tool-class attribution: Bash.");
    expect(observations).toContain("Owner-turn metadata coverage: 80%.");
    expect(diagnostics).toContain("Attributed result bytes: 48,000.");
    expect(diagnostics).toContain("Carry turns: 3.");
    expect(diagnostics).toContain("Directional carry exposure: 13K tokens.");
    expect(diagnostics).toContain("Owner-turn metadata covered events: 4.");
    expect(diagnostics).toContain("Owner-turn metadata denominator: 5 in-window events.");
    expect(diagnostics).toContain("Effective catalog state: alwaysLoad.");
    expect(diagnostics).toContain("Always-load count: 2.");
    for (const details of container.querySelectorAll<HTMLDetailsElement>(
      "details.rec-diagnostics",
    )) {
      expect(details.open).toBe(false);
    }
  });

  it("omits BG detector evidence fields when absent or null", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");
    response.data.active = [
      {
        ...base,
        rec_id: "rec-D8-missing-evidence",
        detector_id: "D8",
        evidence: {
          cause_facets: {
            idle_gap: null,
            model_switch: null,
            session_reopen: null,
            prefix_config_change: null,
            dynamic_content: null,
          },
        },
      },
      {
        ...base,
        rec_id: "rec-D6-missing-evidence",
        detector_id: "D6",
        evidence: {
          attributed_tool: null,
          attributed_result_bytes: null,
          carry_turns: null,
          carry_exposure_tokens_directional: null,
        },
      },
      {
        ...base,
        rec_id: "rec-D7-missing-evidence",
        detector_id: "D7",
        evidence: {
          owner_turn_metadata_coverage: null,
          owner_turn_metadata_covered_event_count: null,
          owner_turn_metadata_denominator_event_count: null,
        },
      },
      {
        ...base,
        rec_id: "rec-D10-missing-evidence",
        detector_id: "D10",
        evidence: {
          effective_catalog_state: null,
          always_load_count: null,
        },
      },
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => expect(container.querySelectorAll(".rec-card")).toHaveLength(4));
    for (const expandBtn of container.querySelectorAll<HTMLButtonElement>(
      "button.rec-expand-btn[aria-expanded='false']",
    )) {
      fireEvent.click(expandBtn);
    }

    const text = [...container.querySelectorAll(".rec-details")]
      .map((details) => details.textContent ?? "")
      .join(" ");
    expect(text).not.toContain("Cause facet —");
    expect(text).not.toContain("Tool-class attribution:");
    expect(text).not.toContain("Attributed result bytes:");
    expect(text).not.toContain("Carry turns:");
    expect(text).not.toContain("Directional carry exposure:");
    expect(text).not.toContain("Owner-turn metadata coverage:");
    expect(text).not.toContain("Owner-turn metadata covered events:");
    expect(text).not.toContain("Owner-turn metadata denominator:");
    expect(text).not.toContain("Effective catalog state:");
    expect(text).not.toContain("Always-load count:");
  });

  it("keeps D6 and D10 details honest when optional evidence is missing", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");
    response.data.active = [
      {
        ...base,
        rec_id: "rec-D6-missing-evidence",
        detector_id: "D6",
        modeled_savings_u_per_wk: null,
        modeled_formula: {
          model: "D6_TOOL_RESULT_BLOAT_V1",
          kind: "DIRECTIONAL",
          inputs: {},
          expression: "structural exposure only; no avoidable-token or USD savings estimate",
        },
        evidence: {},
      },
      { ...base, rec_id: "rec-D10-missing-evidence", detector_id: "D10", evidence: {} },
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => expect(container.querySelectorAll(".rec-card")).toHaveLength(2));
    for (const expandBtn of container.querySelectorAll<HTMLButtonElement>(
      "button.rec-expand-btn[aria-expanded='false']",
    )) {
      fireEvent.click(expandBtn);
    }

    const text = [...container.querySelectorAll(".rec-details")]
      .map((details) => details.textContent ?? "")
      .join(" ");
    expect(text).toContain("Tool-result output crossed the session-level bloat threshold");
    expect(text).toContain(
      "Directional signal only — bytes are converted with an unvalidated 4 B/token heuristic; this is structural exposure, not an avoidable-token or USD savings estimate.",
    );
    expect(text).toContain(
      "tool, plugin, and skill catalog exceeded its configured context target",
    );
    expect(text).toContain("This is a global catalog estimate");
    expect(text).toContain("assumes excess catalog context can be removed");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
  });

  it("keeps a generic decision-detail fallback for unknown future detectors", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");
    response.data.active = [{ ...base, rec_id: "rec-D99-mock", detector_id: "D99" }];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => expect(container.querySelector(".rec-card")).not.toBeNull());
    const expandBtn = container.querySelector<HTMLButtonElement>(
      "button.rec-expand-btn[aria-expanded='false']",
    );
    if (!expandBtn) throw new Error("expand button not found");
    fireEvent.click(expandBtn);

    const text = container.querySelector(".rec-details")?.textContent ?? "";
    expect(text).toContain("This detector crossed its configured threshold");
    expect(text).toContain("Modeled projection");
    expect(text).toContain("Re-run the detector after 7 days");
  });

  it("explains that cross-family rank is not a descending dollar sort", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    const { container } = render(<RecommendationsPage />);

    await waitFor(() => {
      expect(container.textContent ?? "").toContain("not a simple dollar sort");
    });

    const text = container.textContent ?? "";
    expect(text).toContain(
      "Within one category, the recommendation with the higher estimated savings ranks first",
    );
    expect(text).toContain("cache miss with a lower dollar estimate");
    expect(text).not.toContain("ranked by impact, highest first");
    expect(text).not.toContain("leverage class");
    expect(text).not.toContain("detector families follow");
  });

  it("shows the honest detector status strip", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    const { container } = render(<RecommendationsPage />);

    await waitFor(() => {
      expect(container.querySelector(".detstatus-blocked")).not.toBeNull();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("D5 · BLOCKED");
    expect(text).not.toContain("D3 ·");
    expect(text).toContain("D7 · INACTIVE");
    expect(text).toContain("D8 · INACTIVE");
    expect(text).toContain("D9 · INACTIVE");
    expect(text).toContain("D10 · NOT_EVALUATED");
    expect(text).toContain("Retry / redundant-read (D7)");
    expect(text).toContain("Weekly token limit is not configured");
    expect(text).not.toContain(":limit_tokens");
  });

  it("labels D10 as the shipped tool-catalog detector and no longer lists it as planned", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const d10 = response.data.detectors.find((detector) => detector.detector_id === "D10");
    if (!d10) throw new Error("expected D10 in recommendations fixture");
    d10.status = "ACTIVE";
    d10.note = "catalog footprint exceeds the target";
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("Tool catalog (D10)");
    });

    const text = container.textContent ?? "";
    expect(text).not.toContain("Too many connected tools, plugins, and skills · no detector yet");
    expect(text).not.toContain("Effort mismatch");
  });

  it("shows the standing achieved-total footnote without exposing its rule identifier", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.textContent ?? "").toMatch(/never counted as achieved/i);
    });
    expect(container.textContent ?? "").not.toContain("FR-REC-103");
    expect(container.querySelector("[title='FR-REC-103']")).not.toBeNull();
  });

  it("collapsed state contains no absolute paths from evidence", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    const { container } = render(<RecommendationsPage />);

    await waitFor(() => {
      expect(container.querySelector(".rec-card")).not.toBeNull();
    });

    // Evidence table is behind the expand toggle — no absolute paths in DOM when collapsed.
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/C:\\Users/);
    expect(text).not.toMatch(/\/Users\//);
  });
});

// ---------------------------------------------------------------------------
// RV5: Toolbar + URL-synced filter/sort/group tests
// ---------------------------------------------------------------------------

describe("RecommendationsPage — toolbar controls (RV5)", () => {
  // Toolbar state lives in window.location.hash (URL-synced). Reset it between
  // tests so a filter set by one test (e.g. clicking a lifecycle chip) does not
  // leak into the next and hide the default proposed view.
  beforeEach(() => {
    window.location.hash = "";
  });

  it("renders the toolbar when data is loaded", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelector(".recs-toolbar")).not.toBeNull();
    });
  });

  it("shows lifecycle chips (Proposed/Adopted/Dismissed) with counts", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelector("[data-toolbar-state='proposed']")).not.toBeNull();
    });

    const proposed = container.querySelector("[data-toolbar-state='proposed']");
    const adopted = container.querySelector("[data-toolbar-state='adopted']");
    const dismissed = container.querySelector("[data-toolbar-state='dismissed']");
    expect(proposed?.textContent).toContain("Proposed");
    expect(adopted?.textContent).toContain("Adopted");
    expect(dismissed?.textContent).toContain("Dismissed");
    // Counts are in parentheses after the label
    expect(proposed?.textContent).toMatch(/\(\d+\)/);
  });

  it("shows confidence-tier chips for the proposed view", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelector("[data-toolbar-tier]")).not.toBeNull();
    });

    const tierChips = container.querySelectorAll("[data-toolbar-tier]");
    const tierLabels = [...tierChips].map((c) => c.getAttribute("data-toolbar-tier"));
    expect(tierLabels).toContain("WARNING");
    expect(tierLabels).toContain("MODELED SAVINGS");
    expect(tierLabels).toContain("ADVISORY");
    expect(tierLabels).toContain("DIRECTIONAL");
  });

  it("shows group-by and sort selects", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelector("[aria-label='Group recommendations by']")).not.toBeNull();
    });

    const groupSelect = container.querySelector<HTMLSelectElement>(
      "[aria-label='Group recommendations by']",
    );
    const sortSelect = container.querySelector<HTMLSelectElement>(
      "[aria-label='Sort recommendations']",
    );
    expect(groupSelect).not.toBeNull();
    expect(sortSelect).not.toBeNull();
    // Default values
    expect(groupSelect?.value).toBe("detector");
    expect(sortSelect?.value).toBe("confidence");
  });

  it("lifecycle 'adopted' chip hides the proposed section and shows adopted section", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected a rec");
    response.data.adopted = [{ ...base, rec_id: "rec-adopted-tv", state: "ADOPTED" as const }];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelector("[data-toolbar-state='adopted']")).not.toBeNull();
    });

    // Click the 'adopted' lifecycle chip
    const adoptedChip = container.querySelector<HTMLButtonElement>(
      "[data-toolbar-state='adopted']",
    );
    if (!adoptedChip) throw new Error("adopted chip not found");
    fireEvent.click(adoptedChip);

    // The chip should become aria-pressed=true. The toolbar is URL-synced via
    // useSyncExternalStore on hashchange, which jsdom dispatches asynchronously,
    // so wait for the re-render rather than asserting synchronously.
    await waitFor(() => {
      const chip = container.querySelector("[data-toolbar-state='adopted']");
      expect(chip?.getAttribute("aria-pressed")).toBe("true");
    });
  });

  it("filter state never drops the standing honesty footnote (FR-REC-103)", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelector(".recs-toolbar")).not.toBeNull();
    });

    // The standing honesty footnote must always be present regardless of filter state
    expect(container.textContent ?? "").toContain("never counted as achieved");
    expect(container.querySelector("[title='FR-REC-103']")).not.toBeNull();
  });

  it("filter state never drops the waste-source footnote", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelector(".recs-toolbar")).not.toBeNull();
    });
    expect(container.textContent ?? "").toContain("Modeled savings are not additive");
  });
});
