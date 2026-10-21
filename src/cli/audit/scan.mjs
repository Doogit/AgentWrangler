// Standalone, read-only, bounded scanner over Claude Code JSONL transcripts.
// Generated into an audit folder by `agentwrangler audit`. No dependencies (Node built-ins only).
// Usage:
//   node scan.mjs first-prompts [--since ISO] [--limit N] [--root DIR]
//   node scan.mjs listings [--limit N] [--root DIR]
//   node scan.mjs hooks [--limit N] [--root DIR] [--settings a.json,b.json]
//   node scan.mjs session <id> [--root DIR]
// Output: one compact JSON object per line (at most MAX_OUT_LINES lines).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_ROOT = "__AW_JSONL_ROOT__";
// Comma-separated settings files baked in at generation (empty = ~/.claude + each session cwd).
const DEFAULT_SETTINGS = "__AW_SETTINGS__";
const MAX_FILES = 1500;
const MAX_BYTES_PER_FILE = 6 * 1024 * 1024;
const MAX_OUT_LINES = 300;
const MAX_SCAN_MS = 60_000;

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const root = flag("root", DEFAULT_ROOT);
const limit = Math.max(1, Number.parseInt(flag("limit", "50"), 10) || 50);
const started = Date.now();

let outLines = 0;
let truncated = false;
function emit(obj) {
  if (outLines >= MAX_OUT_LINES) {
    truncated = true;
    return;
  }
  outLines++;
  console.log(JSON.stringify(obj));
}
function finish() {
  if (truncated)
    console.log(JSON.stringify({ note: `output truncated at ${MAX_OUT_LINES} lines` }));
}

/** Top-level session files: <root>/<workspace>/<sessionId>.jsonl, newest first, bounded. */
function listSessionFiles() {
  const files = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return files;
  }
  for (const d of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, d.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const p = path.join(root, d.name, e.name);
      try {
        files.push({ p, id: e.name.slice(0, -6), mtime: fs.statSync(p).mtimeMs });
      } catch {
        /* skip */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, MAX_FILES);
}

/** Parsed records of one file, reading at most MAX_BYTES_PER_FILE (partial last line dropped). */
function* records(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, MAX_BYTES_PER_FILE);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    let text = buf.toString("utf8");
    if (size > len) text = text.slice(0, text.lastIndexOf("\n") + 1);
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* unreadable */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const timeUp = () => Date.now() - started > MAX_SCAN_MS;
const clip = (s, n) => (typeof s === "string" ? (s.length > n ? `${s.slice(0, n)}...` : s) : s);
const bytes = (v) => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v ?? ""), "utf8");

function typedPromptText(r) {
  if (r.type !== "user" || r.isSidechain === true) return null;
  if (r.promptSource !== undefined && r.promptSource !== "typed") return null;
  const c = r.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    if (c.some((b) => b?.type === "tool_result")) return null;
    const t = c
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("\n");
    return t || null;
  }
  return null;
}

function firstPrompts() {
  const since = flag("since", "");
  const rows = [];
  for (const f of listSessionFiles()) {
    if (timeUp()) break;
    for (const r of records(f.p)) {
      const text = typedPromptText(r);
      if (text === null || text.trim() === "" || text.startsWith("<")) continue;
      if (since && String(r.timestamp) < since) break;
      rows.push({
        session: r.sessionId ?? f.id,
        ts: r.timestamp,
        cwd: r.cwd,
        gitBranch: r.gitBranch,
        prompt: clip(text.replace(/\s+/g, " ").trim(), 300),
      });
      break;
    }
  }
  rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  for (const r of rows.slice(0, limit)) emit(r);
}

function listings() {
  const LIST = new Set([
    "skill_listing",
    "agent_listing_delta",
    "deferred_tools_delta",
    "mcp_instructions_delta",
    "nested_memory",
  ]);
  let n = 0;
  for (const f of listSessionFiles()) {
    if (n >= limit || timeUp()) break;
    const per = {};
    for (const r of records(f.p)) {
      const a = r.type === "attachment" ? r.attachment : null;
      if (!a || !LIST.has(a.type)) continue;
      const e = per[a.type] ?? { count: 0, bytes: 0 };
      per[a.type] = e;
      e.count++;
      e.bytes += bytes(a);
      if (a.type === "skill_listing") {
        e.skillCount = Math.max(e.skillCount ?? 0, a.skillCount ?? 0);
        e.names = (a.names ?? []).slice(0, 60);
      } else if (a.type === "agent_listing_delta") {
        e.addedTypes = [...new Set([...(e.addedTypes ?? []), ...(a.addedTypes ?? [])])].slice(
          0,
          40,
        );
      } else if (a.type === "deferred_tools_delta") {
        e.addedCount = (e.addedCount ?? 0) + (a.addedNames?.length ?? 0);
      } else if (a.type === "mcp_instructions_delta") {
        e.servers = [...new Set([...(e.servers ?? []), ...(a.addedNames ?? [])])].slice(0, 20);
      } else if (a.type === "nested_memory") {
        e.paths = [...new Set([...(e.paths ?? []), a.path ?? a.displayPath])].slice(0, 20);
      }
    }
    if (Object.keys(per).length === 0) continue;
    n++;
    emit({ session: f.id, listings: per });
  }
}

const SCRIPT_EXT = /\.(?:c?m?js|ts|sh|ps1|py|bat|cmd)$/i;

/** Script/executable paths a hook command refers to (best effort, no shell parsing beyond quotes). */
function referencedPaths(command, cwd) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(command); m !== null; m = re.exec(command))
    tokens.push(m[1] ?? m[2] ?? m[3]);
  const found = [];
  for (let t of tokens) {
    const drive = t.search(/[A-Za-z]:[\\/]/);
    if (drive > 0) t = t.slice(drive); // "nodeC:\x.mjs" typo -> C:\x.mjs
    const looksPath =
      drive >= 0 ||
      t.startsWith("/") ||
      t.startsWith("~") ||
      t.startsWith("./") ||
      t.startsWith("../") ||
      SCRIPT_EXT.test(t);
    // Skip flags, shell syntax (pipes, subshells, regex) and device paths: they are not script paths.
    if (!looksPath || t.startsWith("-") || /[|;&<>()`=*?^]\S|^\/dev\//.test(t) || /['"]/.test(t))
      continue;
    let p = t
      .replace(/^~(?=[\\/]|$)/, os.homedir())
      .replace(/\$\{?HOME\}?/g, os.homedir())
      .replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, cwd ?? "");
    if (/[$%]/.test(p)) continue; // unresolved variable: cannot check statically
    if (!path.isAbsolute(p)) {
      if (!cwd) continue;
      p = path.resolve(cwd, p);
    }
    found.push(p);
  }
  return found;
}

function staticHookCheck(settingsFiles, cwdOf) {
  for (const sf of settingsFiles) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(sf, "utf8"));
    } catch {
      continue;
    }
    const cwd = cwdOf(sf);
    for (const [event, groups] of Object.entries(json.hooks ?? {})) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of g.hooks ?? []) {
          if (typeof h?.command !== "string") continue;
          for (const p of referencedPaths(h.command, cwd)) {
            if (!fs.existsSync(p)) {
              emit({
                kind: "missing-hook-path",
                settings: sf,
                event,
                command: clip(h.command, 200),
                missing: p,
              });
            }
          }
        }
      }
    }
  }
}

function hooks() {
  const agg = new Map();
  const errors = new Map();
  const repeats = new Map();
  const cwds = new Set();
  for (const f of listSessionFiles()) {
    if (timeUp()) break;
    for (const r of records(f.p)) {
      if (r.cwd) cwds.add(r.cwd);
      const a = r.type === "attachment" ? r.attachment : null;
      if (!a) continue;
      if (a.type === "hook_success") {
        const k = `${a.hookEvent}|${a.hookName}`;
        const e = agg.get(k) ?? {
          hookEvent: a.hookEvent,
          hookName: a.hookName,
          runs: 0,
          totalMs: 0,
          maxMs: 0,
          nonZeroExit: 0,
        };
        e.runs++;
        e.totalMs += a.durationMs ?? 0;
        e.maxMs = Math.max(e.maxMs, a.durationMs ?? 0);
        if ((a.exitCode ?? 0) !== 0) e.nonZeroExit++;
        agg.set(k, e);
      } else if (a.type === "hook_non_blocking_error") {
        const k = `${f.id}|${a.command}`;
        const e = errors.get(k) ?? {
          session: f.id,
          hookName: a.hookName,
          command: clip(a.command, 200),
          stderr: clip((a.stderr ?? "").replace(/\s+/g, " "), 200),
          count: 0,
        };
        e.count++;
        errors.set(k, e);
      } else if (a.type === "hook_system_message" || a.type === "hook_additional_context") {
        const text = typeof a.content === "string" ? a.content : JSON.stringify(a.content ?? "");
        const k = `${f.id}|${a.type}|${a.hookName}|${text.slice(0, 120)}`;
        const e = repeats.get(k) ?? {
          session: f.id,
          type: a.type,
          hookName: a.hookName,
          sample: clip(text.replace(/\s+/g, " "), 120),
          count: 0,
        };
        e.count++;
        repeats.set(k, e);
      }
    }
  }
  for (const e of [...agg.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, limit)) {
    emit({ kind: "hook-runs", ...e, avgMs: Math.round(e.totalMs / e.runs) });
  }
  for (const e of [...errors.values()].sort((a, b) => b.count - a.count).slice(0, limit)) {
    emit({ kind: "hook-non-blocking-error", ...e });
  }
  for (const e of [...repeats.values()]
    .filter((x) => x.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)) {
    emit({ kind: "hook-message-repeat", ...e });
  }
  const given = flag("settings", DEFAULT_SETTINGS);
  const settingsFiles = given
    ? given.split(",").filter(Boolean)
    : [
        path.join(os.homedir(), ".claude", "settings.json"),
        ...[...cwds].slice(0, 20).map((c) => path.join(c, ".claude", "settings.json")),
      ];
  staticHookCheck(settingsFiles, (sf) => {
    const dir = path.dirname(path.dirname(sf));
    return path.basename(path.dirname(sf)) === ".claude" ? dir : undefined;
  });
}

function session() {
  const id = argv[1];
  if (!id || id.startsWith("--")) {
    console.error("usage: node scan.mjs session <id>");
    process.exit(2);
  }
  const f = listSessionFiles().find((x) => x.id === id);
  if (!f) {
    emit({ error: `session ${id} not found under ${root}` });
    return;
  }
  let n = 0;
  for (const r of records(f.p)) {
    if (r.type !== "assistant") continue;
    n++;
    const u = r.message?.usage ?? {};
    const tools = (Array.isArray(r.message?.content) ? r.message.content : [])
      .filter((b) => b?.type === "tool_use")
      .map((b) => b.name);
    emit({
      turn: n,
      ts: r.timestamp,
      model: r.message?.model,
      sidechain: r.isSidechain === true,
      in: u.input_tokens ?? 0,
      out: u.output_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      tools,
    });
  }
}

const commands = { "first-prompts": firstPrompts, listings, hooks, session };
if (!commands[cmd]) {
  console.error("usage: node scan.mjs <first-prompts|listings|hooks|session> [options]");
  process.exit(2);
}
commands[cmd]();
finish();
