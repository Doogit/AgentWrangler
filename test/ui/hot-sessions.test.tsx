import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/ui/App";
import HotSessionsPage from "../../src/ui/sessions/HotSessionsPage";

const hotSessions = [
  {
    session_id: "session-expensive",
    workspace_id: "workspace-alpha",
    turns: 12,
    cost_equiv_u: 20_000,
    total_output_tokens: 1_200,
    avg_output_tokens: 100,
    total_context_tokens: 120_000,
    avg_context_tokens: 10_000,
    model: "claude-opus-5",
    last_turn_at: "2026-08-31T12:00:00Z",
    api_error_count: 0,
    compaction_count: 0,
    interrupt_count: 0,
    user_turn_count: 0,
    tool_error_count: 0,
    test_fail_count: 0,
  },
  {
    session_id: "session-cheaper",
    workspace_id: "workspace-beta",
    turns: 4,
    cost_equiv_u: 5_000,
    total_output_tokens: 320,
    avg_output_tokens: 80,
    total_context_tokens: 24_000,
    avg_context_tokens: 6_000,
    model: "claude-sonnet-5",
    last_turn_at: "2026-08-31T11:00:00Z",
    api_error_count: 0,
    compaction_count: 0,
    interrupt_count: 0,
    user_turn_count: 0,
    tool_error_count: 0,
    test_fail_count: 0,
  },
];

vi.mock("../../src/ui/overview/OverviewPage", () => ({
  default: () => (
    <main data-testid="page">
      <h1>Overview page</h1>
    </main>
  ),
}));

vi.mock("../../src/ui/recommendations/RecommendationsPage", () => ({
  default: () => <main data-testid="page">Recommendations page</main>,
}));

vi.mock("../../src/ui/settings/SettingsPage", () => ({
  default: () => <main data-testid="page">Settings page</main>,
}));

vi.mock("../../src/ui/workspaces/WorkspacesPage", () => ({
  default: () => <main data-testid="page">Workspaces page</main>,
}));

vi.mock("../../src/ui/sessions/SessionDetailPage", () => ({
  default: ({ sessionId }: { sessionId: string }) => (
    <main data-testid="page">
      <h1>Session detail page</h1>
      <output>{sessionId}</output>
    </main>
  ),
}));

function replaceHash(hash: string) {
  window.history.replaceState(null, "", hash === "" ? "/" : hash);
}

function setupFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => hotSessions,
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  replaceHash("");
  setupFetch();
});

describe("hot sessions page", () => {
  it("navigates from the Observe Sessions item to the ranked list", async () => {
    render(<App />);

    const navigation = screen.getByRole("navigation");
    const observe = screen.getByText("Observe");
    const configure = screen.getByText("Configure");
    const sessions = screen.getByRole("button", { name: "Sessions" });
    const children = Array.from(navigation.children);

    expect(children.indexOf(sessions)).toBeGreaterThan(children.indexOf(observe));
    expect(children.indexOf(sessions)).toBeLessThan(children.indexOf(configure));

    fireEvent.click(sessions);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
      expect(screen.getByRole("heading", { name: "Hot sessions" })).toBeTruthy();
      expect(screen.getByText("workspace-alpha")).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Copy and open session session-expensive" }),
    );

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions/session-expensive");
      expect(screen.getByRole("heading", { name: "Session detail page" })).toBeTruthy();
    });
  });

  it("renders each mocked row with cost and model values", async () => {
    render(<HotSessionsPage onSelectSession={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("workspace-alpha")).toBeTruthy();
      expect(screen.getByText("workspace-beta")).toBeTruthy();
      expect(screen.getByText("$0.02")).toBeTruthy();
      expect(screen.getByText("$0.01")).toBeTruthy();
      expect(screen.getByText("claude-opus-5")).toBeTruthy();
      expect(screen.getByText("claude-sonnet-5")).toBeTruthy();
      expect(screen.getByText("100 out / 10,000 ctx")).toBeTruthy();
    });
  });

  it("calls onSelectSession with the clicked row session id", async () => {
    const onSelectSession = vi.fn();
    render(<HotSessionsPage onSelectSession={onSelectSession} />);

    const sessionLink = await screen.findByRole("button", {
      name: "Copy and open session session-expensive",
    });
    fireEvent.click(sessionLink);

    expect(onSelectSession).toHaveBeenCalledWith("session-expensive");
  });

  it("keeps the bare sessions route separate from session detail", async () => {
    replaceHash("#/sessions");
    render(<App />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Hot sessions" })).toBeTruthy());

    replaceHash("#/sessions/session-123");
    window.dispatchEvent(new Event("hashchange"));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Session detail page" })).toBeTruthy(),
    );
  });
});
