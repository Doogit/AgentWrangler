/**
 * H1 destructive-command classifier (card review F6, 2026-10-04). The command is parsed, not
 * matched as a substring: a pattern inside a grep, a quoted string, a heredoc or a comment is not a
 * run, `rm` needs both a recursive and a force flag, and deleting only session scratchpads or Temp
 * folders is disposable cleanup.
 */

import type { DestructiveOp } from "./types.js";

/**
 * The simple commands in `command`, each as its words with quotes removed. Splits on unquoted
 * `;`, `&`, `|`, newlines and parentheses; skips heredoc bodies and `#` comments.
 */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word: string | null = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  const heredocs: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1);
      const end = close < 0 ? command.length : close;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (ch === "\\" && /[\s'"$`\\;&|()<>#]/.test(command[i + 1] ?? "")) {
      // An escape only before a shell-special character; `C:\Users` stays a Windows path. A
      // backslash-newline continues the line.
      if (command[i + 1] !== "\n") word = (word ?? "") + command[i + 1];
      i++;
    } else if (ch === "#" && word === null) {
      const nl = command.indexOf("\n", i);
      i = (nl < 0 ? command.length : nl) - 1;
    } else if (ch === "<" && command.startsWith("<<", i) && command[i + 2] !== "<") {
      endWord();
      const tag = /^<<-?\s*(['"]?)([\w.-]+)\1/.exec(command.slice(i));
      if (tag?.[2] !== undefined) heredocs.push(tag[2]);
      i += (tag?.[0].length ?? 2) - 1;
    } else if (ch === "\n") {
      endSegment();
      // Skip each pending heredoc's body, up to its closing tag line.
      for (const tag of heredocs.splice(0)) {
        let at = i + 1;
        for (;;) {
          const nl = command.indexOf("\n", at);
          const line = command.slice(at, nl < 0 ? command.length : nl);
          at = nl < 0 ? command.length : nl + 1;
          if (line.trim() === tag || nl < 0) break;
        }
        i = at - 1;
      }
    } else if (ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
      endSegment();
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      word = (word ?? "") + ch;
    }
  }
  endSegment();
  return segments;
}

/** A path in one form: forward slashes, `/c/` as `c:/`, lower case, no trailing slash. */
export function drivePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\/([a-z])\//i, "$1:/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Somewhere strictly inside a Claude Code session scratchpad or a Temp folder. */
const DISPOSABLE = [
  /\/claude\/[^/]+\/[^/]+\/scratchpad(?:\/|$)/,
  /\/appdata\/local\/temp\/./,
  /^\/(?:var\/)?tmp\/./,
  /^(?:\$\{?(?:tmpdir|temp|tmp)\}?|%temp%|\$env:temp)\/./,
  /\/\.claude\/jobs\/[^/]+\/tmp(?:\/|$)/,
];

/** Whether deleting `path` is disposable cleanup: a scratchpad or Temp folder, never via `..`. */
export function isDisposablePath(path: string): boolean {
  const target = drivePath(path);
  if (/(?:^|\/)\.\.(?:\/|$)/.test(target)) return false;
  return DISPOSABLE.some((pattern) => pattern.test(target));
}

/** Words that run the command after them; their own flags are skipped. */
const PREFIXES = new Set(["sudo", "env", "command", "nohup", "time", "exec", "nice", "xargs"]);
/** Commands that search or print their arguments: a pattern in them is not a run. */
const SEARCH_OR_PRINT = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "findstr",
  "select-string",
  "echo",
  "printf",
  "cat",
  "head",
  "tail",
  "sed",
  "awk",
]);
const SQL_DROP = /\bDROP\s+(?:TABLE|DATABASE)\b/i;
const SQL_TRUNCATE = /\bTRUNCATE\s+(?:TABLE\s+)?\w+/i;
const ASSIGNMENT = /^([A-Za-z_]\w*)=(.*)$/s;

const base = (word: string): string => (word.split(/[\\/]/).pop() ?? word).toLowerCase();

/** `rm` with a recursive and a force flag, in any order or form. */
function recursiveForce(args: string[]): boolean {
  const end = args.indexOf("--");
  const flags = (end < 0 ? args : args.slice(0, end)).filter((a) => /^-./.test(a));
  const short = flags.filter((a) => !a.startsWith("--")).join("");
  return (
    (/[rR]/.test(short) || flags.includes("--recursive")) &&
    (short.includes("f") || flags.includes("--force"))
  );
}

/** The paths `rm` names: no flags (until `--`), no redirections. */
function rmTargets(args: string[]): string[] {
  const end = args.indexOf("--");
  return args.filter(
    (a, i) => (end >= 0 && i > end) || (a !== "--" && !/^-./.test(a) && !/^\d*>/.test(a)),
  );
}

/** `$NAME` / `${NAME}` replaced from assignments earlier in the same command. */
function expand(word: string, vars: Map<string, string>): string {
  return word.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, a, b) => vars.get(a ?? b) ?? whole);
}

/** The destructive operation a Bash command runs, or null. */
export function classifyDestructiveOp(command: string, depth = 0): DestructiveOp | null {
  const vars = new Map<string, string>();
  for (const words of shellSegments(command)) {
    let i = 0;
    for (;;) {
      const assigned = ASSIGNMENT.exec(words[i] ?? "");
      if (assigned?.[1] !== undefined && assigned[2] !== undefined) {
        vars.set(assigned[1], assigned[2]);
        i++;
      } else if (PREFIXES.has(base(words[i] ?? ""))) {
        i++;
        while (/^-./.test(words[i] ?? "")) i++;
      } else break;
    }
    const head = base(words[i] ?? "");
    const args = words.slice(i + 1);
    if (["bash", "sh", "zsh"].includes(head) && args[0] === "-c" && args[1] !== undefined) {
      const inner = depth < 2 ? classifyDestructiveOp(args[1], depth + 1) : null;
      if (inner !== null) return inner;
    } else if (head === "eval" && depth < 2) {
      const inner = classifyDestructiveOp(args.join(" "), depth + 1);
      if (inner !== null) return inner;
    } else if (head === "rm") {
      const targets = rmTargets(args).map((t) => expand(t, vars));
      const disposable = targets.length > 0 && targets.every(isDisposablePath);
      if (recursiveForce(args) && !disposable) return "rm-rf";
    } else if (head === "git") {
      let at = 0;
      while (/^-/.test(args[at] ?? "")) at += args[at] === "-C" || args[at] === "-c" ? 2 : 1;
      const sub = args[at];
      const rest = args.slice(at + 1);
      if (sub === "reset" && rest.includes("--hard")) return "git-reset-hard";
      if (
        sub === "clean" &&
        rest.some((a) => /^-[^-]*f/.test(a) || a === "--force") &&
        !rest.some((a) => /^-[^-]*n/.test(a) || a === "--dry-run")
      )
        return "git-clean";
    } else if (!SEARCH_OR_PRINT.has(head)) {
      const text = words.slice(i).join(" ");
      if (SQL_DROP.test(text)) return "sql-drop";
      if (SQL_TRUNCATE.test(text)) return "truncate";
    }
  }
  return null;
}
