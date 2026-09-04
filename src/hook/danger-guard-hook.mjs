/**
 * Claude Code PreToolUse guard for catastrophic Bash commands.
 *
 * Warn-first by design: it hard-DENIES only an unambiguous catastrophe list and
 * ASKS for the ambiguous shapes. It has no package dependencies.
 *
 * Failure asymmetry is deliberate:
 *  - malformed stdin fails OPEN (allow) — a guard must never brick a session;
 *  - a missing / empty / unparseable deny-list data file fails CLOSED to the
 *    embedded baseline below, so deleting one file cannot silently downgrade
 *    every hard-deny to ask.
 *
 * Deny responses use the JSON `permissionDecision:"deny"` form, which holds even
 * under bypass permissions mode — not an exit-code-only block. The hook always
 * exits 0 and never echoes the raw command back (SEC-101).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * The release-time catastrophe baseline, embedded so the guard still denies the
 * worst commands when the on-disk deny-list is absent or corrupt. The shipped
 * data file (`danger-guard-denylist.json`) is the extensible copy; users edit
 * THAT, not this. Patterns are JS RegExp sources (no flags); each rule carries a
 * static reason — never the command text.
 */
export const EMBEDDED_BASELINE = {
  deny: [
    {
      pattern:
        "(?:^|[\\s;&|(])rm\\s+(?:-\\S*\\s+)*-\\S*r\\S*\\s+(?:[^;&|]*\\s)?(?:/|~|\\$HOME)(?:\\s|/|\\*|$)",
      reason: "recursive delete targeting your home directory or the filesystem root",
    },
    {
      pattern: "git\\s+push\\b(?=[^;&|]*(?:--force|-f)\\b)(?=[^;&|]*\\b(?:main|master)\\b)",
      reason: "force-push to a protected branch (main/master)",
    },
    {
      pattern: "\\b(?:curl|wget)\\b[^;&|]*\\|\\s*(?:sudo\\s+)?(?:sh|bash|zsh|dash|ksh)\\b",
      reason: "piping a downloaded script straight into a shell",
    },
  ],
  ask: [
    {
      pattern: "(?:^|[\\s;&|(])rm\\s+(?:-\\S*\\s+)*-\\S*r\\S*\\b",
      reason: "recursive delete — confirm the target before running",
    },
    {
      pattern: "git\\s+push\\b(?=[^;&|]*(?:--force|-f)\\b)",
      reason: "force-push — confirm the branch before running",
    },
  ],
};

/** Compile a raw ruleset ({deny,ask} of {pattern,reason}) to RegExp rules. Throws on bad shape. */
export function compileRuleset(raw) {
  if (raw === null || typeof raw !== "object") throw new Error("deny-list must be an object");
  const compileList = (list) => {
    if (!Array.isArray(list)) throw new Error("deny-list section must be an array");
    return list.map((item) => {
      if (item === null || typeof item !== "object") throw new Error("rule must be an object");
      const { pattern, reason } = item;
      if (typeof pattern !== "string" || typeof reason !== "string") {
        throw new Error("rule needs string pattern and reason");
      }
      return { re: new RegExp(pattern), reason };
    });
  };
  return { deny: compileList(raw.deny ?? []), ask: compileList(raw.ask ?? []) };
}

/**
 * Load and compile the on-disk deny-list. Any failure (missing file, unreadable,
 * unparseable JSON, bad shape, invalid regex) falls back to the embedded baseline
 * — fail-closed on the deny tier.
 */
export function loadDenyList(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return compileRuleset(raw);
  } catch {
    return compileRuleset(EMBEDDED_BASELINE);
  }
}

/** Evaluate a command against a compiled ruleset. Deny wins over ask; otherwise allow. */
export function evaluateCommand(command, ruleset) {
  if (typeof command !== "string" || command.length === 0) return { action: "allow" };
  for (const rule of ruleset.deny)
    if (rule.re.test(command)) return { action: "deny", reason: rule.reason };
  for (const rule of ruleset.ask)
    if (rule.re.test(command)) return { action: "ask", reason: rule.reason };
  return { action: "allow" };
}

/** Render a decision as the only PreToolUse output it may emit (allow → silence). */
export function decisionToStdout(decision) {
  if (decision.action === "deny") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `AgentWrangler blocked a dangerous command: ${decision.reason}.`,
      },
      systemMessage: `AgentWrangler blocked a dangerous command: ${decision.reason}.`,
    });
  }
  if (decision.action === "ask") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `AgentWrangler flagged a risky command: ${decision.reason}.`,
      },
    });
  }
  return "";
}

/** True when running under CI / headless automation, where the guard must no-op. */
function inCI() {
  const ci = process.env.CI;
  return typeof ci === "string" && ci !== "" && ci !== "false" && ci !== "0";
}

function denyListPath() {
  return (
    process.env.AW_DANGER_DENYLIST ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "danger-guard-denylist.json")
  );
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  });
}

async function main() {
  // No-op in CI: block nothing in headless runs (a top researched backfire).
  if (inCI()) return;
  try {
    const input = JSON.parse(await readStdin());
    // Defensive: the matcher scopes us to Bash, but ignore anything else.
    if (typeof input?.tool_name === "string" && input.tool_name !== "Bash") return;
    const command = input?.tool_input?.command;
    if (typeof command !== "string") return;
    const decision = evaluateCommand(command, loadDenyList(denyListPath()));
    const output = decisionToStdout(decision);
    if (output) process.stdout.write(output);
  } catch {
    // Fail open: a malformed payload must never block Claude Code.
  }
}

const invoked =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) void main();
