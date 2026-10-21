/**
 * test/ui/recommendations.test.tsx — Recommendations surface render tests.
 *
 * Covers: three distinct states (loading ≠ error ≠ ok), the active RecCard
 * (collapsed by default, modeled $/wk demoted out of the headline into the
 * expanded Expected-impact block, MODELED chip visible), the honest detector status strip, page-level
 * EXPERIMENTAL, and the standing FR-REC-103
 * footnote. Client is mocked (no daemon).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import * as feedbackClient from "../../src/ui/api/feedback-client";
import {
  mockEfficiencyHeadroom,
  mockLedger,
  mockPractices,
  mockRecommendations,
} from "../../src/ui/api/fixtures";
import RecommendationsPage from "../../src/ui/recommendations/RecommendationsPage";

vi.mock("../../src/ui/api/client");
vi.mock("../../src/ui/api/feedback-client", async (importOriginal) => {
  const actual = await importOriginal<typeof feedbackClient>();
  return {
    ...actual,
    listFeedback: vi.fn(),
    setFeedback: vi.fn(),
    undoFeedback: vi.fn(),
    deleteFeedback: vi.fn(),
    getGoal: vi.fn(),
    setGoal: vi.fn(),
    resetGoal: vi.fn(),
  };
});

const envelope = <T,>(data: T) => ({ data, meta: {} }) as never;

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
  vi.mocked(feedbackClient.listFeedback).mockResolvedValue(envelope([]));
  vi.mocked(feedbackClient.setFeedback).mockResolvedValue(envelope({}));
  vi.mocked(feedbackClient.undoFeedback).mockResolvedValue(envelope({}));
  vi.mocked(feedbackClient.deleteFeedback).mockResolvedValue(envelope({}));
  vi.mocked(feedbackClient.getGoal).mockResolvedValue(
    envelope({ scope_key: "__global__", goal: "PRESERVE_QUALITY" }),
  );
  vi.mocked(feedbackClient.setGoal).mockResolvedValue(
    envelope({ scope_key: "__global__", goal: "REDUCE_RESOURCE_USE" }),
  );
  vi.mocked(feedbackClient.resetGoal).mockResolvedValue(
    envelope({ scope_key: "__global__", goal: "PRESERVE_QUALITY" }),
  );
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
      expect(container.querySelector(".async-error-state")).not.toBeNull();
    });
    expect(container.textContent ?? "").not.toContain("ECONNREFUSED");
  });

  it("retries only the recommendations collection", async () => {
    vi.mocked(client.fetchRecommendations)
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(mockRecommendations());
    render(<RecommendationsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry recommendations" }));
    await waitFor(() => expect(client.fetchRecommendations).toHaveBeenCalledTimes(2));
  });

  it("maps known ranking warnings and keeps their codes in collapsed technical details", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations data");
    response.data.rank_warnings = [{ code: "PACKET_EXPIRED", detail: "stale evidence" }];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
    const { container } = render(<RecommendationsPage />);

    await waitFor(() => expect(container.querySelector(".recs-rank-warning")).not.toBeNull());
    const warning = container.querySelector(".recs-rank-warning");
    expect(warning?.firstChild?.textContent).toContain("Some evidence is no longer current");
    const details = warning?.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("PACKET_EXPIRED");
    expect(warning?.textContent).not.toContain("stale evidence");
  });

  it("fails closed for an unknown ranking warning code", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations data");
    response.data.rank_warnings = [{ code: "UNRECOGNIZED_WARNING" as never, detail: "" }];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
    const { container } = render(<RecommendationsPage />);

    await waitFor(() => expect(container.querySelector(".recs-rank-warning")).not.toBeNull());
    const warning = container.querySelector(".recs-rank-warning");
    expect(warning?.firstChild?.textContent).toContain("could not be ranked right now");
    expect(warning?.querySelector("details")?.textContent).toContain("UNRECOGNIZED_WARNING");
  });

  it("labels recommendations that need concrete steps", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected data");

    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
    render(<RecommendationsPage />);

    await waitFor(() => {
      expect(screen.getAllByText("needs steps").length).toBeGreaterThan(0);
    });
  });

  it("renders a decision-first detail view with developer diagnostics closed by default", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected data");

    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
    const { container } = render(<RecommendationsPage />);

    // Wait for the card to render — modeled savings are not a collapsed headline anchor.
    await waitFor(() => {
      const headline = container.querySelector(".rec-headline-text");
      expect(headline).not.toBeNull();
      expect(headline?.textContent ?? "").toContain("Use /clear between unrelated tasks");
    });

    // Collapsed directional cards retain only the confidence tier and claim chip.
    const chipRow = container.querySelector(".rec-chip-row");
    expect(chipRow?.querySelector(".chip-modeled")).toBeNull();
    expect(chipRow?.querySelector(".chip-list-equiv")).toBeNull();
    // Page-level EXPERIMENTAL chip present.
    expect(container.querySelector(".chip-experimental")).not.toBeNull();
    expect(container.querySelector(".chip-experimental")?.getAttribute("title")).toContain(
      "method that is still being checked",
    );
    expect(container.textContent ?? "").not.toContain("Cache misses have ~10×");

    // Card is collapsed by default — formula detail NOT yet visible.
    expect(container.textContent ?? "").not.toContain("reduction_fraction");

    const expandBtn = container.querySelector<HTMLButtonElement>(
      "button.rec-expand-btn[aria-expanded='false']",
    );
    if (!expandBtn) throw new Error("expand button not found");
    fireEvent.click(expandBtn);

    expect(container.querySelector(".rec-modeled")?.textContent ?? "").not.toMatch(/\$\d/);

    const text = container.textContent ?? "";
    expect(container.querySelector(".rec-details")?.textContent ?? "").not.toContain(
      "Why this is ranked here",
    );
    expect(text).toContain("What we observed");
    expect(text).toContain("3 long, high-context sessions");
    expect(text).toContain("Possible reduction");
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

  it("shows no confidence tiers and shows unvalidated assumption notes per detector", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected recommendation fixture data");

    const d2 = {
      ...base,
      rec_id: "rec-D2-tier",
      detector_id: "D2",
      confidence_tier: "VERIFIED" as const,
    };
    const d8 = {
      ...base,
      rec_id: "rec-D8-tier",
      detector_id: "D8",
      category: "CACHE",
      title: "D8 cache rewrite",
      evidence: { ...base.evidence, avoidance_fraction: 0.25 },
      confidence_tier: "ESTIMATED" as const,
    };
    const d1 = {
      ...base,
      rec_id: "rec-D1-tier",
      detector_id: "D1",
      title: "D1 memory trim",
      modeled_savings_u_per_wk: 2_000_000,
      modeled_formula: { ...base.modeled_formula, kind: "MODELED", inputs: {} },
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
      expect(container.querySelectorAll(".rec-category-chip").length).toBeGreaterThanOrEqual(6);
    });

    expect(container.querySelectorAll(".rec-confidence-tier")).toHaveLength(0);

    for (const expandBtn of container.querySelectorAll<HTMLButtonElement>(
      "button.rec-expand-btn[aria-expanded='false']",
    )) {
      fireEvent.click(expandBtn);
    }

    const notes = container.textContent ?? "";
    expect(notes).toContain("Unvalidated assumption:");
    // R6-06: D2 uses a one-decimal percent so it matches the $ math elsewhere on the card.
    expect(notes).toContain("33.0%");
    expect(notes).toContain("25%");
    expect(notes).toContain("80K tokens for CLAUDE.md");
    expect(notes).toContain("20%");
  });

  // UIP-7: the single-card + collapsed-members queue was replaced by a spotlight
  // (rec #1) plus each remaining group rendered as its own visible section.
  it("renders each remaining group as a visible section keeping its member recommendations", async () => {
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
      expect(container.querySelector(".recs-group-section")).not.toBeNull();
    });

    // first rec is promoted to the spotlight; the second stays visible in its
    // group section (not hidden behind a single collapsed queue).
    expect(container.querySelector(".recs-group-count")?.textContent).toContain("(1)");
    expect(container.textContent ?? "").toContain("Another session-hygiene recommendation");
    // D-B: no group header is a modeled-$ value or summed total.
    const head = container.querySelector(".recs-group-head")?.textContent ?? "";
    expect(head).not.toContain("$");
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
    await waitFor(() => expect(container.querySelectorAll(".rec-session-links a")).toHaveLength(2));

    expect(
      [...container.querySelectorAll<HTMLAnchorElement>(".rec-session-links a")].map((link) =>
        link.getAttribute("href"),
      ),
    ).toEqual(["#/sessions/session%2Fone", "#/sessions/session%20two"]);
  });

  // UIP-7: minor items are no longer a special second-level collapse with a summed
  // $ header. They render as an ordinary group section (spotlight + group) with no
  // modeled-$ total in the header (D-B).
  it("renders minor items as an ordinary group section without a summed $ header", async () => {
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
      expect(container.querySelector(".recs-group-section")).not.toBeNull();
    });

    // Both minor items are visible (one promoted to the spotlight, one in the
    // group section) — not hidden behind the old second-level collapse.
    expect(container.textContent).toContain("Small memory trim");
    expect(container.textContent).toContain("Small cache cleanup");
    // The old ad-hoc minor-items collapse is gone.
    expect(container.querySelector("details.rec-minor-items")).toBeNull();
    // D-B: no group header carries a modeled-$ value or summed total.
    const heads = [...container.querySelectorAll(".recs-group-head")]
      .map((h) => h.textContent ?? "")
      .join(" ");
    expect(heads).not.toContain("$");
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
      "Long sessions",
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
    // R6-13: the D7 loops caveat no longer claims "no savings estimate is shown" under a
    // rendered $ figure; it states the 50% avoidability assumption instead.
    expect(text).toContain("it assumes 50% of the repeat turns were avoidable");
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
      "Rough estimate: text size is converted at four bytes per token. Large output is not necessarily waste; check whether the task needed it.",
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
    expect(text).toContain("tool inventory scan estimated 55K catalog tokens against a 40K target");
    expect(text).not.toContain("catalog measured");
    expect(text).toContain("15K tokens above target");
    expect(text).toContain("global inventory contains 3 catalog sources");
    expect(text).toContain("weekly projection models repeated reads across 10 turns");
    expect(text).toContain("catalog threshold is unvalidated");
    expect(text).toContain("not measured or achieved savings");
    expect(text).toContain("next tool inventory scan");
    expect(text).toContain(
      "tool, plugin, and skill catalog estimate should move from 55K toward 40K",
    );
  });

  it("labels a U7 D10 row's catalog_target_tokens as the 5% context share, not a target", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");
    response.data.active = [
      {
        ...base,
        rec_id: "rec-D10-global-u7-mock",
        detector_id: "D10",
        category: "TOOLING",
        evidence: {
          catalog_tokens: 18_000,
          catalog_target_tokens: 3_000,
          delta_context_tokens: 6_000,
          removable_tokens: 6_000,
          mean_context_tokens: 60_000,
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
    expect(text).toContain(
      "estimated 18K catalog tokens; about 6K are in items with no recorded use this week (5% of the mean context per turn is 3K).",
    );
    expect(text).toContain("catalog estimate (18K now) should fall by about 6K");
    expect(text).not.toContain("3K target");
    expect(text).not.toContain("toward 3K");
  });

  it("surfaces D2 raw-context, cap-weighted, and cache-read exposure facts", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected data");

    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => expect(container.querySelector(".rec-card")).not.toBeNull());
    const expandBtn = container.querySelector<HTMLButtonElement>(
      "button.rec-expand-btn[aria-expanded='false']",
    );
    if (!expandBtn) throw new Error("expand button not found");
    fireEvent.click(expandBtn);

    const observations = container.querySelector(".rec-observations")?.textContent ?? "";
    expect(observations).toContain("3 long, high-context sessions");
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
      "4 long, high-context sessions crossed the threshold for long sessions.",
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
          workspace_context_from: "2026-08-01T00:00:00.000Z",
          workspace_context_to: "2026-08-15T00:00:00.000Z",
          workspace_qualifying_session_count: 18,
          workspace_affected_session_ids: [
            "ses-a01",
            "ses-a02",
            "ses-a03",
            "ses-a04",
            "ses-a05",
            "ses-a06",
          ],
          workspace_recovered_session_ids: ["ses-a01", "ses-a02", "ses-a03"],
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
    expect(observations).toContain("Tool identified: Bash.");
    expect(observations).toContain("Tool events linked to a model response: 80%.");
    expect(observations).toContain(
      "Workspace cohort context: 6 / 18 repeated test-failure sessions; 3 recovered test sequences.",
    );
    expect(observations).toContain("[2026-08-01T00:00:00.000Z, 2026-08-15T00:00:00.000Z)");
    expect(observations).toContain(
      "Workspace affected IDs: ses-a01, ses-a02, ses-a03, ses-a04, ses-a05, ses-a06",
    );
    expect(observations).toContain("not this session's count or evidence of task success");
    expect(diagnostics).toContain("Output size in bytes: 48,000.");
    expect(diagnostics).toContain("Later turns carrying this output: 3.");
    expect(diagnostics).toContain("Estimated tokens carried into later turns: 13K tokens.");
    expect(diagnostics).toContain("Linked tool events: 4.");
    expect(diagnostics).toContain("Total tool events checked: 5 in-window events.");
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
    expect(text).not.toContain("Output size in bytes:");
    expect(text).not.toContain("Later turns carrying this output:");
    expect(text).not.toContain("Estimated tokens carried into later turns:");
    expect(text).not.toContain("Owner-turn metadata coverage:");
    expect(text).not.toContain("Linked tool events:");
    expect(text).not.toContain("Total tool events checked:");
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
      "Rough estimate: text size is converted at four bytes per token. Large output is not necessarily waste; check whether the task needed it.",
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
    expect(text).toContain("Review the affected sessions and measured trigger facts below.");
    expect(text).toContain("Modeled projection");
    expect(text).toContain("Re-run the detector after 7 days");
  });

  it("presents ranked list above decisions and decisions demoted to the bottom", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    const { container } = render(<RecommendationsPage />);

    // B5: "Ranked by weekly impact" heading is the primary section now.
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Ranked by weekly impact" })).toBeTruthy();
    });

    const text = container.textContent ?? "";
    // Detector details section is present with the simplified label.
    expect(screen.getByRole("heading", { name: "Detector details and filtering" })).toBeTruthy();
    // InfoTip on the ranked list explains the new ordering.
    fireEvent.click(screen.getByRole("button", { name: "How this list is ranked" }));
    expect(screen.getByRole("tooltip").textContent).toContain("highest first");
    for (const card of container.querySelectorAll(".rec-card")) {
      expect(card.querySelector(".rec-rank-badge")).toBeNull();
      expect(card.textContent ?? "").not.toContain("CHECK FIRST");
      expect(card.textContent ?? "").not.toContain("Why this is ranked here");
    }
    expect(text).not.toContain("Ranked decisions");
    expect(text).not.toContain("ranked by impact, highest first");
    expect(text).not.toContain("leverage class");
    expect(text).not.toContain("detector families follow");
  });

  it("shows the active recommendations in the ranked list and keeps D5 in its warning strip", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");

    const d2First = {
      ...base,
      rec_id: "rec-queue-d2-first",
      detector_id: "D2",
      title: "D2 first",
    };
    const d1Middle = {
      ...base,
      rec_id: "rec-queue-d1-middle",
      detector_id: "D1",
      title: "D1 middle",
    };
    const d2Last = {
      ...base,
      rec_id: "rec-queue-d2-last",
      detector_id: "D2",
      title: "D2 last",
    };
    const d5Warning = {
      ...base,
      rec_id: "rec-queue-d5-warning",
      detector_id: "D5",
      category: "LIMIT",
      title: "D5 warning",
      modeled_savings_u_per_wk: null,
      modeled_formula: { ...base.modeled_formula, kind: "WARNING" as const, inputs: {} },
      evidence: {},
    };
    response.data.active = [d2First, d1Middle, d2Last];
    response.data.active_groups = [
      {
        detector_id: "D2",
        label: "Session hygiene",
        recs: [d2First, d2Last],
        session_count: 0,
        total_savings_u_per_wk: 0,
      },
      {
        detector_id: "D1",
        label: "CLAUDE.md / memory",
        recs: [d1Middle],
        session_count: 0,
        total_savings_u_per_wk: 0,
      },
    ];
    response.data.limit_warnings = [d5Warning];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    render(<RecommendationsPage />);

    const queue = await screen.findByRole("list", { name: "Ranked by weekly impact" });
    expect(
      [...queue.querySelectorAll(".rec-card .rec-title")].map((title) => title.textContent),
    ).toEqual(["D2 first", "D2 last", "D1 middle"]);
    expect(document.querySelector(".limit-warning-strip")?.textContent).toContain(d5Warning.lever);
  });

  it("describes the D5 forecast in the limit strip with readable times and no Julian day", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");
    response.data.limit_warnings = [
      {
        ...base,
        rec_id: "rec-d5-forecast",
        detector_id: "D5",
        category: "LIMIT",
        modeled_savings_u_per_wk: null,
        evidence: {
          forecast_state: "WARNING",
          used_pct: 78.4,
          projected_pct: 112,
          resets_at: "2026-09-25T09:00:00.000Z",
          projected_limit_hit_at: "2026-09-24T15:00:00.000Z",
          required_cut_pct: 21,
          projected_exhaustion_jd: 2461303.1,
        },
      },
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    render(<RecommendationsPage />);

    await screen.findByRole("heading", { name: "Ranked by weekly impact" });
    const text = document.querySelector(".limit-warning-strip")?.textContent ?? "";
    expect(text).toContain("78% of the weekly limit is used");
    expect(text).toContain("At the pace of the last day, about 112% by the reset on");
    expect(text).toMatch(/reset on \w{3}, Sep \d+, \d+:\d{2} (AM|PM)/);
    expect(text).toContain("the limit would be reached about");
    expect(text).toContain("Cutting use by about 21%");
    expect(text).not.toContain("2461303");
    fireEvent.click(screen.getByRole("button", { name: "How the limit warning is worked out" }));
    expect(screen.getByRole("tooltip").textContent).toContain("hours left until the reset");
  });

  it("names a since-reset pace when the week is under a day old", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");
    response.data.limit_warnings = [
      {
        ...base,
        rec_id: "rec-d5-young-week",
        detector_id: "D5",
        category: "LIMIT",
        modeled_savings_u_per_wk: null,
        evidence: {
          forecast_state: "WARNING",
          used_pct: 20,
          projected_pct: 140,
          pace_window_hours: 8,
          resets_at: "2026-09-25T09:00:00.000Z",
        },
      },
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    render(<RecommendationsPage />);

    await screen.findByRole("heading", { name: "Ranked by weekly impact" });
    const text = document.querySelector(".limit-warning-strip")?.textContent ?? "";
    expect(text).toContain("At the pace since the weekly reset, about 140%");
    expect(text).not.toContain("the last day");
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
      expect(container.textContent ?? "").toMatch(/kept separate from the results/i);
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

  it("shows estimate-basis chips for the proposed view", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelector("[data-toolbar-basis]")).not.toBeNull();
    });

    const basisChips = container.querySelectorAll("[data-toolbar-basis]");
    const basisValues = [...basisChips].map((c) => c.getAttribute("data-toolbar-basis"));
    expect(basisValues).toEqual(["P", "E", "O", "R"]);
    expect(container.querySelector("[data-toolbar-tier]")).toBeNull();
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

  it("applies lifecycle sort order to adopted and dismissed queue entries", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");
    const adoptedOld = {
      ...base,
      rec_id: "rec-adopted-old",
      state: "ADOPTED" as const,
      title: "Adopted old",
      lever: "Adopted old",
      created_at: "2026-01-01T00:00:00Z",
    };
    const adoptedNew = {
      ...base,
      rec_id: "rec-adopted-new",
      state: "ADOPTED" as const,
      title: "Adopted new",
      lever: "Adopted new",
      created_at: "2026-02-01T00:00:00Z",
    };
    const dismissedOld = {
      ...base,
      rec_id: "rec-dismissed-old",
      state: "DISMISSED" as const,
      title: "Dismissed old",
      lever: "Dismissed old",
      created_at: "2026-01-01T00:00:00Z",
    };
    const dismissedNew = {
      ...base,
      rec_id: "rec-dismissed-new",
      state: "DISMISSED" as const,
      title: "Dismissed new",
      lever: "Dismissed new",
      created_at: "2026-02-01T00:00:00Z",
    };
    response.data.active = [];
    response.data.active_groups = [];
    response.data.limit_warnings = [];
    response.data.adopted = [adoptedOld, adoptedNew];
    response.data.dismissed = [dismissedOld, dismissedNew];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    window.location.hash = "#/recommendations?state=adopted&sort=newest";
    render(<RecommendationsPage />);

    const adoptedHeading = await screen.findByRole("heading", {
      name: "Adopted changes — measured effect",
    });
    const adoptedList = adoptedHeading.closest(".card")?.querySelector("ul.rec-adopted-list");
    const adoptedRows = [...(adoptedList?.querySelectorAll("li.rec-adopted-row") ?? [])];
    expect(adoptedRows).toHaveLength(2);
    expect(adoptedRows[0]?.textContent).toContain("Adopted new");
    expect(adoptedRows[1]?.textContent).toContain("Adopted old");
    // Each adopted rec appears exactly once — no duplicate adopted/dismissed list.
    expect(document.querySelectorAll("li.rec-adopted-row")).toHaveLength(2);

    window.location.hash = "#/recommendations?state=dismissed&sort=newest";
    await waitFor(() => {
      const dismissedHeading = screen.getByRole("heading", { name: "Dismissed", level: 2 });
      const dismissedList = dismissedHeading
        .closest(".card")
        ?.querySelector("ul.rec-dismissed-list");
      const rows = [...(dismissedList?.querySelectorAll("li.rec-dismissed-row") ?? [])];
      expect(rows).toHaveLength(2);
      expect(rows[0]?.textContent).toContain("Dismissed new");
      expect(rows[1]?.textContent).toContain("Dismissed old");
    });
  });

  it("filter state never drops the standing honesty footnote (FR-REC-103)", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelector(".recs-toolbar")).not.toBeNull();
    });

    // The standing honesty footnote must always be present regardless of filter state
    expect(container.textContent ?? "").toContain("kept separate from the results");
    expect(container.querySelector("[title='FR-REC-103']")).not.toBeNull();
  });

  it("filter state never drops the waste-source footnote", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
    const { container } = render(<RecommendationsPage />);
    await waitFor(() => {
      expect(container.querySelector(".recs-toolbar")).not.toBeNull();
    });
    expect(container.textContent ?? "").toContain(
      "Dollar figures are net of overlaps: each token is counted once, so they add up.",
    );
  });
});
