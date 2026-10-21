/**
 * test/ui/boot-gate.test.tsx — P1-U5: the SPA mounts before the daemon is ready.
 *
 * The old readiness gate (main.tsx waited on /api/ready before mounting) is
 * intentionally removed. The shell and the Overview skeleton paint at once while
 * the daemon reads its first slice, and the shell's StatusChip says so. Daemon
 * unreachability comes from the shell's /api/status poll, not from a page fetch,
 * so a cold deep link to any route still shows the unreachable card.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/ui/App";
import type { DaemonStatus } from "../../src/ui/api/client";

/** A pre-ready /api/status: the boot fields exist only until /api/ready is true. */
const PRE_READY_STATUS = {
  sessions: 0,
  files_seen: 3,
  files_parsed: 3,
  scan_state: "scanning",
  boot_files_total: 12,
  boot_sessions_found: 2,
  boot_tokens_counted: 4_000,
  boot_scan_events: [{ seq: 1, ts: "2026-10-01T00:00:00.000Z", kind: "stage", text: "reading" }],
} as DaemonStatus;

const { fetchStatus, fetchOverviewView } = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  // Never resolves: the daemon has not finished its first slice.
  fetchOverviewView: vi.fn(() => new Promise<never>(() => {})),
}));
vi.mock("../../src/ui/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ui/api/client")>();
  return { ...actual, fetchStatus, fetchOverviewView };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Reflect.deleteProperty(window, "__awBoot");
  window.history.replaceState(null, "", "/");
});

describe("mount before ready (P1-U5)", () => {
  it("paints Overview skeletons and a 'Reading last 7 days' chip while /api/ready is false", async () => {
    fetchStatus.mockResolvedValue(PRE_READY_STATUS);
    const reveal = vi.fn();
    window.__awBoot = { reveal };
    window.history.replaceState(null, "", "#/overview");
    render(<App />);
    // The overlay is dismissed on the first commit, not on first data.
    expect(reveal).toHaveBeenCalled();

    expect(await screen.findByRole("button", { name: /Reading last 7 days/ })).toBeTruthy();
    const main = document.getElementById("main-content");
    await waitFor(() => expect(main?.querySelector(".skeleton")).not.toBeNull());
  });

  it.each(["#/overview", "#/settings"])(
    "shows the unreachable card on a cold load of %s",
    async (hash) => {
      const { DaemonUnreachableError } =
        await vi.importActual<typeof import("../../src/ui/api/client")>("../../src/ui/api/client");
      fetchStatus.mockRejectedValue(new DaemonUnreachableError());
      window.history.replaceState(null, "", hash);
      render(<App />);

      expect(await screen.findByRole("heading", { name: "Local daemon unavailable" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry connection" })).toBeTruthy();
    },
  );

  it("does not show the unreachable card for a non-transport status error", async () => {
    fetchStatus.mockRejectedValue(new Error("/api/status returned 503"));
    window.history.replaceState(null, "", "#/settings");
    render(<App />);
    await waitFor(() => expect(fetchStatus).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "Local daemon unavailable" })).toBeNull();
  });
});
