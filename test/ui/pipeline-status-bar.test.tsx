/**
 * test/ui/pipeline-status-bar.test.tsx — PipelineStatusBar component contract (U4).
 *
 * Covers:
 *   SC7 — happy path: reading → detecting → done, with counts and completion CTA.
 *   Dismiss — clicking close hides the bar; localStorage is untouched.
 *   DL-3 — dismissed before done → completion confirmation never renders.
 *   Error — failed_phase set → Retry button labeled with phase; clicking calls retryPipeline.
 *   Indeterminate — files_total === 0 → no broken ratio rendered.
 *   A11y — close button has an accessible name.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus, PipelineStatus } from "../../src/ui/api/client";
import * as client from "../../src/ui/api/client";
import { STATUS_BUSY_POLL_MS, _resetStatusPoller } from "../../src/ui/api/status-poller";
import PipelineStatusBar, { _resetDismissState } from "../../src/ui/shell/PipelineStatusBar";

vi.mock("../../src/ui/api/client");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  _resetDismissState();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});

function makeStatus(pipeline: PipelineStatus | null): DaemonStatus {
  return {
    sessions: 100,
    files_seen: 100,
    files_parsed: 100,
    scan_state: "complete",
    ...(pipeline ? { pipeline } : {}),
  };
}

const readingStatus: PipelineStatus = {
  phase: "reading",
  files_total: 9000,
  files_completed: 4210,
  files_with_new_data: 0,
  detector_runs: 0,
  failed_phase: null,
  events: ["reading — 4210 / 9000 files"],
};

const detectingStatus: PipelineStatus = {
  phase: "detecting",
  files_total: 9000,
  files_completed: 9000,
  files_with_new_data: 50,
  detector_runs: 3,
  failed_phase: null,
  events: ["reading — 9000 / 9000 files", "detecting — 9000 / 9000 files"],
};

const doneStatus: PipelineStatus = {
  phase: "done",
  files_total: 9000,
  files_completed: 9000,
  files_with_new_data: 50,
  detector_runs: 7,
  failed_phase: null,
  events: ["done — 9000 files, 7 detector runs"],
};

const historyStatus: PipelineStatus = {
  phase: "history",
  weeks_total: 11,
  weeks_done: 3,
  files_total: 9000,
  files_completed: 9000,
  files_with_new_data: 50,
  detector_runs: 3,
  failed_phase: null,
  events: ["history — week 3 / 11 (2 new findings)"],
};

// ── SC7: happy path ───────────────────────────────────────────────────────────

describe("SC7 — happy path", () => {
  it("shows reading phase with count", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(readingStatus));
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/reading sessions/i)).toBeTruthy();
    expect(screen.getByText(/4,210/)).toBeTruthy();
    expect(screen.getByText(/9,000/)).toBeTruthy();
    expect(screen.getByRole("status").dataset.reservesSpace).toBe("true");
  });

  it("shows detecting phase", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(detectingStatus));
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/detecting patterns/i)).toBeTruthy();
  });

  it("shows history phase with week progress", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(historyStatus));
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Scanning history — week 3 of 11")).toBeTruthy();
  });

  it("shows completion confirmation with CTA when phase transitions to done", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(detectingStatus));
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Transition to done.
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(doneStatus));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_BUSY_POLL_MS);
    });

    expect(screen.getByText(/background scan complete/i)).toBeTruthy();
    const cta = screen.getByRole("link", { name: /view usage patterns/i });
    expect((cta as HTMLAnchorElement).href).toContain("/diagnostics");
  });

  it("auto-dismisses completion confirmation after ~8s", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(detectingStatus));
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(doneStatus));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_BUSY_POLL_MS);
    });
    expect(screen.getByText(/background scan complete/i)).toBeTruthy();

    // Advance past auto-dismiss window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8500);
    });
    expect(screen.queryByText(/background scan complete/i)).toBeNull();
  });

  it("shows nothing when pipeline is absent", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(null));
    const { container } = render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.firstChild).toBeNull();
  });
});

// ── Dismiss ───────────────────────────────────────────────────────────────────

describe("Dismiss", () => {
  it("clicking close hides the bar", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(readingStatus));
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const closeBtn = screen.getByRole("button", { name: /dismiss pipeline status/i });
    await act(async () => {
      fireEvent.click(closeBtn);
    });

    expect(screen.queryByText(/reading sessions/i)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not write to localStorage on dismiss", async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(readingStatus));
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const closeBtn = screen.getByRole("button", { name: /dismiss pipeline status/i });
    fireEvent.click(closeBtn);

    expect(setItemSpy).not.toHaveBeenCalled();
  });
});

// ── DL-3: dismissed before completion ────────────────────────────────────────

describe("DL-3 — dismissed before completion", () => {
  it("completion confirmation does not appear if bar was dismissed before done", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(readingStatus));
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Dismiss before done.
    const closeBtn = screen.getByRole("button", { name: /dismiss pipeline status/i });
    fireEvent.click(closeBtn);

    // Transition to done.
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(doneStatus));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_BUSY_POLL_MS);
    });

    // Completion confirmation should NOT appear.
    expect(screen.queryByText(/background scan complete/i)).toBeNull();
  });
});

// ── Error: failed_phase ───────────────────────────────────────────────────────

describe("Error — failed_phase", () => {
  it("shows a Retry button labeled with the failed phase", async () => {
    const errorStatus: PipelineStatus = {
      ...readingStatus,
      failed_phase: "reading",
    };
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(errorStatus));
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const retryBtn = screen.getByRole("button", { name: /retry reading/i });
    expect(retryBtn).toBeTruthy();
  });

  it("clicking Retry calls retryPipeline", async () => {
    const mockRetry = vi.mocked(client.retryPipeline).mockResolvedValue(undefined);
    const errorStatus: PipelineStatus = {
      ...detectingStatus,
      failed_phase: "detecting",
    };
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(errorStatus));
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const retryBtn = screen.getByRole("button", { name: /retry detecting/i });
    await act(async () => {
      fireEvent.click(retryBtn);
      // retryPipeline is async; flush its promise.
      await Promise.resolve();
    });

    expect(mockRetry).toHaveBeenCalledOnce();
  });
});

// ── Indeterminate ─────────────────────────────────────────────────────────────

describe("Indeterminate (files_total === 0)", () => {
  it("shows no ratio when files_total is 0", async () => {
    const indeterminate: PipelineStatus = {
      phase: "reading",
      files_total: 0,
      files_completed: 0,
      files_with_new_data: 0,
      detector_runs: 0,
      failed_phase: null,
      events: [],
    };
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(indeterminate));
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Should show the phase label, but not a ratio like "0 / 0".
    expect(screen.getByText(/reading sessions/i)).toBeTruthy();
    expect(screen.queryByText(/0 \/ 0/)).toBeNull();
  });
});

// ── OV-13: cold-build job rows ────────────────────────────────────────────────

describe("OV-13 — cold-build job rows", () => {
  const NOW = Date.parse("2026-10-13T12:00:00.000Z");
  const jobs: NonNullable<DaemonStatus["jobs"]> = [
    { kind: "recommendations", started_at: "2026-10-13T11:59:48.000Z", expected_ms: 20_000 },
    {
      kind: "diagnostics",
      window_days: 30,
      started_at: "2026-10-13T11:59:55.000Z",
      expected_ms: null,
    },
  ];

  beforeEach(() => {
    vi.setSystemTime(NOW);
    // The shared poller keeps the previous test's last status; start each test from none.
    _resetStatusPoller();
  });

  it("shows one row per job with no pipeline data, each with elapsed/usual and a link", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue({ ...makeStatus(null), jobs });
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Building recommendations")).toBeTruthy();
    expect(screen.getByText("12 s · usually ~20 s")).toBeTruthy();
    expect(screen.getByText("Building usage patterns (last 30 days)")).toBeTruthy();
    expect(screen.getByText("5 s")).toBeTruthy();
    const links = screen.getAllByRole("link", { name: "Show" }) as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#/recommendations",
      "#/diagnostics",
    ]);
    expect(screen.getAllByRole("button", { name: /dismiss pipeline status/i })).toHaveLength(1);
  });

  it("ticks the elapsed time", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue({
      ...makeStatus(null),
      jobs: jobs.slice(0, 1),
    });
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText("15 s · usually ~20 s")).toBeTruthy();
  });

  it("shows the job row under a finished pipeline (done, no completion row)", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue({ ...makeStatus(doneStatus), jobs });
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText(/background scan complete/i)).toBeNull();
    expect(screen.getByText("Building recommendations")).toBeTruthy();
    // The scan log belongs to the hidden scan row, so no dead "Show log" toggle.
    expect(screen.queryByRole("button", { name: /show log/i })).toBeNull();
  });

  it("shows the pipeline row and the job rows together", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue({ ...makeStatus(readingStatus), jobs });
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/reading sessions/i)).toBeTruthy();
    expect(screen.getByText("Building recommendations")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /dismiss pipeline status/i })).toHaveLength(1);
  });

  it("hides when the jobs finish", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue({ ...makeStatus(null), jobs });
    const { container } = render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(null));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_BUSY_POLL_MS);
    });
    expect(container.firstChild).toBeNull();
  });

  it("dismiss hides job rows too", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue({ ...makeStatus(null), jobs });
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /dismiss pipeline status/i }));
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

// ── A11y ──────────────────────────────────────────────────────────────────────

describe("A11y", () => {
  it("close button has accessible name", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(readingStatus));
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const closeBtn = screen.getByRole("button", { name: /dismiss pipeline status/i });
    expect(closeBtn).toBeTruthy();
  });

  it("bar has role=status for screen readers", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(readingStatus));
    render(<PipelineStatusBar />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const bar = screen.getByRole("status");
    expect(bar).toBeTruthy();
  });

  it("announces progress without stealing focus", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(makeStatus(readingStatus));
    render(
      <>
        <button type="button">Keep focus</button>
        <PipelineStatusBar />
      </>,
    );
    const control = screen.getByRole("button", { name: "Keep focus" });
    control.focus();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(document.activeElement).toBe(control);
  });
});
