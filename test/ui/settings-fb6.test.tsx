/**
 * test/ui/settings-fb6.test.tsx — FB6: Idle sessions panel (liveness-grounded).
 *
 * Uses STUBBED fetch (vi.mock + per-test overrides). Never calls the real endpoint.
 *
 * Covers:
 *   - Intersection-only view: shows sessions that are BOTH transcript-idle AND live
 *   - Non-live sessions collapsed to "N past sessions ended" line
 *   - Background row (pid null): claude agents CTA, no End button
 *   - End button opens confirm dialog naming pid + cwd + session name
 *   - Confirm End calls endSessionPid; row drops on success
 *   - Failure shows honest reason inline
 *   - CLI-absent (available: false): banner + transcript-only list, no End button
 *   - Bulk End button appears; confirm dialog lists pids
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockSettings } from "../../src/ui/api/fixtures";
import SettingsPage from "../../src/ui/settings/SettingsPage";

vi.mock("../../src/ui/api/client");

const LIVE_INTERACTIVE: import("../../src/query/api/agents-liveness").LiveAgent = {
  session_id: "sess-live-interactive",
  pid: 12345,
  workspace_id: "ws-alpha",
  cwd: "/home/user/projects/alpha",
  kind: "interactive",
  status: "running",
  name: "Alpha interactive",
  started_at: "2026-09-01T10:00:00Z",
  idle_seconds: 3700,
  cap_weighted_context_held: 5000,
};

const LIVE_BACKGROUND: import("../../src/query/api/agents-liveness").LiveAgent = {
  session_id: "sess-live-background",
  pid: null,
  workspace_id: "ws-beta",
  cwd: "/home/user/projects/beta",
  kind: "background",
  status: "waiting",
  name: "Beta background",
  started_at: "2026-09-01T09:00:00Z",
  idle_seconds: 7200,
  cap_weighted_context_held: 2000,
};

const TRANSCRIPT_IDLE_INTERACTIVE: import("../../src/query/api/idle-sessions").IdleSession = {
  session_id: "sess-live-interactive",
  workspace_id: "ws-alpha",
  last_activity_ts: "2026-09-01T10:00:00Z",
  idle_seconds: 3700,
  cap_weighted_tokens: 5000,
  sidechain: true,
};

const TRANSCRIPT_IDLE_CLOSED: import("../../src/query/api/idle-sessions").IdleSession = {
  session_id: "sess-closed",
  workspace_id: "ws-gamma",
  last_activity_ts: "2026-08-31T08:00:00Z",
  idle_seconds: 86400,
  cap_weighted_tokens: 8000,
  sidechain: true,
};

function mockHookConfig() {
  vi.mocked(client.fetchHookConfig).mockResolvedValue({
    data: {
      context_window: 200_000,
      soft_pct: 0.6,
      hard_pct: 0.8,
      stale_s: 300,
      d7_fail_count: 3,
      d7_window_turns: 10,
      d9_idle_seconds: 1800,
      installed: false,
    },
    meta: mockSettings().meta,
  });
}

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
  mockHookConfig();
  // Default: one interactive + one closed transcript-idle session
  vi.mocked(client.fetchIdleSessions).mockResolvedValue({
    data: [TRANSCRIPT_IDLE_INTERACTIVE, TRANSCRIPT_IDLE_CLOSED],
    meta: mockSettings().meta,
  });
  // Default: only the interactive session is live
  vi.mocked(client.fetchAgentsLiveness).mockResolvedValue({
    data: {
      available: true,
      reason: null,
      agents: [LIVE_INTERACTIVE],
    },
    meta: mockSettings().meta,
  });
  vi.mocked(client.endSessionPid).mockResolvedValue({ ok: true, ended: 12345, status: 200 });
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("FB6 — intersection view", () => {
  it("shows only sessions that are BOTH transcript-idle AND live", async () => {
    render(<SettingsPage />);
    // sess-live-interactive is in both → shown
    expect(await screen.findByText("sess-live-interactive")).toBeTruthy();
    // sess-closed is transcript-idle but NOT live → NOT shown as a row
    expect(screen.queryByText("sess-closed")).toBeNull();
  });

  it("shows 'N past sessions ended' for transcript-idle sessions not in live list", async () => {
    render(<SettingsPage />);
    await screen.findByText("sess-live-interactive");
    // sess-closed counts as 1 non-live
    await waitFor(() =>
      expect(screen.getByText(/1 past session ended — closed sessions cost nothing/i)).toBeTruthy(),
    );
  });

  it("shows cap-weighted context held column value", async () => {
    render(<SettingsPage />);
    await screen.findByText("sess-live-interactive");
    // 5000 → "5,000" or "5000"
    expect(screen.getByText(/5[,.]?000/)).toBeTruthy();
  });
});

describe("FB6 — background row (pid null)", () => {
  it("shows 'claude agents' CTA and NO End button for background row", async () => {
    // Only have the background session in transcript-idle AND live
    vi.mocked(client.fetchIdleSessions).mockResolvedValue({
      data: [
        {
          session_id: "sess-live-background",
          workspace_id: "ws-beta",
          last_activity_ts: "2026-09-01T09:00:00Z",
          idle_seconds: 7200,
          cap_weighted_tokens: 2000,
          sidechain: true,
        },
      ],
      meta: mockSettings().meta,
    });
    vi.mocked(client.fetchAgentsLiveness).mockResolvedValue({
      data: { available: true, reason: null, agents: [LIVE_BACKGROUND] },
      meta: mockSettings().meta,
    });
    render(<SettingsPage />);
    await screen.findByText("sess-live-background");
    // Background row: no End button
    expect(screen.queryByRole("button", { name: /end session/i })).toBeNull();
    // Has the claude agents CTA
    expect(screen.getByText(/claude agents/)).toBeTruthy();
  });
});

describe("FB6 — End session (single)", () => {
  it("End button opens confirm dialog naming pid and cwd", async () => {
    render(<SettingsPage />);
    await screen.findByText("sess-live-interactive");
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
      // Dialog shows the pid
      expect(screen.getByText(/12345/)).toBeTruthy();
      // Dialog shows the cwd
      expect(screen.getByText(/\/home\/user\/projects\/alpha/)).toBeTruthy();
    });
  });

  it("Cancel closes the confirm dialog without calling endSessionPid", async () => {
    render(<SettingsPage />);
    await screen.findByText("sess-live-interactive");
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    await waitFor(() => screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(client.endSessionPid).not.toHaveBeenCalled();
  });

  it("Confirm End calls endSessionPid(pid) and the row drops from view", async () => {
    render(<SettingsPage />);
    await screen.findByText("sess-live-interactive");
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    await waitFor(() => screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm End" }));
    await waitFor(() => expect(client.endSessionPid).toHaveBeenCalledWith(12345));
    // Row drops on success
    await waitFor(() => expect(screen.queryByText("sess-live-interactive")).toBeNull());
  });

  it("shows honest error reason inline when endSessionPid fails", async () => {
    vi.mocked(client.endSessionPid).mockRejectedValue(new Error("process not found"));
    render(<SettingsPage />);
    await screen.findByText("sess-live-interactive");
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    await waitFor(() => screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm End" }));
    await waitFor(() => expect(screen.getByText(/process not found/i)).toBeTruthy());
    // Row stays (session didn't end)
    expect(screen.queryByText("sess-live-interactive")).toBeTruthy();
  });
});

describe("FB6 — CLI-absent fallback", () => {
  it("renders banner + transcript-only list; no End button when available: false", async () => {
    vi.mocked(client.fetchAgentsLiveness).mockResolvedValue({
      data: {
        available: false,
        reason: "liveness unknown: Claude Code CLI not found or too old",
        agents: [],
      },
      meta: mockSettings().meta,
    });
    render(<SettingsPage />);
    // Banner with reason shown
    await waitFor(() =>
      expect(
        screen.getByText(/liveness unknown: Claude Code CLI not found or too old/),
      ).toBeTruthy(),
    );
    // Both transcript-idle sessions shown in fallback list (no intersection filtering)
    await waitFor(() => expect(screen.getByText("sess-live-interactive")).toBeTruthy());
    expect(screen.getByText("sess-closed")).toBeTruthy();
    // No End button in fallback mode
    expect(screen.queryByRole("button", { name: /end session/i })).toBeNull();
  });
});

describe("FB6 — Bulk End", () => {
  it("bulk End button appears when there are pid rows", async () => {
    render(<SettingsPage />);
    await screen.findByText("sess-live-interactive");
    expect(screen.getByRole("button", { name: "End all idle interactive sessions" })).toBeTruthy();
  });

  it("bulk End opens confirm dialog listing pids then calls endSessionPid per pid", async () => {
    render(<SettingsPage />);
    await screen.findByText("sess-live-interactive");
    fireEvent.click(screen.getByRole("button", { name: "End all idle interactive sessions" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(screen.getByText(/PID 12345/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm End All" }));
    await waitFor(() => expect(client.endSessionPid).toHaveBeenCalledWith(12345));
  });
});
