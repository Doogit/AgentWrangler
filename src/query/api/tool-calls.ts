/**
 * Oversized tool calls behind a tool-result card, read back from the session transcripts.
 *
 * `tool_events` keeps only result sizes; the call's input (file, command, URL, pattern) is in the
 * transcript's `tool_use` block whose id is the event id. Subagent events are stored under the
 * parent session, so its `<transcript>/subagents/**.jsonl` files are searched too. What each call ran
 * on is cached by event id: transcripts are append-only and a call's input never changes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "../../db/open.js";
import { A1_RESULT_BYTES_THRESHOLD } from "../../detector/detectors/a1_tool_result_bloat.js";
import { C2_NOT_FOUND_WHERE } from "../../detector/detectors/c2_content_not_found.js";
import { mechanicalRuns } from "../../detector/detectors/e2_main_thread_mechanical_runs.js";
import { destructiveRuns } from "../../detector/detectors/h1_destructive_operations.js";
import { findingIds } from "../../detector/privacy-contract.js";
import { createResultCarry } from "../../detector/result-claims.js";
import { C9_DENIAL_WHERE, FAILED_STEP_LINE, d11Outcome } from "../../detector/turn-claim.js";
import {
  classifyDestructiveOp,
  drivePath,
  isDisposablePath,
  shellSegments,
} from "../../ingest/destructive.js";
import { RESULT_CAPS } from "./rec-actions/card-rules.js";
import { displayPath } from "./rec-actions/families/context.js";
import { D6_TARGET_EVENTS, JOB_SCRATCH_TMP, missingCommand } from "./rec-actions/trigger.js";
import type { CardToolCall, GuardShape } from "./rec-actions/types.js";

/** Largest events looked up per card; bounds the transcript reads. */
const MAX_EVENTS = 300;
const TARGET_CACHE_LIMIT = 10_000;

/** Longest command or result shown; a longer command is cut between its chained parts. */
const MAX_TEXT = 400;
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);
const HOOK_PREFIX = /^PreToolUse:\S+ hook error:\s*/i;

type ToolInput = Record<string, unknown>;
export type CallTarget = Pick<CardToolCall, "target" | "kind" | "whole_file"> &
  Partial<Pick<CardToolCall, "tool" | "result" | "risk" | "guard_shape">> & {
    /** A Read right before or after an edit of the same file: needed, not a repeat to fix. */
    beside_edit?: boolean;
    /** The path the call named, as written (the target drops a worktree segment). */
    path?: string;
    /** Found in a subagent's transcript: its result leaves context when the subagent ends. */
    in_subagent?: boolean;
    /** What a URL call returned, hashed: a page that changed between reads is not a repeat. */
    result_hash?: string;
  };
/**
 * Event id (raw, or an anchor's hashed `eid_…`) → what the call ran on; null when its input is in
 * no transcript.
 */
const targetCache = new Map<string, CallTarget | null>();

interface EventRow {
  event_id: string;
  session_id: string;
  tool_name: string;
  result_bytes: number;
  file_path: string | null;
}

function transcriptFiles(file: string): string[] {
  const files = [file];
  try {
    const dir = file.replace(/\.jsonl$/, "");
    for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
      if (entry.endsWith(".jsonl")) files.push(path.join(dir, entry));
    }
  } catch {
    // No subagent folder.
  }
  return files;
}

function inputFromLine(line: string, id: string): ToolInput | null {
  try {
    const content = JSON.parse(line)?.message?.content;
    if (!Array.isArray(content)) return null;
    for (const block of content) {
      if (block?.type === "tool_use" && block.id === id && typeof block.input === "object") {
        return block.input as ToolInput;
      }
    }
  } catch {
    // Partial or malformed line.
  }
  return null;
}

function resolveTargets(events: EventRow[]): void {
  const pending = new Map<string, Map<string, string>>();
  for (const event of events) {
    if (targetCache.has(event.event_id) || event.file_path === null) continue;
    const ids = pending.get(event.file_path) ?? new Map<string, string>();
    ids.set(event.event_id, event.tool_name);
    pending.set(event.file_path, ids);
  }
  if (targetCache.size > TARGET_CACHE_LIMIT) targetCache.clear();
  for (const [file, ids] of pending) {
    for (const transcript of transcriptFiles(file)) {
      if (ids.size === 0) break;
      let text: string;
      try {
        text = readFileSync(transcript, "utf8");
      } catch {
        continue;
      }
      const touches = new Map<string, Array<Record<string, unknown>>>();
      for (const [id, tool] of [...ids]) {
        const at = text.indexOf(`"id":"${id}"`);
        if (at < 0) continue;
        const start = text.lastIndexOf("\n", at) + 1;
        const end = text.indexOf("\n", at);
        const input = inputFromLine(text.slice(start, end < 0 ? undefined : end), id);
        if (input === null) continue;
        const call = describe(tool, input);
        if (transcript !== file) call.in_subagent = true;
        const hash = call.kind === "url" ? resultHash(text, id) : undefined;
        if (hash !== undefined) call.result_hash = hash;
        if (tool === "Read" && typeof input.file_path === "string") {
          call.beside_edit = besideEdit(text, id, input.file_path, touches);
        }
        targetCache.set(id, call);
        ids.delete(id);
      }
    }
    for (const id of ids.keys()) targetCache.set(id, null);
  }
}

/** A hash of what the call returned, or undefined when its result is not in this transcript. */
function resultHash(text: string, id: string): string | undefined {
  for (const line of linesWith([text], `"tool_use_id":"${id}"`)) {
    const block = contentBlocks(line).find(
      (item) => item.type === "tool_result" && item.tool_use_id === id,
    );
    if (block !== undefined) {
      return createHash("sha256").update(JSON.stringify(block.content)).digest("hex");
    }
  }
  return undefined;
}

/**
 * Whether the call on `file` just before or after this Read is an edit (as D7 counts a re-read only
 * with no edit between). Cached with the read, so an edit written after the lookup is not seen.
 */
function besideEdit(
  text: string,
  id: string,
  file: string,
  touches: Map<string, Array<Record<string, unknown>>>,
): boolean {
  let calls = touches.get(file);
  if (calls === undefined) {
    calls = [];
    for (const line of new Set(linesWith([text], `"file_path":${JSON.stringify(file)}`))) {
      for (const block of contentBlocks(line)) {
        if (block.type === "tool_use" && (block.input as ToolInput)?.file_path === file) {
          calls.push(block);
        }
      }
    }
    touches.set(file, calls);
  }
  const at = calls.findIndex((block) => block.id === id);
  return [calls[at - 1], calls[at + 1]].some(
    (block) => at >= 0 && EDIT_TOOLS.has(String(block?.name)),
  );
}

/** The same file in a worktree and in the main checkout is one file. */
function canonicalPath(filePath: string): string {
  return displayPath(
    filePath.replace(/[\\/](?:\.claude[\\/])?\.?worktrees[\\/][^\\/]+(?=[\\/])/, ""),
  );
}

function oneLine(value: string, max = 120): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const CHAIN = /( && | \|\| |; | \| )/;

/**
 * A command on one line; one too long to show is cut between chained parts, never inside one. A
 * destructive part past the cut is shown instead, so the example shows why it was flagged.
 */
export function commandText(command: string): string {
  const line = command.replace(/\s+/g, " ").trim();
  if (line.length <= MAX_TEXT) return line;
  const head = line.slice(0, MAX_TEXT);
  const cut = Math.max(...[" && ", " || ", "; ", " | "].map((sep) => head.lastIndexOf(sep)));
  const shown = line.slice(0, cut > 0 ? cut : head.lastIndexOf(" "));
  const parts = line.split(CHAIN).filter((part, i) => i % 2 === 0);
  const risky = parts.find((part) => classifyDestructiveOp(part) !== null && !shown.includes(part));
  if (risky === undefined) return `${shown} …`;
  const at = line.indexOf(risky);
  const excerpt = line.slice(at, at + MAX_TEXT);
  return `… ${excerpt}${at + MAX_TEXT < line.length ? " …" : ""}`;
}

/**
 * A path an `rm -rf` names that may reach past the project: a variable, a home, absolute or parent
 * path, a wildcard or the whole folder.
 */
const RISKY_RM_PATH =
  /[$%`~]|^[\\/]|^[a-z]:|(?:^|[\\/])\.\.(?:[\\/]|$)|^\.[\\/]?$|^(?:\.[\\/])?\*/i;

/**
 * Whether an absolute path is one the operator treats as safe to delete (2026-09-26, review 3 B2):
 * strictly inside the session's working directory. A parent (`..`) step is never safe.
 */
function safeAbsolutePath(path: string, cwd: string | undefined): boolean {
  const target = drivePath(path);
  if (/(?:^|\/)\.\.(?:\/|$)/.test(target)) return false;
  return cwd !== undefined && target.startsWith(`${drivePath(cwd)}/`);
}

/**
 * How risky an `rm -rf` is by what it deletes (review 2 H1a): LOW when every path is relative and
 * inside the project, an absolute path inside the working directory `cwd` (review 3 B2), or a
 * session scratchpad or Temp folder (card review F6); RISKY otherwise, also when no path is named.
 * A variable set earlier in the same command (`SP=…; rm -rf "$SP/x"`) is resolved first. The
 * command is split as the H1 classifier splits it. Null with no recursive `rm`.
 */
export function rmRisk(command: string, cwd?: string): "LOW" | "RISKY" | null {
  return rmScan(command, cwd).risk;
}

/** The paths of a recursive `rm` that made it RISKY, with the command's own variables resolved. */
export function rmRiskyPaths(command: string, cwd?: string): string[] {
  return rmScan(command, cwd).paths;
}

function rmScan(command: string, cwd?: string): { risk: "LOW" | "RISKY" | null; paths: string[] } {
  let risk: "LOW" | "RISKY" | null = null;
  const vars = new Map<string, string>();
  for (const segment of shellSegments(command)) {
    const words = segment[0] === "export" ? segment.slice(1) : segment;
    const assigned = words.length === 1 ? /^([A-Za-z_]\w*)=(.*)$/s.exec(words[0] ?? "") : null;
    if (assigned?.[1] !== undefined && assigned[2] !== undefined) {
      vars.set(assigned[1], assigned[2]);
      continue;
    }
    const at = words.indexOf("rm");
    if (at < 0) continue;
    const flags = words.slice(at + 1).filter((word) => word.startsWith("-"));
    // `rm -r` is rated too (review 3 B2), though the detector now counts only `-r` with `-f` (F6).
    if (!flags.some((flag) => /^-[^-]*r|^--recursive$/i.test(flag))) continue;
    const paths = words
      .slice(at + 1)
      .filter((word) => !word.startsWith("-") && !/^\d*>/.test(word))
      .map((word) =>
        word.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, a, b) => vars.get(a ?? b) ?? whole),
      );
    const risky = (path: string): boolean =>
      isDisposablePath(path)
        ? false
        : /^[\\/]|^[a-z]:/i.test(path)
          ? !safeAbsolutePath(path, cwd)
          : RISKY_RM_PATH.test(path);
    if (paths.length === 0 || paths.some(risky))
      return { risk: "RISKY", paths: paths.filter(risky) };
    risk = "LOW";
  }
  return { risk, paths: [] };
}

/** An edit in a `python -c` script: a file opened to write, a write, or a delete or move. */
const PYTHON_WRITES =
  /open\([^)]*['"][wax]\+?b?['"]|\.write\(|write_text|write_bytes|os\.(?:remove|unlink|rename|replace)|shutil\./;

/**
 * A shell that runs its quoted argument (`bash -c`, `sh -c`, `eval`, `ssh <host>`,
 * `pwsh`/`powershell -Command`/`-c`): that argument is not a harmless quoted literal (review 5 M5).
 */
const EXECUTING_CARRIER_BEFORE =
  /\b(?:bash|sh)\s+-c\s+$|\b(?:pwsh|powershell)\s+(?:-Command|-c)\s+$|\beval\s+$|\bssh\s+\S+\s+$/i;

/**
 * `command` with every single- or double-quoted string blanked out, except one that contains a
 * `$(` (its content can still run) or is the argument an executing carrier runs (review 5 M5): a
 * `python -c` match that survives only inside such a string is a false positive (QUOTED_PATTERN).
 */
function stripQuotedLiterals(command: string): string {
  return command.replace(/"[^"]*"|'[^']*'/g, (match: string, offset: number) => {
    if (match.includes("$(")) return match;
    if (EXECUTING_CARRIER_BEFORE.test(command.slice(0, offset))) return match;
    return " ";
  });
}

/** The shapes a command-shape guard exists to stop, checked first: any one makes the block correct. */
const CORRECT_SHAPES: Array<[GuardShape, (command: string, head: string) => boolean]> = [
  ["CD_PREFIX", (c) => /(?:^|&&|\|\||;)\s*cd\s+[^;&|\n]*&&/.test(c)],
  [
    "IN_PLACE_EDIT",
    (c) =>
      /\bsed\s+(?:-[^\si]+\s+)*-\w*i/.test(c) ||
      /\bperl\s+-\w*i/.test(c) ||
      (/\bpython3?\s+-c\b/.test(c) && PYTHON_WRITES.test(c)),
  ],
  // A heredoc written to a file: `cat >> f <<'EOF'` or `cat <<EOF > f` on the heredoc's line.
  [
    "HEREDOC_FILE",
    (_, head) => /<</.test(head) && /(?<![\d&])>>?\s*(?!\/dev\/null)[^\s&|;>]/.test(head),
  ],
  // U9 r7: a heredoc feeding a command (`git commit -F - <<'EOF'`) is what the rule forbids too.
  ["HEREDOC_STDIN", (_, head) => /<<-?\s*['"]?\w+/.test(head)],
  ["TMP_WRITE", (c) => /(?:^|[\s'"=])\/tmp\//.test(c)],
  [
    "DESTRUCTIVE_GIT",
    (c) => /\bgit\s+(?:-C\s+\S+\s+)?(?:reset\s+--hard|clean\b|stash\s+(?:push\s+)?-u)/.test(c),
  ],
];
const FALSE_POSITIVE_SHAPES: Array<[GuardShape, (command: string, head: string) => boolean]> = [
  // Checked before PYTHON_READ (review 5 M5): the match only survives inside a quoted argument.
  [
    "QUOTED_PATTERN",
    (c) => /\bpython3?\s+-c\b/.test(c) && !/\bpython3?\s+-c\b/.test(stripQuotedLiterals(c)),
  ],
  ["PYTHON_READ", (c) => /\bpython3?\s+-c\b/.test(c)],
  ["GIT_STASH_READ", (c) => /\bgit\s+(?:-C\s+\S+\s+)?stash\s+(?:list|show)\b/.test(c)],
  // U7: a job scratch directory (`…/tmp/…`, or an unexpanded `$CLAUDE_JOB_DIR/tmp`) is not a bare `/tmp`.
  ["SCRATCH_TMP", (c) => SCRATCH_TMP_PATH.test(c)],
];

/** The job scratch `tmp` folder, the one folder the `/tmp` fix lets through (any other `tmp` stays blocked). */
const SCRATCH_TMP_PATH = new RegExp(JOB_SCRATCH_TMP.source, "i");
/** `<<` that only appears inside a quoted literal, such as a grep pattern: not a heredoc. */
const quotedOnlyHeredoc = (c: string): boolean =>
  c.includes("<<") && !stripQuotedLiterals(c).includes("<<");

/**
 * PowerShell guard blocks have their own shapes (U7), tested before the Bash ones. The first two
 * are what the guards exist to stop; the last two are false positives.
 */
const POWERSHELL_SHAPES: Array<[GuardShape, (command: string) => boolean]> = [
  ["TMP_WRITE", (c) => /(?:^|[\s'"=])\/tmp\//.test(c)],
  [
    "WORKTREE_REMOVE",
    (c) =>
      /\bgit\s+(?:-C\s+\S+\s+)?worktree\s+(?:remove|prune)\b/i.test(c) ||
      /\bRemove-Item\b[^\n]*[\\/]\.worktrees\b/i.test(c),
  ],
  // `node -e` is what the guard stops; its pattern also matches a PowerShell parameter after `node`.
  [
    "PS_NODE_FLAG",
    (c) => /\bnode(?:\.exe)?\s+-e[a-z]/i.test(c) && !/\bnode(?:\.exe)?\s+-e(?![\w-])/i.test(c),
  ],
  ["PS_SCRATCH_TMP", (c) => SCRATCH_TMP_PATH.test(c)],
];

/**
 * The shape a PreToolUse guard blocked (review 2 C9g2): a shape guards exist to stop when the
 * command has one, else a known false positive, else OTHER. PowerShell has its own shapes.
 */
export function guardShape(command: string, tool = "Bash"): GuardShape {
  if (tool === "PowerShell") {
    // The PowerShell guard also stops `python -c`, a `cd … &&` prefix and the like: those fall through.
    const own = POWERSHELL_SHAPES.find(([, test]) => test(command));
    if (own !== undefined) return own[0];
  }
  const heredocLine = command.split("\n").find((line) => line.includes("<<")) ?? "";
  const head = quotedOnlyHeredoc(command) ? "" : heredocLine;
  const early = CORRECT_SHAPES.find(([, test]) => test(command, head));
  if (early !== undefined) return early[0];
  if (quotedOnlyHeredoc(command) && !/\bpython3?\s+-c\b/.test(command)) return "QUOTED_HEREDOC";
  const hit = FALSE_POSITIVE_SHAPES.find(([, test]) => test(command, head));
  return hit?.[0] ?? "OTHER";
}

/** Text on one line, cut between words when too long. */
function firstWords(value: string, max: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.lastIndexOf(" ", max - 1);
  return `${line.slice(0, cut > 0 ? cut : max - 1)}…`;
}

/**
 * One page, one target: host case, a `#fragment`, a trailing slash or `.md`/`.html`, and a doubled
 * path segment (`/docs/en/docs/…`, a docs redirect alias) do not make a different page.
 */
function canonicalUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const seen = new Set<string>();
  const parts = parsed.pathname
    .replace(/\.(md|html?)$/i, "")
    .split("/")
    .filter((part) => part !== "" && !seen.has(part) && seen.add(part));
  return `${parsed.origin}/${parts.join("/")}${parsed.search}`;
}

/** Tools whose first word after the program names what the command does. */
const SUBCOMMAND_TOOLS = new Set(["git", "npm", "npx", "pnpm", "yarn", "gh", "docker", "cargo"]);
const LOCATION_COMMANDS = new Set(["cd", "set-location", "sl", "pushd", "push-location"]);
/** Options that take the next word as their value (`git -C <dir> diff`). */
const VALUE_OPTIONS = new Set(["-C", "-c"]);

/** "git diff" for `git -C x --no-pager diff main`, "cat" for `cat big.log`. */
export function shellFamily(command: string): string {
  const parts = command.trim().split(/\s*(?:&&|\|\||;|\|)\s+|\s*\n\s*/);
  const words = (part: string): string[] =>
    (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).filter((word) => !/^\w+=/.test(word));
  // A leading `cd <dir>` (or `Set-Location`, or a `$x = …` / `X=…` assignment) says where, not what.
  const setup = (part: string): boolean =>
    words(part).length === 0 ||
    LOCATION_COMMANDS.has((words(part)[0] ?? "").toLowerCase()) ||
    /^\$\w+\s*=/.test(part.trim());
  const first = parts.find((part) => !setup(part)) ?? parts[0];
  const [program = "", ...rest] = words(first ?? "");
  const name = path.basename(program.replace(/^["']|["']$/g, "")).replace(/\.(exe|cmd)$/i, "");
  if (!SUBCOMMAND_TOOLS.has(name)) return name;
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i] ?? "";
    if (VALUE_OPTIONS.has(word)) i += 1;
    else if (!word.startsWith("-")) return `${name} ${word}`;
  }
  return name;
}

function describe(tool: string, input: ToolInput): CallTarget {
  const file = input.file_path ?? input.notebook_path;
  if (typeof file === "string") {
    return {
      target: canonicalPath(file),
      kind: "file",
      whole_file: tool === "Read" && input.offset == null && input.limit == null,
    };
  }
  const whole_file = false;
  if (typeof input.command === "string") {
    return { target: commandText(input.command), kind: "command", whole_file };
  }
  if (typeof input.url === "string") {
    return { target: canonicalUrl(input.url), kind: "url", whole_file };
  }
  if (typeof input.pattern === "string") {
    const where = typeof input.path === "string" ? ` in ${canonicalPath(input.path)}` : "";
    return { target: oneLine(`${input.pattern}${where}`), kind: "search", whole_file };
  }
  if (typeof input.query === "string") {
    return { target: oneLine(input.query), kind: "search", whole_file };
  }
  return { target: oneLine(`${tool} ${JSON.stringify(input)}`), kind: "other", whole_file };
}

/**
 * The oversized calls of every tool in a workspace and window, grouped by target (shell calls
 * by command family): by re-send cost, repeated first on a tie. Calls whose input is not in any
 * transcript, reads next to an edit of the same file, results cut at the tool's cap, and pages
 * that changed between reads are left out. Every group is returned so the card can total them;
 * the card lists only the first few.
 */
export function oversizedToolCalls(
  db: Db,
  scope: { workspaceId: string; from: string; to: string },
): CardToolCall[] {
  return oversizedCallGroups(db, scope).map(({ event_ids, ...call }) => call);
}

/** `oversizedToolCalls` with each group's raw `tool_events` ids, for pricing the lead (R6-03). */
export function oversizedCallGroups(
  db: Db,
  scope: { workspaceId: string; from: string; to: string },
): Array<CardToolCall & { event_ids: string[] }> {
  const events = db
    .prepare(
      `SELECT e.event_id, e.session_id, e.ts, e.tool_name, e.result_bytes, s.file_path,
              m.owner_message_id
         FROM tool_events e JOIN sessions s ON s.session_id = e.session_id
         LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
        WHERE s.workspace_id = ? AND e.ts >= ? AND e.ts < ? AND e.result_bytes > ?
        ORDER BY e.result_bytes DESC, e.event_id ASC
        LIMIT ${MAX_EVENTS}`,
    )
    .all(scope.workspaceId, scope.from, scope.to, A1_RESULT_BYTES_THRESHOLD) as Array<
    EventRow & { ts: string; owner_message_id: string | null }
  >;
  resolveTargets(events);
  const resultCarry = createResultCarry(db);

  const groups = new Map<
    string,
    CardToolCall & {
      sessions: Set<string>;
      resend: number;
      results: Set<string>;
      subagent: boolean;
      event_ids: string[];
    }
  >();
  for (const event of events) {
    const cached = targetCache.get(event.event_id);
    if (cached == null || cached.beside_edit) continue;
    if (event.result_bytes === RESULT_CAPS[event.tool_name]) continue;
    const { beside_edit, in_subagent, result_hash, ...call } = cached;
    // Bytes the result adds to later requests: once per later turn of its owner chain (the main
    // thread, or the subagent that read it, until it ends), at least the next one (U7; A1's
    // carry walk, cap 75).
    const carry = resultCarry(event.session_id, event.ts, event.owner_message_id)?.carry ?? 0;
    const resend = event.result_bytes * Math.max(1, carry);
    const family = call.kind === "command" ? shellFamily(call.target) : null;
    const target = family ?? (call.kind === "file" ? call.target.toLowerCase() : call.target);
    const key = `${call.kind}\0${target}`;
    const group = groups.get(key);
    // A family of different commands is shown by its name ("git diff"), one command as itself.
    if (family !== null && group !== undefined && group.target !== call.target) {
      group.target = family;
    }
    if (group === undefined) {
      groups.set(key, {
        ...call,
        tool: event.tool_name,
        calls: 1,
        session_ids: [],
        session_count: 0,
        total_bytes: event.result_bytes,
        max_bytes: event.result_bytes,
        subagent: in_subagent === true,
        sessions: new Set([event.session_id]),
        resend,
        results: new Set(result_hash === undefined ? [] : [result_hash]),
        event_ids: [event.event_id],
      });
      continue;
    }
    group.event_ids.push(event.event_id);
    group.calls += 1;
    group.resend += resend;
    if (result_hash !== undefined) group.results.add(result_hash);
    group.total_bytes += event.result_bytes;
    group.max_bytes = Math.max(group.max_bytes, event.result_bytes);
    group.whole_file &&= call.whole_file;
    group.subagent &&= in_subagent === true;
    group.sessions.add(event.session_id);
  }
  // The most re-sent bytes first, the same yardstick as A1's rank (U7); a repeated target only
  // breaks a tie. A page that returned different content is not a repeat to save (review 4 A1).
  return [...groups.values()]
    .filter((group) => group.results.size <= 1)
    .sort(
      (a, b) =>
        b.resend - a.resend ||
        Number(b.calls > 1) - Number(a.calls > 1) ||
        b.calls - a.calls ||
        b.sessions.size - a.sessions.size ||
        b.total_bytes - a.total_bytes ||
        a.target.localeCompare(b.target),
    )
    .map(({ sessions, resend, results, subagent, ...group }) => ({
      ...group,
      ...(subagent ? { is_subagent: true } : {}),
      session_ids: [...sessions].slice(0, 3),
      session_count: sessions.size,
    }));
}

/**
 * D6's targets (U9 r3): the files and commands behind the largest mid-size results (25 KB or
 * less) in the given sessions, grouped by file (case-folded) or shell command family, largest
 * total first; at most four Read files, then the four largest groups of any other tool.
 */
export function midSizeToolCalls(
  db: Db,
  scope: { sessionIds: readonly string[]; from: string; to: string },
): CardToolCall[] {
  if (scope.sessionIds.length === 0) return [];
  const marks = scope.sessionIds.map(() => "?").join(", ");
  const events = db
    .prepare(
      `SELECT e.event_id, e.session_id, e.tool_name, e.result_bytes, s.file_path
         FROM tool_events e JOIN sessions s ON s.session_id = e.session_id
        WHERE e.session_id IN (${marks}) AND e.ts >= ? AND e.ts < ?
          AND e.result_bytes > 0 AND e.result_bytes <= ?
          AND e.tool_name IN ('Read', 'Bash', 'PowerShell', 'Grep')
        ORDER BY e.result_bytes DESC, e.event_id ASC
        LIMIT ${D6_TARGET_EVENTS}`,
    )
    .all(...scope.sessionIds, scope.from, scope.to, A1_RESULT_BYTES_THRESHOLD) as EventRow[];
  resolveTargets(events);
  const groups = new Map<string, CardToolCall & { sessions: Set<string> }>();
  for (const event of events) {
    const cached = targetCache.get(event.event_id);
    if (cached == null) continue;
    const family = cached.kind === "command" ? shellFamily(cached.target) : null;
    const target = family ?? cached.target;
    const key = `${event.tool_name}\0${target.toLowerCase()}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        target,
        kind: cached.kind,
        whole_file: cached.whole_file,
        tool: event.tool_name,
        calls: 1,
        session_ids: [],
        session_count: 0,
        total_bytes: event.result_bytes,
        max_bytes: event.result_bytes,
        sessions: new Set([event.session_id]),
      });
      continue;
    }
    group.calls += 1;
    group.total_bytes += event.result_bytes;
    group.max_bytes = Math.max(group.max_bytes, event.result_bytes);
    group.whole_file &&= cached.whole_file;
    group.sessions.add(event.session_id);
  }
  const ranked = [...groups.values()].sort(
    (a, b) => b.total_bytes - a.total_bytes || a.target.localeCompare(b.target),
  );
  const reads = ranked.filter((group) => group.tool === "Read").slice(0, 4);
  const others = ranked.filter((group) => group.tool !== "Read").slice(0, 4);
  return [...reads, ...others].map(({ sessions, ...group }) => ({
    ...group,
    session_ids: [...sessions].slice(0, 3),
    session_count: sessions.size,
  }));
}

/**
 * A path inside the workspace's project folder (or one of its `.worktrees/<slug>` checkouts) as a
 * repo-relative path; null for a path outside it. The project slug is the folder path with every
 * non-alphanumeric character replaced by `-`, so it lines up with the path character for character.
 */
export function repoRelative(
  filePath: string,
  projectSlug: string,
  home = os.homedir(),
): string | null {
  // Resolved targets are display paths (`~/…`); expand them back to compare with the slug.
  const expanded = filePath.startsWith("~/") ? `${home}/${filePath.slice(2)}` : filePath;
  const normalized = expanded.replaceAll("\\", "/");
  const encoded = normalized.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
  if (!encoded.startsWith(`${projectSlug.toLowerCase()}-`)) return null;
  if (normalized[projectSlug.length] !== "/") return null;
  return normalized.slice(projectSlug.length + 1).replace(/^\.worktrees\/[^/]+\//, "");
}

/**
 * E1's targets (U8): the files the long-orientation sessions Read on the main thread before
 * their first edit, grouped by file (case-folded), read by the most sessions first, then most
 * calls; at most six.
 */
export function orientationToolCalls(
  db: Db,
  scope: { sessionIds: readonly string[]; to: string },
): CardToolCall[] {
  if (scope.sessionIds.length === 0) return [];
  const marks = scope.sessionIds.map(() => "?").join(", ");
  // Like E1: reads from session start in turns before the editing turn, capped per session so a
  // few read-heavy sessions cannot crowd out the rest.
  const events = db
    .prepare(
      `WITH main_events AS (
         SELECT e.event_id, e.session_id, e.tool_name, e.ts, t.ts AS turn_ts, e.result_bytes
           FROM tool_events e
           JOIN tool_event_metadata m ON m.event_id = e.event_id
           JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
          WHERE e.session_id IN (${marks}) AND e.ts < ?
            AND t.is_sidechain = 0 AND t.provisional = 0
       ), first_edit AS (
         SELECT session_id, MIN(turn_ts) AS turn_ts FROM main_events
          WHERE tool_name IN ('Edit', 'Write', 'MultiEdit', 'NotebookEdit')
          GROUP BY session_id
       ), pre_edit AS (
         SELECT me.event_id, me.session_id, me.tool_name, me.result_bytes,
                ROW_NUMBER() OVER (PARTITION BY me.session_id ORDER BY me.ts, me.event_id) AS n
           FROM main_events me
           JOIN first_edit f ON f.session_id = me.session_id
          WHERE me.tool_name = 'Read' AND me.turn_ts < f.turn_ts
       )
       SELECT p.event_id, p.session_id, p.tool_name, COALESCE(p.result_bytes, 0) AS result_bytes,
              s.file_path, w.project_slug
         FROM pre_edit p
         JOIN sessions s ON s.session_id = p.session_id
         JOIN workspaces w ON w.workspace_id = s.workspace_id
        WHERE p.n <= ?
        ORDER BY p.session_id, p.n`,
    )
    .all(
      ...scope.sessionIds,
      scope.to,
      Math.ceil(MAX_EVENTS / scope.sessionIds.length),
    ) as (EventRow & { project_slug: string })[];
  resolveTargets(events);
  const groups = new Map<string, CardToolCall & { sessions: Set<string> }>();
  for (const event of events) {
    const cached = targetCache.get(event.event_id);
    if (cached == null || cached.kind !== "file") continue;
    const target = repoRelative(cached.target, event.project_slug) ?? cached.target;
    const key = target.toLowerCase();
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        target,
        kind: "file",
        whole_file: cached.whole_file,
        tool: "Read",
        calls: 1,
        session_ids: [],
        session_count: 0,
        total_bytes: event.result_bytes,
        max_bytes: event.result_bytes,
        sessions: new Set([event.session_id]),
      });
      continue;
    }
    group.calls += 1;
    group.total_bytes += event.result_bytes;
    group.max_bytes = Math.max(group.max_bytes, event.result_bytes);
    group.whole_file &&= cached.whole_file;
    group.sessions.add(event.session_id);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        b.sessions.size - a.sessions.size || b.calls - a.calls || a.target.localeCompare(b.target),
    )
    .slice(0, 6)
    .map(({ sessions, ...group }) => ({
      ...group,
      session_ids: [...sessions].slice(0, 3),
      session_count: sessions.size,
    }));
}

const OTHER_SHELL = "other shell commands";
/** E2's example calls: this many named groups, then the folded row. */
const MAX_RUN_GROUPS = 8;
/** Shell syntax and wrappers: they name no tool and hide the real command. */
const SHELL_SYNTAX = new Set([
  "for",
  "until",
  "while",
  "if",
  "foreach",
  "cmd",
  "cd",
  "sleep",
  "echo",
  "export",
]);

const RUN_TASK_TYPES: Record<string, string> = {
  BASH_GIT: "git commands",
  BASH_NPM: "npm commands",
  BASH_TEST: "test runs",
  BASH_BUILD: "builds",
  BASH_PYTHON: "python commands",
  Read: "file reads",
  Grep: "searches",
  Glob: "searches",
};

/**
 * E2's targets (U10): the kinds of work inside the mechanical runs of the card's sessions, by
 * calls. The runs come from the detector's own walk so the card and the finding agree.
 */
export function mechanicalRunToolCalls(
  db: Db,
  scope: { sessionIds: readonly string[]; from: string; to: string },
): CardToolCall[] {
  if (scope.sessionIds.length === 0) return [];
  const runs = mechanicalRuns(db, {
    fromIso: scope.from,
    toIso: scope.to,
    sessionIds: scope.sessionIds,
  });
  const callsOf = db.prepare(
    `SELECT e.event_id, e.session_id, e.tool_name, e.bash_command_family,
            COALESCE(e.result_bytes, 0) AS result_bytes, s.file_path
       FROM tool_event_metadata m
       JOIN tool_events e ON e.event_id = m.event_id
       JOIN sessions s ON s.session_id = e.session_id
      WHERE m.owner_message_id = ?`,
  );
  const rows = runs.flatMap((run) =>
    run.message_ids.flatMap(
      (messageId) =>
        callsOf.all(messageId) as (EventRow & { bash_command_family: string | null })[],
    ),
  );
  // Most shell calls carry no family; their leading command, read back from the transcript, names
  // the work instead ("node", "npx vitest").
  const unnamed = (row: (typeof rows)[number]) =>
    RUN_TASK_TYPES[row.bash_command_family ?? row.tool_name] === undefined;
  resolveTargets(rows.filter(unnamed).slice(0, MAX_EVENTS));
  const commandOf = (row: (typeof rows)[number]): string => {
    const cached = targetCache.get(row.event_id);
    if (cached == null || cached.kind !== "command") return OTHER_SHELL;
    const family = shellFamily(cached.target);
    // The family column misses chained git/npm calls; group them with the ones it caught.
    const program = family.split(" ")[0] ?? "";
    if (program === "git" || program === "npm") return `${program} commands`;
    if (SHELL_SYNTAX.has(program)) return OTHER_SHELL;
    return /^[\w.]/.test(family) ? `\`${family}\`` : OTHER_SHELL;
  };
  const groups = new Map<string, CardToolCall & { sessions: Set<string> }>();
  for (const call of rows) {
    const target = RUN_TASK_TYPES[call.bash_command_family ?? call.tool_name] ?? commandOf(call);
    const group = groups.get(target);
    if (group === undefined) {
      groups.set(target, {
        target,
        kind: "other",
        whole_file: false,
        tool: call.tool_name,
        calls: 1,
        session_ids: [],
        session_count: 0,
        total_bytes: call.result_bytes,
        max_bytes: call.result_bytes,
        sessions: new Set([call.session_id]),
      });
      continue;
    }
    group.calls += 1;
    group.total_bytes += call.result_bytes;
    group.max_bytes = Math.max(group.max_bytes, call.result_bytes);
    group.sessions.add(call.session_id);
  }
  // The top named groups, then one row folding the tail into "other shell commands".
  const ranked = [...groups.values()]
    .filter((group) => group.target !== OTHER_SHELL)
    .sort((a, b) => b.calls - a.calls || a.target.localeCompare(b.target));
  const shown = ranked.slice(0, MAX_RUN_GROUPS);
  const other = groups.get(OTHER_SHELL);
  const folded = [...ranked.slice(MAX_RUN_GROUPS), ...(other === undefined ? [] : [other])];
  const [firstFolded] = folded;
  if (firstFolded !== undefined) {
    shown.push({
      ...firstFolded,
      target: OTHER_SHELL,
      calls: folded.reduce((sum, group) => sum + group.calls, 0),
      total_bytes: folded.reduce((sum, group) => sum + group.total_bytes, 0),
      max_bytes: Math.max(...folded.map((group) => group.max_bytes)),
      sessions: new Set(folded.flatMap((group) => [...group.sessions])),
    });
  }
  return shown.map(({ sessions, ...group }) => ({
    ...group,
    session_ids: [...sessions].slice(0, 3),
    session_count: sessions.size,
  }));
}

/** The command a PowerShell parse error points at: the word above the error's first `~` mark. */
function parseErrorCommand(error: string): string | undefined {
  if (!/ParserError|ParseException/.test(error)) return undefined;
  const lines = error.split(/\r?\n/);
  for (let i = 0; i + 2 < lines.length; i += 1) {
    const snippet = lines[i + 1] ?? "";
    const marks = lines[i + 2] ?? "";
    if (!/At line:\d+ char:\d+/.test(lines[i] ?? "") || !snippet.startsWith("+")) continue;
    const column = marks.startsWith("+") ? marks.indexOf("~") : -1;
    if (column > 0) return /^[A-Za-z][\w.-]*/.exec(snippet.slice(column))?.[0];
  }
  return undefined;
}

/**
 * The command that failed in a shell-caused failure (review 5 residual M12): "| tail" for a
 * command the shell did not have that the call piped into, "tail" when it ran it directly, the
 * command a parse error points at, else undefined (the call is grouped by its leading command).
 */
function failedCommand(command: string, error: string | null): string | undefined {
  if (error === null) return undefined;
  const missing = missingCommand(error);
  if (missing === undefined) return parseErrorCommand(error);
  const escaped = missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\|\\s*${escaped}\\b`).test(command) ? `| ${missing}` : missing;
}

/**
 * The failed calls of one shell that D11 counts (`d11Outcome`), grouped by the command that
 * failed, else by command family, most failures first. Command and error come from stored
 * content, so no transcript is read.
 */
export function shellFailureToolCalls(
  db: Db,
  scope: { workspaceId: string; tool: string; from: string; to: string },
): CardToolCall[] {
  const rows = db
    .prepare(
      `SELECT e.session_id, e.exit_class,
              json_extract(c.content_json, '$.command') AS command,
              json_extract(c.content_json, '$.error') AS error
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
         JOIN tool_event_content c ON c.event_id = e.event_id
        WHERE s.workspace_id = ? AND e.ts >= ? AND e.ts < ? AND e.tool_name = ?
          AND e.exit_class = 'ERROR'
        ORDER BY e.ts DESC, e.event_id`,
    )
    .all(scope.workspaceId, scope.from, scope.to, scope.tool) as Array<{
    session_id: string;
    exit_class: string;
    command: string | null;
    error: string | null;
  }>;
  const groups = new Map<string, CardToolCall & { sessions: Set<string> }>();
  for (const row of rows) {
    if (row.command === null || d11Outcome(row.exit_class, row.command, row.error) !== "ERROR") {
      continue;
    }
    const failed = failedCommand(row.command, row.error);
    const command = failed ?? commandText(row.command);
    const family = failed ?? shellFamily(row.command);
    const key = `${failed === undefined ? "family" : "failed"}\0${family}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        target: command,
        kind: "command",
        whole_file: false,
        tool: scope.tool,
        ...(row.error === null ? {} : { result: oneLine(row.error, 160) }),
        calls: 1,
        session_ids: [],
        session_count: 0,
        total_bytes: 0,
        max_bytes: 0,
        sessions: new Set([row.session_id]),
      });
      continue;
    }
    // A family of different commands is shown by its name ("git diff"), one command as itself.
    if (group.target !== command) group.target = family;
    group.calls += 1;
    group.sessions.add(row.session_id);
  }
  return [...groups.values()]
    .sort((a, b) => b.calls - a.calls || a.target.localeCompare(b.target))
    .map(({ sessions, ...group }) => ({
      ...group,
      session_ids: [...sessions].slice(0, 3),
      session_count: sessions.size,
    }));
}

/** A card's evidence anchor: hashed ids (privacy-contract `findingIds`) plus the event time. */
export interface EvidenceAnchor {
  event_id: string;
  session_id: string;
  timestamp: string;
}

/** Every transcript line containing `key`, in file order. */
function* linesWith(texts: string[], key: string): Generator<string> {
  for (const text of texts) {
    for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, at + key.length)) {
      const end = text.indexOf("\n", at);
      yield text.slice(text.lastIndexOf("\n", at) + 1, end < 0 ? undefined : end);
    }
  }
}

function lineWith(texts: string[], key: string): string | null {
  for (const line of linesWith(texts, key)) return line;
  return null;
}

function contentBlocks(line: string | null): Array<Record<string, unknown>> {
  if (line === null) return [];
  try {
    const content = JSON.parse(line)?.message?.content;
    return Array.isArray(content) ? content : [];
  } catch {
    return [];
  }
}

/** The working directory a transcript line was written in; undefined when it has none. */
function lineCwd(line: string | null): string | undefined {
  if (line === null) return undefined;
  try {
    const cwd = JSON.parse(line)?.cwd;
    return typeof cwd === "string" ? cwd : undefined;
  } catch {
    return undefined;
  }
}

function resultText(content: unknown, stripHook = true): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
        : "";
  // A guard's "PreToolUse:<Tool> hook error:" prefix goes before the cut, so its message shows whole.
  // A browser batch shows the step that failed, not its first step (review 4 C1).
  const first = (
    FAILED_STEP_LINE.exec(text)?.[0] ??
    text.split("\n").find((line) => line.trim() !== "") ??
    ""
  ).trim();
  return firstWords(stripHook ? first.replace(HOOK_PREFIX, "") : first, MAX_TEXT);
}

/**
 * The call behind one event and the first line it returned. A `tool_events` id is the `tool_use`
 * id. An `ingest_metric_events` id is a hash, so its event is the tool result line at its time.
 */
function resolveAnchor(file: string, event: AnchorEvent): CallTarget | null {
  // Most anchored events are in the main transcript; read the subagent ones only if not.
  return (
    callFromTexts(readTexts([file]), event) ??
    callFromTexts(readTexts(transcriptFiles(file)), event)
  );
}

function readTexts(files: string[]): string[] {
  const texts: string[] = [];
  for (const file of files) {
    try {
      texts.push(readFileSync(file, "utf8"));
    } catch {
      // Unreadable transcript.
    }
  }
  return texts;
}

/**
 * An event behind an anchor. `call_tool` is set when the ingest line is a call rather than a
 * result: a risky command was classified from a Bash call's input.
 */
interface AnchorEvent {
  id: string;
  ts: string;
  source: "tool" | "ingest";
  call_tool: string | null;
}

function callFromTexts(texts: string[], event: AnchorEvent): CallTarget | null {
  let useId = event.id;
  if (event.source === "ingest") {
    // The line is the call itself (a risky command) or its result (a denial). Other calls and
    // results can share its timestamp, so only a block of the right kind and tool counts.
    const wanted = (part: Record<string, unknown>): boolean =>
      event.call_tool === null
        ? part.type === "tool_result"
        : part.type === "tool_use" &&
          (part.name === event.call_tool ||
            (event.call_tool === "Bash" && part.name === "PowerShell"));
    let block: Record<string, unknown> | undefined;
    for (const line of linesWith(texts, `"timestamp":"${event.ts}"`)) {
      block = contentBlocks(line).find(wanted);
      if (block !== undefined) break;
    }
    const id = block?.type === "tool_use" ? block.id : block?.tool_use_id;
    if (typeof id !== "string") return null;
    useId = id;
  }
  const result = contentBlocks(lineWith(texts, `"tool_use_id":"${useId}"`)).find(
    (block) => block.tool_use_id === useId,
  );
  const useLine = lineWith(texts, `"id":"${useId}"`);
  const use = contentBlocks(useLine).find(
    (block) => block.type === "tool_use" && block.id === useId,
  );
  if (typeof use?.name !== "string" || typeof use.input !== "object" || use.input === null) {
    return null;
  }
  const input = use.input as ToolInput;
  const named = input.file_path ?? input.notebook_path ?? input.path;
  const command = typeof input.command === "string" ? input.command : null;
  const risk = command === null ? null : rmRisk(command, lineCwd(useLine));
  // U7: guards also check tools with no command (TaskCreate, Agent); their blocks need a shape too.
  const blocked =
    (command !== null || GUARD_INPUT_TOOLS.has(use.name)) &&
    HOOK_PREFIX.test(resultText(result?.content, false));
  return {
    ...describe(use.name, input),
    tool: use.name,
    result: resultText(result?.content),
    ...(typeof named === "string" ? { path: named } : {}),
    ...(risk === null ? {} : { risk }),
    ...(blocked
      ? { guard_shape: blockedShape(command, use.name, resultText(result?.content, false)) }
      : {}),
  };
}

/** The shape of a guard block; a dispatch the guard stopped for omitting `model` is intended (U9 r3). */
function blockedShape(command: string | null, tool: string, result: string): GuardShape {
  // U9 r4: the worktree-remove guard stops `git worktree remove` through a node_modules junction
  // (or with an unresolvable path). Its block is intended whatever else the command holds, such as
  // a `/tmp`-looking scratch path in a chained commit message file.
  if (/worktree-remove guard/i.test(result)) return "WORKTREE_REMOVE";
  if (command === null && GUARD_INPUT_TOOLS.has(tool) && /omitted `?model`?/i.test(result)) {
    return "MISSING_MODEL";
  }
  return guardShape(command ?? "", tool);
}

/** Tools besides the shell ones whose PreToolUse blocks are classified (shape OTHER: no command). */
const GUARD_INPUT_TOOLS = new Set(["TaskCreate", "Agent", "Task"]);

/** Hashed `sid_…` → raw session id; rebuilt when a session is missing (a new one was ingested). */
const sessionIds = new Map<string, string>();

function rawSessionId(db: Db, hashed: string): string | null {
  if (!sessionIds.has(hashed)) {
    for (const { session_id } of db.prepare("SELECT session_id FROM sessions").all() as Array<{
      session_id: string;
    }>) {
      sessionIds.set(findingIds.session(session_id), session_id);
    }
  }
  return sessionIds.get(hashed) ?? null;
}

/**
 * The calls a card's evidence anchors point at, grouped by target, most calls first. Anchors carry
 * hashed ids, so each is matched by hashing the events recorded at its timestamp.
 */
export function anchoredToolCalls(db: Db, anchors: readonly EvidenceAnchor[]): CardToolCall[] {
  // Both tables are indexed by session first; neither by time alone.
  const events = db.prepare(
    `SELECT e.event_id AS id, e.ts, s.file_path AS file, 'tool' AS source, NULL AS call_tool
       FROM tool_events e JOIN sessions s ON s.session_id = e.session_id
      WHERE e.session_id = ? AND e.ts = ?
     UNION ALL
     SELECT e.event_id, e.event_ts, s.file_path, 'ingest',
            CASE WHEN e.destructive_op IS NOT NULL OR e.command_shape IS NOT NULL THEN 'Bash' END
       FROM ingest_metric_events e JOIN sessions s ON s.session_id = e.session_id
      WHERE e.session_id = ? AND e.event_ts = ?`,
  );
  const groups = new Map<string, CardToolCall & { sessions: Set<string> }>();
  for (const anchor of anchors) {
    const session = rawSessionId(db, anchor.session_id);
    if (session === null) continue;
    let call = targetCache.get(anchor.event_id);
    if (call === undefined) {
      const raw = (
        events.all(session, anchor.timestamp, session, anchor.timestamp) as Array<
          AnchorEvent & { file: string | null }
        >
      ).find((row) => findingIds.event(row.id) === anchor.event_id);
      // An event not ingested yet is looked up again next build.
      if (raw === undefined || raw.file === null) continue;
      call = resolveAnchor(raw.file, raw);
      targetCache.set(anchor.event_id, call);
    }
    if (call == null) continue;
    const key = `${call.kind}\0${call.target}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        target: call.target,
        kind: call.kind,
        whole_file: call.whole_file,
        tool: call.tool ?? "",
        ...(call.result === undefined ? {} : { result: call.result }),
        ...(call.risk === undefined ? {} : { risk: call.risk }),
        ...(call.guard_shape === undefined ? {} : { guard_shape: call.guard_shape }),
        calls: 1,
        session_ids: [],
        session_count: 0,
        total_bytes: 0,
        max_bytes: 0,
        sessions: new Set([session]),
      });
      continue;
    }
    group.calls += 1;
    group.sessions.add(session);
  }
  return [...groups.values()]
    .sort((a, b) => b.calls - a.calls || a.target.localeCompare(b.target))
    .map(({ sessions, ...group }) => ({
      ...group,
      session_ids: [...sessions].slice(0, 3),
      session_count: sessions.size,
    }));
}

/**
 * Every run of one destructive-operation class in a workspace's window, read back like anchors. The
 * finding keeps five anchors; the card needs every run to say whether any was risky (review 2 H1a).
 */
export function destructiveToolCalls(
  db: Db,
  scope: { workspaceId: string; operation: string; from: string; to: string },
): CardToolCall[] {
  // The detector's own runs (card review F6), so the read-back counts what the card counts.
  return readBackNewestFirst(
    db,
    destructiveRuns(db, scope.from, scope.to)
      .filter(
        (run) => run.workspace_id === scope.workspaceId && run.destructive_op === scope.operation,
      )
      .sort((a, b) => b.event_ts.localeCompare(a.event_ts))
      .slice(0, MAX_EVENTS),
  ).map((call) => {
    // U9 r7: say which path made a run RISKY, after the command's own variables are resolved.
    const paths = call.risk === "RISKY" && call.kind === "command" ? rmRiskyPaths(call.target) : [];
    return paths.length === 0 ? call : { ...call, risky_paths: paths };
  });
}

/**
 * Every block by the user's PreToolUse guard in a workspace's window, newest block's group first
 * (its message is the guard's current version; review 2 C9g3).
 */
export function guardBlockToolCalls(
  db: Db,
  scope: { workspaceId: string; from: string; to: string },
): CardToolCall[] {
  return windowToolCalls(db, `${C9_DENIAL_WHERE} AND e.classifier_label = 'hook-block'`, [], scope);
}

/** Ingest events matching `where` in a workspace's window, read back like anchors, newest first. */
function windowToolCalls(
  db: Db,
  where: string,
  params: unknown[],
  scope: { workspaceId: string; from: string; to: string },
): CardToolCall[] {
  return readBackNewestFirst(
    db,
    db
      .prepare(
        `SELECT e.event_id, e.session_id, e.event_ts
           FROM ingest_metric_events e JOIN sessions s ON s.session_id = e.session_id
          WHERE s.workspace_id = ? AND ${where} AND e.event_ts >= ? AND e.event_ts < ?
          ORDER BY e.event_ts DESC LIMIT ${MAX_EVENTS}`,
      )
      .all(scope.workspaceId, ...params, scope.from, scope.to) as Array<{
      event_id: string;
      session_id: string;
      event_ts: string;
    }>,
  );
}

/** Ingest events (newest first) read back like anchors; the newest event's group leads. */
function readBackNewestFirst(
  db: Db,
  rows: Array<{ event_id: string; session_id: string; event_ts: string }>,
): CardToolCall[] {
  const anchors = rows.map((row) => ({
    event_id: findingIds.event(row.event_id),
    session_id: findingIds.session(row.session_id),
    timestamp: row.event_ts,
  }));
  const calls = anchoredToolCalls(db, anchors);
  // The newest event resolves from the cache; its group leads.
  const newest = anchors.find((anchor) => targetCache.get(anchor.event_id) != null);
  const lead = newest === undefined ? undefined : targetCache.get(newest.event_id);
  const at = calls.findIndex((call) => call.target === lead?.target && call.kind === lead.kind);
  return at <= 0 ? calls : [calls[at] as CardToolCall, ...calls.filter((_, i) => i !== at)];
}

/** The calls behind raw `tool_events` ids (tool_use ids), read back like anchors. */
export function eventToolCalls(db: Db, eventIds: readonly string[]): CardToolCall[] {
  const event = db.prepare("SELECT session_id, ts FROM tool_events WHERE event_id = ?");
  return anchoredToolCalls(
    db,
    eventIds.flatMap((id) => {
      const row = event.get(id) as { session_id: string; ts: string } | undefined;
      return row === undefined
        ? []
        : [
            {
              event_id: findingIds.event(id),
              session_id: findingIds.session(row.session_id),
              timestamp: row.ts,
            },
          ];
    }),
  );
}

/**
 * The files a cross-session re-read card names: one read of each read back for its path, with the
 * file's read totals in the window. A read's result is file content, so it is not shown.
 */
export function rereadToolCalls(
  db: Db,
  eventIds: readonly string[],
  scope: { workspaceId: string; from: string; to: string },
): CardToolCall[] {
  // U9 r7: the detector's re-read identity (same path, region and result size, in sessions that
  // did not edit the file), so the card's counts are the detector's counts.
  const totals = db.prepare(
    `WITH ref AS (
       SELECT m.file_path_hash, r.input_hash, COALESCE(r.result_bytes, 0) AS result_bytes
         FROM tool_events r JOIN tool_event_metadata m ON m.event_id = r.event_id
        WHERE r.event_id = ?)
     SELECT COUNT(*) AS calls, COUNT(DISTINCT e.session_id) AS sessions,
            COALESCE(SUM(e.result_bytes), 0) AS bytes, COALESCE(MAX(e.result_bytes), 0) AS max_bytes,
            GROUP_CONCAT(DISTINCT e.session_id) AS session_list
       FROM tool_events e
       JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       JOIN ref ON ref.file_path_hash = m.file_path_hash
      WHERE s.workspace_id = ? AND e.ts >= ? AND e.ts < ? AND e.tool_name = 'Read'
        AND COALESCE(e.result_bytes, 0) <= ?
        AND e.input_hash IS ref.input_hash AND COALESCE(e.result_bytes, 0) = ref.result_bytes
        AND NOT EXISTS (
          SELECT 1 FROM tool_events ed JOIN tool_event_metadata mm ON mm.event_id = ed.event_id
           WHERE ed.session_id = e.session_id AND mm.file_path_hash = ref.file_path_hash
             AND ed.tool_name IN ('Edit', 'MultiEdit', 'Write', 'NotebookEdit')
             AND ed.ts >= ? AND ed.ts < ?)`,
  );
  return eventIds.flatMap((id) => {
    const [call] = eventToolCalls(db, [id]);
    if (call === undefined) return [];
    const { result, ...read } = call;
    const total = totals.get(
      id,
      scope.workspaceId,
      scope.from,
      scope.to,
      A1_RESULT_BYTES_THRESHOLD,
      scope.from,
      scope.to,
    ) as {
      calls: number;
      sessions: number;
      bytes: number;
      max_bytes: number;
      session_list: string | null;
    };
    if (total.calls === 0) return [];
    return [
      {
        ...read,
        session_ids: (total.session_list ?? "")
          .split(",")
          .filter((s) => s !== "")
          .sort(),
        calls: total.calls,
        session_count: total.sessions,
        total_bytes: total.bytes,
        max_bytes: total.max_bytes,
      },
    ];
  });
}

const SCRATCHPAD_OF =
  /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/scratchpad\//;
const WORKTREE_OF = /^(.*?)\/\.?worktrees\/([^/]+)/;
const CWD_NOTE = /current working directory is (.+?)\.?$/;

function comparablePath(value: string): string {
  const full = value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
  return full.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

/** What the disk says now about a repo, for telling a missing path's cause apart. */
export interface RepoProbe {
  exists(file: string): boolean;
  /** The other checkouts of the repo whose main checkout is `repo` (its worktrees, or `repo`). */
  checkouts(repo: string): string[];
  /** Lowercased repo-relative paths of the files tracked in the checkout at `root`. */
  trackedFiles(root: string): string[];
}

const trackedCache = new Map<string, string[]>();

/**
 * The on-disk spelling of a lowercased comparable path, or null when it is not there. Paths are
 * compared lowercased; on a case-sensitive filesystem (Linux) the lowercased path itself would
 * miss a real `~/Projects/Repo`, so each segment is matched case-insensitively.
 */
function onDiskCase(file: string): string | null {
  if (existsSync(file)) return file;
  if (process.platform === "win32" || process.platform === "darwin") return null;
  const { root } = path.parse(file);
  let current = root;
  for (const segment of file.slice(root.length).split("/").filter(Boolean)) {
    try {
      const hit = readdirSync(current).find((name) => name.toLowerCase() === segment.toLowerCase());
      if (hit === undefined) return null;
      current = path.join(current, hit);
    } catch {
      return null;
    }
  }
  return current;
}

const diskProbe: RepoProbe = {
  exists: (file) => onDiskCase(file) !== null,
  checkouts: (repo) => {
    const trees = onDiskCase(path.join(repo, ".worktrees"));
    const names =
      trees !== null
        ? readdirSync(trees, { withFileTypes: true }).filter((entry) => entry.isDirectory())
        : [];
    return [repo, ...names.map((entry) => `${repo}/.worktrees/${entry.name.toLowerCase()}`)];
  },
  trackedFiles: (root) => {
    let files = trackedCache.get(root);
    if (files === undefined) {
      try {
        files = execFileSync("git", ["-C", onDiskCase(root) ?? root, "ls-files"], {
          encoding: "utf8",
          timeout: 5_000,
          windowsHide: true,
        })
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => line.toLowerCase());
      } catch {
        files = [];
      }
      trackedCache.set(root, files);
    }
    return files;
  },
};

/**
 * Why a looked-up path did not exist: a file in another session's scratchpad, a path in a different
 * checkout of the repo than the working directory Claude Code's error names, a file that exists
 * only on another checkout's branch, a file name that exists in another folder, or else a guess.
 */
export function notFoundCause(
  call: CallTarget,
  sessionId: string,
  probe: RepoProbe = diskProbe,
): NonNullable<CardToolCall["cause"]> {
  const file = comparablePath(call.path ?? call.target);
  const pad = file.match(SCRATCHPAD_OF);
  if (pad !== null && pad[1] !== sessionId.toLowerCase()) return "OTHER_SCRATCHPAD";
  const cwdText = call.result?.match(CWD_NOTE)?.[1];
  if (cwdText !== undefined) {
    const cwd = comparablePath(cwdText);
    const cwdTree = cwd.match(WORKTREE_OF);
    const repo = cwdTree?.[1] ?? cwd;
    const fileTree = file.match(WORKTREE_OF)?.[2] ?? null;
    if (file.startsWith(`${repo}/`) && fileTree !== (cwdTree?.[2] ?? null)) {
      // U9 r4: a main-checkout path that exists in no checkout (a directory that was never there,
      // like `.audits-none`) was guessed, not read from the wrong worktree. When the repo is not on
      // this disk the path cannot be checked, so it stays a wrong-worktree lookup.
      if (!probe.exists(repo)) return "WRONG_WORKTREE";
      if (fileTree === null) return probe.exists(file) ? "WRONG_WORKTREE" : "GUESSED_PATH";
      // U9 r7: a path that names a worktree is a wrong-worktree lookup only when the file exists
      // somewhere. A worktree that is gone cannot be checked (it may have been removed since), but
      // one that is still on disk and holds no such file, nor does any other checkout, was a
      // guessed file name (`d10_catalog_bloat.ts` for `d10_catalog_footprint.ts`).
      // U9 r8: a worktree that is not on disk any more is its own cause (the file went with it, or
      // was never saved there), not a path read from the wrong, still existing worktree.
      const worktree = `${repo}/.worktrees/${fileTree}`;
      if (!probe.exists(worktree)) return "WORKTREE_GONE";
      const relative = file.slice(worktree.length + 1);
      const exists =
        probe.exists(file) ||
        probe.checkouts(repo).some((other) => probe.exists(`${other}/${relative}`));
      return exists ? "WRONG_WORKTREE" : "GUESSED_PATH";
    }
    const checkout = cwdTree?.[0] ?? cwd;
    if (file.startsWith(`${checkout}/`)) {
      const relative = file.slice(checkout.length + 1);
      // Review 2 C2c: the file is on another branch, checked out somewhere else.
      const elsewhere = probe
        .checkouts(repo)
        .some((other) => other !== checkout && probe.exists(`${other}/${relative}`));
      if (elsewhere) return "NOT_ON_BRANCH";
      // Review 2 C2d: the right file name in the wrong folder. A name shared by several files
      // (`types.ts`) does not say which one was meant, so only a unique name counts.
      const name = relative.slice(relative.lastIndexOf("/") + 1);
      const root = probe.exists(checkout) ? checkout : repo;
      const sameName = probe
        .trackedFiles(root)
        .filter((tracked) => tracked === name || tracked.endsWith(`/${name}`));
      if (sameName.length === 1 && sameName[0] !== relative) return "WRONG_FOLDER";
    }
  }
  return "GUESSED_PATH";
}

/**
 * A workspace's missing-path lookups (the calls C2 counts), newest first up to the event cap,
 * grouped by target with each group's cause, most calls first.
 */
export function notFoundToolCalls(
  db: Db,
  scope: { workspaceId: string; from: string; to: string },
): CardToolCall[] {
  const events = db
    .prepare(
      `SELECT e.event_id AS id, e.ts, e.session_id, s.file_path AS file
         FROM tool_events e
         JOIN tool_event_metadata m ON m.event_id = e.event_id
         JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
         JOIN sessions s ON s.session_id = e.session_id
        WHERE s.workspace_id = ? AND ${C2_NOT_FOUND_WHERE}
        ORDER BY e.ts DESC, e.event_id
        LIMIT ${MAX_EVENTS}`,
    )
    .all(scope.workspaceId, scope.from, scope.to) as Array<{
    id: string;
    ts: string;
    session_id: string;
    file: string | null;
  }>;
  if (targetCache.size > TARGET_CACHE_LIMIT) targetCache.clear();
  // Main-chain calls only, so each session's own transcript is read once and subagents never.
  const texts = new Map<string, string[]>();
  const groups = new Map<string, CardToolCall & { sessions: Set<string> }>();
  for (const event of events) {
    let call = targetCache.get(event.id);
    if (call === undefined) {
      if (event.file === null) continue;
      let text = texts.get(event.file);
      if (text === undefined) {
        text = readTexts([event.file]);
        texts.set(event.file, text);
      }
      call = callFromTexts(text, { id: event.id, ts: event.ts, source: "tool", call_tool: null });
      targetCache.set(event.id, call);
    }
    if (call == null) continue;
    const cause = notFoundCause(call, event.session_id);
    // The target drops a worktree segment; a wrong-worktree lookup shows the path as written, so
    // the worktree it named is visible (U9: the card showed the main checkout's path; r9: the same
    // for a worktree that is gone, whose fix says "the paths name a worktree folder").
    const target =
      (cause === "WRONG_WORKTREE" || cause === "WORKTREE_GONE") &&
      call.path !== undefined &&
      call.kind === "file"
        ? displayPath(call.path)
        : call.target;
    const key = `${call.kind}\0${target}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        target,
        kind: call.kind,
        whole_file: call.whole_file,
        tool: call.tool ?? "",
        ...(call.result === undefined ? {} : { result: call.result }),
        cause,
        calls: 1,
        session_ids: [],
        session_count: 0,
        total_bytes: 0,
        max_bytes: 0,
        sessions: new Set([event.session_id]),
      });
      continue;
    }
    group.calls += 1;
    group.sessions.add(event.session_id);
  }
  return [...groups.values()]
    .sort((a, b) => b.calls - a.calls || a.target.localeCompare(b.target))
    .map(({ sessions, ...group }) => ({
      ...group,
      session_ids: [...sessions].slice(0, 3),
      session_count: sessions.size,
    }));
}

/**
 * Every Edit or Write C3 counts in a workspace's window (a file not read first), main thread and
 * subagents, grouped by file with how many calls ran in a subagent. The finding keeps five anchors;
 * the card needs the files and the thread split for all of them.
 */
export function notReadToolCalls(
  db: Db,
  scope: { workspaceId: string; from: string; to: string },
): CardToolCall[] {
  const events = db
    .prepare(
      `SELECT e.event_id AS id, e.ts, e.session_id, s.file_path AS file,
              (t.is_sidechain = 1) AS sub
         FROM tool_events e
         JOIN tool_event_metadata m ON m.event_id = e.event_id
         JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
         JOIN sessions s ON s.session_id = e.session_id
        WHERE s.workspace_id = ? AND e.ts >= ? AND e.ts < ?
          AND s.state = 'RECONCILED' AND t.provisional = 0
          AND (t.is_sidechain = 0 OR t.agent_id IS NOT NULL)
          AND e.tool_name IN ('Edit', 'Write')
          AND e.tool_error_class = 'NOT_READ'
          AND e.tool_error_classifier_version = 'tool-error-1'
        ORDER BY e.ts DESC, e.event_id
        LIMIT ${MAX_EVENTS}`,
    )
    .all(scope.workspaceId, scope.from, scope.to) as Array<{
    id: string;
    ts: string;
    session_id: string;
    file: string | null;
    sub: number;
  }>;
  if (targetCache.size > TARGET_CACHE_LIMIT) targetCache.clear();
  const groups = new Map<
    string,
    CardToolCall & { sessions: Set<string>; subagent_calls: number }
  >();
  for (const event of events) {
    let call = targetCache.get(event.id);
    if (call === undefined) {
      if (event.file === null) continue;
      call = resolveAnchor(event.file, {
        id: event.id,
        ts: event.ts,
        source: "tool",
        call_tool: null,
      });
      targetCache.set(event.id, call);
    }
    if (call == null) continue;
    const key = `${call.tool ?? ""}\0${call.target}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        target: call.target,
        kind: call.kind,
        whole_file: false,
        tool: call.tool ?? "",
        calls: 1,
        session_ids: [],
        session_count: 0,
        total_bytes: 0,
        max_bytes: 0,
        sessions: new Set([event.session_id]),
        subagent_calls: event.sub ? 1 : 0,
      });
      continue;
    }
    group.calls += 1;
    group.sessions.add(event.session_id);
    if (event.sub) group.subagent_calls += 1;
  }
  return [...groups.values()]
    .sort((a, b) => b.calls - a.calls || a.target.localeCompare(b.target))
    .map(({ sessions, ...group }) => ({
      ...group,
      session_ids: [...sessions].slice(0, 3),
      session_count: sessions.size,
    }));
}

/**
 * The cache as plain entries. Each recommendations build runs in a fresh worker, so the daemon
 * carries the cache from one build to the next with these two.
 */
export function toolCallTargetEntries(): Array<[string, CallTarget | null]> {
  return [...targetCache];
}

export function seedToolCallTargets(entries: Array<[string, CallTarget | null]>): void {
  for (const [id, target] of entries) targetCache.set(id, target);
}

/** Test hook: forget cached call targets. */
export function __resetToolCallTargets(): void {
  targetCache.clear();
  sessionIds.clear();
}
