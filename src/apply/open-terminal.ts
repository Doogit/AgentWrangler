/**
 * src/apply/open-terminal.ts — O11 Apply Console phase 1 (Option B).
 *
 * "Open in Claude Code ↗": launch the user's real terminal, detached, in a
 * recommendation's workspace folder running an interactive `claude` session
 * seeded with the INT-2 prompt artifact. The daemon NEVER runs the edit — the
 * user's own session is the permission surface and git is the rollback. This
 * module only spawns a detached terminal; it writes nothing to apply_jobs.
 *
 * Two invariants fixed by the 2026-09-04 spike (spec-apply-console.md §5):
 *   - Q3 env strip: a detached child inherits the daemon's env, which carries
 *     CLAUDECODE=1 + CLAUDE_CODE_* — those trip the nested-claude guard crash
 *     (DR1). stripClaudeEnv() removes them (plus the CLAUDE_PID/PLUGIN_DATA/
 *     EFFORT runtime residuals a fresh session must not inherit).
 *   - Q4 no shell interpolation: the pinned CLI has no --append-system-prompt-file,
 *     so the prompt is written to a temp file and only the file PATH rides the
 *     terminal's command line. A tiny node wrapper (open-terminal-child.mjs)
 *     reads the file and execs claude with the prompt as a single argv element,
 *     so prompt CONTENT never touches any shell/command-line parser.
 */

import { spawn as realSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/open.js";
import { getRecommendationCard } from "../query/api/recommendations.js";
import { getQueryDb } from "../query/db-context.js";

export type OpenTerminalResult =
  | { launched: true; launcher: string }
  | { launched: false; reason: string };

/** Minimal shape of the detached child we need (subset of ChildProcess). */
interface SpawnedLike {
  unref(): void;
}

type SpawnLike = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    detached: boolean;
    stdio: "ignore";
    windowsHide: boolean;
    env: NodeJS.ProcessEnv;
  },
) => SpawnedLike;

export interface OpenTerminalDeps {
  spawn: SpawnLike;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  tmpRoot: string;
  nodePath: string;
  /** Resolve a launcher command to an absolute path, or null when absent. */
  resolveCommand: (command: string) => string | null;
}

const WRAPPER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "open-terminal-child.mjs",
);

/**
 * Strip the Claude Code runtime env vars from a child's environment. Removing
 * CLAUDECODE is what prevents the nested-claude guard crash (DR1); the rest are
 * parent-session runtime state a fresh interactive session must not inherit.
 */
export function stripClaudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "CLAUDECODE") continue;
    if (k.startsWith("CLAUDE_CODE_")) continue;
    if (k === "CLAUDE_PID" || k === "CLAUDE_PLUGIN_DATA" || k === "CLAUDE_EFFORT") continue;
    out[k] = v;
  }
  return out;
}

/** PATH-search a launcher command; returns an absolute path or null. */
function defaultResolveCommand(command: string, env: NodeJS.ProcessEnv): string | null {
  if (path.isAbsolute(command)) return fs.existsSync(command) ? command : null;
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter((d) => d.length > 0);
  // cmd.exe always lives in System32 even if PATH is unusual.
  if (process.platform === "win32" && env.SystemRoot) {
    dirs.push(path.join(env.SystemRoot, "System32"));
  }
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())
      : [""];
  for (const dir of dirs) {
    if (path.extname(command) !== "") {
      const p = path.join(dir, command);
      if (fs.existsSync(p)) return p;
      continue;
    }
    for (const ext of exts) {
      const p = path.join(dir, command + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

interface Candidate {
  launcher: string;
  command: string;
  /** Build the launcher argv given the wrapper invocation (node wrapper promptFile cwd). */
  args: (ctx: { nodePath: string; promptFile: string; cwd: string }) => string[];
}

/** Shell-quote a single token for an AppleScript `do script` string (macOS arm, untested). */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function candidatesFor(platform: NodeJS.Platform): Candidate[] {
  const child = (ctx: { nodePath: string; promptFile: string; cwd: string }) => [
    ctx.nodePath,
    WRAPPER_PATH,
    ctx.promptFile,
    ctx.cwd,
  ];
  if (platform === "win32") {
    return [
      { launcher: "wt", command: "wt.exe", args: (ctx) => ["-d", ctx.cwd, ...child(ctx)] },
      {
        launcher: "cmd",
        command: "cmd.exe",
        args: (ctx) => ["/c", "start", "", "/d", ctx.cwd, ...child(ctx)],
      },
    ];
  }
  if (platform === "darwin") {
    // UNTESTED (spec §5 Q4): no macOS host this session. Only file PATHS are
    // interpolated into the AppleScript string; prompt content stays in the file.
    return [
      {
        launcher: "osascript",
        command: "osascript",
        args: (ctx) => [
          "-e",
          `tell application "Terminal" to do script "cd ${shq(ctx.cwd)} && ${shq(ctx.nodePath)} ${shq(WRAPPER_PATH)} ${shq(ctx.promptFile)} ${shq(ctx.cwd)}"`,
        ],
      },
    ];
  }
  // linux + others — UNTESTED (spec §5 Q4). argv arrays, no shell.
  return [
    {
      launcher: "x-terminal-emulator",
      command: "x-terminal-emulator",
      args: (ctx) => ["-e", ...child(ctx)],
    },
    { launcher: "gnome-terminal", command: "gnome-terminal", args: (ctx) => ["--", ...child(ctx)] },
    { launcher: "xterm", command: "xterm", args: (ctx) => ["-e", ...child(ctx)] },
  ];
}

function defaultDeps(): OpenTerminalDeps {
  const env = process.env;
  return {
    spawn: realSpawn as unknown as SpawnLike,
    platform: process.platform,
    env,
    tmpRoot: os.tmpdir(),
    nodePath: process.execPath,
    resolveCommand: (command) => defaultResolveCommand(command, env),
  };
}

/**
 * Launch a detached terminal in `cwd` running an interactive claude seeded with
 * `prompt`. Pure w.r.t. the DB — takes cwd + prompt directly. Injectable deps
 * make terminal selection, env strip, and prompt hand-off unit-testable.
 */
export function openTerminal(
  input: { cwd: string; prompt: string },
  deps: Partial<OpenTerminalDeps> = {},
): OpenTerminalResult {
  const d: OpenTerminalDeps = { ...defaultDeps(), ...deps };
  const { cwd, prompt } = input;
  if (typeof prompt !== "string" || prompt.length === 0) {
    return { launched: false, reason: "No prompt to seed — Copy prompt instead." };
  }
  if (typeof cwd !== "string" || cwd.length === 0 || !path.isAbsolute(cwd)) {
    return { launched: false, reason: "Workspace folder is not a valid absolute path." };
  }

  const candidate = candidatesFor(d.platform).find((c) => d.resolveCommand(c.command) !== null);
  if (candidate === undefined) {
    return { launched: false, reason: "No terminal emulator found — Copy prompt instead." };
  }
  const resolved = d.resolveCommand(candidate.command) as string;

  // Write the prompt to a temp file (Q4). The wrapper unlinks it after reading,
  // so prompt content is transient (SEC-101) and never rides a command line.
  const promptDir = fs.mkdtempSync(path.join(d.tmpRoot, "aw-open-"));
  const promptFile = path.join(promptDir, "prompt.txt");
  fs.writeFileSync(promptFile, prompt, "utf8");

  const args = candidate.args({ nodePath: d.nodePath, promptFile, cwd });
  try {
    const child = d.spawn(resolved, args, {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      env: stripClaudeEnv(d.env),
    });
    child.unref();
  } catch (e) {
    try {
      fs.rmSync(promptDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    return {
      launched: false,
      reason: `Couldn't start ${candidate.launcher} — Copy prompt instead. (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  return { launched: true, launcher: candidate.launcher };
}

/** Persisted counts-only demand signal for Option A (spec §4/§7). SEC-101: a scalar. */
function incrementOpenTerminalCount(db: Db): void {
  db.prepare(
    `INSERT INTO user_config (key, value, updated_at)
       VALUES ('open_terminal_click_count', '1', ?)
     ON CONFLICT(key) DO UPDATE
       SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at`,
  ).run(new Date().toISOString());
}

/**
 * Resolve a recommendation's workspace folder and open a terminal there. The
 * cwd comes from workspaces.repo_path (server-side) so reach is every
 * workspace-scoped rec with a local folder, not just file-ref recs. `prompt` is
 * the UI-built INT-2 artifact (the daemon is fenced off from the UI templates).
 */
export function openTerminalForRec(
  recId: string,
  prompt: string,
  deps: Partial<OpenTerminalDeps> = {},
): OpenTerminalResult {
  const db = getQueryDb();
  const rec = getRecommendationCard(recId);
  if (rec === null) return { launched: false, reason: "Recommendation not found." };
  if (rec.scope_workspace_id === null) {
    return {
      launched: false,
      reason:
        "This is a cross-workspace recommendation with no single folder — Copy prompt instead.",
    };
  }
  const row = db
    .prepare("SELECT repo_path FROM workspaces WHERE workspace_id = ?")
    .get(rec.scope_workspace_id) as { repo_path: string | null } | undefined;
  const cwd = row?.repo_path ?? null;
  if (cwd === null || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) {
    return {
      launched: false,
      reason:
        "This recommendation's workspace folder isn't available locally — Copy prompt instead.",
    };
  }

  const result = openTerminal({ cwd, prompt }, deps);
  if (result.launched) incrementOpenTerminalCount(db);
  return result;
}
