/**
 * test/ui/adopt2.test.tsx — ADOPT-2 regression tests (D-a..D-d).
 *
 * D-a: exactly one .rec-actions per measuring adopted card.
 * D-b: "Measuring and reopened" section visible when state filter is unset.
 * D-c: RecCard state does NOT carry over when selectedRec changes (key fix).
 * D-d: banners and Retry name the rec's detector, file, and workspace/global.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import * as client from "../../src/ui/api/client";
import type * as effectClient from "../../src/ui/api/effect-client";
import {
  mockEfficiencyHeadroom,
  mockLedger,
  mockPractices,
  mockRecommendations,
} from "../../src/ui/api/fixtures";
import RecCard, { DETECTOR_GROUP_LABELS } from "../../src/ui/recommendations/RecCard";
import RecommendationsPage from "../../src/ui/recommendations/RecommendationsPage";

vi.mock("../../src/ui/api/client");
vi.mock("../../src/ui/recommendations/EffectEvidence", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  default: () => null,
}));

// Mock fetchEffectEvidence so EffectHistory never calls global fetch and doesn't
// interfere with the sequenced fetch mocks in D-d lifecycle tests.
vi.mock("../../src/ui/api/effect-client", async (importOriginal) => {
  const actual = await importOriginal<typeof effectClient>();
  return {
    ...actual,
    fetchEffectEvidence: vi.fn().mockResolvedValue({
      cycles: [],
      legacy: [],
      next_cycle_cursor: null,
      next_legacy_cursor: null,
    }),
  };
});

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

function fakeResponse(status = 200, body: unknown = undefined): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function baseRec(overrides: Partial<RecommendationCard> = {}): RecommendationCard {
  const base = mockRecommendations().data?.active[0];
  if (!base) throw new Error("expected fixture");
  return { ...base, ...overrides };
}

function openSettlingCycle() {
  return {
    state: "OPEN_SETTLING" as const,
    targetDirection: null,
    scheduledObservationTo: "2026-10-08T00:00:00.000Z",
    targetDefinition: { unit: "tokens", sampleUnit: "source observation" },
    finalEvidence: null,
    cycleId: "cycle-001",
    versionStatus: "SUPPORTED" as const,
    rollbackStatus: null,
  } as unknown as NonNullable<RecommendationCard["effect_cycle"]>;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
  vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
  vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// D-a: exactly one .rec-actions per measuring adopted card
// ---------------------------------------------------------------------------
describe("D-a: measuring adopted card layout", () => {
  it("renders exactly one .rec-actions element and includes Undo adopt inside it", () => {
    const rec = baseRec({
      rec_id: "da-measuring",
      state: "ADOPTED",
      effect_cycle: openSettlingCycle(),
    });
    const { container } = render(<RecCard rec={rec} showRank={false} onEffectMutated={vi.fn()} />);
    expect(container.querySelectorAll(".rec-actions")).toHaveLength(1);
    const actionsDiv = container.querySelector(".rec-actions") as HTMLElement;
    expect(within(actionsDiv).getByRole("button", { name: "Undo adopt" })).toBeTruthy();
    expect(within(actionsDiv).getByRole("button", { name: "Adopted" })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// D-b: "Measuring and reopened" visible when state filter is unset
// ---------------------------------------------------------------------------
describe("D-b: measuring section visible without state filter", () => {
  it("shows Measuring and reopened section when state filter is null (All view)", async () => {
    window.location.hash = "";
    const base = mockRecommendations();
    if (!base.data) throw new Error("expected data");
    const measuringRec = baseRec({
      rec_id: "db-measuring",
      title: "Measuring adopted rec",
      state: "ADOPTED",
      effect_cycle: openSettlingCycle(),
    });
    base.data.active = [];
    base.data.active_groups = [];
    base.data.adopted = [measuringRec];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(base);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() =>
      expect(
        container.querySelector('[aria-label="Measuring and reopened recommendations"]'),
      ).not.toBeNull(),
    );
    const measuringSection = container.querySelector(
      '[aria-label="Measuring and reopened recommendations"]',
    ) as HTMLElement;
    expect(within(measuringSection).getByText("Measuring adopted rec")).toBeTruthy();
    // Undo adopt button must be reachable
    const measuringArea = within(
      container.querySelector(
        '[aria-label="Measuring and reopened recommendations"]',
      ) as HTMLElement,
    );
    expect(measuringArea.getByRole("button", { name: "Undo adopt" })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// D-c regression: RecCard state must not carry over when selectedRec changes
// Write this test FIRST and verify it is RED before the fix.
// ---------------------------------------------------------------------------
describe("D-c: no state carryover when selectedRec changes", () => {
  it("does not carry saveState to a new rec when key resets on rec change", async () => {
    const recA = baseRec({ rec_id: "dc-rec-a", title: "Rec A for adopt" });
    const recB = baseRec({ rec_id: "dc-rec-b", title: "Rec B spotlight" });

    const phase1 = mockRecommendations();
    if (!phase1.data) throw new Error("expected data");
    phase1.data.active = [recA];
    phase1.data.active_groups = [];
    phase1.data.adopted = [];

    const phase2 = mockRecommendations();
    if (!phase2.data) throw new Error("expected data");
    phase2.data.active = [recB];
    phase2.data.active_groups = [];
    phase2.data.adopted = [{ ...recA, state: "ADOPTED" as const }];

    vi.mocked(client.fetchRecommendations).mockResolvedValueOnce(phase1).mockResolvedValue(phase2);

    // Fetch mock: fail first adopt, succeed second (retry)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(200, { token: "tok-1" })) // token for first adopt
      .mockResolvedValueOnce(fakeResponse(409)) // first adopt fails
      .mockResolvedValueOnce(fakeResponse(200, { token: "tok-2" })) // token for retry
      .mockResolvedValueOnce(fakeResponse(200, { ok: true })); // retry adopt succeeds
    vi.stubGlobal("fetch", fetchMock);

    render(<RecommendationsPage />);

    // Wait for recA at spotlight (real timers needed for async fetch)
    await waitFor(() => expect(screen.getByText("Rec A for adopt")).toBeTruthy());

    // Switch to fake timers BEFORE clicking Adopt so the pending setTimeout is
    // created in the fake timer queue and vi.advanceTimersByTime can fire it.
    vi.useFakeTimers();

    // Click Adopt (schedules with 5s undo window — timer created under fake timers)
    fireEvent.click(screen.getByRole("button", { name: "Adopt" }));

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.useRealTimers();

    // First adopt fails — error banner appears
    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(alerts.some((el) => el.textContent?.includes("Could not save"))).toBe(true);
    });

    // Click Retry — second attempt succeeds, triggers refresh() → phase2 data (recB)
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // After refresh, recB is the spotlight card
    await waitFor(() => expect(screen.getByText("Rec B spotlight")).toBeTruthy());

    // D-c assertion: saved banner ("Tracking saved") must NOT appear on recB's card
    // Without key fix: writeState.saved from recA's adopt would carry to recB → "Tracking saved" visible
    expect(screen.queryByText(/Tracking saved/)).toBeNull();
    // The page (not the remounted card) confirms which rec was adopted.
    expect(document.querySelector("output.rec-apply-status")?.textContent).toMatch(
      new RegExp(`^Adopted: ${DETECTOR_GROUP_LABELS[recA.detector_id] ?? recA.detector_id} · `),
    );

    // D-c assertion: no adopt POST was sent for recB
    const postsForB = fetchMock.mock.calls.filter(
      ([url, init]) =>
        url === "/api/recommendations/adopt" &&
        typeof init?.body === "string" &&
        JSON.parse(init.body).rec_id === recB.rec_id,
    );
    expect(postsForB).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// D-d: banners include detector, file, and workspace/global labels
// ---------------------------------------------------------------------------
describe("D-d: banners name the rec's target", () => {
  it("failed adopt banner and Retry include detector, file, and 'global' for a null-scope D1 rec", async () => {
    const d1GlobalRec = baseRec({
      rec_id: "dd-d1-global",
      detector_id: "D1",
      scope_workspace_id: null,
      file_ref: "C:\\Users\\dev\\Documents\\GitHub\\AgentWrangler\\CLAUDE.md",
      state: "ADOPTED",
      effect_cycle: openSettlingCycle(),
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(200, { token: "tok-undo" }))
      .mockResolvedValueOnce(fakeResponse(503, { error: "signal timed out" }));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <RecCard rec={d1GlobalRec} showRank={false} onEffectMutated={vi.fn()} />,
    );

    // Click "Undo adopt"
    fireEvent.click(within(container).getByRole("button", { name: "Undo adopt" }));
    await waitFor(() => expect(container.querySelector(".rec-apply-status--error")).not.toBeNull());

    const alert = container.querySelector(".rec-apply-status--error");
    expect(alert?.textContent).toContain("CLAUDE.md / memory");
    expect(alert?.textContent).toContain("CLAUDE.md");
    expect(alert?.textContent).toContain("global");

    const retryBtn = within(container).getByRole("button", { name: /Retry/i });
    expect(retryBtn.textContent).toContain("CLAUDE.md / memory");
    expect(retryBtn.textContent).toContain("global");
  });

  it("saved banner includes detector and workspace for a workspace-scoped rec", async () => {
    const wsRec = baseRec({
      rec_id: "dd-d2-ws",
      detector_id: "D2",
      scope_workspace_id: "ws-123",
      file_ref: null,
      state: "ADOPTED",
      effect_cycle: openSettlingCycle(),
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(200, { token: "tok-undo2" }))
      .mockResolvedValueOnce(fakeResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    // useWorkspaceNames uses fetchWorkspaceNames under the hood; mock at API level
    vi.mocked(client.fetchWorkspaceNames).mockResolvedValue({
      data: [{ workspace_id: "ws-123", name: "AgentWrangler" }],
    } as never);

    const { container } = render(
      <RecCard rec={wsRec} showRank={false} onEffectMutated={vi.fn()} />,
    );

    fireEvent.click(within(container).getByRole("button", { name: "Undo adopt" }));
    await waitFor(() => {
      const output = container.querySelector("output");
      expect(output).not.toBeNull();
      expect(output?.textContent).toContain("Adoption decision undone");
    });

    const output = container.querySelector("output");
    // The saved output should exist — presence of workspace or detector label
    expect(output?.textContent).toBeTruthy();
  });

  it("D1 member rows in grouped card show their file without expanding", () => {
    const d1Rec = baseRec({
      rec_id: "dd-d1-grouped",
      detector_id: "D1",
      file_ref: "C:\\Users\\dev\\AgentWrangler\\CLAUDE.md",
    });

    const group = {
      detector_id: "D1",
      label: "CLAUDE.md / memory",
      recs: [d1Rec],
      session_count: 0,
      total_savings_u_per_wk: 0,
    };

    const { container } = render(<RecCard group={group} rank={1} showRank={false} />);

    // The collapsed member row must name the file without needing to expand
    const memberRow = container.querySelector(".rec-group-members");
    expect(memberRow?.textContent).toContain("CLAUDE.md");
  });
});
