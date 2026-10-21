/**
 * test/ui/status-chip.test.tsx — P1-U5 shell StatusChip: phase label, the "N of ~M days"
 * history label, the click-open detail popover (the old boot overlay's log), and the
 * first-run "could not start" escalation that moved here from the boot overlay.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus, PipelineStatus } from "../../src/ui/api/client";
import StatusChip, { BOOT_MAX_WAIT_MS } from "../../src/ui/shell/StatusChip";

const { fetchStatus } = vi.hoisted(() => ({ fetchStatus: vi.fn() }));
vi.mock("../../src/ui/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ui/api/client")>();
  return { ...actual, fetchStatus };
});

const PRE_READY = {
  sessions: 0,
  files_seen: 4,
  files_parsed: 4,
  scan_state: "scanning",
  boot_files_total: 10,
  boot_sessions_found: 3,
  boot_tokens_counted: 1_200,
  boot_scan_events: [
    { seq: 1, ts: "2026-10-01T00:00:00.000Z", kind: "root", text: "scanning 1 root" },
    { seq: 2, ts: "2026-10-01T00:00:01.000Z", kind: "workspace", text: "workspace alpha" },
  ],
} as DaemonStatus;

function readyWith(pipeline?: Partial<PipelineStatus>): DaemonStatus {
  return {
    sessions: 40,
    files_seen: 50,
    files_parsed: 50,
    scan_state: "complete",
    ...(pipeline
      ? {
          pipeline: {
            phase: "done",
            files_total: 0,
            files_completed: 0,
            files_with_new_data: 0,
            detector_runs: 0,
            failed_phase: null,
            events: [],
            ...pipeline,
          },
        }
      : {}),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("StatusChip", () => {
  it("labels the first slice and opens a popover with the boot log", async () => {
    fetchStatus.mockResolvedValue(PRE_READY);
    render(<StatusChip />);
    const chip = await screen.findByRole("button", { name: /Reading last 7 days/ });
    expect(chip.textContent).toContain("4 of 10 files");
    expect(chip.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("workspace alpha")).toBeTruthy();
    expect(screen.queryByText(/could not start/)).toBeNull();

    fireEvent.keyDown(chip, { key: "Escape" });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(chip);
  });

  it("shows the 'could not start' escalation in the popover after the boot timeout", async () => {
    vi.useFakeTimers();
    fetchStatus.mockResolvedValue(PRE_READY);
    render(<StatusChip />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_MAX_WAIT_MS - 1_000);
    });
    fireEvent.click(screen.getByRole("button", { name: /Reading last 7 days/ }));
    expect(screen.queryByText(/could not start/)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByRole("button", { name: /needs attention/i })).toBeTruthy();
    expect(screen.getByText("Dashboard could not start")).toBeTruthy();
    expect(screen.getByText(/did not become ready within 30 seconds/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open recovery Help" }).getAttribute("href")).toBe(
      "#/help?topic=troubleshooting&section=daemon",
    );
  });

  it("never escalates once the daemon has reported ready", async () => {
    vi.useFakeTimers();
    fetchStatus.mockResolvedValue(readyWith());
    render(<StatusChip />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_MAX_WAIT_MS + 5_000);
    });
    fireEvent.click(screen.getByRole("button", { name: /Up to date/ }));
    expect(screen.queryByText(/could not start/)).toBeNull();
  });

  it.each<[Partial<PipelineStatus>, RegExp]>([
    [
      { phase: "reading", files_total: 9_000, files_completed: 4_210 },
      /Reading sessions · 4,210 of 9,000 files/,
    ],
    [{ phase: "detecting" }, /Detecting patterns/],
    [{ phase: "history", weeks_done: 2, weeks_total: 11 }, /Reading history · 14 of ~77 days/],
    [{ phase: "history", weeks_done: 2, weeks_total: 0 }, /Reading history · 14 days$/],
    [{ phase: "reading", failed_phase: "reading" }, /Scan error/],
    [{ phase: "done" }, /Up to date/],
  ])("labels pipeline %o", async (pipeline, label) => {
    fetchStatus.mockResolvedValue(readyWith(pipeline));
    render(<StatusChip />);
    expect(await screen.findByRole("button", { name: label })).toBeTruthy();
  });
});
