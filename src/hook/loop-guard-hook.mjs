/**
 * Fail-open Claude Code PreToolUse hook for AgentWrangler's D7 loop guard.
 * It deliberately exposes neither tool input nor tool output.
 */

import * as http from "node:http";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REQUEST_TIMEOUT_MS = 500;

/** Convert a loop-guard stage to the only hook output it may emit. */
export function stageToStdout(stage, reason) {
  if (stage === "block") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Repeated identical failures detected. Restate the latest failure and change the approach before retrying.",
      },
      systemMessage:
        "AgentWrangler: repeated identical failures detected. Restate the latest failure and change the approach before retrying.",
    });
  }
  if (stage === "warn") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason:
          "Repeated identical failures are approaching the guard threshold.",
      },
      additionalContext:
        "Repeated identical failures are approaching the guard threshold. Restate the latest failure and change the approach before retrying.",
      systemMessage:
        "AgentWrangler: repeated identical failures are approaching the guard threshold. Change the approach before retrying.",
    });
  }
  void reason;
  return "";
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

function fetchGuard(sessionId) {
  return new Promise((resolve, reject) => {
    const port = process.env.AW_PORT ?? "47821";
    const request = http.get(
      `http://127.0.0.1:${port}/api/loop-guard?session_id=${encodeURIComponent(sessionId)}`,
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
            resolve(JSON.parse(raw)?.data);
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
    const guard = await fetchGuard(sessionId);
    const output = stageToStdout(guard?.stage, guard?.reason);
    if (output) await new Promise((resolve) => process.stdout.write(output, resolve));
  } catch {
    // Hooks must never block Claude Code when AgentWrangler is unavailable.
  } finally {
    process.exit(0);
  }
}

const invoked =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) void main();
