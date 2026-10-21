import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/ui/App";
import HotSessionsPage from "../../src/ui/sessions/HotSessionsPage";

const { fetchPage } = vi.hoisted(() => ({ fetchPage: vi.fn() }));
vi.mock("../../src/ui/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/ui/api/client")>()),
  fetchHotSessionsPage: fetchPage,
}));
vi.mock("../../src/ui/overview/OverviewPage", () => ({
  default: () => <main>Overview page</main>,
}));
vi.mock("../../src/ui/recommendations/RecommendationsPage", () => ({
  default: () => <main>Recommendations page</main>,
}));
vi.mock("../../src/ui/settings/SettingsPage", () => ({
  default: () => <main>Settings page</main>,
}));
vi.mock("../../src/ui/workspaces/WorkspacesPage", () => ({
  default: () => <main>Workspaces page</main>,
}));
vi.mock("../../src/ui/sessions/SessionDetailPage", () => ({
  default: ({ sessionId }: { sessionId: string }) => (
    <main>
      <h1>Session detail page</h1>
      {sessionId}
    </main>
  ),
}));

const row = {
  session_id: "session-expensive",
  workspace_id: "workspace-alpha",
  title: "Test session A",
  repo_owner: null,
  repo_name: null,
  turns: 4,
  cost_equiv_u: 20_000,
  total_output_tokens: 1200,
  avg_output_tokens: 300,
  total_context_tokens: 100_000,
  avg_context_tokens: 25_000,
  max_context_tokens: 40_000,
  sum_cache_read_tokens: 50_000,
  sidechain_cost_u: 5_000,
  active_time_s: 600,
  wall_time_s: 3600,
  model: "claude-opus-5",
  models: ["claude-opus-5"],
  last_turn_at: "2026-08-31T12:00:00Z",
  compaction_count: 2,
  spend_percentile: 0.95,
  spend_percentile_n: 30,
  issues: {
    top_driver: { detector_id: "D7", label: "LOOP_RETRY_WASTE", session_cost_u: 10_000 },
    categories: ["loops"],
  },
};
beforeEach(() => {
  window.history.replaceState(null, "", "/#/sessions");
  fetchPage.mockReset().mockResolvedValue({ rows: [row], next_cursor: null });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ["claude-opus-5"] }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("hot sessions list", () => {
  it("navigates from Sessions to the detail link", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);
    fireEvent.click(screen.getByRole("link", { name: "Sessions" }));
    const link = await screen.findByRole("link", { name: "Open session session-expensive" });
    expect(link.getAttribute("href")).toBe("#/sessions/session-expensive");
    fireEvent.click(link);
    expect(await screen.findByRole("heading", { name: "Session detail page" })).toBeTruthy();
  });

  it("renders whole-session columns, title, issues and spend percentile", async () => {
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    expect(await screen.findByText("Test session A")).toBeTruthy();
    expect(screen.getByText("$0.02")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("40,000 · 2 compactions")).toBeTruthy();
    // Subagent column shows cost and share of session cost (sortable by cost, OV-3).
    expect(screen.getByText(/· 25%$/)).toBeTruthy();
    expect(screen.getByText("10m of 1h 0m")).toBeTruthy();
    const driverChip = screen.getByText("Loop / retry waste");
    expect(driverChip).toBeTruthy();
    expect(driverChip.getAttribute("title")).toBe("$0.01 spent on this in this session");
    expect(
      within(screen.getByText("Test session A").closest("tr") as HTMLElement).getByText("Loops"),
    ).toBeTruthy();
    expect(screen.getByText("top 5% by estimated value")).toBeTruthy();
  });

  it("maps deep-linked model and sort controls to the page query", async () => {
    window.history.replaceState(
      null,
      "",
      "/#/sessions?model=claude-opus-5&sort=issues&direction=asc",
    );
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    await waitFor(() =>
      expect(fetchPage).toHaveBeenCalledWith(
        expect.objectContaining({ model: "claude-opus-5", sort: "issues", direction: "asc" }),
      ),
    );
    expect(screen.getByRole("columnheader", { name: /Issues/ }).getAttribute("aria-sort")).toBe(
      "ascending",
    );
    expect((screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement).value).toBe(
      "claude-opus-5",
    );
  });

  it("sorts Issues and preserves semantic row navigation", async () => {
    const onSelectSession = vi.fn();
    render(<HotSessionsPage onSelectSession={onSelectSession} />);
    await screen.findByText("Test session A");
    fireEvent.click(screen.getByRole("button", { name: "Sort by issues" }));
    expect(window.location.hash).toContain("sort=issues");
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("navigates from the Observe Sessions item: nav order, heading, hash, and detail link", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);

    const navigation = screen.getByRole("navigation");
    const observe = screen.getByRole("region", { name: "Observe" });
    const configure = screen.getByRole("region", { name: "Configure" });
    const sessions = screen.getByRole("link", { name: "Sessions" });
    const children = Array.from(navigation.querySelectorAll(".nav-group, .nav-link"));

    expect(children.indexOf(sessions)).toBeGreaterThan(children.indexOf(observe));
    expect(children.indexOf(sessions)).toBeLessThan(children.indexOf(configure));

    fireEvent.click(sessions);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
      expect(screen.getByRole("heading", { name: "Sessions by estimated cost" })).toBeTruthy();
    });

    const sessionLink = await screen.findByRole("link", { name: "Open session session-expensive" });
    expect(sessionLink.getAttribute("href")).toBe("#/sessions/session-expensive");
    fireEvent.click(sessionLink);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions/session-expensive");
      expect(screen.getByRole("heading", { name: "Session detail page" })).toBeTruthy();
    });
  });

  it("renders every model reported for a mixed-model session", async () => {
    fetchPage.mockResolvedValue({
      rows: [{ ...row, models: ["claude-opus-5", "claude-sonnet-5"] }],
      next_cursor: null,
    });
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    expect(await screen.findByTitle("Model: claude-opus-5")).toBeTruthy();
    expect(screen.getByTitle("Model: claude-sonnet-5")).toBeTruthy();
  });

  it("offers models that are absent from the limited session rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ["claude-catalog-only", "claude-opus-5"],
      }),
    );
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    const select = await screen.findByRole("combobox", { name: "Model" });
    await waitFor(() =>
      expect(
        Array.from((select as HTMLSelectElement).options).map((option) => option.value),
      ).toContain("claude-catalog-only"),
    );
  });

  it("updates the hash and asks the server to sort when a column header is clicked", async () => {
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    await screen.findByText("Test session A");

    fireEvent.click(screen.getByRole("button", { name: "Sort by turns" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions?sort=turns&direction=desc");
      expect(fetchPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: "turns", direction: "desc" }),
      );
    });
  });

  it("retries the failed sessions collection", async () => {
    vi.stubEnv("MODE", "production");
    fetchPage
      .mockReset()
      .mockRejectedValueOnce(new Error("C:\\private\\sessions.db"))
      .mockRejectedValueOnce(new Error("C:\\private\\sessions.db"))
      .mockResolvedValue({ rows: [row], next_cursor: null });

    const { container } = render(<HotSessionsPage onSelectSession={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: "Retry sessions" });
    expect(container.textContent ?? "").not.toContain("private\\sessions.db");
    fireEvent.click(retry);

    await screen.findByText("Test session A");
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(4));
  });

  it("keeps the bare sessions route separate from session detail", async () => {
    window.history.replaceState(null, "", "/#/sessions");
    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Sessions by estimated cost" })).toBeTruthy(),
    );

    window.history.replaceState(null, "", "/#/sessions/session-123");
    window.dispatchEvent(new Event("hashchange"));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Session detail page" })).toBeTruthy(),
    );
  });
});
