import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HotSessionsPage from "../../../src/ui/sessions/HotSessionsPage";

const { fetchPage } = vi.hoisted(() => ({ fetchPage: vi.fn() }));
vi.mock("../../../src/ui/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/api/client")>()),
  fetchHotSessionsPage: fetchPage,
}));
const row = (id: string) => ({
  session_id: id,
  workspace_id: "test-workspace",
  title: `Test ${id}`,
  repo_owner: null,
  repo_name: null,
  turns: 2,
  cost_equiv_u: 1_000,
  total_context_tokens: 100,
  sum_cache_read_tokens: 0,
  max_context_tokens: 100,
  sidechain_cost_u: 0,
  active_time_s: 0,
  wall_time_s: 0,
  models: ["test-model"],
  model: "test-model",
  last_turn_at: "2026-09-23T00:00:00Z",
  compaction_count: 0,
  spend_percentile: null,
  spend_percentile_n: 0,
  issues: { top_driver: null, categories: [] },
});
beforeEach(() => {
  window.history.replaceState(null, "", "/#/sessions");
  fetchPage.mockReset().mockResolvedValue({ rows: [row("session-one")], next_cursor: null });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Sessions list filters and pagination", () => {
  it("sends a rolling 30-day from by default and omits dates for All history", async () => {
    const earliestFrom = Date.now() - 30 * 86_400_000;
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    const first = fetchPage.mock.calls[1]?.[0];
    const latestFrom = Date.now() - 30 * 86_400_000;
    expect(Date.parse(first.window.from)).toBeGreaterThanOrEqual(earliestFrom);
    expect(Date.parse(first.window.from)).toBeLessThanOrEqual(latestFrom);
    fireEvent.click(screen.getByRole("button", { name: "All history" }));
    await waitFor(() =>
      expect(fetchPage).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ window: expect.anything() }),
      ),
    );
    expect(window.location.hash).toContain("range=all");
  });

  it("prefills category, workspace, dates and prefix from the hash", async () => {
    window.history.replaceState(
      null,
      "",
      "/#/sessions?workspace=test-workspace&from=2026-09-01&to=2026-09-24&category=loops&q=session",
    );
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    await waitFor(() =>
      expect(fetchPage).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace: "test-workspace",
          category: ["loops"],
          q: "session",
          window: { from: "2026-09-01", to: "2026-09-24" },
        }),
      ),
    );
    expect((screen.getByRole("checkbox", { name: "Loops" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByRole("searchbox", { name: "Session ID" }) as HTMLInputElement).value).toBe(
      "session",
    );
  });

  it("submits prefix search on Enter and resets filters", async () => {
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    await screen.findByText("Test session-one");
    fireEvent.change(screen.getByRole("searchbox", { name: "Session ID" }), {
      target: { value: "session" },
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ q: "session" })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() => expect(window.location.hash).toBe("#/sessions"));
  });

  it("appends a second page without duplicate IDs", async () => {
    fetchPage
      .mockReset()
      .mockResolvedValueOnce({ rows: [row("session-one")], next_cursor: null })
      .mockResolvedValueOnce({ rows: [row("session-one")], next_cursor: "1" })
      .mockResolvedValueOnce({ rows: [row("session-one"), row("session-two")], next_cursor: null });
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByText("Test session-two");
    expect(screen.getAllByText("Test session-one")).toHaveLength(1);
    expect(fetchPage.mock.calls[2]?.[0]).toEqual(expect.objectContaining({ cursor: "1" }));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("default request does NOT send a `to`", async () => {
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    const first = fetchPage.mock.calls[1]?.[0];
    expect(first?.window?.to).toBeUndefined();
  });

  it("two categories checked → fetchPage called with both; comma pre-fill checks both boxes", async () => {
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    await screen.findByText("Test session-one");

    fireEvent.click(screen.getByRole("checkbox", { name: "Loops" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Errors" }));

    await waitFor(() =>
      expect(fetchPage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          category: expect.arrayContaining(["loops", "errors"]),
        }),
      ),
    );

    cleanup();

    window.history.replaceState(null, "", "/#/sessions?category=loops,errors");
    fetchPage.mockReset().mockResolvedValue({ rows: [row("session-one")], next_cursor: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    render(<HotSessionsPage onSelectSession={vi.fn()} />);

    await waitFor(() => {
      expect((screen.getByRole("checkbox", { name: "Loops" }) as HTMLInputElement).checked).toBe(
        true,
      );
      expect((screen.getByRole("checkbox", { name: "Errors" }) as HTMLInputElement).checked).toBe(
        true,
      );
    });
  });

  it("changing a filter after Load more resets paging to the first page", async () => {
    fetchPage
      .mockReset()
      .mockResolvedValueOnce({ rows: [row("session-one")], next_cursor: null })
      .mockResolvedValueOnce({ rows: [row("session-one")], next_cursor: "1" })
      .mockResolvedValueOnce({ rows: [row("session-two")], next_cursor: null })
      .mockResolvedValueOnce({ rows: [row("session-three")], next_cursor: null })
      .mockResolvedValueOnce({ rows: [row("session-three")], next_cursor: null });

    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByText("Test session-two");

    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), {
      target: { value: "test-model" },
    });

    await waitFor(() => {
      const lastCall = fetchPage.mock.calls.at(-1)?.[0];
      expect(lastCall?.cursor).toBeUndefined();
      expect(lastCall).toEqual(expect.objectContaining({ model: "test-model" }));
    });

    await screen.findByText("Test session-three");
    expect(screen.queryByText("Test session-two")).toBeNull();
  });

  it("disables Load more in flight and retries the same cursor after failure", async () => {
    let rejectSecond: ((reason: Error) => void) | undefined;
    fetchPage
      .mockReset()
      .mockResolvedValueOnce({ rows: [row("session-one")], next_cursor: null })
      .mockResolvedValueOnce({ rows: [row("session-one")], next_cursor: "1" })
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSecond = reject;
          }),
      )
      .mockResolvedValueOnce({ rows: [row("session-two")], next_cursor: null });
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect((screen.getByRole("button", { name: "Loading…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    rejectSecond?.(new Error("offline"));
    expect(await screen.findByText(/Couldn't load more sessions/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Test session-two");
    expect(fetchPage.mock.calls[3]?.[0]).toEqual(expect.objectContaining({ cursor: "1" }));
  });
});
