/**
 * Fail-open Claude Code PreToolUse hook for AgentWrangler rate-limit burn.
 * It intentionally has no package dependencies and never exits non-zero.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WARN_PCT = 0.15;
const CHECKPOINT_PCT = 0.5;
const DEBOUNCE_SECONDS = 300;

/** Return the warning stage for a burn-status payload without side effects. */
export function stageFromStatus(status) {
  if (!status || status.available === false) return null;

  const fiveHour = status.five_hour?.utilization;
  const sevenDay = status.seven_day?.utilization;
  const atCheckpoint = fiveHour >= CHECKPOINT_PCT || sevenDay >= CHECKPOINT_PCT;
  if (atCheckpoint) return "checkpoint";
  if (fiveHour >= WARN_PCT || sevenDay >= WARN_PCT) return "soft";
  return null;
}

/** Convert an endpoint stage to the only hook output it may emit. */
export function stageToStdout(stage) {
  if (stage === "checkpoint") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
      additionalContext:
        "AgentWrangler: 5h or 7d rate-limit cap >=50% consumed. Checkpoint your work now.",
    });
  }
  if (stage === "soft") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
      additionalContext:
        "AgentWrangler: 5h or 7d rate-limit cap >=15% consumed. Consider checkpointing.",
    });
  }
  return "";
}

function markerPath(sessionId) {
  const markerRoot = path.join(os.homedir(), ".agentwrangler", "hook-markers");
  return path.join(markerRoot, `limit-burn-${encodeURIComponent(sessionId)}.marker`);
}

function shouldEmit(sessionId) {
  const file = markerPath(sessionId);
  const now = Math.floor(Date.now() / 1_000);
  try {
    const previous = Number(fs.readFileSync(file, "utf8"));
    if (Number.isFinite(previous) && now - previous < DEBOUNCE_SECONDS) return false;
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
        // Marker write failed — degrade to no-debounce so warnings are never silently dropped.
        return true;
      }
    }
    // Unexpected error — degrade to no-debounce so warnings are never silently dropped.
    return true;
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

async function fetchBurnStatus() {
  const port = process.env.AW_PORT ?? 47821;
  const response = await fetch(`http://127.0.0.1:${port}/api/burn-status`, {
    signal: AbortSignal.timeout(500),
  });
  if (response.status !== 200) return null;
  return response.json();
}

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    const sessionId = input?.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;

    const status = await fetchBurnStatus();
    if (!status || status.available === false) return;

    const stage = stageFromStatus(status);
    if (!stage || !shouldEmit(sessionId)) return;

    const output = stageToStdout(stage);
    if (output) process.stdout.write(output);
  } catch {
    // Hooks must never block Claude Code if AgentWrangler is unavailable.
  }
}

const invoked =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.normalize(
      decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"),
    );
if (invoked) void main();
