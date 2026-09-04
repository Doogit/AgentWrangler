import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockSettings } from "../../src/ui/api/fixtures";
import SettingsPage from "../../src/ui/settings/SettingsPage";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
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
  vi.mocked(client.installHook).mockResolvedValue({
    changed: true,
    settingsPath: "C:\\Users\\test\\.claude\\settings.json",
  });
  vi.mocked(client.uninstallHook).mockResolvedValue({
    changed: true,
    settingsPath: "C:\\Users\\test\\.claude\\settings.json",
  });
  vi.mocked(client.saveHookConfig).mockResolvedValue({
    data: {
      context_window: 200_000,
      soft_pct: 0.7,
      hard_pct: 0.8,
      stale_s: 300,
      d7_fail_count: 3,
      d7_window_turns: 10,
      d9_idle_seconds: 1800,
    },
    meta: mockSettings().meta,
  });
});

describe("SettingsPage context-budget hook", () => {
  it("renders hook controls (FB5: In-session guards) and invokes install with feedback", async () => {
    render(<SettingsPage />);
    expect(await screen.findByRole("heading", { name: "In-session guards" })).toBeTruthy();
    const installBtn = await screen.findByRole("button", { name: /Install directly — writes/i });
    fireEvent.click(installBtn);
    await waitFor(() => expect(client.installHook).toHaveBeenCalledTimes(1));
    // The install result is surfaced (previously there was zero feedback).
    expect(await screen.findByLabelText("install status")).toBeTruthy();
  });

  it("saves the soft threshold as a fraction when the percent input changes", async () => {
    render(<SettingsPage />);
    const softInput = await screen.findByLabelText("Soft threshold percent");
    fireEvent.change(softInput, { target: { value: "70" } });
    await waitFor(() => expect(client.saveHookConfig).toHaveBeenCalledWith({ soft_pct: 0.7 }));
  });
});
