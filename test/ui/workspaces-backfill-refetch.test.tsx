/**
 * test/ui/workspaces-backfill-refetch.test.tsx — a history revision bump must never be lost on the
 * Workspaces page (cold backfill demo: 0 rows all run, "No workspaces yet" at pipeline done).
 *
 * Oracle: hand-set /api/status scopes (through the real poller) and the call counts / resolved
 * values of the mocked list fetchers.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus, PipelineStatus } from "../../src/ui/api/client";
import { mockTrends, mockWorkspaceOutcomes, mockWorkspaces } from "../../src/ui/api/fixtures";
import { _resetStatusPoller, pollStatusNow, useStatusPoller } from "../../src/ui/api/status-poller";
import WorkspacesPage from "../../src/ui/workspaces/WorkspacesPage";

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
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

const HISTORY = {
  phase: "history",
  weeks_total: 13,
  weeks_done: 2,
  files_total: 10,
  files_completed: 4,
  files_with_new_data: 4,
  detector_runs: 1,
  failed_phase: null,
  events: [],
} as PipelineStatus;

const status = (ingest: number): DaemonStatus =>
  ({
    sessions: 3,
    files_seen: 10,
    files_parsed: 10,
    data_version: 5,
    data_scopes: { live: 1, ingest, detectors: 1, lifecycle: 1, clock: "d|d" },
    pipeline: HISTORY,
  }) as DaemonStatus;

const full = () => mockWorkspaces({ preset: "7d" });
const empty = () => {
  const response = full();
  return { ...response, data: { ...response.data, items: [], total: 0 } };
};
const bump = (ingest: number) => {
  mocks.fetchStatus.mockResolvedValue(status(ingest));
  pollStatusNow();
};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Land the first /api/status before mount so the page starts on a real revision, not "pending". */
function StatusProbe() {
  useStatusPoller();
  return null;
}
async function primeStatus() {
  render(<StatusProbe />);
  await waitFor(() => expect(mocks.fetchStatus).toHaveBeenCalled());
  await tick(30);
}

describe("Workspaces page never drops a history revision", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.fetchStatus.mockResolvedValue(status(1));
    mocks.fetchTrends.mockResolvedValue(mockTrends({ preset: "7d" }));
    mocks.fetchWorkspaceOutcomes.mockResolvedValue(mockWorkspaceOutcomes());
    mocks.fetchWorkspaceNames.mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    window.history.replaceState(null, "", "/#/workspaces?window=7d");
  });
  afterEach(() => {
    cleanup();
    _resetStatusPoller();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("(a) a bump while the first load is in flight refetches once it settles", async () => {
    let settleFirst: (value: ReturnType<typeof empty>) => void = () => {};
    mocks.fetchWorkspaces
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settleFirst = resolve;
          }),
      )
      .mockResolvedValue(full());
    await primeStatus();
    render(<WorkspacesPage />);
    await waitFor(() => expect(mocks.fetchWorkspaces).toHaveBeenCalledTimes(1));
    bump(2);
    await tick(80);
    settleFirst(empty());
    await waitFor(() => expect(mocks.fetchWorkspaces).toHaveBeenCalledTimes(2));
    expect((await screen.findAllByText(/orbit-api/)).length).toBeGreaterThan(0);
  });

  it("(b) cold start with an empty list: a later ingest bump fills the rows without a remount", async () => {
    mocks.fetchWorkspaces.mockResolvedValueOnce(empty()).mockResolvedValue(full());
    await primeStatus();
    render(<WorkspacesPage />);
    expect(await screen.findByText("No workspaces yet")).toBeTruthy();
    await tick(50);
    bump(2);
    expect((await screen.findAllByText(/orbit-api/)).length).toBeGreaterThan(0);
  });

  it("(d) staged window: a bump while the broad fetch is in flight refetches after it settles", async () => {
    window.history.replaceState(null, "", "/#/workspaces");
    let settleBroad: (value: ReturnType<typeof empty>) => void = () => {};
    mocks.fetchWorkspaces
      .mockResolvedValueOnce(empty())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settleBroad = resolve;
          }),
      )
      .mockResolvedValue(full());
    await primeStatus();
    render(<WorkspacesPage />);
    await waitFor(() => expect(mocks.fetchWorkspaces).toHaveBeenCalledTimes(2));
    bump(2);
    await tick(80);
    settleBroad(empty());
    await waitFor(() => expect(mocks.fetchWorkspaces).toHaveBeenCalledTimes(3));
    expect((await screen.findAllByText(/orbit-api/)).length).toBeGreaterThan(0);
  });

  it("(c) a rejected full fetch does not strand later revisions", async () => {
    window.history.replaceState(null, "", "/#/workspaces?window=30d");
    // Staged load: recent 7d top-8 resolves, then the full fetch rejects.
    mocks.fetchWorkspaces
      .mockResolvedValueOnce(full())
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(full());
    await primeStatus();
    render(<WorkspacesPage />);
    await waitFor(() => expect(mocks.fetchWorkspaces).toHaveBeenCalledTimes(2));
    await tick(80);
    bump(2);
    await waitFor(() => expect(mocks.fetchWorkspaces).toHaveBeenCalledTimes(3));
  });
});
