/**
 * src/daemon/config.ts — daemon configuration.
 *
 * Config is layered:
 *   1. Compile-time defaults (below).
 *   2. Environment variable overrides (AW_* prefix).
 *   3. Runtime overrides from the user_config table (persisted by WP4).
 *
 * WP4 implements the user_config read/write path. This module provides the
 * defaults and the environment-variable layer used at boot time.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Default scan root for ~/.claude/projects/ transcript discovery. */
const DEFAULT_SCAN_ROOT = path.join(os.homedir(), ".claude", "projects");

/** Default TCP port for the loopback HTTP server. */
const DEFAULT_PORT = 47821;

/**
 * Activity window in seconds: sessions with last_turn_at within this many
 * seconds of now are considered LIVE. Beyond this, they are reconciled.
 */
const DEFAULT_ACTIVITY_WINDOW_SECS = 5 * 60; // 5 minutes

/** Default on-disk database path. */
const DEFAULT_DB_PATH = path.join(os.homedir(), ".agentwrangler", "db.sqlite");

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_UI_ROOT = path.resolve(MODULE_DIR, "..", "..", "dist", "ui");

export interface DaemonConfig {
  /** Path to the on-disk SQLite database. */
  dbPath: string;
  /** TCP port to bind (loopback). */
  port: number;
  /** Root directories to scan for transcript files. */
  scanRoots: string[];
  /** Activity window in seconds. */
  activityWindowSecs: number;
  /** Path to the built SPA assets, or null if not yet built. */
  uiRoot: string | null;
}

/**
 * Load the daemon config from compile-time defaults and environment variables.
 * WP4 will augment this with user_config table values after DB is open.
 */
export function loadConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const dbPath = process.env.AW_DB_PATH ?? DEFAULT_DB_PATH;

  const portEnv = process.env.AW_PORT;
  const port = portEnv !== undefined ? Number.parseInt(portEnv, 10) : DEFAULT_PORT;

  const scanRootEnv = process.env.AW_SCAN_ROOT;
  const scanRoots = scanRootEnv !== undefined ? [scanRootEnv] : [DEFAULT_SCAN_ROOT];

  const windowEnv = process.env.AW_ACTIVITY_WINDOW_SECS;
  const activityWindowSecs =
    windowEnv !== undefined ? Number.parseInt(windowEnv, 10) : DEFAULT_ACTIVITY_WINDOW_SECS;

  const uiRootEnv = process.env.AW_UI_ROOT;
  const uiRoot: string | null =
    uiRootEnv !== undefined ? uiRootEnv : fs.existsSync(DEFAULT_UI_ROOT) ? DEFAULT_UI_ROOT : null;

  return {
    dbPath,
    port,
    scanRoots,
    activityWindowSecs,
    uiRoot,
    ...overrides,
  };
}
