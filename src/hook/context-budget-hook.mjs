/**
 * Fail-open Claude Code PreToolUse hook for AgentWrangler context budgets.
 * It intentionally has no package dependencies, never exits non-zero, and never
 * decides a tool call's permission — both thresholds are warn-only (a deny at the hard
 * threshold would block the very commit/handoff it prescribes).
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REQUEST_TIMEOUT_MS = 500;
const DEBOUNCE_MS = 60_000;

/** "250k" for 250000; null when the endpoint gave no usable count. */
function kTokens(n) {
  return Number.isFinite(n) && n > 0 ? `${Math.round(n / 1000)}k` : null;
}

/**
 * Convert an endpoint stage to the only hook output it may emit.
 * additionalContext must sit inside hookSpecificOutput: Claude Code ignores it at the top level,
 * and systemMessage is shown to the user only. No permissionDecision: an "allow" would skip the
 * user's permission prompt for the tool call this warning rides on.
 */
export function stageToStdout(stage, budget) {
  const tokens = kTokens(budget?.context_tokens);
  const at = tokens ? `Context is at ${tokens} tokens. ` : "";
  let message;
  if (stage === "hard") {
    message = `${at}Commit your work now, write a handoff with the repo's handoff skill (or handoff-global), then ask the operator to run /clear.`;
  } else if (stage === "soft") {
    message = `${at}Context budget is approaching its limit. Reach a checkpoint soon; at the urgent threshold you will be asked to commit and hand off.`;
  } else {
    return "";
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message },
    systemMessage: `AgentWrangler: ${message}`,
  });
}

/** Marker key: session, plus agent for a subagent, so a subagent crossing never silences the main thread. */
function markerPath(sessionId, agentId, stage) {
  const markerRoot =
    process.env.AW_HOOK_MARKER_DIR ?? path.join(os.homedir(), ".agentwrangler", "hook-markers");
  const key =
    encodeURIComponent(sessionId) + (agentId ? `-agent-${encodeURIComponent(agentId)}` : "");
  return path.join(markerRoot, `context-budget-${stage}-${key}.marker`);
}

/** One warning per stage per minute, so a reached threshold doesn't land in context on every tool call. */
function shouldEmit(sessionId, agentId, stage) {
  const file = markerPath(sessionId, agentId, stage);
  const now = Date.now();
  try {
    const previous = Number(fs.readFileSync(file, "utf8"));
    if (Number.isFinite(previous) && now - previous < DEBOUNCE_MS) return false;
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

function fetchBudget(sessionId, agentId) {
  return new Promise((resolve, reject) => {
    const port = process.env.AW_PORT ?? "2929";
    const agentParam = agentId ? `&agent_id=${encodeURIComponent(agentId)}` : "";
    const request = http.get(
      `http://127.0.0.1:${port}/api/context-budget?session_id=${encodeURIComponent(sessionId)}${agentParam}`,
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
    const agentId = typeof input?.agent_id === "string" && input.agent_id ? input.agent_id : null;
    // A subagent call without an agent_id can't be scoped: warn nothing rather than misattribute.
    if (agentId === null && input?.agent_type !== undefined) return;
    const budget = await fetchBudget(sessionId, agentId);
    const stage = budget?.stage;
    if ((stage === "soft" || stage === "hard") && !shouldEmit(sessionId, agentId, stage)) return;
    const output = stageToStdout(stage, budget);
    if (output) process.stdout.write(output);
  } catch {
    // Hooks must never block Claude Code if AgentWrangler is unavailable.
  }
}

const invoked =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) void main();
