/**
 * FU-B: UsageLimitsCard dev-only `?fakeLimits=` override renders exactly one
 * exclusive-state message per fake (guide §6.6 — never two notices at once).
 * Verifies the one-message-per-state guarantee without the live usage API.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../../src/ui/api/client";
import { mockLimits } from "../../../src/ui/api/fixtures";
import UsageLimitsCard from "../../../src/ui/overview/UsageLimitsCard";

vi.mock("../../../src/ui/api/client");

function setHash(fake: string | null) {
  window.location.hash = fake === null ? "#/overview" : `#/overview?fakeLimits=${fake}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The fake override takes precedence over the fetch; resolve a real connected
  // model so the poll never leaves the component in its fetch-error branch.
  vi.mocked(client.fetchLimits).mockResolvedValue(mockLimits());
});

afterEach(() => {
  cleanup();
  setHash(null);
});

function notices(container: HTMLElement): number {
  return container.querySelectorAll(".notice").length;
}

describe("UsageLimitsCard ?fakeLimits override", () => {
  it("signed-out → exactly one notice, no meter rows", async () => {
    setHash("signed-out");
    const { container } = render(<UsageLimitsCard />);
    await waitFor(() => expect(screen.getByTestId("fake-limits-chip")).toBeTruthy());
    expect(notices(container)).toBe(1);
    expect(container.querySelectorAll(".meter-row").length).toBe(0);
  });

  it("error → exactly one notice, no meter rows", async () => {
    setHash("error");
    const { container } = render(<UsageLimitsCard />);
    await waitFor(() => expect(screen.getByTestId("fake-limits-chip")).toBeTruthy());
    expect(notices(container)).toBe(1);
    expect(container.querySelectorAll(".meter-row").length).toBe(0);
  });

  it("rate-limited → exactly one notice, plus meter rows (data, not a message)", async () => {
    setHash("rate-limited");
    const { container } = render(<UsageLimitsCard />);
    await waitFor(() => expect(screen.getByTestId("fake-limits-chip")).toBeTruthy());
    expect(notices(container)).toBe(1);
    expect(container.querySelectorAll(".meter-row").length).toBeGreaterThan(0);
  });

  it("connected → zero notices, meter rows render", async () => {
    setHash("connected");
    const { container } = render(<UsageLimitsCard />);
    await waitFor(() => expect(screen.getByTestId("fake-limits-chip")).toBeTruthy());
    expect(notices(container)).toBe(0);
    expect(container.querySelectorAll(".meter-row").length).toBeGreaterThan(0);
  });

  it("loading → zero notices, skeleton only", async () => {
    setHash("loading");
    const { container } = render(<UsageLimitsCard />);
    await waitFor(() => expect(screen.getByTestId("fake-limits-chip")).toBeTruthy());
    expect(notices(container)).toBe(0);
    expect(container.querySelector(".skeleton")).toBeTruthy();
    expect(container.querySelectorAll(".meter-row").length).toBe(0);
  });

  it("no param → no dev chip (production path unchanged)", async () => {
    setHash(null);
    render(<UsageLimitsCard />);
    await waitFor(() => expect(screen.getByTestId("usage-limits-card")).toBeTruthy());
    expect(screen.queryByTestId("fake-limits-chip")).toBeNull();
  });
});
