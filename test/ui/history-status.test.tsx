/**
 * test/ui/history-status.test.tsx — P2-U7: Sessions and Workspaces read history state from the
 * P2-U5 status poller (poll-first, D6), not a 10 s /api/history-progress poll.
 *
 * Oracle: hand-set /api/status bodies (`pipeline`, `history_coverage`, `data_scopes`) and the
 * request counts of the mocked list fetchers.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus, PipelineStatus } from "../../src/ui/api/client";
import {
  mockTrends,
  mockWorkspaceNames,
  mockWorkspaceOutcomes,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
import { _resetStatusPoller, pollStatusNow } from "../../src/ui/api/status-poller";
import { coverageLabel, historyFromStatus, historyNoteText } from "../../src/ui/lib/history-status";
import HotSessionsPage from "../../src/ui/sessions/HotSessionsPage";
import WorkspacesPage from "../../src/ui/workspaces/WorkspacesPage";

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  fetchHotSessionsPage: vi.fn(),
  fetchWorkspaces: vi.fn(),
  fetchTrends: vi.fn(),
  fetchWorkspaceOutcomes: vi.fn(),
  fetchWorkspaceNames: vi.fn(),
}));
vi.mock("../../src/ui/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/ui/api/client")>()),
  ...mocks,
}));
vi.mock("../../src/ui/shell/PipelineStatusBar", () => ({ default: () => null }));

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-06T12:00:00Z");
/** The UTC day `n - 1` days before today, so the covered span is `n` days inclusive. */
const coveredFrom = (n: number, now = Date.now()) =>
  new Date(now - (n - 1) * DAY).toISOString().slice(0, 10);

const HISTORY: PipelineStatus = {
  phase: "history",
  weeks_total: 13,
  weeks_done: 2,
  files_total: 10,
  files_completed: 4,
  files_with_new_data: 4,
  detector_runs: 1,
  failed_phase: null,
  events: [],
};
const DONE: PipelineStatus = { ...HISTORY, phase: "done", weeks_done: 13 };

type Scopes = { live: number; ingest: number; detectors: number; lifecycle: number };
function status(
  scopes: Partial<Scopes> = {},
  extra: Partial<DaemonStatus> & Record<string, unknown> = {},
): DaemonStatus {
  return {
    sessions: 3,
    files_seen: 10,
    files_parsed: 10,
    data_version: 5,
    data_scopes: { live: 1, ingest: 1, detectors: 1, lifecycle: 1, clock: "d|d", ...scopes },
    pipeline: HISTORY,
    history_coverage: {
      weeks_done: 2,
      weeks_total: 13,
      complete_through_ms: Date.now() - 8 * DAY,
      oldest_complete_day: coveredFrom(9),
      partial_week: false,
    },
    ...extra,
  } as DaemonStatus;
}

describe("historyFromStatus / coverageLabel (pure)", () => {
  const coverage = (over: Record<string, unknown> = {}) => ({
    weeks_done: 2,
    weeks_total: 13,
    complete_through_ms: NOW - 8 * DAY,
    oldest_complete_day: coveredFrom(9, NOW),
    partial_week: false,
    ...over,
  });

  it("labels coverage in days, from oldest_complete_day through today (test 1, M36)", () => {
    expect(coverageLabel(coverage(), undefined, NOW)).toBe("Showing 9 of ~91 days");
  });

  it("adds 'partial week' while the current week is cut (test 2)", () => {
    expect(coverageLabel(coverage({ partial_week: true }), undefined, NOW)).toBe(
      "Showing 9 of ~91 days (partial week)",
    );
  });

  it("labels a window wider than the covered days, and nothing for a narrower one (test 3)", () => {
    expect(coverageLabel(coverage(), 30, NOW)).toBe("Showing 9 of 30 days");
    expect(coverageLabel(coverage(), 7, NOW)).toBeNull();
  });

  it("has no label once history is complete, or before any day is complete", () => {
    expect(coverageLabel(coverage({ weeks_done: 13 }), undefined, NOW)).toBeNull();
    expect(coverageLabel(coverage({ oldest_complete_day: null }), undefined, NOW)).toBeNull();
    expect(coverageLabel(undefined, undefined, NOW)).toBeNull();
  });

  it("keeps the /api/history-progress rules for complete / processing / failed (test 4)", () => {
    expect(historyFromStatus(null)).toMatchObject({
      complete: false,
      processing: false,
      failed: false,
      revision: "pending",
    });
    expect(historyFromStatus(status({}, { pipeline: DONE }))).toMatchObject({
      complete: true,
      processing: false,
      failed: false,
    });
    expect(historyFromStatus(status())).toMatchObject({ complete: false, processing: true });
    expect(
      historyFromStatus(status({}, { pipeline: { ...HISTORY, failed_phase: "reading" } })),
    ).toMatchObject({ complete: false, processing: false, failed: true });
  });

  it("builds the page chip from the label and the pipeline state", () => {
    const loading = historyFromStatus(status());
    expect(historyNoteText("Showing 9 of ~91 days", loading)).toBe(
      "Showing 9 of ~91 days · loading",
    );
    expect(historyNoteText(null, loading)).toBe("loading");
    const failed = historyFromStatus(
      status({}, { pipeline: { ...HISTORY, failed_phase: "reading" } }),
    );
    expect(historyNoteText(null, failed)).toBe("history paused; may be incomplete");
    expect(historyNoteText(null, historyFromStatus(status({}, { pipeline: DONE })))).toBeNull();
  });

  it("moves the revision on ingest / detectors, never on live", () => {
    const base = historyFromStatus(status()).revision;
    expect(historyFromStatus(status({ live: 9 })).revision).toBe(base);
    expect(historyFromStatus(status({ ingest: 2 })).revision).not.toBe(base);
    expect(historyFromStatus(status({ detectors: 2 })).revision).not.toBe(base);
  });
});

describe("pages read the status poller", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.fetchStatus.mockResolvedValue(status());
    mocks.fetchHotSessionsPage.mockResolvedValue({ rows: [], next_cursor: null });
    mocks.fetchWorkspaces.mockResolvedValue(mockWorkspaces({ preset: "7d" }));
    mocks.fetchTrends.mockResolvedValue(mockTrends({ preset: "7d" }));
    mocks.fetchWorkspaceOutcomes.mockResolvedValue(mockWorkspaceOutcomes());
    mocks.fetchWorkspaceNames.mockResolvedValue(mockWorkspaceNames());
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    cleanup();
    _resetStatusPoller();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  const historyProgressCalls = () =>
    fetchSpy.mock.calls.filter(([url]) => String(url).includes("/api/history-progress")).length;

  it("Sessions: an ingest bump refetches the list once; a live bump does not (tests 1, 5)", async () => {
    window.history.replaceState(null, "", "/#/sessions");
    render(<HotSessionsPage onSelectSession={() => {}} />);
    expect(await screen.findByText(/Showing 9 of ~91 days/)).toBeTruthy();
    // The staged first load (recent 7 days, then the full window) settles.
    await waitFor(() => expect(mocks.fetchHotSessionsPage).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 200));
    const settled = mocks.fetchHotSessionsPage.mock.calls.length;

    mocks.fetchStatus.mockResolvedValue(status({ live: 7 }));
    pollStatusNow();
    await new Promise((r) => setTimeout(r, 100));
    expect(mocks.fetchHotSessionsPage).toHaveBeenCalledTimes(settled);

    mocks.fetchStatus.mockResolvedValue(
      status(
        { live: 7, ingest: 2 },
        {
          history_coverage: {
            weeks_done: 3,
            weeks_total: 13,
            complete_through_ms: Date.now() - 15 * DAY,
            oldest_complete_day: coveredFrom(16),
            partial_week: false,
          },
        },
      ),
    );
    pollStatusNow();
    await waitFor(() => expect(mocks.fetchHotSessionsPage).toHaveBeenCalledTimes(settled + 1));
    expect(await screen.findByText(/Showing 16 of ~91 days/)).toBeTruthy();
    expect(historyProgressCalls()).toBe(0);
  });

  it("Workspaces: an ingest bump refetches the table once; a live bump does not (tests 1, 5)", async () => {
    window.history.replaceState(null, "", "/#/workspaces");
    render(<WorkspacesPage />);
    expect(await screen.findByText(/Showing 9 of ~91 days/)).toBeTruthy();
    await waitFor(() => expect(mocks.fetchWorkspaces).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 200));
    const settled = mocks.fetchWorkspaces.mock.calls.length;

    mocks.fetchStatus.mockResolvedValue(status({ live: 7 }));
    pollStatusNow();
    await new Promise((r) => setTimeout(r, 100));
    expect(mocks.fetchWorkspaces).toHaveBeenCalledTimes(settled);

    mocks.fetchStatus.mockResolvedValue(status({ live: 7, ingest: 2 }));
    pollStatusNow();
    await waitFor(() => expect(mocks.fetchWorkspaces).toHaveBeenCalledTimes(settled + 1));
    expect(historyProgressCalls()).toBe(0);
  });

  it("shows no label once history is done (test 4)", async () => {
    mocks.fetchStatus.mockResolvedValue(
      status(
        {},
        {
          pipeline: DONE,
          history_coverage: {
            weeks_done: 13,
            weeks_total: 13,
            complete_through_ms: Date.now() - 90 * DAY,
            oldest_complete_day: coveredFrom(91),
            partial_week: false,
          },
        },
      ),
    );
    window.history.replaceState(null, "", "/#/sessions");
    render(<HotSessionsPage onSelectSession={() => {}} />);
    await waitFor(() => expect(mocks.fetchStatus).toHaveBeenCalled());
    await waitFor(() => expect(mocks.fetchHotSessionsPage).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Showing \d+ of/)).toBeNull();
    expect(document.querySelector(".history-notice")).toBeNull();
  });
});
