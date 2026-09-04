/** Local-only wrappers for the Claude Code hook installer. */

import { type HookInstallResult, installHook, uninstallHook } from "../../hook/install.js";

export type { HookInstallResult } from "../../hook/install.js";

export function installHookRoute(): HookInstallResult {
  return installHook();
}

export function uninstallHookRoute(): HookInstallResult {
  return uninstallHook();
}
