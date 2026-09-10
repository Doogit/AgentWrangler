import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationsView } from "../../src/query/api/recommendations";
import * as client from "../../src/ui/api/client";
import {
  mockEfficiencyHeadroom,
  mockLedger,
  mockPractices,
  mockRecommendations,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
import { __resetWorkspaceNamesCache } from "../../src/ui/lib/workspace-names";
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
  vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
  vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
});

afterEach(() => {
  cleanup();
  __resetWorkspaceNamesCache();
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
