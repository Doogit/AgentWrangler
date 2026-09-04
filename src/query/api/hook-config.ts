/** Runtime configuration for the local context-budget hook. */

import type { Db } from "../../db/open.js";
import { isHookInstalled } from "../../hook/install.js";
import { getQueryDb } from "../db-context.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";

export interface HookConfig {
  /** User-declared context window in tokens (200k standard, 1_000_000 for 1M-context models). */
  context_window: number;
  /** Warn when a session's context reaches this fraction of the window. */
  soft_pct: number;
  /** Urgent warning at this fraction of the window (warn-only — the hook never blocks). */
  hard_pct: number;
  stale_s: number;
  d7_fail_count: number;
  d7_window_turns: number;
  d9_idle_seconds: number;
}

export interface HookConfigResponse extends HookConfig {
  installed: boolean;
}

export type HookConfigUpdate = Partial<HookConfig>;

export const DEFAULT_HOOK_CONFIG: HookConfig = {
  context_window: 200_000,
  soft_pct: 0.6,
  hard_pct: 0.8,
  stale_s: 300,
  d7_fail_count: 3,
  d7_window_turns: 10,
  d9_idle_seconds: 1800,
};

const CONFIG_PREFIX = "hook_config.";
const CONFIG_KEYS = Object.keys(DEFAULT_HOOK_CONFIG) as Array<keyof HookConfig>;

function configKey(key: keyof HookConfig): string {
  return `${CONFIG_PREFIX}${key}`;
}

function isValidConfig(config: HookConfig): boolean {
  return (
    Number.isFinite(config.context_window) &&
    config.context_window > 0 &&
    Number.isFinite(config.soft_pct) &&
    config.soft_pct > 0 &&
    Number.isFinite(config.hard_pct) &&
    config.hard_pct > config.soft_pct &&
    config.hard_pct <= 1 &&
    Number.isFinite(config.stale_s) &&
    config.stale_s > 0 &&
    Number.isInteger(config.d7_fail_count) &&
    config.d7_fail_count >= 3 &&
    Number.isInteger(config.d7_window_turns) &&
    config.d7_window_turns > 0 &&
    Number.isInteger(config.d9_idle_seconds) &&
    config.d9_idle_seconds > 0
  );
}

/** Read each dedicated user_config key, degrading corrupt values to defaults. */
export function readHookConfig(db: Db): HookConfig {
  const read = db.prepare("SELECT value FROM user_config WHERE key = ?");
  const config = { ...DEFAULT_HOOK_CONFIG };
  for (const key of CONFIG_KEYS) {
    const row = read.get(configKey(key)) as { value: string | null } | undefined;
    if (row?.value === null || row?.value === undefined) continue;
    const value = Number(row.value);
    if (Number.isFinite(value)) config[key] = value;
  }
  return isValidConfig(config) ? config : { ...DEFAULT_HOOK_CONFIG };
}

export function getHookConfig(): ApiResponse<HookConfigResponse> {
  return buildResponse(
    { ...readHookConfig(getQueryDb()), installed: isHookInstalled() },
    { claim_kind: "N_A", n: 1 },
  );
}

/** Validate and atomically persist a partial update to dedicated config keys. */
export function updateHookConfig(update: HookConfigUpdate): ApiResponse<HookConfig> {
  if (update === null || typeof update !== "object" || Array.isArray(update)) {
    throw new Error("Invalid hook config");
  }
  for (const key of Object.keys(update)) {
    if (!CONFIG_KEYS.includes(key as keyof HookConfig)) throw new Error("Invalid hook config key");
  }

  const db = getQueryDb();
  const next = { ...readHookConfig(db), ...update };
  if (!isValidConfig(next)) throw new Error("Invalid hook config");

  const write = db.prepare(
    `INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    for (const key of CONFIG_KEYS) {
      if (update[key] !== undefined)
        write.run(configKey(key), String(next[key]), new Date().toISOString());
    }
  })();

  return buildResponse(next, { claim_kind: "N_A", n: 1 });
}
