/**
 * Fail-open Claude Code PreToolUse hook for AgentWrangler context budgets.
 * It intentionally has no package dependencies, never exits non-zero, and never
 * denies a tool call — both thresholds are warn-only (a deny at the hard threshold
 * would block the very checkpoint/clear it prescribes).
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REQUEST_TIMEOUT_MS = 500;
const SOFT_DEBOUNCE_MS = 60_000;

/** Convert an endpoint stage to the only hook output it may emit. */
export function stageToStdout(stage) {
  if (stage === "hard") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Context budget at its urgent threshold.",
      },
      additionalContext:
        "Context budget is at its urgent threshold. Checkpoint now, then run /clear.",
      systemMessage:
        "AgentWrangler: context budget at its urgent threshold. Checkpoint now, then run /clear.",
    });
  }
  if (stage === "soft") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Context budget approaching its limit.",
      },
      additionalContext:
        "Context budget is approaching its limit. Checkpoint, then run /clear or /compact soon.",
      systemMessage:
        "AgentWrangler: context budget is approaching its limit. Checkpoint, then run /clear or /compact soon.",
    });
  }
  return "";
}

function markerPath(sessionId) {
  const markerRoot =
    process.env.AW_HOOK_MARKER_DIR ?? path.join(os.homedir(), ".agentwrangler", "hook-markers");
  return path.join(markerRoot, `context-budget-${encodeURIComponent(sessionId)}.marker`);
}

function shouldEmitSoft(sessionId) {
  const file = markerPath(sessionId);
  const now = Date.now();
  try {
    const previous = Number(fs.readFileSync(file, "utf8"));
    if (Number.isFinite(previous) && now - previous < SOFT_DEBOUNCE_MS) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(now), { encoding: "utf8", mode: 0o600 });
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, String(now), { encoding: "utf8", mode: 0o600 });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
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

function fetchBudget(sessionId) {
  return new Promise((resolve, reject) => {
    const port = process.env.AW_PORT ?? "47821";
    const request = http.get(
      `http://127.0.0.1:${port}/api/context-budget?session_id=${encodeURIComponent(sessionId)}`,
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error("non-200 response"));
          return;
        }
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          try {
            const body = JSON.parse(raw);
            resolve(body?.data);
          } catch {
            reject(new Error("invalid response"));
          }
        });
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    const sessionId = input?.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    const budget = await fetchBudget(sessionId);
    const stage = budget?.stage;
    if (stage === "soft" && !shouldEmitSoft(sessionId)) return;
    const output = stageToStdout(stage);
    if (output) process.stdout.write(output);
  } catch {
    // Hooks must never block Claude Code if AgentWrangler is unavailable.
  }
}

const invoked =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) void main();
