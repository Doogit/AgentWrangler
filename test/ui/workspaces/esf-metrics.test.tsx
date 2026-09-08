import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

beforeEach(() => {
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaceSessions).mockResolvedValue(
    mockWorkspaceSessions(WS, { preset: "7d" }),
  );
  vi.mocked(client.fetchContextComposition).mockResolvedValue(mockContextComposition(WS));
  vi.mocked(client.fetchWorkspaceOutcomes).mockResolvedValue(mockWorkspaceOutcomes());
  vi.mocked(client.fetchClosureProxy).mockResolvedValue(mockClosureProxy(WS));
  vi.mocked(client.fetchCostPerSuccess).mockResolvedValue(mockCostPerSuccess({ preset: "7d" }, WS));
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
});
