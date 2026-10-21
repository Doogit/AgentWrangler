/**
 * USAGE-CLI live-demo bug: with OverviewPage's 180 s fetchLimits poll mounted beside the card, the card
 * switching 10 s → 180 s when `pending` clears re-joined the 180 s group and was replayed its stale
 * (pending, error) lastValue, so it flipped back to 10 s, fetched, got the fresh model, and looped.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LimitsModel } from "../../../src/query/limits/types";
import * as client from "../../../src/ui/api/client";
import { mockLimits } from "../../../src/ui/api/fixtures";
import { useForegroundPoll } from "../../../src/ui/lib/use-foreground-poll";
import UsageLimitsCard from "../../../src/ui/overview/UsageLimitsCard";

vi.mock("../../../src/ui/api/client");

/** Stands in for OverviewPage's own 180 s fetchLimits poll (OV-12 E8). */
function OverviewPoll() {
  useForegroundPoll(
    client.fetchLimits,
    180_000,
    () => {},
    () => {},
  );
  return null;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("UsageLimitsCard beside OverviewPage's 180 s poll (USAGE-CLI)", () => {
  it("one landing reading makes at most a couple of fetches, not a burst", async () => {
    vi.useFakeTimers();
    const pendingModel: LimitsModel = {
      ...mockLimits(),
      state: "error",
      rows: [],
      stale: false,
      pending: true,
    };
    const doneModel: LimitsModel = { ...mockLimits(), source: "cli" };
    const fetchLimits = vi.mocked(client.fetchLimits);
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue({
      state: "not-set-up",
      ageSec: null,
      snippet: "x",
    });
    fetchLimits.mockResolvedValue(pendingModel);
    render(
      <>
        <OverviewPoll />
        <UsageLimitsCard />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByTestId("limits-pending")).toBeTruthy();

    const before = fetchLimits.mock.calls.length;
    // Fresh model from now on; past 50 calls hang so a runaway loop ends and the count shows it.
    fetchLimits.mockImplementation(() =>
      fetchLimits.mock.calls.length - before > 50
        ? new Promise<LimitsModel>(() => {})
        : Promise.resolve(doneModel),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }
    // The 10 s poll that sees the reading, plus at most one immediate fetch on the cadence switch.
    expect(fetchLimits.mock.calls.length - before).toBeLessThanOrEqual(2);
    expect(screen.queryByTestId("limits-pending")).toBeNull();
  });
});
