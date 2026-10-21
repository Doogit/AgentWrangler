/**
 * test/ui/workspaces-rv1.test.tsx — RV1a/RV1b: workspace detail route, row-click
 * navigation, empty-workspace state, and App.tsx parseHash extension.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHash } from "../../src/ui/App";
import * as client from "../../src/ui/api/client";
import * as esfClient from "../../src/ui/api/esf-client";
import {
  mockClosureProxy,
  mockContextComposition,
  mockCostPerSuccess,
  mockTrends,
  mockWorkspaceOutcomes,
  mockWorkspaceSessions,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
import WorkspaceDetailPage from "../../src/ui/workspaces/WorkspaceDetailPage";

vi.mock("../../src/ui/api/client");
vi.mock("../../src/ui/api/esf-client");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setupDetailMocks(workspaceId = "ws-1") {
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaceSessions).mockResolvedValue(
    mockWorkspaceSessions(workspaceId, { preset: "7d" }),
  );
  vi.mocked(client.fetchContextComposition).mockResolvedValue(mockContextComposition(workspaceId));
  vi.mocked(client.fetchWorkspaceOutcomes).mockResolvedValue(mockWorkspaceOutcomes());
  vi.mocked(client.fetchClosureProxy).mockResolvedValue(mockClosureProxy(workspaceId));
  vi.mocked(client.fetchCostPerSuccess).mockResolvedValue(
    mockCostPerSuccess({ preset: "7d" }, workspaceId),
  );
  // Cohort evidence stays pending; these tests cover the data sections above it.
  vi.mocked(esfClient.fetchEsfObservations).mockReturnValue(new Promise(() => {}));
}

// ---------------------------------------------------------------------------
// parseHash — workspace-detail routes
// ---------------------------------------------------------------------------

describe("parseHash — workspace-detail routes (RV1b)", () => {
  it("resolves #/workspaces/:id to workspace-detail with workspaceId", () => {
    const result = parseHash("#/workspaces/ws-42");
    expect(result.route).toBe("workspace-detail");
    expect(result.workspaceId).toBe("ws-42");
    expect(result.sessionId).toBeNull();
  });

  it("decodes URL-encoded workspace ids", () => {
    const result = parseHash("#/workspaces/C--Users-dev%2Forbit-api");
    expect(result.route).toBe("workspace-detail");
    expect(result.workspaceId).toBe("C--Users-dev/orbit-api");
  });

  it("resolves bare #/workspaces (no id) to workspaces list", () => {
    const result = parseHash("#/workspaces");
    expect(result.route).toBe("workspaces");
    expect(result.workspaceId).toBeNull();
  });

  it("resolves #/workspaces with query params to workspaces list", () => {
    const result = parseHash("#/workspaces?ws=alpha");
    expect(result.route).toBe("workspaces");
    expect(result.workspaceId).toBeNull();
  });

  it("existing routes carry workspaceId: null", () => {
    expect(parseHash("#/overview").workspaceId).toBeNull();
    expect(parseHash("#/sessions/abc").workspaceId).toBeNull();
    expect(parseHash("#/recommendations").workspaceId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WorkspaceDetailPage — render
// ---------------------------------------------------------------------------

describe("WorkspaceDetailPage", () => {
  beforeEach(() => {
    setupDetailMocks();
  });

  it("renders KPI headers and workspace label", async () => {
    render(<WorkspaceDetailPage workspaceId="ws-1" onBack={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("Spend (7d)")).toBeTruthy();
    });
    expect(screen.getByText("Cost per turn")).toBeTruthy();
    expect(screen.getByText("Sessions (7d)")).toBeTruthy();
  });

  it("renders the top sessions table", async () => {
    render(<WorkspaceDetailPage workspaceId="ws-1" onBack={() => {}} />);
    await waitFor(() => {
      expect(screen.getByRole("columnheader", { name: "Session" })).toBeTruthy();
    });
    expect(screen.getByRole("columnheader", { name: "Turns" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Cost" })).toBeTruthy();
  });

  it("renders context composition panel", async () => {
    const { container } = render(<WorkspaceDetailPage workspaceId="ws-1" onBack={() => {}} />);
    await waitFor(() => {
      // OV-11 item 12: "Where tokens went" is the only visible heading; the panel keeps its region name.
      expect(screen.getByRole("region", { name: "Context composition" })).toBeTruthy();
    });
    const whereTokensCard = screen
      .getByRole("heading", { name: "Where tokens went" })
      .closest(".card");
    const outcomesCard = screen.getByRole("heading", { name: "Outcomes" }).closest(".card");
    expect(whereTokensCard?.querySelector(":scope > .card-body-padded")).not.toBeNull();
    expect(outcomesCard?.querySelector(":scope > .card-body-padded")).not.toBeNull();
    expect(
      container.querySelectorAll("[data-testid='workspace-outcome-stat-cards'] > .card.kpi").length,
    ).toBe(3);
  });

  it("uses a real session detail link in the primary cell", async () => {
    render(<WorkspaceDetailPage workspaceId="ws-1" onBack={() => {}} />);
    // Wait for sessions to load
    await waitFor(() => {
      expect(screen.getByRole("columnheader", { name: "Session" })).toBeTruthy();
    });
    // OV-11 item 11: the cell shows a short id; the full id stays in the link title.
    const sessionLink = screen.getAllByTitle(/ua11-session-.*-ws-1-/)[0];
    expect(sessionLink?.textContent).toMatch(/…$/);
    expect(sessionLink).toBeDefined();
    expect(sessionLink?.getAttribute("href")).toMatch(/^#\/sessions\//);
    fireEvent.click(sessionLink as Element);
    await waitFor(() => expect(window.location.hash).toContain("#/sessions/"));
  });

  it("requests cohort evidence only after the top-sessions request settles (OV-11 perf)", async () => {
    let release!: (value: ReturnType<typeof mockWorkspaceSessions>) => void;
    vi.mocked(client.fetchWorkspaceSessions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(<WorkspaceDetailPage workspaceId="ws-1" onBack={() => {}} />);
    await waitFor(() => expect(client.fetchCostPerSuccess).toHaveBeenCalledTimes(1));
    expect(esfClient.fetchEsfObservations).not.toHaveBeenCalled();
    release(mockWorkspaceSessions("ws-1", { preset: "7d" }));
    await waitFor(() => expect(esfClient.fetchEsfObservations).toHaveBeenCalledTimes(1));
  });

  it("calls onBack when back button is clicked", async () => {
    const onBack = vi.fn();
    render(<WorkspaceDetailPage workspaceId="ws-1" onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: /back to workspaces/i }));
    expect(onBack).toHaveBeenCalled();
  });

  it("renders workspace-filtered recs link", async () => {
    render(<WorkspaceDetailPage workspaceId="ws-1" onBack={() => {}} />);
    await waitFor(() => {
      const recsLink = screen.getByText(/View workspace recommendations/i);
      expect(recsLink).toBeTruthy();
      expect((recsLink.closest("a") as HTMLAnchorElement).href).toContain(
        encodeURIComponent("ws-1"),
      );
    });
  });

  it("shows EARLY ESTIMATE chip on the Outcomes section", async () => {
    render(<WorkspaceDetailPage workspaceId="ws-1" onBack={() => {}} />);
    await waitFor(() => {
      // There should be at least one EARLY ESTIMATE chip in the outcomes section.
      expect(screen.getAllByRole("status", { name: "EARLY ESTIMATE" }).length).toBeGreaterThan(0);
    });
  });

  it("shows empty state when workspace not found in spend list", async () => {
    const workspaces = mockWorkspaces({ preset: "7d" });
    if (workspaces.data === null) throw new Error("fixture must have data");
    workspaces.data.items = [];
    vi.mocked(client.fetchWorkspaces).mockResolvedValue(workspaces);

    render(<WorkspaceDetailPage workspaceId="unknown-ws" onBack={() => {}} />);
    // KPI section should show the "no spend data" banner
    await waitFor(() => {
      expect(
        screen.getByText(/No spend data found for workspace/i) || screen.getByText(/unknown-ws/),
      ).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// WorkspaceDetailPage — empty sessions state
// ---------------------------------------------------------------------------

describe("WorkspaceDetailPage — empty sessions", () => {
  it("shows empty state when sessions list is empty", async () => {
    vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
    const emptySessions = mockWorkspaceSessions("ws-1", { preset: "7d" });
    if (emptySessions.data === null) throw new Error("fixture must have data");
    emptySessions.data.items = [];
    vi.mocked(client.fetchWorkspaceSessions).mockResolvedValue(emptySessions);
    vi.mocked(client.fetchContextComposition).mockResolvedValue(mockContextComposition("ws-1"));
    vi.mocked(client.fetchWorkspaceOutcomes).mockResolvedValue(mockWorkspaceOutcomes());
    vi.mocked(client.fetchClosureProxy).mockResolvedValue(mockClosureProxy("ws-1"));
    vi.mocked(client.fetchCostPerSuccess).mockResolvedValue(
      mockCostPerSuccess({ preset: "7d" }, "ws-1"),
    );

    render(<WorkspaceDetailPage workspaceId="ws-1" onBack={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/No sessions found/i)).toBeTruthy();
    });
  });
});
