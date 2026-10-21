/**
 * src/query/limits/statusline-install.ts — install/uninstall `agentwrangler statusline` as Claude Code's
 * statusLine command (OV-7b).
 *
 * Writes the user's ~/.claude/settings.json, so: preview first (plan), refuse unparseable files, back up
 * before writing, write atomically, and change ONLY the `statusLine` member by splicing text — every other
 * key, its order and the file's indentation/line endings stay byte-identical, so uninstall can return the
 * original file exactly (when the original statusLine used standard JSON.stringify formatting).
 *
 * An existing statusLine command is kept, not replaced: the new command is
 *   "<node>" "<cli>" statusline --wrap '<old command>'
 * and uninstall reads the old command back out of `--wrap`.
 *
 * Invocation choice: absolute node + absolute cli path. The global `agentwrangler` bin may not be on the
 * PATH Claude Code's shell sees, and a per-refresh `npx` would be far too slow. Forward slashes are used
 * so the command is safe inside bash double quotes on Windows too. Trade-off: if node or the install
 * moves, the statusline goes blank until reinstalled (the panel then shows the file as stale).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Json = Record<string, unknown>;

export type StatuslineAction = "install" | "uninstall";

export interface StatuslinePlan {
  action: StatuslineAction;
  settingsPath: string;
  /** Current statusLine entry as pretty JSON, or null when there is none. */
  before: string | null;
  /** The entry after the change (null = key removed). */
  after: string | null;
  /** False when there is nothing to do (already installed / not installed). */
  changed: boolean;
}

export type PlanResult =
  | { ok: true; plan: StatuslinePlan }
  | { ok: false; error: string; code: "invalid" | "conflict" };

export type ApplyResult =
  | { ok: true; plan: StatuslinePlan; backupPath: string | null }
  | { ok: false; error: string; code: "invalid" | "conflict" };

export interface InstallOptions {
  settingsPath?: string;
  /** Command to install (default: statuslineCommand()). */
  command?: string;
  /** The `before` text the user was shown; a mismatch aborts (the file changed since the preview). */
  expectBefore?: string | null | undefined;
}

const MARKER = /agentwrangler(?:\.js)?["']?\s+statusline(?:\s|$)/;
const fwd = (p: string) => p.replace(/\\/g, "/");

export function defaultClaudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

/** The command the install writes: absolute node + absolute CLI path + `statusline`. */
export function statuslineCommand(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/query/limits (or src/query/limits under tsx)
  const candidates = [
    path.resolve(here, "..", "..", "cli", "agentwrangler.js"),
    path.resolve(here, "..", "..", "..", "dist", "cli", "agentwrangler.js"),
  ];
  const cli = candidates.find((c) => fs.existsSync(c)) ?? (candidates[1] as string);
  return `"${fwd(process.execPath)}" "${fwd(cli)}" statusline`;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Inverse of shellQuote; null when `s` is not exactly one quoted string in that form. */
function shellUnquote(s: string): string | null {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "'") return null;
    const end = s.indexOf("'", i + 1);
    if (end === -1) return null;
    out += s.slice(i + 1, end);
    i = end + 1;
    if (s.startsWith("\\'", i)) {
      out += "'";
      i += 2;
    } else if (i !== s.length) return null;
  }
  return i === s.length && s.length > 0 ? out : null;
}

const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const commandOf = (v: unknown): string | null =>
  isObj(v) && typeof v.command === "string" ? v.command : null;
const pretty = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v, null, 2));

// ── text splice helpers ─────────────────────────────────────────────────────

interface Member {
  key: string;
  start: number;
  valueStart: number;
  valueEnd: number;
}

/** Locate the top-level members of a JSON object text that JSON.parse already accepted. */
function scanRoot(t: string): { open: number; close: number; members: Member[] } {
  const ws = (from: number) => {
    let i = from;
    while (i < t.length && /\s/.test(t[i] as string)) i++;
    return i;
  };
  const str = (from: number) => {
    let i = from + 1;
    while (t[i] !== '"') i += t[i] === "\\" ? 2 : 1;
    return i + 1;
  };
  const value = (from: number): number => {
    const c = t[from];
    if (c === '"') return str(from);
    let i = from;
    if (c === "{" || c === "[") {
      let depth = 0;
      for (; i < t.length; i++) {
        const d = t[i];
        if (d === '"') i = str(i) - 1;
        else if (d === "{" || d === "[") depth++;
        else if ((d === "}" || d === "]") && --depth === 0) return i + 1;
      }
    }
    while (i < t.length && !/[\s,}\]]/.test(t[i] as string)) i++;
    return i;
  };
  const open = ws(0);
  const members: Member[] = [];
  let i = ws(open + 1);
  while (t[i] !== "}") {
    const start = i;
    const keyEnd = str(i);
    const key = JSON.parse(t.slice(start, keyEnd)) as string;
    i = ws(keyEnd);
    i = ws(i + 1); // ':'
    const valueStart = i;
    const valueEnd = value(i);
    members.push({ key, start, valueStart, valueEnd });
    i = ws(valueEnd);
    if (t[i] === ",") i = ws(i + 1);
  }
  return { open, close: i, members };
}

interface Loaded {
  path: string;
  /** File text without BOM ("" when the file does not exist). */
  text: string;
  bom: string;
  exists: boolean;
  obj: Json;
}

function load(settingsPath: string): { ok: true; v: Loaded } | { ok: false; error: string } {
  if (!fs.existsSync(settingsPath)) {
    return { ok: true, v: { path: settingsPath, text: "", bom: "", exists: false, obj: {} } };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (e) {
    return { ok: false, error: `Could not read ${settingsPath}: ${(e as Error).message}` };
  }
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const text = raw.slice(bom.length);
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `settings.json is not valid JSON: ${(e as Error).message}` };
  }
  if (!isObj(obj)) return { ok: false, error: "settings.json must contain a JSON object" };
  return { ok: true, v: { path: settingsPath, text, bom, exists: true, obj } };
}

/** Rewrite the statusLine member of `l.text` to `next` (undefined = remove). */
function splice(l: Loaded, next: unknown): string {
  if (!l.exists) return `${JSON.stringify({ statusLine: next }, null, 2)}\n`;
  const t = l.text;
  const eol = t.includes("\r\n") ? "\r\n" : "\n";
  const { open, close, members } = scanRoot(t);
  const idx = members.map((m) => m.key).lastIndexOf("statusLine");
  const first = members[0];
  const lineStart = first ? t.lastIndexOf("\n", first.start) + 1 : 0;
  const lead = first ? t.slice(lineStart, first.start) : "";
  const indent = first && /^[ \t]*$/.test(lead) ? lead : "  ";
  const unit = indent.includes("\t") ? "\t" : indent;
  const fmt = (v: unknown, base: string) =>
    JSON.stringify(v, null, unit).split("\n").join(`${eol}${base}`);

  if (idx !== -1) {
    const m = members[idx] as Member;
    if (next !== undefined) {
      const ls = t.lastIndexOf("\n", m.start) + 1;
      const lm = t.slice(ls, m.start);
      return (
        t.slice(0, m.valueStart) +
        fmt(next, /^[ \t]*$/.test(lm) ? lm : indent) +
        t.slice(m.valueEnd)
      );
    }
    if (idx > 0) return t.slice(0, (members[idx - 1] as Member).valueEnd) + t.slice(m.valueEnd);
    if (members.length > 1) return t.slice(0, m.start) + t.slice((members[1] as Member).start);
    return `${t.slice(0, open + 1)}${t.slice(close)}`;
  }
  if (next === undefined) return t;
  const member = `"statusLine": ${fmt(next, indent)}`;
  const last = members[members.length - 1];
  if (last) return `${t.slice(0, last.valueEnd)},${eol}${indent}${member}${t.slice(last.valueEnd)}`;
  return `${t.slice(0, open + 1)}${eol}${indent}${member}${eol}${t.slice(close)}`;
}

// ── plan / apply ────────────────────────────────────────────────────────────

interface Computed {
  plan: StatuslinePlan;
  loaded: Loaded;
  next: unknown; // undefined = remove key
}

function compute(
  action: StatuslineAction,
  o: InstallOptions,
): { ok: true; c: Computed } | { ok: false; error: string; code: "invalid" } {
  const settingsPath = o.settingsPath ?? defaultClaudeSettingsPath();
  const r = load(settingsPath);
  if (!r.ok) return { ok: false, error: r.error, code: "invalid" };
  const cur = r.v.obj.statusLine;
  const curCmd = commandOf(cur);
  const installed = curCmd !== null && MARKER.test(curCmd);
  const base = { action, settingsPath, before: pretty(cur) };
  const done = (next: unknown, changed: boolean): { ok: true; c: Computed } => ({
    ok: true,
    c: {
      plan: { ...base, after: changed ? pretty(next) : base.before, changed },
      loaded: r.v,
      next,
    },
  });

  if (action === "install") {
    if (installed) return done(cur, false);
    const cmd = o.command ?? statuslineCommand();
    if (cur === undefined) return done({ type: "command", command: cmd }, true);
    if (curCmd === null) {
      return {
        ok: false,
        error: "settings.json has a statusLine entry without a command; not changing it",
        code: "invalid",
      };
    }
    return done({ ...(cur as Json), command: `${cmd} --wrap ${shellQuote(curCmd)}` }, true);
  }

  if (!installed) return done(cur, false);
  const at = (curCmd as string).indexOf(" --wrap ");
  if (at === -1) return done(undefined, true);
  const old = shellUnquote((curCmd as string).slice(at + " --wrap ".length));
  if (old === null) {
    return {
      ok: false,
      error: "Could not read the wrapped command back from statusLine; edit settings.json by hand",
      code: "invalid",
    };
  }
  return done({ ...(cur as Json), command: old }, true);
}

export function planStatusline(action: StatuslineAction, o: InstallOptions = {}): PlanResult {
  const r = compute(action, o);
  return r.ok ? { ok: true, plan: r.c.plan } : { ok: false, error: r.error, code: r.code };
}

export function isStatuslineInstalled(settingsPath: string = defaultClaudeSettingsPath()): boolean {
  const r = load(settingsPath);
  const cmd = r.ok ? commandOf(r.v.obj.statusLine) : null;
  return cmd !== null && MARKER.test(cmd);
}

let backupSeq = 0;

export function applyStatusline(action: StatuslineAction, o: InstallOptions = {}): ApplyResult {
  const r = compute(action, o);
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  const { plan, loaded, next } = r.c;
  if (o.expectBefore !== undefined && o.expectBefore !== plan.before) {
    return {
      ok: false,
      error: "settings.json changed since the preview; review the new preview and confirm again",
      code: "conflict",
    };
  }
  if (!plan.changed) return { ok: true, plan, backupPath: null };
  try {
    let backupPath: string | null = null;
    fs.mkdirSync(path.dirname(loaded.path), { recursive: true });
    if (loaded.exists) {
      const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(++backupSeq).padStart(3, "0")}`;
      backupPath = `${loaded.path}.aw-statusline-backup-${stamp}`;
      fs.copyFileSync(loaded.path, backupPath);
    }
    const tmp = `${loaded.path}.aw-tmp-${process.pid}`;
    fs.writeFileSync(tmp, loaded.bom + splice(loaded, next));
    fs.renameSync(tmp, loaded.path);
    return { ok: true, plan, backupPath };
  } catch (e) {
    return {
      ok: false,
      error: `Could not write settings.json: ${(e as Error).message}`,
      code: "invalid",
    };
  }
}
