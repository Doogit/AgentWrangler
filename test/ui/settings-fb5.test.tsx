/**
 * test/ui/settings-fb5.test.tsx — FB5: In-session guards panel.
 *
 * Covers:
 *   - Heading rename + status pill
 *   - Three guard card headings
 *   - All five threshold inputs present + auto-save
 *   - Copy install prompt: calls buildHookInstallPrompt(currentConfig)
 *   - Copy uninstall prompt works
 *   - Copied! feedback shown
 *   - Install directly calls installHook
 *   - Copy prompt reflects updated threshold after save
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockSettings } from "../../src/ui/api/fixtures";
import SettingsPage from "../../src/ui/settings/SettingsPage";

vi.mock("../../src/ui/api/client");

const BASE_CONFIG = {
  context_window: 200_000,
  soft_pct: 0.6,
  hard_pct: 0.8,
  stale_s: 300,
  d7_fail_count: 3,
  d7_window_turns: 10,
  d9_idle_seconds: 1800,
  installed: false,
};

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
  vi.mocked(client.fetchHookConfig).mockResolvedValue({
    data: { ...BASE_CONFIG },
    meta: mockSettings().meta,
  });
  vi.mocked(client.saveHookConfig).mockResolvedValue({
    data: { ...BASE_CONFIG },
    meta: mockSettings().meta,
  });
  vi.mocked(client.installHook).mockResolvedValue({
    changed: true,
    settingsPath: "~/.claude/settings.json",
  });
  vi.mocked(client.uninstallHook).mockResolvedValue({
    changed: true,
    settingsPath: "~/.claude/settings.json",
  });
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("FB5 — In-session guards: heading and status pill", () => {
  it("renders heading 'In-session guards'", async () => {
    render(<SettingsPage />);
    expect(await screen.findByRole("heading", { name: "In-session guards" })).toBeTruthy();
  });

  it("shows 'Not installed' status pill when installed: false", async () => {
    render(<SettingsPage />);
    await screen.findByRole("heading", { name: "In-session guards" });
    await waitFor(() => expect(screen.getByLabelText("Not installed")).toBeTruthy());
  });

  it("shows 'Installed' status pill when installed: true", async () => {
    vi.mocked(client.fetchHookConfig).mockResolvedValue({
      data: { ...BASE_CONFIG, installed: true },
      meta: mockSettings().meta,
    });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText("Installed")).toBeTruthy());
  });
});

describe("FB5 — In-session guards: three guard cards", () => {
  it("renders all three guard card headings once config loads", async () => {
    render(<SettingsPage />);
    // Guard cards only appear after fetchHookConfig resolves — use findByText to wait
    expect(await screen.findByText("Context budget")).toBeTruthy();
    expect(screen.getByText("Loop guard")).toBeTruthy();
    expect(screen.getByText("Burn alert")).toBeTruthy();
  });
});

describe("FB5 — In-session guards: threshold inputs auto-save", () => {
  it("all threshold inputs are present", async () => {
    render(<SettingsPage />);
    await screen.findByLabelText("Context window (tokens)");
    expect(screen.getByLabelText("Soft threshold percent")).toBeTruthy();
    expect(screen.getByLabelText("Hard threshold percent")).toBeTruthy();
    expect(screen.getByLabelText("Identical-failure count")).toBeTruthy();
    expect(screen.getByLabelText("Loop window (turns)")).toBeTruthy();
    expect(screen.getByLabelText("Idle cutoff (seconds)")).toBeTruthy();
  });

  it("soft-percent input auto-saves as a fraction on change", async () => {
    render(<SettingsPage />);
    const softInput = await screen.findByLabelText("Soft threshold percent");
    fireEvent.change(softInput, { target: { value: "50" } });
    await waitFor(() => expect(client.saveHookConfig).toHaveBeenCalledWith({ soft_pct: 0.5 }));
  });

  it("d7_fail_count input auto-saves on change", async () => {
    render(<SettingsPage />);
    const input = await screen.findByLabelText("Identical-failure count");
    fireEvent.change(input, { target: { value: "4" } });
    await waitFor(() => expect(client.saveHookConfig).toHaveBeenCalledWith({ d7_fail_count: 4 }));
  });

  it("d9_idle_seconds input auto-saves on change", async () => {
    render(<SettingsPage />);
    const input = await screen.findByLabelText("Idle cutoff (seconds)");
    fireEvent.change(input, { target: { value: "3600" } });
    await waitFor(() =>
      expect(client.saveHookConfig).toHaveBeenCalledWith({ d9_idle_seconds: 3600 }),
    );
  });
});

describe("FB5 — In-session guards: prompt-first actions", () => {
  it("'Copy install prompt' calls clipboard.writeText with install content including current config", async () => {
    render(<SettingsPage />);
    const copyBtn = await screen.findByRole("button", { name: "Copy install prompt" });
    fireEvent.click(copyBtn);
    await waitFor(() => {
      const calls = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const text = calls[0]?.[0] as string;
      // buildHookInstallPrompt output includes these hook filenames and current config values
      expect(text).toContain("context-budget-hook.mjs");
      expect(text).toContain("loop-guard-hook.mjs");
      expect(text).toContain("limit-burn-hook.mjs");
      expect(text).toContain("soft_pct: 0.6");
    });
  });

  it("shows 'Copied!' feedback after clipboard copy", async () => {
    render(<SettingsPage />);
    const copyBtn = await screen.findByRole("button", { name: "Copy install prompt" });
    fireEvent.click(copyBtn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied!" })).toBeTruthy());
  });

  it("'Copy uninstall prompt' copies uninstall instruction text", async () => {
    render(<SettingsPage />);
    const copyBtn = await screen.findByRole("button", { name: "Copy uninstall prompt" });
    fireEvent.click(copyBtn);
    await waitFor(() => {
      const calls = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const text = calls[0]?.[0] as string;
      expect(text).toContain("context-budget-hook.mjs");
    });
  });

  it("'Install directly' calls installHook", async () => {
    render(<SettingsPage />);
    // Use the full label to distinguish from "Uninstall directly"
    const installBtn = await screen.findByRole("button", {
      name: /Install directly — writes/i,
    });
    fireEvent.click(installBtn);
    await waitFor(() => expect(client.installHook).toHaveBeenCalledTimes(1));
  });

  it("copy prompt reflects current config after threshold save", async () => {
    // saveHookConfig returns updated soft_pct=0.5 (50%)
    vi.mocked(client.saveHookConfig).mockResolvedValue({
      data: { ...BASE_CONFIG, soft_pct: 0.5 },
      meta: mockSettings().meta,
    });

    render(<SettingsPage />);
    const softInput = await screen.findByLabelText("Soft threshold percent");
    fireEvent.change(softInput, { target: { value: "50" } });
    await waitFor(() => expect(client.saveHookConfig).toHaveBeenCalled());

    // Wait until the input reflects the saved value
    await waitFor(() => {
      expect((screen.getByLabelText("Soft threshold percent") as HTMLInputElement).value).toBe(
        "50",
      );
    });

    // Click Copy install prompt — should use updated config
    fireEvent.click(screen.getByRole("button", { name: "Copy install prompt" }));
    await waitFor(() => {
      const calls = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls;
      const lastText = calls[calls.length - 1]?.[0] as string;
      expect(lastText).toContain("soft_pct: 0.5");
    });
  });
});
