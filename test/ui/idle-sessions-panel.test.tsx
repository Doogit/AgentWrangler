import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockSettings } from "../../src/ui/api/fixtures";
import SettingsPage from "../../src/ui/settings/SettingsPage";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
  // fetchHookConfig auto-mocked (returns undefined → component handles gracefully)
  vi.mocked(client.fetchIdleSessions).mockResolvedValue({
    data: [
      {
        session_id: "idle-sidechain",
        workspace_id: "ws-alpha",
        last_activity_ts: "2026-09-01T11:00:00.000Z",
        idle_seconds: 3600,
        cap_weighted_tokens: 12345,
        sidechain: true,
      },
    ],
    meta: mockSettings().meta,
  });
  // fetchAgentsLiveness auto-mocked (returns undefined → liveness is null → fallback mode)
});

describe("IdleSessionsPanel — liveness unavailable (fallback to transcript-only)", () => {
  it("renders transcript-idle sessions in fallback mode with no End button", async () => {
    render(<SettingsPage />);
    // Session appears in transcript-only fallback list
    expect(await screen.findByText(/idle-sidechain/)).toBeTruthy();
    // No End action in fallback mode (liveness not available)
    expect(screen.queryByRole("button", { name: /end session/i })).toBeNull();
    expect(vi.mocked(client.fetchIdleSessions)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.saveHookConfig)).not.toHaveBeenCalled();
  });

  it("shows the job-description sentence about idle cost", async () => {
    render(<SettingsPage />);
    await screen.findByText(/idle-sidechain/);
    expect(
      screen.getByText(/resuming after the prompt cache expires re-writes the whole context/i),
    ).toBeTruthy();
  });
});
