// Isolated `claude -p` judge transport (JMS-P2 U9; ADR-112 "Transport").
// Runs the user's own Claude Code CLI with every ambient-context source switched off, so the judge sees only
// the allow-listed payload. AgentWrangler never reads the OAuth token. Payload and model text are never logged.
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutAnthropicApiKey } from "../shared/claude-child-env.js";

export const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

/** Env switches that stop the CLI loading CLAUDE.md, auto-memory, git instructions and attachments. */
export const ISOLATION_ENV = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
  CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
} as const;

const JUDGE_SETTINGS = JSON.stringify({ outputStyle: "default" });

/**
 * Context the CLI still adds that no flag or env var turns off (live probe, CLI 2.1.296). The consent screen must
 * show these alongside the payload.
 */
export const CLI_CONTEXT_DISCLOSURES = [
  "Your Claude account email address",
  "Your OS name and version",
  "A temporary folder path, which contains your OS user name",
  "Today's date and the model name",
] as const;

export interface JudgeSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  input: string;
  signal?: AbortSignal;
}
export type JudgeSpawn = (
  cmd: string,
  argv: string[],
  opts: JudgeSpawnOptions,
) => Promise<JudgeSpawnResult>;
export interface JudgeSpawnResult {
  code: number | null;
  stdout: string;
  /** The CLI rejected a flag: it predates the isolation flags. */
  unknownOption?: boolean;
}

export type JudgeCliReason =
  | "payload_too_large"
  | "cli_missing"
  | "cli_outdated"
  | "cli_failed"
  | "cli_error"
  | "bad_output"
  | "cancelled";

export type JudgeCliResult =
  | { ok: true; data: unknown; costUsd: number | null }
  | { ok: false; reason: JudgeCliReason };

export interface RunClaudeJudgeInput {
  payload: string;
  systemPrompt: string;
  jsonSchema: object;
  model: string;
  baseEnv?: Record<string, string | undefined>;
  spawn?: JudgeSpawn;
  signal?: AbortSignal;
}

/**
 * The env for an isolated CLI spawn: `base` minus CLAUDECODE (the daemon may inherit it from a session that
 * launched it; the CLI then refuses to start) and any `dropKeys`, plus ISOLATION_ENV.
 */
export function buildCliEnv(
  base: Record<string, string | undefined>,
  opts: { dropKeys?: readonly string[] } = {},
): Record<string, string> {
  const drop = new Set(["CLAUDECODE", ...(opts.dropKeys ?? [])]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !drop.has(k)) env[k] = v;
  Object.assign(env, ISOLATION_ENV);
  return env;
}

export async function runClaudeJudge(input: RunClaudeJudgeInput): Promise<JudgeCliResult> {
  if (Buffer.byteLength(input.payload, "utf8") > MAX_PAYLOAD_BYTES)
    return { ok: false, reason: "payload_too_large" };

  const env = buildCliEnv(withoutAnthropicApiKey(input.baseEnv ?? process.env));

  // The cwd must be empty so no project CLAUDE.md/settings are discovered; the prompt file lives elsewhere.
  const cwd = mkdtempSync(join(tmpdir(), "aw-judge-cwd-"));
  const promptDir = mkdtempSync(join(tmpdir(), "aw-judge-prompt-"));
  const promptFile = join(promptDir, "system-prompt.txt");
  try {
    writeFileSync(promptFile, input.systemPrompt, "utf8");
    const argv = [
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
      input.model,
      "--json-schema",
      JSON.stringify(input.jsonSchema),
      // --safe-mode drops custom output styles but not a built-in one named in user settings (probe 2026-10-13).
      "--settings",
      JUDGE_SETTINGS,
    ];
    let out: JudgeSpawnResult;
    try {
      out = await (input.spawn ?? spawnCli)("claude", argv, {
        cwd,
        env,
        input: input.payload,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (err) {
      if (input.signal?.aborted) return { ok: false, reason: "cancelled" };
      return {
        ok: false,
        reason: (err as { code?: string }).code === "ENOENT" ? "cli_missing" : "cli_failed",
      };
    }
    if (input.signal?.aborted) return { ok: false, reason: "cancelled" };
    if (out.code !== 0)
      return { ok: false, reason: out.unknownOption ? "cli_outdated" : "cli_failed" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(out.stdout);
    } catch {
      return { ok: false, reason: "bad_output" };
    }
    if (!parsed || typeof parsed !== "object") return { ok: false, reason: "bad_output" };
    const rec = parsed as {
      is_error?: unknown;
      structured_output?: unknown;
      total_cost_usd?: unknown;
    };
    if (rec.is_error === true) return { ok: false, reason: "cli_error" };
    if (!rec.structured_output || typeof rec.structured_output !== "object")
      return { ok: false, reason: "bad_output" };
    const cost = rec.total_cost_usd;
    return {
      ok: true,
      data: rec.structured_output,
      costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(promptDir, { recursive: true, force: true });
  }
}

/**
 * Find the `claude` the user's shell would run. Without a shell, Windows' spawn only tries `.com`/`.exe` and so can
 * skip an npm `claude.cmd` earlier on PATH in favour of a stale native install. A `.cmd` can't be spawned without a
 * shell, so an npm shim is mapped to the binary it wraps. Elsewhere execvp's PATH lookup already matches the shell.
 */
export function resolveClaudeCli(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | null {
  if (platform !== "win32") return "claude";
  const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";
  for (const dir of pathVar.split(";").filter(Boolean)) {
    for (const exe of ["claude.com", "claude.exe"])
      if (exists(join(dir, exe))) return join(dir, exe);
    if (exists(join(dir, "claude.cmd"))) {
      const wrapped = join(
        dir,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      );
      if (exists(wrapped)) return wrapped;
    }
  }
  return null;
}

/**
 * No shell: argv is passed verbatim, env only via spawn options, payload on stdin. With `timeoutMs`, the process
 * tree is killed at the deadline and the promise rejects with code ETIMEDOUT.
 */
export const spawnCli = (
  cmd: string,
  argv: string[],
  opts: JudgeSpawnOptions & { timeoutMs?: number },
): Promise<JudgeSpawnResult> =>
  new Promise((resolve, reject) => {
    const bin = cmd === "claude" ? resolveClaudeCli(opts.env) : cmd;
    if (!bin) return reject(Object.assign(new Error("claude not found"), { code: "ENOENT" }));
    const child = nodeSpawn(bin, argv, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (opts.timeoutMs !== undefined) {
      const timer = setTimeout(() => {
        killTree(child.pid);
        reject(Object.assign(new Error("claude timed out"), { code: "ETIMEDOUT" }));
      }, opts.timeoutMs);
      child.on("close", () => clearTimeout(timer));
      child.on("error", () => clearTimeout(timer));
    }
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    // stderr is only inspected for an old CLI's flag rejection; never logged or returned.
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 4096) stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(chunks).toString("utf8"),
        unknownOption: /unknown option/i.test(stderr),
      }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input, "utf8");
  });

/**
 * Kill a timed-out child. On Windows taskkill /T also walks its children (async, so the daemon loop isn't
 * blocked); elsewhere only the direct child is killed, which is all an isolated `claude -p` with no tools runs.
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32")
      nodeSpawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => {});
    else process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}
