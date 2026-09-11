import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryMetrics } from "../../../src/query/api/delivery";
import type { ApiResponse } from "../../../src/query/envelope";
import * as client from "../../../src/ui/api/client";
import {
  mockClosureProxy,
  mockContextComposition,
  mockCostPerSuccess,
  mockWorkspaceOutcomes,
  mockWorkspaceSessions,
  mockWorkspaces,
} from "../../../src/ui/api/fixtures";
import WorkspaceDetailPage from "../../../src/ui/workspaces/WorkspaceDetailPage";

vi.mock("../../../src/ui/api/client");

const WS = "ws-1";
const delivery: ApiResponse<DeliveryMetrics> = {
  data: {
    commit_session_count: 2,
    total_session_count: 4,
    commit_session_rate: 0.5,
    spend_per_commit_session_u: 4250000,
    abandoned_spend_u: 0,
    abandoned_spend_share: null,
    no_commit_activity_session_count: 1,
    no_commit_activity_spend_u: 1250000,
    no_commit_activity_spend_share: 0.1,
    live_session_excluded_from_no_commit_activity_count: 0,
    from: "2026-09-01T00:00:00.000Z",
    to: "2026-09-08T00:00:00.000Z",
    workspace_id: WS,
  },
  meta: {
    claim_kind: "OBS_PROXY",
    n: 2,
    window: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-08T00:00:00.000Z" },
    qualification: {
      provisional_excluded: true,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: "Observed delivery proxy.",
    },
    metric_definition_version: "esf-1",
    drilldown_ids: { workspace_id: WS },
  },
};

beforeEach(() => {
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaceSessions).mockResolvedValue(
    mockWorkspaceSessions(WS, { preset: "7d" }),
  );
  vi.mocked(client.fetchContextComposition).mockResolvedValue(mockContextComposition(WS));
  vi.mocked(client.fetchWorkspaceOutcomes).mockResolvedValue(mockWorkspaceOutcomes());
  vi.mocked(client.fetchClosureProxy).mockResolvedValue(mockClosureProxy(WS));
  vi.mocked(client.fetchCostPerSuccess).mockResolvedValue(mockCostPerSuccess({ preset: "7d" }, WS));
  vi.mocked(client.fetchWorkspaceDelivery).mockResolvedValue(delivery);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ESF metric labels on WorkspaceDetailPage", () => {
  it("labels closure as a no-later-session observation rather than resolution", async () => {
    render(<WorkspaceDetailPage workspaceId={WS} onBack={() => {}} />);

    const closure = await screen.findByTestId("ef2-closure-proxy");
    expect(closure.textContent).toContain("No later workspace session within 48h");
    expect(closure.textContent).not.toContain("resolved share");
    expect(closure.textContent).toContain("observation denominator");
  });

  it("shows unavailable shared-session coverage for a legacy payload", async () => {
    const cost = mockCostPerSuccess({ preset: "7d" }, WS);
    if (cost.data === null) throw new Error("fixture must have data");
    const {
      unique_linked_session_count: _unique,
      shared_linked_session_count: _shared,
      ...legacy
    } = cost.data;
    cost.data = legacy;
    vi.mocked(client.fetchCostPerSuccess).mockResolvedValue(cost);

    render(<WorkspaceDetailPage workspaceId={WS} onBack={() => {}} />);
    await screen.findByTestId("r4a-cost-per-merged-pr");
    expect(screen.getByTestId("r4a-unique-linked-session-count").textContent).toContain(
      "unavailable",
    );
    expect(screen.getByTestId("r4a-shared-linked-session-count").textContent).toContain(
      "unavailable",
    );
  });

  it("renders delivery as denominator-bearing stat cards without a composite score or data-row table", async () => {
    render(<WorkspaceDetailPage workspaceId={WS} onBack={() => {}} />);

    const card = await screen.findByTestId("workspace-delivery-card");
    expect(card.textContent).toContain("Bash/edit activity without an observed commit");
    expect(card.textContent).toContain("2/4");
    expect(card.textContent).toContain("1/4");
    expect(screen.getByTestId("workspace-outcome-stat-cards").querySelector("table")).toBeNull();
    expect(
      screen.getByTestId("workspace-outcome-stat-cards").textContent?.toLowerCase(),
    ).not.toContain("score");
  });
});
