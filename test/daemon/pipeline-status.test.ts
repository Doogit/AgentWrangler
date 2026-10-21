/**
 * test/daemon/pipeline-status.test.ts — pipeline-status state module contract (U4).
 *
 * Covers:
 *   1. setPipelineProgress reflects phase/counts; events appended and capped at 50.
 *   2. setPipelineFailed sets failed_phase; subsequent setPipelineProgress clears it.
 *   3. getPipelineStatus returns null before any snapshot.
 *   4. SEC-101: every event string contains only safe characters (no path separators,
 *      no arbitrary text).
 *   5. resetPipelineStatus clears everything.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  endHistoryPhase,
  getPipelineRetryHook,
  getPipelineStatus,
  reportHistoryWeek,
  resetPipelineStatus,
  setPipelineFailed,
  setPipelineProgress,
  setPipelineRetryHook,
} from "../../src/ingest/boot-progress.js";

beforeEach(() => {
  resetPipelineStatus();
});

afterEach(() => {
  resetPipelineStatus();
});

// ── 1. Basic progress snapshots ───────────────────────────────────────────────

describe("setPipelineProgress", () => {
  it("reflects phase and counts in getPipelineStatus", () => {
    setPipelineProgress({
      phase: "reading",
      files_total: 9000,
      files_completed: 4210,
      files_skipped: 4168,
      files_with_new_data: 42,
      detector_runs: 0,
    });
    const s = getPipelineStatus();
    expect(s).not.toBeNull();
    expect(s?.phase).toBe("reading");
    expect(s?.files_total).toBe(9000);
    expect(s?.files_completed).toBe(4210);
    expect(s?.files_skipped).toBe(4168);
    expect(s?.files_with_new_data).toBe(42);
    expect(s?.detector_runs).toBe(0);
    expect(s?.failed_phase).toBeNull();
  });

  it("appends a log event on each call", () => {
    setPipelineProgress({
      phase: "reading",
      files_total: 100,
      files_completed: 10,
      files_skipped: 0,
      files_with_new_data: 1,
      detector_runs: 0,
    });
    setPipelineProgress({
      phase: "detecting",
      files_total: 100,
      files_completed: 100,
      files_skipped: 0,
      files_with_new_data: 5,
      detector_runs: 3,
    });
    const s = getPipelineStatus();
    expect(s?.events).toHaveLength(2);
  });

  it("caps the event ring at 50, dropping oldest", () => {
    for (let i = 0; i < 55; i++) {
      setPipelineProgress({
        phase: "reading",
        files_total: 55,
        files_completed: i,
        files_skipped: 0,
        files_with_new_data: 0,
        detector_runs: 0,
      });
    }
    const s = getPipelineStatus();
    expect(s?.events).toHaveLength(50);
  });

  it("records the done phase", () => {
    setPipelineProgress({
      phase: "done",
      files_total: 200,
      files_completed: 200,
      files_skipped: 0,
      files_with_new_data: 12,
      detector_runs: 7,
    });
    const s = getPipelineStatus();
    expect(s?.phase).toBe("done");
    expect(s?.detector_runs).toBe(7);
  });

  it("reports history progress with count-only event text and status counts", () => {
    setPipelineProgress({
      phase: "detecting",
      files_total: 100,
      files_completed: 100,
      files_skipped: 0,
      files_with_new_data: 12,
      detector_runs: 1,
    });
    expect(reportHistoryWeek({ weeksDone: 3, weeksTotal: 11, newFindings: 2 })).toBe(
      "history — week 3 / 11 (2 new findings)",
    );
    expect(getPipelineStatus()).toMatchObject({
      phase: "history",
      weeks_done: 3,
      weeks_total: 11,
      events: expect.arrayContaining(["history — week 3 / 11 (2 new findings)"]),
    });
  });

  it("endHistoryPhase closes a history phase that no done snapshot follows", () => {
    reportHistoryWeek({ weeksDone: 11, weeksTotal: 11, newFindings: 0 });
    endHistoryPhase();
    expect(getPipelineStatus()).toMatchObject({ phase: "done", weeks_done: 11, weeks_total: 11 });
  });

  it("endHistoryPhase leaves a non-history phase alone", () => {
    setPipelineProgress({
      phase: "reading",
      files_total: 10,
      files_completed: 4,
      files_skipped: 0,
      files_with_new_data: 1,
      detector_runs: 0,
    });
    endHistoryPhase();
    expect(getPipelineStatus()?.phase).toBe("reading");
  });
});

// ── 2. Failed phase ───────────────────────────────────────────────────────────

describe("setPipelineFailed / failed_phase", () => {
  it("sets failed_phase to 'reading'", () => {
    setPipelineProgress({
      phase: "reading",
      files_total: 100,
      files_completed: 5,
      files_skipped: 0,
      files_with_new_data: 0,
      detector_runs: 0,
    });
    setPipelineFailed("reading");
    expect(getPipelineStatus()?.failed_phase).toBe("reading");
  });

  it("sets failed_phase to 'detecting'", () => {
    setPipelineProgress({
      phase: "detecting",
      files_total: 100,
      files_completed: 100,
      files_skipped: 0,
      files_with_new_data: 3,
      detector_runs: 0,
    });
    setPipelineFailed("detecting");
    expect(getPipelineStatus()?.failed_phase).toBe("detecting");
  });

  it("a subsequent setPipelineProgress clears failed_phase", () => {
    setPipelineProgress({
      phase: "reading",
      files_total: 100,
      files_completed: 0,
      files_skipped: 0,
      files_with_new_data: 0,
      detector_runs: 0,
    });
    setPipelineFailed("reading");
    expect(getPipelineStatus()?.failed_phase).toBe("reading");

    // Retry fires a new progress snapshot — should clear the failure.
    setPipelineProgress({
      phase: "reading",
      files_total: 100,
      files_completed: 50,
      files_skipped: 0,
      files_with_new_data: 0,
      detector_runs: 0,
    });
    expect(getPipelineStatus()?.failed_phase).toBeNull();
  });
});

// ── 3. Null before any snapshot ───────────────────────────────────────────────

describe("getPipelineStatus before any snapshot", () => {
  it("returns null when no progress has been set", () => {
    expect(getPipelineStatus()).toBeNull();
  });
});

// ── 4. SEC-101 event format ───────────────────────────────────────────────────

describe("SEC-101 event text safety", () => {
  /**
   * Assert every event string contains ONLY:
   *   - phase label (reading | detecting | done)
   *   - digits, commas (locale number separators)
   *   - forward slash (the count separator: 4210 / 9000)
   *   - spaces and em-dash (—) as separators
   *
   * Critically, no backslashes, no colons that look like file paths,
   * and no arbitrary text beyond the enum label + numbers.
   */
  const SAFE_EVENT_PATTERN =
    /^(reading|detecting|done)[ —\-]+[\d,/ a-z]+$|^history — week \d+ \/ \d+ \(\d+ new findings\)$/i;

  it("event lines match the safe pattern for history phase", () => {
    reportHistoryWeek({ weeksDone: 3, weeksTotal: 11, newFindings: 2 });
    const s = getPipelineStatus();
    expect(s?.events.length).toBeGreaterThan(0);
    for (const line of s?.events ?? []) {
      expect(line).toMatch(SAFE_EVENT_PATTERN);
    }
  });

  it("event lines match the safe pattern for reading phase", () => {
    setPipelineProgress({
      phase: "reading",
      files_total: 9000,
      files_completed: 4210,
      files_skipped: 0,
      files_with_new_data: 0,
      detector_runs: 0,
    });
    const s = getPipelineStatus();
    for (const line of s?.events ?? []) {
      expect(line).toMatch(SAFE_EVENT_PATTERN);
    }
  });

  it("event lines match the safe pattern for detecting phase", () => {
    setPipelineProgress({
      phase: "detecting",
      files_total: 9000,
      files_completed: 9000,
      files_skipped: 0,
      files_with_new_data: 0,
      detector_runs: 5,
    });
    const s = getPipelineStatus();
    for (const line of s?.events ?? []) {
      expect(line).toMatch(SAFE_EVENT_PATTERN);
    }
  });

  it("event lines match the safe pattern for done phase", () => {
    setPipelineProgress({
      phase: "done",
      files_total: 9000,
      files_completed: 9000,
      files_skipped: 0,
      files_with_new_data: 200,
      detector_runs: 12,
    });
    const s = getPipelineStatus();
    for (const line of s?.events ?? []) {
      expect(line).toMatch(SAFE_EVENT_PATTERN);
    }
  });

  it("events contain no path separators (backslash / forward-slash in filenames)", () => {
    setPipelineProgress({
      phase: "reading",
      files_total: 9000,
      files_completed: 4210,
      files_skipped: 0,
      files_with_new_data: 0,
      detector_runs: 0,
    });
    const s = getPipelineStatus();
    for (const line of s?.events ?? []) {
      // The "/" in "4210 / 9000" is fine, but file paths like "/home/user" contain
      // more slashes. The log line format should not contain any alphabetic characters
      // after a slash (which would indicate a path component).
      expect(line).not.toMatch(/\/[a-zA-Z]/);
      expect(line).not.toMatch(/\\/);
    }
  });
});

// ── 5. resetPipelineStatus ────────────────────────────────────────────────────

describe("resetPipelineStatus", () => {
  it("clears snapshot, failed_phase, and events", () => {
    setPipelineProgress({
      phase: "reading",
      files_total: 100,
      files_completed: 50,
      files_skipped: 0,
      files_with_new_data: 0,
      detector_runs: 0,
    });
    setPipelineFailed("reading");
    resetPipelineStatus();
    expect(getPipelineStatus()).toBeNull();
  });
});

// ── 6. Retry hook seam ────────────────────────────────────────────────────────

describe("pipeline retry hook", () => {
  afterEach(() => {
    // Clear the hook so it doesn't bleed between tests.
    setPipelineRetryHook(() => {});
  });

  it("wires and retrieves the retry hook", () => {
    const fn = () => {};
    setPipelineRetryHook(fn);
    expect(getPipelineRetryHook()).toBe(fn);
  });
});
