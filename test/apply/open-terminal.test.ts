import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type OpenTerminalDeps,
  openTerminal,
  openTerminalForRec,
  stripClaudeEnv,
} from "../../src/apply/open-terminal.js";
import { setDbWriteGate } from "../../src/db/write-gate.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { seedValidatedRecommendation } from "../fixtures/recommendations.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// A hostile prompt: every char that would break out if content ever rode a
// shell/command-line. It must survive as file content and NEVER appear in the
// terminal's argv.
const NASTY_PROMPT = `Trim it. "q" & echo pwn > x | %PATH% ^c $(whoami) ;semi\`tick\nl2\ttab`;

interface SpawnCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

function makeDeps(
  overrides: {
    present?: Set<string>;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    spawnThrows?: boolean;
    /** Exit code the launcher process reports (macOS osascript is awaited). */
    exitCode?: number;
    /** The launcher hangs (e.g. osascript blocked on an unanswered TCC dialog). */
    neverExits?: boolean;
  } = {},
): {
  deps: Partial<OpenTerminalDeps>;
  calls: SpawnCall[];
  tmpRoot: string;
  killed: Array<NodeJS.Signals | undefined>;
} {
  const killed: Array<NodeJS.Signals | undefined> = [];
  const present = overrides.present ?? new Set(["wt.exe", "cmd.exe"]);
  const calls: SpawnCall[] = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-open-test-"));
  const deps: Partial<OpenTerminalDeps> = {
    platform: overrides.platform ?? "win32",
    env: overrides.env ?? { PATH: "/usr/bin", CLAUDECODE: "1" },
    tmpRoot,
    nodePath: "/fake/node",
    resolveCommand: (command) => (present.has(command) ? `/resolved/${command}` : null),
    spawn: (command, args, options) => {
      if (overrides.spawnThrows) throw new Error("spawn EPERM");
      calls.push({ command, args, env: options.env, cwd: options.cwd });
      const child = Object.assign(new EventEmitter(), {
        unref: () => {},
        kill: (signal?: NodeJS.Signals) => {
          killed.push(signal);
          return true;
        },
      });
      if (!overrides.neverExits) setTimeout(() => child.emit("exit", overrides.exitCode ?? 0), 0);
      return child;
    },
  };
  return { deps, calls, tmpRoot, killed };
}

describe("stripClaudeEnv", () => {
  it("removes the nested-guard trigger + runtime residuals, keeps everything else", () => {
    const out = stripClaudeEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_PID: "123",
      CLAUDE_PLUGIN_DATA: "x",
      CLAUDE_EFFORT: "high",
      PATH: "/usr/bin",
      HOME: "/home/u",
    });
    expect(out.CLAUDECODE).toBeUndefined();
    expect(out.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(out.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(out.CLAUDE_PID).toBeUndefined();
    expect(out.CLAUDE_PLUGIN_DATA).toBeUndefined();
    expect(out.CLAUDE_EFFORT).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/u");
  });
});

describe("openTerminal (Windows)", () => {
  it("uses wt when present", async () => {
    const { deps, calls } = makeDeps({ present: new Set(["wt.exe", "cmd.exe"]) });
    const res = await openTerminal({ cwd: "C:\\repo", prompt: "hi" }, deps);
    expect(res).toEqual({ launched: true, launcher: "wt" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("/resolved/wt.exe");
    expect(calls[0]?.args.slice(0, 3)).toEqual(["-d", "C:\\repo", "/fake/node"]);
  });

  it("falls back to cmd when wt is absent", async () => {
    const { deps, calls } = makeDeps({ present: new Set(["cmd.exe"]) });
    const res = await openTerminal({ cwd: "C:\\repo", prompt: "hi" }, deps);
    expect(res).toEqual({ launched: true, launcher: "cmd" });
    expect(calls[0]?.command).toBe("/resolved/cmd.exe");
    expect(calls[0]?.args.slice(0, 5)).toEqual(["/c", "start", "", "/d", "C:\\repo"]);
  });

  it("returns launched:false when no terminal is found", async () => {
    const { deps, calls } = makeDeps({ present: new Set() });
    const res = await openTerminal({ cwd: "C:\\repo", prompt: "hi" }, deps);
    expect(res.launched).toBe(false);
    if (!res.launched) expect(res.reason).toMatch(/No terminal/i);
    expect(calls).toHaveLength(0);
  });

  it("strips the Claude Code env from the child", async () => {
    const { deps, calls } = makeDeps({
      env: {
        PATH: "/usr/bin",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "s",
        ANTHROPIC_API_KEY: "sk-ant-daemon",
        KEEP: "yes",
      },
    });
    await openTerminal({ cwd: "C:\\repo", prompt: "hi" }, deps);
    const env = calls[0]?.env ?? {};
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    // D2: the session bills the user's subscription, never the daemon's API key.
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env.KEEP).toBe("yes");
  });

  it("never puts prompt content on the command line; the temp file holds it verbatim", async () => {
    const { deps, calls } = makeDeps();
    const res = await openTerminal({ cwd: "C:\\repo", prompt: NASTY_PROMPT }, deps);
    expect(res.launched).toBe(true);
    const args = calls[0]?.args ?? [];
    // No fragment of the hostile prompt appears anywhere in the argv.
    const argvJoined = JSON.stringify(args);
    expect(argvJoined).not.toContain("whoami");
    expect(argvJoined).not.toContain("PATH%");
    expect(argvJoined).not.toContain("echo pwn");
    // The prompt file path IS on the command line, and holds the prompt verbatim.
    const promptFile = args.find((a) => a.endsWith("prompt.txt"));
    expect(promptFile).toBeDefined();
    expect(fs.readFileSync(promptFile as string, "utf8")).toBe(NASTY_PROMPT);
  });

  it("reports a friendly failure and cleans up when spawn throws", async () => {
    const { deps } = makeDeps({ spawnThrows: true });
    const res = await openTerminal({ cwd: "C:\\repo", prompt: "hi" }, deps);
    expect(res.launched).toBe(false);
  });

  it("rejects an empty prompt and a non-absolute cwd", async () => {
    const { deps } = makeDeps();
    expect((await openTerminal({ cwd: "C:\\repo", prompt: "" }, deps)).launched).toBe(false);
    expect((await openTerminal({ cwd: "relative", prompt: "hi" }, deps)).launched).toBe(false);
  });

  it("does not wait on the launcher's exit (wt/cmd stay detached)", async () => {
    // A non-zero exit from the detached Windows launcher is not observed: unchanged behavior.
    const { deps } = makeDeps({ exitCode: 1 });
    expect(await openTerminal({ cwd: "C:\\repo", prompt: "hi" }, deps)).toEqual({
      launched: true,
      launcher: "wt",
    });
  });
});

/** Decode an AppleScript string literal body: `\"` → `"`, `\\` → `\`; a bare `"` is a syntax error. */
function decodeAppleScriptString(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '"') throw new Error(`unescaped quote at ${i}`);
    if (c === "\\") {
      const next = body[i + 1];
      if (next !== '"' && next !== "\\") throw new Error(`bad escape at ${i}`);
      out += next;
      i += 1;
    } else out += c;
  }
  return out;
}

describe("openTerminal (macOS, D4)", () => {
  const mac = (o: Parameters<typeof makeDeps>[0] = {}) =>
    makeDeps({ platform: "darwin", present: new Set(["osascript"]), ...o });

  it("reports launched when osascript exits 0", async () => {
    const { deps, calls } = mac();
    const res = await openTerminal({ cwd: "/srv/repo", prompt: "hi" }, deps);
    expect(res).toEqual({ launched: true, launcher: "osascript" });
    expect(calls[0]?.command).toBe("/resolved/osascript");
  });

  it("returns not-launched with a reason and deletes the prompt file when osascript fails (TCC -1743)", async () => {
    const { deps, calls, tmpRoot } = mac({ exitCode: 1 });
    const res = await openTerminal({ cwd: "/srv/repo", prompt: "secret prompt" }, deps);
    expect(res.launched).toBe(false);
    if (res.launched) throw new Error("expected failure");
    expect(res.reason).toMatch(/Automation/);
    expect(res.reason).toMatch(/Copy prompt/);
    // The prompt file path rode the AppleScript; it must be gone (SEC-101), dir and all.
    const script = calls[0]?.args[1] ?? "";
    const shell = decodeAppleScriptString(script.slice(script.indexOf('do script "') + 11, -1));
    const promptFile = /'([^']*prompt\.txt)'/.exec(shell)?.[1];
    expect(promptFile).toBeDefined();
    expect(fs.existsSync(promptFile as string)).toBe(false);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it("F1: bounds the osascript wait; on timeout kills it, removes the prompt, asks to answer the dialog", async () => {
    const { deps, tmpRoot, killed } = mac({ neverExits: true });
    const res = await openTerminal(
      { cwd: "/srv/repo", prompt: "secret prompt" },
      { ...deps, exitTimeoutMs: 50 },
    );
    expect(res).toEqual({
      launched: false,
      reason: "Answer the macOS permission dialog, then retry.",
    });
    expect(killed).toEqual(["SIGKILL"]);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it("F1: the default osascript wait bound is 20 s", async () => {
    vi.useFakeTimers();
    try {
      const { deps, killed } = mac({ neverExits: true });
      let settled = false;
      const pending = openTerminal({ cwd: "/srv/repo", prompt: "hi" }, deps).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(19_900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect((await pending).launched).toBe(false);
      expect(killed).toEqual(["SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('escapes " and \\ so the AppleScript string stays well-formed', async () => {
    const { deps, calls } = mac();
    const cwd = "/srv/we\"ird\\dir/it's";
    await openTerminal({ cwd, prompt: "hi" }, deps);
    const args = calls[0]?.args ?? [];
    expect(args[0]).toBe("-e");
    const script = args[1] ?? "";
    const prefix = 'tell application "Terminal" to do script "';
    expect(script.startsWith(prefix)).toBe(true);
    expect(script.endsWith('"')).toBe(true);
    const shell = decodeAppleScriptString(script.slice(prefix.length, -1));
    // After AppleScript unescaping, the shell sees the single-quoted cwd verbatim.
    expect(shell.startsWith(`cd '/srv/we"ird\\dir/it'\\''s' && '/fake/node' `)).toBe(true);
    expect(shell.endsWith(` '/srv/we"ird\\dir/it'\\''s'`)).toBe(true);
  });
});

describe("openTerminalForRec", () => {
  let db: Database.Database;
  let repoDir: string;

  function insertWorkspaceRec(recId: string, workspaceId: string, repoPath: string | null): void {
    db.prepare(
      `INSERT INTO workspaces (workspace_id, project_slug, repo_path, registered_at)
       VALUES (?, ?, ?, '2026-09-01T00:00:00.000Z')`,
    ).run(workspaceId, workspaceId, repoPath);
    seedValidatedRecommendation(db, { recId, scope: workspaceId });
  }

  beforeEach(() => {
    db = createInMemoryFixtureDb();
    setQueryDb(db);
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-open-repo-"));
  });

  afterEach(() => {
    resetQueryDb();
    db.close();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  function countConfig(): number {
    const row = db
      .prepare("SELECT value FROM user_config WHERE key = 'open_terminal_click_count'")
      .get() as { value: string } | undefined;
    return row === undefined ? 0 : Number(row.value);
  }

  it("resolves cwd from the workspace repo_path, launches, and counts the click", async () => {
    insertWorkspaceRec("rec-1", "ws-x", repoDir);
    const { deps } = makeDeps();
    const res = await openTerminalForRec("rec-1", "do the thing", deps);
    expect(res).toEqual({ launched: true, launcher: "wt" });
    expect(countConfig()).toBe(1);
    const again = await openTerminalForRec("rec-1", "again", deps);
    expect(again.launched).toBe(true);
    expect(countConfig()).toBe(2);
  });

  it("the click count waits out an in-flight WAL checkpoint (write gate), then is written", async () => {
    insertWorkspaceRec("rec-g", "ws-g", repoDir);
    const { deps } = makeDeps();
    let release = (): void => {};
    let gate: Promise<void> | null = new Promise<void>((r) => {
      release = () => {
        gate = null;
        r();
      };
    });
    setDbWriteGate(() => gate);
    try {
      const pending = openTerminalForRec("rec-g", "gated", deps);
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      expect(countConfig()).toBe(0); // launched, but the write is held behind the gate
      release();
      expect((await pending).launched).toBe(true);
      expect(countConfig()).toBe(1);
    } finally {
      setDbWriteGate(null);
    }
  });

  it("does not count when the workspace has no local folder", async () => {
    insertWorkspaceRec("rec-2", "ws-y", null);
    const { deps } = makeDeps();
    const res = await openTerminalForRec("rec-2", "do the thing", deps);
    expect(res.launched).toBe(false);
    expect(countConfig()).toBe(0);
  });

  it("refuses cross-workspace (global) recs", async () => {
    seedValidatedRecommendation(db, { recId: "rec-g", scope: null });
    const { deps } = makeDeps();
    const res = await openTerminalForRec("rec-g", "do the thing", deps);
    expect(res.launched).toBe(false);
    if (!res.launched) expect(res.reason).toMatch(/cross-workspace/i);
  });

  it("returns not-found for an unknown rec", async () => {
    const { deps } = makeDeps();
    const res = await openTerminalForRec("nope", "x", deps);
    expect(res.launched).toBe(false);
  });
});
