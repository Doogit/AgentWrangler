/** Live Claude Code agent measurements and confirm-gated session termination. */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { capWeightExprSql, resolveCapReadCoeff } from "../cap-weighted.js";
import { getQueryDb } from "../db-context.js";
import { type ApiResponse, buildResponse } from "../envelope.js";

const LIVENESS_UNAVAILABLE = "liveness unknown: Claude Code CLI not found or too old";
const CACHE_MS = 30_000;

export interface LiveAgent {
  session_id: string;
  pid: number | null;
  workspace_id: string | null;
  cwd: string;
  kind: string;
  status: string;
  name: string;
  started_at: string;
  idle_seconds: number;
  cap_weighted_context_held: number;
}

export interface AgentsLivenessResult {
  available: boolean;
  reason: string | null;
  agents: LiveAgent[];
}

export interface EndSessionResult {
  ok: boolean;
  ended?: number;
  reason?: string;
  status: number;
}

interface AgentRow {
  sessionId?: unknown;
  pid?: unknown;
  cwd?: unknown;
  kind?: unknown;
  status?: unknown;
  state?: unknown;
  name?: unknown;
  startedAt?: unknown;
}

interface SessionUsageRow {
  workspace_id: string | null;
  last_activity_ts: string | null;
  cap_weighted_raw: number | null;
}

let cached: { at: number; result: ApiResponse<AgentsLivenessResult> } | null = null;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function unavailable(): ApiResponse<AgentsLivenessResult> {
  const result: AgentsLivenessResult = {
    available: false,
    reason: LIVENESS_UNAVAILABLE,
    agents: [],
  };
  return buildResponse(result, { claim_kind: "OBS_PROXY", n: result.agents.length });
}

function runAgentsCommand(): Promise<string | null> {
  const childEnv = { ...process.env };
  // biome-ignore lint/performance/noDelete: the child must not inherit Claude's nesting guard.
  delete childEnv.CLAUDECODE;
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("CLAUDE_CODE_")) delete childEnv[key];
  }

  let child: ChildProcess;
  try {
    child = spawn("claude", ["agents", "--json"], {
      env: childEnv,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return Promise.resolve(null);
  }
  const stdoutStream = child.stdout;
  if (stdoutStream === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      settle(null);
    }, 5_000);
    stdoutStream.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", () => settle(null));
    child.once("close", (code) => settle(code === 0 ? stdout : null));
  });
}

function isAlive(pid: number): boolean {
  process.kill(pid, 0);
  return true;
}

function isProcessNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** End an agent process only after an explicit user confirmation. */
export function endSession(pid: unknown, confirm: unknown): EndSessionResult {
  if (confirm !== true) return { ok: false, reason: "confirmation required", status: 400 };
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: "invalid pid", status: 400 };
  }
  try {
    isAlive(pid);
  } catch (error) {
    if (isProcessNotFound(error)) return { ok: false, reason: "process not found", status: 404 };
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "unable to probe process",
      status: 500,
    };
  }

  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error("taskkill failed");
    } else {
      process.kill(pid, "SIGTERM");
      pause(100);
      try {
        isAlive(pid);
      } catch (error) {
        if (isProcessNotFound(error)) return { ok: true, ended: pid, status: 200 };
        throw error;
      }
      process.kill(pid, "SIGKILL");
    }
    return { ok: true, ended: pid, status: 200 };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "failed to end process",
      status: 500,
    };
  }
}

/** Return active Claude Code agents enriched with local, read-only usage measurements. */
export async function getAgentsLiveness(): Promise<ApiResponse<AgentsLivenessResult>> {
  if (cached !== null && Date.now() - cached.at < CACHE_MS) return cached.result;

  const stdout = await runAgentsCommand();
  if (stdout === null) return unavailable();

  let rawAgents: unknown;
  try {
    rawAgents = JSON.parse(stdout);
  } catch {
    return unavailable();
  }
  if (!Array.isArray(rawAgents)) return unavailable();

  try {
    const db = getQueryDb();
    const expr = capWeightExprSql("turns", resolveCapReadCoeff(db));
    const usage = db.prepare(
      `SELECT MAX(workspace_id) AS workspace_id,
              MAX(ts) AS last_activity_ts,
              COALESCE(SUM(${expr}), 0) AS cap_weighted_raw
         FROM turns
        WHERE session_id = ?`,
    );
    const now = Date.now();
    const agents: LiveAgent[] = [];
    for (const rawAgent of rawAgents) {
      if (typeof rawAgent !== "object" || rawAgent === null) continue;
      const agent = rawAgent as AgentRow;
      const sessionId = stringValue(agent.sessionId);
      if (sessionId.length === 0) continue;
      const usageRow = usage.get(sessionId) as SessionUsageRow;
      const lastActivityMs = Date.parse(usageRow.last_activity_ts ?? "");
      agents.push({
        session_id: sessionId,
        pid: typeof agent.pid === "number" && Number.isInteger(agent.pid) ? agent.pid : null,
        workspace_id: usageRow.workspace_id,
        cwd: stringValue(agent.cwd),
        kind: stringValue(agent.kind),
        status: stringValue(agent.status) || stringValue(agent.state),
        name: stringValue(agent.name),
        started_at: stringValue(agent.startedAt),
        idle_seconds: Number.isFinite(lastActivityMs)
          ? Math.floor(Math.max(0, now - lastActivityMs) / 1_000)
          : 0,
        cap_weighted_context_held: Math.round(usageRow.cap_weighted_raw ?? 0),
      });
    }
    const result: AgentsLivenessResult = { available: true, reason: null, agents };
    const response = buildResponse(result, { claim_kind: "OBS_PROXY", n: result.agents.length });
    cached = { at: now, result: response };
    return response;
  } catch {
    return unavailable();
  }
}
