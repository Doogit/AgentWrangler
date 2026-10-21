import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowFilter } from "../../src/query/api/overview";
import App from "../../src/ui/App";
import * as client from "../../src/ui/api/client";
import {
  mockClosureProxy,
  mockContextComposition,
  mockCostPerSuccess,
  mockTrends,
  mockWorkspaceNames,
  mockWorkspaceOutcomes,
  mockWorkspaceSessions,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";

const now = Date.parse("2026-09-24T12:00:00Z");
const day = 86_400_000;
// Independent period oracle: $2 recent, $3 older than 7d, $5 older than 30d;
// a second workspace's $91 must never appear in the first workspace's summary.
const corpus = [
  { workspace: "ws-1", age: 2, dollars: 2 },
  { workspace: "ws-1", age: 15, dollars: 3 },
  { workspace: "ws-1", age: 45, dollars: 5 },
  { workspace: "ws-2", age: 1, dollars: 91 },
];
function bounds(filter: WindowFilter) {
  const days = filter.preset === "30d" ? 30 : filter.preset === "24h" ? 1 : 7;
  return {
    from: filter.from ?? new Date(now - days * day).toISOString(),
    to: filter.to ?? new Date(now).toISOString(),
  };
}
function corpusWorkspaces(filter: WindowFilter) {
  const response = mockWorkspaces(filter);
  if (!response.data) throw new Error("Missing workspace fixture data");
  response.meta.window = bounds(filter);
  const selected = corpus.filter((r) => now - r.age * day >= Date.parse(response.meta.window.from));
  response.data.items = response.data.items
    .filter((r) => selected.some((s) => s.workspace === r.workspace_id))
    .map((r) => ({
      ...r,
      cost_equiv_u: selected
        .filter((s) => s.workspace === r.workspace_id)
        .reduce((sum, s) => sum + s.dollars * 1_000_000, 0),
    }));
  return response;
}

vi.mock("../../src/ui/api/client");
vi.mock("../../src/ui/shell/PipelineStatusBar", () => ({ default: () => null }));
vi.mock("../../src/ui/esf/ObservationEvidence", () => ({ ObservationEvidence: () => null }));
vi.mock("../../src/ui/lib/history-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/ui/lib/history-status")>()),
  useHistoryStatus: () => ({
    complete: true,
    processing: false,
    failed: false,
    revision: "test",
    coverage: undefined,
  }),
}));
vi.mock("../../src/ui/sessions/SessionDetailPage", () => ({
  default: ({
    onBack,
    backLabel,
    anchorMessageId,
    anchorTurnIndex,
  }: {
    onBack: () => void;
    backLabel: string;
    anchorMessageId: string;
    anchorTurnIndex: number;
  }) => (
    <div>
      <h1>Whole session</h1>
      <output>
        {anchorMessageId}:{anchorTurnIndex}
      </output>
      <button type="button" onClick={onBack}>
        {backLabel}
      </button>
    </div>
  ),
}));

beforeEach(() => {
  vi.mocked(client.fetchWorkspaces).mockImplementation(async (filter) => corpusWorkspaces(filter));
  vi.mocked(client.fetchWorkspaceNames).mockResolvedValue(mockWorkspaceNames());
  vi.mocked(client.fetchTrends).mockResolvedValue(mockTrends({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaceOutcomes).mockResolvedValue(mockWorkspaceOutcomes());
  vi.mocked(client.fetchWorkspaceSessions).mockImplementation(async (id, filter) => {
    const response = mockWorkspaceSessions("ws-1", { preset: "7d" });
    const template = response.data?.items[0];
    if (!response.data || !template) throw new Error("Missing session fixture data");
    response.meta.window = bounds(filter);
    response.data.items = corpus
      .filter((r) => r.workspace === id && now - r.age * day >= Date.parse(bounds(filter).from))
      .map((r) => ({
        ...template,
        workspace_id: id,
        session_id: `${id}/age-${r.age}`,
        cost_equiv_u: r.dollars * 1_000_000,
      }));
    return response;
  });
  vi.mocked(client.fetchContextComposition).mockResolvedValue(mockContextComposition("ws-1"));
  vi.mocked(client.fetchClosureProxy).mockResolvedValue(mockClosureProxy("ws-1"));
  vi.mocked(client.fetchCostPerSuccess).mockResolvedValue(
    mockCostPerSuccess({ preset: "7d" }, "ws-1"),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("mounted workspace scope navigation", () => {
  for (const suffix of ["", "?window=invalid"]) {
    it(`defaults an unrecognized list window to all through detail and Back: ${suffix}`, async () => {
      window.history.replaceState(null, "", `#/workspaces${suffix}`);
      render(<App />);
      await screen.findByRole("link", { name: "acme/orbit-api" });
      await waitFor(() =>
        expect(client.fetchWorkspaces).toHaveBeenCalledWith(
          { from: "1970-01-01T00:00:00.000Z" },
          { fresh: true },
        ),
      );
      const link = screen.getByRole("link", { name: "acme/orbit-api" });
      expect(new URLSearchParams(link.getAttribute("href")?.split("?")[1]).get("window")).toBe(
        "all",
      );
      fireEvent.click(link);
      await screen.findByText("Spend (all)");
      await waitFor(() =>
        expect(client.fetchWorkspaceSessions).toHaveBeenCalledWith("ws-1", {
          from: "1970-01-01T00:00:00.000Z",
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Back to workspaces" }));
      await waitFor(() => expect(window.location.hash).toBe("#/workspaces?window=all"));
    });
  }

  it("keeps an encoded workspace ID in the link and decodes it for detail requests", async () => {
    const workspaceId = "ws/encoded";
    vi.mocked(client.fetchWorkspaces).mockImplementation(async (filter) => {
      const response = corpusWorkspaces(filter);
      const row = response.data?.items[0];
      if (!response.data || !row) throw new Error("Missing workspace fixture row");
      response.data.items = [{ ...row, workspace_id: workspaceId, repo_name: "encoded" }];
      return response;
    });
    window.history.replaceState(null, "", "#/workspaces?window=all");
    render(<App />);
    const link = await screen.findByRole("link", { name: "acme/encoded" });
    expect(link.getAttribute("href")).toBe("#/workspaces/ws%2Fencoded?window=all");
    fireEvent.click(link);
    await screen.findByText("Spend (all)");
    await waitFor(() =>
      expect(client.fetchWorkspaceSessions).toHaveBeenCalledWith(workspaceId, {
        from: "1970-01-01T00:00:00.000Z",
      }),
    );
  });

  it("honors a 30d detail reload and returns to the 30d list", async () => {
    window.history.replaceState(null, "", "#/workspaces/ws-1?window=30d");
    render(<App />);
    await screen.findByText("Spend (30d)");
    expect(client.fetchWorkspaces).toHaveBeenCalledWith({ preset: "30d" });
    fireEvent.click(screen.getByRole("button", { name: "Back to workspaces" }));
    await waitFor(() => expect(window.location.hash).toBe("#/workspaces?window=30d"));
    await screen.findByLabelText("Workspace activity window");
  });

  for (const scope of ["7d", "30d", "all"] as const) {
    for (const id of ["ws-1", "ws-idle"]) {
      it(`${scope}: ${id} row survives click, reload, Back and browser history`, async () => {
        window.history.replaceState(null, "", `#/workspaces?window=${scope}&keep=encoded%2Fvalue`);
        let mounted = render(<App />);
        const label = id === "ws-1" ? "acme/orbit-api" : "acme/legacy-etl";
        const link = await screen.findByRole("link", { name: label });
        const target = link.getAttribute("href") ?? "";
        expect(new URLSearchParams(target.split("?")[1]).get("window")).toBe(scope);
        fireEvent.click(link);
        await screen.findByText(`Workspace detail · selected ${scope} window`);
        await waitFor(() =>
          expect(client.fetchWorkspaceSessions).toHaveBeenCalledWith(
            id,
            scope === "all" ? { from: "1970-01-01T00:00:00.000Z" } : { preset: scope },
          ),
        );
        if (id === "ws-1") {
          const value = scope === "7d" ? "$2.00" : scope === "30d" ? "$5.00" : "$10.00";
          expect(screen.getByText(`Spend (${scope})`).closest(".kpi")?.textContent).toContain(
            value,
          );
          expect(document.querySelector('a[href*="ws-2%2Fage"]')).toBeNull();
          expect(client.fetchCostPerSuccess).toHaveBeenLastCalledWith(
            scope === "all" ? { from: "1970-01-01T00:00:00.000Z" } : { preset: scope },
            id,
          );
          expect(client.fetchWorkspaceDelivery).toHaveBeenLastCalledWith(
            id,
            scope === "all" ? { from: "1970-01-01T00:00:00.000Z" } : { preset: scope },
          );
        }
        mounted.unmount();
        mounted = render(<App />);
        await screen.findByText(`Workspace detail · selected ${scope} window`);
        fireEvent.click(screen.getByRole("button", { name: "Back to workspaces" }));
        await screen.findByLabelText("Workspace activity window");
        expect(window.location.hash).toContain(`window=${scope}`);
        expect(window.location.hash).toContain("keep=encoded%2Fvalue");
        act(() => window.history.back());
        await screen.findByText(`Workspace detail · selected ${scope} window`);
        act(() => window.history.forward());
        await screen.findByLabelText("Workspace activity window");
        mounted.unmount();
        // An unmounted list must not fire its staged full-window fetch into the next test.
        const callsAtUnmount = vi.mocked(client.fetchWorkspaces).mock.calls.length;
        await new Promise((r) => setTimeout(r, 300));
        expect(client.fetchWorkspaces).toHaveBeenCalledTimes(callsAtUnmount);
      });
    }
  }

  it("updates the mounted detail URL and rejects late responses from its old scope", async () => {
    window.history.replaceState(null, "", "#/workspaces/ws-1?window=7d&keep=yes");
    let release!: (value: ReturnType<typeof corpusWorkspaces>) => void;
    vi.mocked(client.fetchWorkspaces).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^30d$/ }));
    await screen.findByText("Spend (30d)");
    expect(window.location.hash).toBe("#/workspaces/ws-1?window=30d&keep=yes");
    await act(async () => release(corpusWorkspaces({ preset: "7d" })));
    expect(screen.getByText("Spend (30d)").closest(".kpi")?.textContent).toContain("$5.00");
    act(() => window.history.back());
    await screen.findByText("Spend (7d)");
  });

  it("ignores a late workspace retry after the detail window changes", async () => {
    window.history.replaceState(null, "", "#/workspaces/ws-1?window=7d");
    let release!: (value: ReturnType<typeof corpusWorkspaces>) => void;
    vi.mocked(client.fetchWorkspaces)
      .mockRejectedValueOnce(new Error("initial request failed"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry workspaces" }));
    await waitFor(() => expect(client.fetchWorkspaces).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /^30d$/ }));
    await screen.findByText("Spend (30d)");
    expect(screen.getByText("Spend (30d)").closest(".kpi")?.textContent).toContain("$5.00");
    await act(async () => release(corpusWorkspaces({ preset: "7d" })));
    expect(screen.getByText("Spend (30d)").closest(".kpi")?.textContent).toContain("$5.00");
  });

  it("ignores a late sessions retry after the detail window changes", async () => {
    window.history.replaceState(null, "", "#/workspaces/ws-1?window=7d");
    let release!: (value: ReturnType<typeof mockWorkspaceSessions>) => void;
    vi.mocked(client.fetchWorkspaceSessions)
      .mockRejectedValueOnce(new Error("initial sessions request failed"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry workspace sessions" }));
    await waitFor(() => expect(client.fetchWorkspaceSessions).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /^30d$/ }));
    await waitFor(() => expect(document.querySelector('a[href*="age-15"]')).not.toBeNull());
    await act(async () => release(mockWorkspaceSessions("ws-1", { preset: "7d" })));
    expect(document.querySelector('a[href*="age-15"]')).not.toBeNull();
  });

  // P1-U6a: dependent requests no longer wait for the new workspace list; they send the new
  // window's preset and each route resolves it (drilldown-window-parity.test.ts).
  it("starts the new window's dependent requests without waiting for the workspace list", async () => {
    window.history.replaceState(null, "", "#/workspaces/ws-1?window=7d");
    render(<App />);
    await waitFor(() => expect(client.fetchWorkspaceSessions).toHaveBeenCalledTimes(1));
    let release!: (value: ReturnType<typeof corpusWorkspaces>) => void;
    vi.mocked(client.fetchWorkspaces).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^30d$/ }));
    await waitFor(() => expect(client.fetchWorkspaces).toHaveBeenCalledTimes(2));
    // The list is still pending, yet the 30d dependents are already requested.
    expect(client.fetchWorkspaceSessions).toHaveBeenCalledTimes(2);
    expect(client.fetchWorkspaceSessions).toHaveBeenLastCalledWith("ws-1", { preset: "30d" });
    expect(client.fetchCostPerSuccess).toHaveBeenLastCalledWith({ preset: "30d" }, "ws-1");
    expect(client.fetchWorkspaceDelivery).toHaveBeenLastCalledWith("ws-1", { preset: "30d" });
    await act(async () => release(corpusWorkspaces({ preset: "30d" })));
    await screen.findByText("Spend (30d)");
  });

  for (const suffix of ["", "?window=invalid"]) {
    it(`retains standalone legacy detail default: ${suffix}`, async () => {
      window.history.replaceState(null, "", `#/workspaces/ws-1${suffix}`);
      render(<App />);
      await screen.findByText("Spend (7d)");
      fireEvent.click(screen.getByRole("button", { name: "Back to workspaces" }));
      await waitFor(() => expect(window.location.hash).toBe("#/workspaces?window=7d"));
    });
  }

  it("retains scoped session return, encoded IDs and anchor/turn on reload", async () => {
    window.history.replaceState(null, "", "#/workspaces/ws-1?window=all");
    let mounted = render(<App />);
    await screen.findByText("Spend (all)");
    const session = document.querySelector<HTMLAnchorElement>('a[href^="#/sessions/ws-1%2F"]');
    if (!session) throw new Error("Missing linked session");
    const target = `${session.getAttribute("href")}&anchor=turn%2Fone&turn=3`;
    mounted.unmount();
    window.history.replaceState(null, "", target);
    mounted = render(<App />);
    await screen.findByText("turn/one:3");
    fireEvent.click(screen.getByRole("button", { name: "Back to workspaces" }));
    await screen.findByText("Spend (all)");
    fireEvent.click(screen.getByRole("button", { name: "Back to workspaces" }));
    await screen.findByLabelText("Workspace activity window");
    expect(window.location.hash).toBe("#/workspaces?window=all");
  });

  for (const target of ["https://example.com", "#/settings", "#/workspaces/%ZZ", "//example.com"]) {
    it(`rejects an unsafe session return target: ${target}`, async () => {
      window.history.replaceState(null, "", `#/sessions/id?returnTo=${encodeURIComponent(target)}`);
      render(<App />);
      await screen.findByRole("button", { name: "Back to sessions" });
    });
  }
});
