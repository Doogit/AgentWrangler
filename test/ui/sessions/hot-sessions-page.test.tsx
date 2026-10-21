import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWorkspaceNamesCache } from "../../../src/ui/lib/workspace-names";
import HotSessionsPage from "../../../src/ui/sessions/HotSessionsPage";

const { fetchPage } = vi.hoisted(() => ({ fetchPage: vi.fn() }));
vi.mock("../../../src/ui/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/api/client")>()),
  fetchHotSessionsPage: fetchPage,
}));
const id = "12345678-1234-1234-1234-123456789abc";
const row = {
  session_id: id,
  workspace_id: "workspace-alpha",
  repo_owner: "acme",
  repo_name: "widget",
  title: null,
  turns: 1,
  cost_equiv_u: 0,
  total_context_tokens: 0,
  max_context_tokens: 0,
  sum_cache_read_tokens: 0,
  sidechain_cost_u: 0,
  active_time_s: 0,
  wall_time_s: 0,
  models: ["claude-sonnet"],
  model: "claude-sonnet",
  last_turn_at: "2026-08-31T12:00:00Z",
  compaction_count: 0,
  spend_percentile: null,
  spend_percentile_n: 0,
  issues: { top_driver: null, categories: [] },
};
beforeEach(() => {
  __resetWorkspaceNamesCache();
  window.history.replaceState(null, "", "/#/sessions");
  fetchPage.mockReset().mockResolvedValue({ rows: [row], next_cursor: null });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HotSessionsPage row structure", () => {
  it("paints a bounded recent slice, then replaces it with the selected range", async () => {
    let finishFull!: (value: { rows: (typeof row)[]; next_cursor: string | null }) => void;
    fetchPage
      .mockReset()
      .mockResolvedValueOnce({ rows: [row], next_cursor: null })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFull = resolve;
          }),
      );
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    await screen.findByText(/recent seven days only/);
    expect(fetchPage.mock.calls[0]?.[0]).toMatchObject({ limit: 8 });
    expect(screen.getByRole("link", { name: `Open session ${id}` })).toBeTruthy();
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    const older = { ...row, session_id: "older-session" };
    finishFull({ rows: [older], next_cursor: null });
    await screen.findByRole("link", { name: "Open session older-session" });
    expect(screen.queryByText(/recent seven days only/)).toBeNull();
    expect(screen.queryByRole("link", { name: `Open session ${id}` })).toBeNull();
  });
  it("keeps an empty recent slice explicit until older filtered results arrive", async () => {
    fetchPage
      .mockReset()
      .mockResolvedValueOnce({ rows: [], next_cursor: null })
      .mockResolvedValueOnce({ rows: [row], next_cursor: "50" });
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    await screen.findByText(/No sessions in the recent seven days match these filters/);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    await screen.findByRole("link", { name: `Open session ${id}` });
    expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
  });
  it("discards an older load-more response after the filters change", async () => {
    let finishMore!: (value: { rows: (typeof row)[]; next_cursor: string | null }) => void;
    fetchPage.mockImplementation((query: { cursor?: string; workspace?: string }) => {
      if (query.cursor)
        return new Promise((resolve) => {
          finishMore = resolve;
        });
      if (query.workspace === "other")
        return Promise.resolve({
          rows: [{ ...row, session_id: "filtered-session" }],
          next_cursor: null,
        });
      return Promise.resolve({ rows: [row], next_cursor: "50" });
    });
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "All history" }));
    await screen.findByRole("button", { name: "Load more" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(finishMore).toBeTypeOf("function"));
    window.location.hash = "#/sessions?range=all&workspace=other";
    fireEvent(window, new Event("hashchange"));
    await screen.findByRole("link", { name: "Open session filtered-session" });
    finishMore({ rows: [{ ...row, session_id: "old-filter-session" }], next_cursor: null });
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Open session old-filter-session" })).toBeNull(),
    );
  });
  it("row has hot-session-row class, workspace link has hot-session-workspace-link class, live-session-link present, no tabindex or onclick", async () => {
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    const workspace = await screen.findByRole("link", { name: "acme/widget" });
    const tr = workspace.closest("tr");
    expect(tr?.classList.contains("hot-session-row")).toBe(true);
    expect(workspace.classList.contains("hot-session-workspace-link")).toBe(true);
    expect(tr?.querySelectorAll(`a.live-session-link[href="#/sessions/${id}"]`)).toHaveLength(1);
    expect(tr?.hasAttribute("tabindex")).toBe(false);
    expect(tr?.hasAttribute("onclick")).toBe(false);
  });

  it("Estimated cost header present; InfoTip hover shows cost explanation", async () => {
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    await screen.findByRole("link", { name: "acme/widget" });
    expect(screen.getByRole("columnheader", { name: /Estimated cost/i })).toBeTruthy();
    fireEvent.mouseEnter(screen.getByRole("button", { name: "What Estimated cost means" }));
    expect(screen.getByText(/Estimated session cost at public API list prices/)).toBeTruthy();
  });

  it("falls back to the workspace slug when canonical identity is null", async () => {
    fetchPage.mockResolvedValue({
      rows: [{ ...row, repo_owner: null, repo_name: null }],
      next_cursor: null,
    });
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    expect(await screen.findByRole("link", { name: "workspace-alpha" })).toBeTruthy();
  });

  it("spend_percentile chip shows top X% and n; null percentile omits chip", async () => {
    fetchPage.mockResolvedValue({
      rows: [{ ...row, spend_percentile: 0.95, spend_percentile_n: 30 }],
      next_cursor: null,
    });
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    const chip = await screen.findByText("top 5% by estimated value");
    expect(chip.getAttribute("title")).toMatch(/30 sessions/);

    cleanup();
    fetchPage.mockResolvedValue({
      rows: [{ ...row, spend_percentile: null, spend_percentile_n: 0 }],
      next_cursor: null,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    await screen.findByRole("link", { name: `Open session ${id}` });
    expect(screen.queryByText(/by estimated value/)).toBeNull();
  });
});

describe("HotSessionsPage privacy labels", () => {
  it("keeps distinct workspace and session links and uses short ID fallback", async () => {
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    const workspace = await screen.findByRole("link", { name: "acme/widget" });
    const tr = workspace.closest("tr");
    expect(workspace.getAttribute("href")).toBe("#/workspaces/workspace-alpha");
    expect(tr?.querySelectorAll(`a[href="#/sessions/${id}"]`)).toHaveLength(1);
    expect(screen.getByRole("link", { name: `Open session ${id}` }).getAttribute("title")).toBe(id);
    expect(screen.getByText("12345678…")).toBeTruthy();
    expect(screen.queryByText(id)).toBeNull();
  });

  it("shows zero-denominator placeholders and no driver or spend chip", async () => {
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("12345678…")).toBeTruthy());
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText(/by spend/)).toBeNull();
  });

  it.each([
    { active_time_s: 0, wall_time_s: 60 },
    { active_time_s: null, wall_time_s: 60 },
    { active_time_s: 60, wall_time_s: 0 },
  ])("shows a placeholder for unavailable active or wall time (%o)", async (times) => {
    fetchPage.mockResolvedValue({ rows: [{ ...row, ...times }], next_cursor: null });
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    await screen.findByRole("link", { name: `Open session ${id}` });
    const header = screen.getByRole("columnheader", { name: /Active \/ wall/ });
    const columnIndex = Array.from(header.parentElement?.children ?? []).indexOf(header);
    const sessionRow = screen.getByRole("link", { name: `Open session ${id}` }).closest("tr");
    expect(sessionRow?.querySelectorAll("td")[columnIndex]?.textContent).toBe("—");
  });
});
