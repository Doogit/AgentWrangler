import { describe, expect, it } from "vitest";
import { DEFAULT_HOOK_CONFIG } from "../../src/query/api/hook-config";
import {
  buildHookInstallPrompt,
  buildHookUninstallPrompt,
} from "../../src/ui/settings/install-prompt";

const HOOK_FILENAMES = ["context-budget-hook.mjs", "loop-guard-hook.mjs", "limit-burn-hook.mjs"];

describe("settings install prompts", () => {
  it("builds an install prompt with hooks, current thresholds, and safe wording", () => {
    const prompt = buildHookInstallPrompt(DEFAULT_HOOK_CONFIG);

    for (const filename of HOOK_FILENAMES) expect(prompt).toContain(filename);
    for (const value of [
      DEFAULT_HOOK_CONFIG.context_window,
      DEFAULT_HOOK_CONFIG.soft_pct,
      DEFAULT_HOOK_CONFIG.hard_pct,
      DEFAULT_HOOK_CONFIG.d7_fail_count,
      DEFAULT_HOOK_CONFIG.d7_window_turns,
      DEFAULT_HOOK_CONFIG.d9_idle_seconds,
    ]) {
      expect(prompt).toContain(String(value));
    }

    expect(buildHookInstallPrompt({ ...DEFAULT_HOOK_CONFIG, context_window: 999_000 })).not.toBe(
      prompt,
    );
    expect(buildHookInstallPrompt({ ...DEFAULT_HOOK_CONFIG, context_window: 999_000 })).toContain(
      "999000",
    );
    expect(prompt).toMatch(/idempotent|safe to re-run|do not duplicate/i);
    expect(prompt).toContain("immediately");
    expect(prompt).not.toMatch(/restart/i);
  });

  it("builds an immediate, scoped uninstall prompt", () => {
    const prompt = buildHookUninstallPrompt();

    for (const filename of HOOK_FILENAMES) expect(prompt).toContain(filename);
    expect(prompt).toMatch(/immediately/);
    expect(prompt).not.toMatch(/restart/i);
  });
});
