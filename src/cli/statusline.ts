/**
 * src/cli/statusline.ts — `agentwrangler statusline [--wrap "<command>"]` (OV-7b).
 *
 * Claude Code pipes a JSON payload to the statusLine command on every refresh. This prints the
 * one-line status (same text as the operator's hand-tuned statusline-command.sh, see
 * test/cli/statusline-oracle.test.ts) and writes ~/.agentwrangler/statusline-limits.json — the two
 * rate-limit windows only (SEC-101) — for the usage-limits fallback (OV-7). With --wrap the payload is
 * also piped to the user's own statusline command and ITS output is printed instead.
 *
 * Runs on every refresh and Claude Code cancels a slow statusline, so: no git, no subprocess (except a
 * wrapped command), only fs. It never throws; bad input prints what it can.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultStatuslinePath } from "../query/limits/statusline.js";

type Json = Record<string, unknown>;

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const CYAN = `${ESC}[36m`;
const MAGENTA = `${ESC}[35m`;

/** jq's `.a.b.c`: null-safe path walk. */
function get(o: unknown, ...keys: string[]): unknown {
  let cur: unknown = o;
  for (const k of keys) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Json)[k];
  }
  return cur;
}
/** jq truthiness: everything except null and false. */
const truthy = (v: unknown): boolean => v !== null && v !== undefined && v !== false;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** jq round(): half away from zero. */
const round = (n: number): number => Math.sign(n) * Math.round(Math.abs(n));

const pct = (v: unknown): string => {
  const n = num(v);
  return n === null ? "" : String(round(n) || 0);
};

function secs(t: unknown): number | null {
  if (typeof t === "number") return Number.isFinite(t) ? t : null;
  if (typeof t !== "string") return null;
  const s = t.replace(/\.[0-9]+/, "");
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms / 1000;
}

/** Time until a window resets: "2d11h", "1h48m", "26m"; empty when unknown or already past. */
function left(t: unknown, nowMs: number): string {
  if (!truthy(t)) return "";
  const at = secs(t);
  if (at === null) return "";
  const s = Math.floor(at - nowMs / 1000);
  if (s <= 0) return "";
  if (s >= 86400) return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.ceil(s / 60)}m`;
}

function dur(ms: unknown): string {
  const n = num(ms);
  if (n === null) return "";
  const s = Math.floor(n / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

function tokens(input: unknown): string {
  const u = get(input, "context_window", "current_usage");
  let n: number | null = null;
  if (truthy(u)) {
    n =
      (num(get(u, "input_tokens")) ?? 0) +
      (num(get(u, "cache_creation_input_tokens")) ?? 0) +
      (num(get(u, "cache_read_input_tokens")) ?? 0);
  } else {
    const p = num(get(input, "context_window", "used_percentage"));
    const size = num(get(input, "context_window", "context_window_size"));
    if (p !== null && size !== null) n = (p * size) / 100;
  }
  if (n === null || n === 0) return "";
  return n >= 1000 ? `${round(n / 1000)}k` : String(round(n));
}

function colorFor(p: number): string {
  return p >= 80 ? RED : p >= 50 ? YELLOW : GREEN;
}

const firstLine = (file: string): string | null => {
  try {
    const t = fs.readFileSync(file, "utf8");
    const i = t.search(/\r?\n/);
    return i === -1 ? t : t.slice(0, i);
  } catch {
    return null;
  }
};

/** Branch (and the repo name, when the payload has none) from .git/HEAD, walking up from `cwd`. Never spawns git. */
function gitInfo(cwd: string): { branch: string; repo: string } {
  let d = cwd;
  while (d !== "") {
    const dotGit = `${d}/.git`;
    if (fs.existsSync(dotGit)) {
      let gitdir = dotGit;
      if (fs.statSync(dotGit).isFile()) {
        gitdir = (firstLine(dotGit) ?? "").replace(/^gitdir: /, "");
        if (!/^(\/|.:)/.test(gitdir)) gitdir = `${d}/${gitdir}`;
      }
      let branch = "";
      const head = firstLine(`${gitdir}/HEAD`);
      if (head !== null)
        branch = head.startsWith("ref: refs/heads/")
          ? head.slice("ref: refs/heads/".length)
          : "detached";
      const wt = gitdir.lastIndexOf("/.git/worktrees/");
      const root = wt !== -1 ? gitdir.slice(0, wt) : d;
      return { branch, repo: root.slice(root.lastIndexOf("/") + 1) };
    }
    const parent = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : d;
    if (parent === d) break;
    d = parent;
  }
  return { branch: "", repo: "" };
}

export interface Rendered {
  line: string;
  /** JSON for statusline-limits.json, or null when the payload lacks either window. */
  limitsJson: string | null;
}

/** Pure: payload text -> printed line + limits-file content. Bad JSON yields an empty line. */
export function renderStatusline(stdin: string, nowMs: number): Rendered {
  let input: unknown;
  try {
    input = JSON.parse(stdin.replace(/^\uFEFF/, ""));
  } catch {
    return { line: "", limitsJson: null };
  }
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return { line: "", limitsJson: null };

  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const model = str(get(input, "model", "display_name")).replace(/ *\(.*\)$/, "");
  const cwd = str(get(input, "workspace", "current_dir") ?? get(input, "cwd")).replace(/\\/g, "/");
  const payloadRepo = str(get(input, "workspace", "repo", "name"));
  const used = pct(get(input, "context_window", "used_percentage"));
  const five = pct(get(input, "rate_limits", "five_hour", "used_percentage"));
  const week = pct(get(input, "rate_limits", "seven_day", "used_percentage"));
  const costNum = num(get(input, "cost", "total_cost_usd"));
  const cents = costNum === null ? null : round(costNum * 100);
  const runtime = dur(get(input, "cost", "total_duration_ms"));

  const git = gitInfo(cwd);
  const repo = payloadRepo || git.repo || cwd.slice(cwd.lastIndexOf("/") + 1);

  let ctx = "";
  if (used !== "") {
    const u = Number(used);
    const filled = Math.min(10, Math.trunc(u / 10));
    const bar = "#".repeat(Math.max(0, filled)) + "-".repeat(10 - Math.max(0, filled));
    ctx = `ctx ${colorFor(u)}[${bar}] ${used}%${RESET}`;
    const t = tokens(input);
    if (t !== "") ctx += ` ${t}`;
  }

  const windowPart = (p: string, label: string, resetsAt: unknown) => {
    if (p === "") return "";
    const l = left(resetsAt, nowMs);
    return `${colorFor(Number(p))}${label}:${p}%${RESET}${l !== "" ? ` ${l}` : ""}`;
  };
  const rate = [
    windowPart(five, "5h", get(input, "rate_limits", "five_hour", "resets_at")),
    windowPart(week, "7d", get(input, "rate_limits", "seven_day", "resets_at")),
  ]
    .filter((s) => s !== "")
    .join("  ");

  let session = "";
  if (cents !== null) {
    const c = cents >= 2000 ? RED : cents >= 500 ? YELLOW : GREEN;
    const frac = String(cents % 100).padStart(2, "0");
    session = `${c}~$${Math.trunc(cents / 100)}.${frac}${RESET}`;
  }
  if (runtime !== "") session = session !== "" ? `${session} ${runtime}` : runtime;

  const line = [
    model,
    repo !== "" ? `${MAGENTA}${repo}${RESET}` : "",
    git.branch !== "" ? `${CYAN}${git.branch}${RESET}` : "",
    ctx,
    rate,
    session,
  ]
    .filter((s) => s !== "")
    .join(" | ");

  let limitsJson: string | null = null;
  const fiveH = get(input, "rate_limits", "five_hour");
  const sevenD = get(input, "rate_limits", "seven_day");
  if (truthy(fiveH) && truthy(sevenD)) {
    const win = (w: unknown) => ({
      used_percentage: get(w, "used_percentage") ?? null,
      resets_at: get(w, "resets_at") ?? null,
    });
    limitsJson = JSON.stringify({
      at: Math.floor(nowMs),
      rate_limits: { five_hour: win(fiveH), seven_day: win(sevenD) },
    });
  }
  return { line, limitsJson };
}

/** Temp file + rename so a reader never sees a half-written file. Failure is swallowed. */
function writeLimits(file: string, json: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing to clean
    }
  }
}

/** Run the user's own statusline command with the same stdin. Null when it produced nothing. */
function runWrapped(command: string, stdin: string): string | null {
  const shell = process.env.SHELL;
  try {
    const opts = { input: stdin, encoding: "utf8", windowsHide: true, maxBuffer: 1 << 20 } as const;
    const r = shell
      ? spawnSync(shell, ["-c", command], opts)
      : spawnSync(command, { ...opts, shell: true });
    return typeof r.stdout === "string" && r.stdout !== "" ? r.stdout : null;
  } catch {
    return null;
  }
}

export interface RunOptions {
  stdin: string;
  home?: string;
  nowMs?: number;
  wrap?: string | undefined;
}

/** Full run: write the limits file, then return what to print. Never throws. */
export function runStatusline(o: RunOptions): string {
  try {
    const { line, limitsJson } = renderStatusline(o.stdin, o.nowMs ?? Date.now());
    if (limitsJson !== null) writeLimits(defaultStatuslinePath(o.home ?? os.homedir()), limitsJson);
    if (o.wrap !== undefined) return runWrapped(o.wrap, o.stdin) ?? line;
    return line;
  } catch {
    return "";
  }
}

/** `--wrap <cmd>` or `--wrap=<cmd>` from the args after `statusline`. */
export function parseWrapArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--wrap") return args[i + 1];
    if (a.startsWith("--wrap=")) return a.slice("--wrap=".length);
  }
  return undefined;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  try {
    for await (const c of process.stdin) chunks.push(c as Buffer);
  } catch {
    // partial input is still rendered
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** CLI entry: args are everything after `statusline`. Always exits 0. */
export async function runStatuslineCli(args: string[]): Promise<void> {
  const out = runStatusline({ stdin: await readStdin(), wrap: parseWrapArg(args) });
  process.stdout.write(out);
}
