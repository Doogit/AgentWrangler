import type { HookConfig } from "../../query/api/hook-config";

/** Build instructions for Claude Code to install the AgentWrangler hook commands. */
export function buildHookInstallPrompt(config: HookConfig): string {
  return `Update ~/.claude/settings.json by merging these three AgentWrangler PreToolUse hook entries. For each command, use the installed AgentWrangler hook script path that ends in the named filename:

- { "matcher": "*", "hooks": [{ "type": "command", "command": "<AgentWrangler hook path>/context-budget-hook.mjs" }] }
- { "matcher": "*", "hooks": [{ "type": "command", "command": "<AgentWrangler hook path>/loop-guard-hook.mjs" }] }
- { "matcher": "*", "hooks": [{ "type": "command", "command": "<AgentWrangler hook path>/limit-burn-hook.mjs" }] }

Make this idempotent and safe to re-run: do not duplicate an already-present AgentWrangler hook entry. Preserve all unrelated settings and any other hooks.

Current thresholds (managed in the AgentWrangler dashboard)
- context_window: ${config.context_window}
- soft_pct: ${config.soft_pct}
- hard_pct: ${config.hard_pct}
- d7_fail_count: ${config.d7_fail_count}
- d7_window_turns: ${config.d7_window_turns}
- d9_idle_seconds: ${config.d9_idle_seconds}

The hook commands fetch these thresholds live from the AgentWrangler daemon; they are documented here for reference and are not stored in settings.json. This change takes effect immediately because Claude Code watches settings.json.`;
}

/** Build instructions for Claude Code to remove only the AgentWrangler hook commands. */
export function buildHookUninstallPrompt(): string {
  return `Update ~/.claude/settings.json by removing only the AgentWrangler PreToolUse hook entries whose commands reference these filenames:

- context-budget-hook.mjs
- loop-guard-hook.mjs
- limit-burn-hook.mjs

Make this idempotent and safe to re-run: do not duplicate or remove any unrelated settings or hooks. Preserve every non-AgentWrangler PreToolUse entry. This change takes effect immediately because Claude Code watches settings.json.`;
}
