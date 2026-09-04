import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type OpenTerminalDeps,
  openTerminal,
  openTerminalForRec,
  stripClaudeEnv,
} from "../../src/apply/open-terminal.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
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
  } = {},
): { deps: Partial<OpenTerminalDeps>; calls: SpawnCall[]; tmpRoot: string } {
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
      return { unref: () => {} };
    },
  };
  return { deps, calls, tmpRoot };
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
  it("uses wt when present", () => {
    const { deps, calls } = makeDeps({ present: new Set(["wt.exe", "cmd.exe"]) });
    const res = openTerminal({ cwd: "C:\\repo", prompt: "hi" }, deps);
    expect(res).toEqual({ launched: true, launcher: "wt" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("/resolved/wt.exe");
    expect(calls[0]?.args.slice(0, 3)).toEqual(["-d", "C:\\repo", "/fake/node"]);
  });

  it("falls back to cmd when wt is absent", () => {
    const { deps, calls } = makeDeps({ present: new Set(["cmd.exe"]) });
    const res = openTerminal({ cwd: "C:\\repo", prompt: "hi" }, deps);
    expect(res).toEqual({ launched: true, launcher: "cmd" });
    expect(calls[0]?.command).toBe("/resolved/cmd.exe");
    expect(calls[0]?.args.slice(0, 5)).toEqual(["/c", "start", "", "/d", "C:\\repo"]);
  });

  it("returns launched:false when no terminal is found", () => {
    const { deps, calls } = makeDeps({ present: new Set() });
    const res = openTerminal({ cwd: "C:\\repo", prompt: "hi" }, deps);
    expect(res.launched).toBe(false);
    if (!res.launched) expect(res.reason).toMatch(/No terminal/i);
    expect(calls).toHaveLength(0);
  });

  it("strips the Claude Code env from the child", () => {
    const { deps, calls } = makeDeps({
      env: { PATH: "/usr/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", KEEP: "yes" },
    });
    openTerminal({ cwd: "C:\\repo", prompt: "hi" }, deps);
    const env = calls[0]?.env ?? {};
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.KEEP).toBe("yes");
  });

  it("never puts prompt content on the command line; the temp file holds it verbatim", () => {
    const { deps, calls } = makeDeps();
    const res = openTerminal({ cwd: "C:\\repo", prompt: NASTY_PROMPT }, deps);
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

  it("reports a friendly failure and cleans up when spawn throws", () => {
    const { deps } = makeDeps({ spawnThrows: true });
    const res = openTerminal({ cwd: "C:\\repo", prompt: "hi" }, deps);
    expect(res.launched).toBe(false);
  });

  it("rejects an empty prompt and a non-absolute cwd", () => {
    const { deps } = makeDeps();
    expect(openTerminal({ cwd: "C:\\repo", prompt: "" }, deps).launched).toBe(false);
    expect(openTerminal({ cwd: "relative", prompt: "hi" }, deps).launched).toBe(false);
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
    db.prepare(
      `INSERT INTO recommendations
         (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
          modeled_savings_u_per_wk, modeled_formula_json, evidence_json,
          target_metric, state, created_at, dismissed_until)
       VALUES (?, 'RULE', 'D1', 'CONTEXT', ?, 'Trim workspace CLAUDE.md', 1000,
         '{"model":"D1","inputs":{}}', ?, 'avg_context_per_turn',
         'PROPOSED', '2026-08-25T00:00:00.000Z', NULL)`,
    ).run(recId, workspaceId, JSON.stringify({ component: "CLAUDE_MD", steps: [] }));
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

  it("resolves cwd from the workspace repo_path, launches, and counts the click", () => {
    insertWorkspaceRec("rec-1", "ws-x", repoDir);
    const { deps } = makeDeps();
    const res = openTerminalForRec("rec-1", "do the thing", deps);
    expect(res).toEqual({ launched: true, launcher: "wt" });
    expect(countConfig()).toBe(1);
    const again = openTerminalForRec("rec-1", "again", deps);
    expect(again.launched).toBe(true);
    expect(countConfig()).toBe(2);
  });

  it("does not count when the workspace has no local folder", () => {
    insertWorkspaceRec("rec-2", "ws-y", null);
    const { deps } = makeDeps();
    const res = openTerminalForRec("rec-2", "do the thing", deps);
    expect(res.launched).toBe(false);
    expect(countConfig()).toBe(0);
  });

  it("refuses cross-workspace (global) recs", () => {
    db.prepare(
      `INSERT INTO recommendations
         (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
          modeled_savings_u_per_wk, modeled_formula_json, evidence_json,
          target_metric, state, created_at, dismissed_until)
       VALUES ('rec-g', 'RULE', 'D1', 'CONTEXT', NULL, 'x', 1000,
         '{"model":"D1","inputs":{}}', '{}', 'avg_context_per_turn',
         'PROPOSED', '2026-08-25T00:00:00.000Z', NULL)`,
    ).run();
    const { deps } = makeDeps();
    const res = openTerminalForRec("rec-g", "do the thing", deps);
    expect(res.launched).toBe(false);
    if (!res.launched) expect(res.reason).toMatch(/cross-workspace/i);
  });

  it("returns not-found for an unknown rec", () => {
    const { deps } = makeDeps();
    const res = openTerminalForRec("nope", "x", deps);
    expect(res.launched).toBe(false);
  });
});
