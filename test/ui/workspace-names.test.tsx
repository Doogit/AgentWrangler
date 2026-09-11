import { cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationsView } from "../../src/query/api/recommendations";
import * as client from "../../src/ui/api/client";
import {
  mockEfficiencyHeadroom,
  mockLedger,
  mockPractices,
  mockRecommendations,
  mockWorkspaceNames,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
import { __resetWorkspaceNamesCache, useWorkspaceNames } from "../../src/ui/lib/workspace-names";
import RecommendationsPage from "../../src/ui/recommendations/RecommendationsPage";

vi.mock("../../src/ui/api/client");

const UNKNOWN_WORKSPACE_ID = "C--Users-fixture-user-Documents-GitHub-fixture-project";

function recommendationsWithWorkspaceScopes(): ReturnType<typeof mockRecommendations> {
  const response = mockRecommendations();
  if (response.data === null) throw new Error("expected recommendation fixture data");
  const [base] = response.data.active;
  if (base === undefined) throw new Error("expected active recommendation fixture data");
  const active = [
    {
      ...base,
      rec_id: "rec-known-workspace",
      scope_workspace_id: "ws-1",
      cross_workspace: false,
      workspace_multiplier: null,
    },
    {
      ...base,
      rec_id: "rec-unknown-workspace",
      scope_workspace_id: UNKNOWN_WORKSPACE_ID,
      cross_workspace: false,
      workspace_multiplier: null,
    },
    {
      // ws-idle exists only in mockWorkspaceNames (not mockWorkspaces) — the
      // >30d-idle workspace the UIR-8 unwindowed name source must still label.
      ...base,
      rec_id: "rec-idle-workspace",
      scope_workspace_id: "ws-idle",
      cross_workspace: false,
      workspace_multiplier: null,
    },
  ];
  return {
    ...response,
    data: { ...response.data, active, active_groups: [] } as RecommendationsView,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceNamesCache();
  vi.mocked(client.fetchRecommendations).mockResolvedValue(recommendationsWithWorkspaceScopes());
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaceNames).mockResolvedValue(mockWorkspaceNames());
  vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
  vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
});

afterEach(() => {
  cleanup();
  __resetWorkspaceNamesCache();
});

describe("useWorkspaceNames fetch failure", () => {
  it("retries after a failed fetch instead of caching the rejection", async () => {
    // First mount: fetch rejects → slug fallback (and the cache must NOT keep
    // the rejected promise). beforeEach's mockResolvedValue serves the retry.
    vi.mocked(client.fetchWorkspaceNames).mockRejectedValueOnce(new Error("daemon down"));

    const first = renderHook(() => useWorkspaceNames());
    await waitFor(() => expect(client.fetchWorkspaceNames).toHaveBeenCalledTimes(1));
    expect(first.result.current.labelFor("ws-1")).toBe("ws-1");
    first.unmount();

    const second = renderHook(() => useWorkspaceNames());
    await waitFor(() => expect(second.result.current.labelFor("ws-1")).toBe("acme/orbit-api"));
    expect(client.fetchWorkspaceNames).toHaveBeenCalledTimes(2);
  });
});

describe("workspace names in recommendations", () => {
  it("renders owner/name in the Recommendations scope filter and ScopeBadge when known", async () => {
    const { container } = render(<RecommendationsPage />);

    const scopeStrip = await screen.findByLabelText("Filter by scope");
    await waitFor(() => expect(within(scopeStrip).getByText(/acme\/orbit-api/)).toBeDefined());
    expect(
      [...container.querySelectorAll(".rec-scope-badge--workspace")].some((badge) =>
        badge.textContent?.includes("acme/orbit-api"),
      ),
    ).toBe(true);
  });

  it("renders owner/name for a workspace absent from the windowed listing (>30d idle, UIR-8)", async () => {
    const { container } = render(<RecommendationsPage />);

    const scopeStrip = await screen.findByLabelText("Filter by scope");
    await waitFor(() => expect(within(scopeStrip).getByText(/acme\/legacy-etl/)).toBeDefined());
    expect(
      [...container.querySelectorAll(".rec-scope-badge--workspace")].some((badge) =>
        badge.textContent?.includes("acme/legacy-etl"),
      ),
    ).toBe(true);
  });

  it("falls back to the raw workspace slug in the scope filter and ScopeBadge when unknown", async () => {
    const { container } = render(<RecommendationsPage />);

    const scopeStrip = await screen.findByLabelText("Filter by scope");
    await waitFor(() =>
      expect(within(scopeStrip).getByText(new RegExp(UNKNOWN_WORKSPACE_ID))).toBeDefined(),
    );
    expect(
      [...container.querySelectorAll(".rec-scope-badge--workspace")].some((badge) =>
        badge.textContent?.includes(UNKNOWN_WORKSPACE_ID),
      ),
    ).toBe(true);
  });
});
