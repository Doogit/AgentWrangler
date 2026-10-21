import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ISOLATION_ENV,
  type JudgeSpawn,
  MAX_PAYLOAD_BYTES,
  resolveClaudeCli,
  runClaudeJudge,
} from "../../src/judge/claude-cli.js";

describe("resolveClaudeCli", () => {
  const npm = "C:\\npm";
  const local = "C:\\local\\bin";
  const shimTarget = join(npm, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");

  it("non-Windows: leaves PATH lookup to execvp", () => {
    expect(resolveClaudeCli({ PATH: "/x" }, "linux", () => false)).toBe("claude");
  });

  it("Windows: an npm claude.cmd earlier on PATH wins over a later claude.exe (matches the shell)", () => {
    const files = new Set([join(npm, "claude.cmd"), shimTarget, join(local, "claude.exe")]);
    expect(resolveClaudeCli({ Path: `${npm};${local}` }, "win32", (p) => files.has(p))).toBe(
      shimTarget,
    );
  });

  it("Windows: a claude.exe earlier on PATH wins", () => {
    const files = new Set([join(npm, "claude.cmd"), shimTarget, join(local, "claude.exe")]);
    expect(resolveClaudeCli({ PATH: `${local};${npm}` }, "win32", (p) => files.has(p))).toBe(
      join(local, "claude.exe"),
    );
  });

  it("Windows: a .cmd that is not the npm shim is skipped; nothing found → null", () => {
    expect(
      resolveClaudeCli({ PATH: npm }, "win32", (p) => p === join(npm, "claude.cmd")),
    ).toBeNull();
  });
});

const SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
};

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a value");
  return v;
}

function okSpawn(
  stdout: string,
  seen: { argv?: string[]; opts?: Parameters<JudgeSpawn>[2]; prompt?: string },
) {
  return vi.fn<JudgeSpawn>(async (cmd, argv, opts) => {
    seen.argv = [cmd, ...argv];
    seen.opts = opts;
    const f = must(argv[argv.indexOf("--system-prompt-file") + 1]);
    seen.prompt = readFileSync(f, "utf8");
    return { code: 0, stdout };
  });
}

describe("runClaudeJudge — isolated claude -p spawn", () => {
  it("spawns claude with the exact isolation argv, empty temp cwd, isolation env and payload on stdin", async () => {
    const seen: { argv?: string[]; opts?: Parameters<JudgeSpawn>[2]; prompt?: string } = {};
    const spawn = okSpawn(
      JSON.stringify({ structured_output: { verdict: "ok" }, total_cost_usd: 0.41 }),
      seen,
    );
    const res = await runClaudeJudge({
      payload: "PAYLOAD-BYTES",
      systemPrompt: "SYSTEM-PROMPT",
      jsonSchema: SCHEMA,
      model: "claude-sonnet-5-5",
      baseEnv: { PATH: "/bin", HTTPS_PROXY: "http://proxy:1" },
      spawn,
    });

    expect(res).toEqual({ ok: true, data: { verdict: "ok" }, costUsd: 0.41 });
    expect(spawn).toHaveBeenCalledTimes(1);
    const argv = must(seen.argv);
    const promptFile = must(argv[argv.indexOf("--system-prompt-file") + 1]);
    expect(argv).toEqual([
      "claude",
      "-p",
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--system-prompt-file",
      promptFile,
      "--output-format",
      "json",
      "--max-turns",
      "1",
      "--model",
      "claude-sonnet-5-5",
      "--json-schema",
      JSON.stringify(SCHEMA),
      "--settings",
      '{"outputStyle":"default"}',
    ]);
    expect(seen.prompt).toBe("SYSTEM-PROMPT");
    expect(seen.opts?.input).toBe("PAYLOAD-BYTES");
    expect(seen.opts?.env).toEqual({
      PATH: "/bin",
      HTTPS_PROXY: "http://proxy:1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
      CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
    });
    expect(ISOLATION_ENV).toEqual({
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
      CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
    });
    // cwd is a fresh temp dir that held nothing but the prompt file, and is removed afterwards.
    const cwd = must(seen.opts?.cwd);
    expect(cwd.startsWith(tmpdir())).toBe(true);
    expect(promptFile.startsWith(cwd)).toBe(false);
    expect(existsSync(cwd)).toBe(false);
    expect(existsSync(promptFile)).toBe(false);
  });

  it("isolation env overrides a base env that tries to re-enable CLAUDE.md loading", async () => {
    const seen: { opts?: Parameters<JudgeSpawn>[2] } = {};
    const spawn = okSpawn(JSON.stringify({ structured_output: { verdict: "ok" } }), seen);
    await runClaudeJudge({
      payload: "p",
      systemPrompt: "s",
      jsonSchema: SCHEMA,
      model: "m",
      baseEnv: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "0", CLAUDECODE: "1" },
      spawn,
    });
    expect(seen.opts?.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
    // An inherited nested-session marker would make the CLI refuse to start.
    expect(seen.opts?.env).not.toHaveProperty("CLAUDECODE");
  });

  it("D2: never passes the daemon's ANTHROPIC_API_KEY to the judge child", async () => {
    const seen: { opts?: Parameters<JudgeSpawn>[2] } = {};
    const spawn = okSpawn(JSON.stringify({ structured_output: { verdict: "ok" } }), seen);
    await runClaudeJudge({
      payload: "p",
      systemPrompt: "s",
      jsonSchema: SCHEMA,
      model: "m",
      baseEnv: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-daemon" },
      spawn,
    });
    expect(seen.opts?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(seen.opts?.env.PATH).toBe("/bin");
  });

  it("refuses a payload over the 10 MB cap without spawning", async () => {
    const spawn = vi.fn<JudgeSpawn>();
    const res = await runClaudeJudge({
      payload: "x".repeat(MAX_PAYLOAD_BYTES + 1),
      systemPrompt: "s",
      jsonSchema: SCHEMA,
      model: "m",
      baseEnv: {},
      spawn,
    });
    expect(res).toEqual({ ok: false, reason: "payload_too_large" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["non-zero exit", { code: 1, stdout: "" }, "cli_failed"],
    [
      "old CLI rejects an isolation flag",
      { code: 1, stdout: "", unknownOption: true },
      "cli_outdated",
    ],
    ["non-JSON stdout", { code: 0, stdout: "not json <secret model text>" }, "bad_output"],
    [
      "is_error result",
      { code: 0, stdout: JSON.stringify({ is_error: true, result: "boom" }) },
      "cli_error",
    ],
    [
      "missing structured_output",
      { code: 0, stdout: JSON.stringify({ result: "prose" }) },
      "bad_output",
    ],
  ] as const)("%s → fixed reason enum, no raw text echoed", async (_name, out, reason) => {
    const spawn = vi.fn<JudgeSpawn>(async () => out);
    const res = await runClaudeJudge({
      payload: "p",
      systemPrompt: "s",
      jsonSchema: SCHEMA,
      model: "m",
      baseEnv: {},
      spawn,
    });
    expect(res).toEqual({ ok: false, reason });
  });

  it("spawn rejection (e.g. claude not on PATH) → cli_missing, temp dir cleaned", async () => {
    let cwd = "";
    const spawn = vi.fn<JudgeSpawn>(async (_c, _a, opts) => {
      cwd = opts.cwd;
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    });
    const res = await runClaudeJudge({
      payload: "p",
      systemPrompt: "s",
      jsonSchema: SCHEMA,
      model: "m",
      baseEnv: {},
      spawn,
    });
    expect(res).toEqual({ ok: false, reason: "cli_missing" });
    expect(existsSync(cwd)).toBe(false);
  });

  it("aborted signal → cancelled", async () => {
    const ac = new AbortController();
    const spawn = vi.fn<JudgeSpawn>(async (_c, _a, opts) => {
      ac.abort();
      expect(opts.signal).toBe(ac.signal);
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const res = await runClaudeJudge({
      payload: "p",
      systemPrompt: "s",
      jsonSchema: SCHEMA,
      model: "m",
      baseEnv: {},
      spawn,
      signal: ac.signal,
    });
    expect(res).toEqual({ ok: false, reason: "cancelled" });
  });

  it("does not log payload or model text", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const spawn = vi.fn<JudgeSpawn>(async () => ({ code: 0, stdout: "MODEL-TEXT-xyz" }));
    await runClaudeJudge({
      payload: "PAYLOAD-abc",
      systemPrompt: "s",
      jsonSchema: SCHEMA,
      model: "m",
      baseEnv: {},
      spawn,
    });
    for (const l of logs) {
      for (const call of l.mock.calls)
        expect(JSON.stringify(call)).not.toMatch(/PAYLOAD-abc|MODEL-TEXT-xyz/);
      l.mockRestore();
    }
  });
});
