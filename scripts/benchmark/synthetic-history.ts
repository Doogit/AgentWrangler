/**
 * Reproducible, synthetic-only daemon-route profile.
 *
 * Run from the repository root:
 *   node --import tsx/esm scripts/benchmark/synthetic-history.ts
 *
 * Each scale gets a new temporary SQLite database and a separate loopback child
 * server. The parent is only the client/controller, so child CPU, RSS, and
 * event-loop samples exclude HTTP-client work. No operator config, credentials,
 * transcripts, scan roots, network clients, or src/daemon/index.ts are used.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/db/migrate.js";
import { type Db, openDb } from "../../src/db/open.js";

const SCALES = [1_000, 10_000, 100_000] as const;
const WARM_SAMPLES = 30;
const REQUEST_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 60_000;
const IDLE_MS = 1_000;

const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOW_FROM = "2026-01-01T00:00:00.000Z";
const WINDOW_TO = "2026-01-15T00:00:00.000Z";
const encodedWindow = `from=${encodeURIComponent(WINDOW_FROM)}&to=${encodeURIComponent(WINDOW_TO)}`;

type ChildEvent = Record<string, unknown> & { event: string };
type Pending = {
  resolve: (event: ChildEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

interface ChildHarness {
  port: number;
  command(command: Record<string, unknown>): Promise<ChildEvent>;
  close(): Promise<void>;
}

interface HttpResult {
  status: number;
  body: string;
  elapsedMs: number;
}

function percentile(samples: number[], quantile: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function request(port: number, route: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = http.get(
      { hostname: "127.0.0.1", port, path: route, timeout: REQUEST_TIMEOUT_MS },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            elapsedMs: performance.now() - started,
          }),
        );
        response.on("error", reject);
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error(`${route} timed out after ${REQUEST_TIMEOUT_MS}ms`)),
    );
    req.on("error", reject);
  });
}

function requireRouteSuccess(route: string, result: HttpResult, expectedTurns: number): void {
  if (result.status !== 200) throw new Error(`${route} returned HTTP ${result.status}`);
  const body = JSON.parse(result.body) as Record<string, unknown>;
  const data = body.data ?? body;
  if (route === "overview" && (data as { turns?: number } | undefined)?.turns !== expectedTurns)
    throw new Error("Overview returned an unexpected synthetic turn count");
  if (
    [
      "workspaces",
      "hot_sessions",
      "workspace_sessions",
      "session_turns",
      "session_drivers",
    ].includes(route) &&
    !JSON.stringify(data).includes(
      route === "workspaces" ? "synthetic-ws-0" : "synthetic-session-0",
    )
  )
    throw new Error(`${route} response did not retain the expected synthetic identity`);
  if (
    ["trends", "cache_write"].includes(route) &&
    (!data ||
      !Array.isArray((data as { buckets?: unknown }).buckets) ||
      !(data as { buckets: unknown[] }).buckets.length)
  )
    throw new Error(`${route} response did not include populated synthetic buckets`);
  if (route === "flavor" && (!data || Object.keys(data as Record<string, unknown>).length === 0))
    throw new Error("flavor response was unexpectedly empty for synthetic history");
}

function removeSyntheticDirectory(tempDir: string): void {
  const resolved = path.resolve(tempDir);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("agent-wrangler-synthetic-")
  )
    throw new Error("Refusing cleanup outside the synthetic temporary directory");
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
}

function startChild(dbPath: string, claudeDir: string): Promise<ChildHarness> {
  return new Promise((resolve, reject) => {
    const childScript = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "synthetic-daemon-child.ts",
    );
    const child = childProcess.spawn(
      process.execPath,
      ["--import", "tsx/esm", childScript, "--db", dbPath, "--claude-dir", claudeDir],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const pending: Pending[] = [];
    let ready = false;
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let stderr = "";
    let resolveExited: (() => void) | undefined;
    const exitedPromise = new Promise<void>((resolveExitedPromise) => {
      resolveExited = resolveExitedPromise;
    });
    const waitForExit = async (timeoutMs: number): Promise<boolean> => {
      if (exited) return true;
      return new Promise((resolveWait) => {
        const timer = setTimeout(() => resolveWait(false), timeoutMs);
        void exitedPromise.then(() => {
          clearTimeout(timer);
          resolveWait(true);
        });
      });
    };
    const terminate = async (): Promise<void> => {
      if (exited) return;
      child.kill();
      await exitedPromise;
    };
    const rejectPending = (error: Error): void => {
      while (pending.length) {
        const current = pending.shift();
        if (current) {
          clearTimeout(current.timer);
          current.reject(error);
        }
      }
    };
    const failStartup = async (error: Error): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      rejectPending(error);
      await terminate();
      reject(error);
    };
    const startupTimer = setTimeout(() => {
      void failStartup(new Error("Synthetic daemon child did not become ready within 30 seconds"));
    }, 30_000);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let event: ChildEvent;
        try {
          event = JSON.parse(line) as ChildEvent;
        } catch {
          continue;
        }
        if (event.event === "ready") {
          const port = Number(event.port);
          if (!Number.isInteger(port) || port <= 0) {
            void failStartup(new Error("Synthetic daemon child reported an invalid port"));
            return;
          }
          ready = true;
          settled = true;
          clearTimeout(startupTimer);
          resolve({
            port,
            command(command): Promise<ChildEvent> {
              return new Promise((commandResolve, commandReject) => {
                const timer = setTimeout(() => {
                  const index = pending.findIndex((entry) => entry.reject === commandReject);
                  if (index >= 0) pending.splice(index, 1);
                  void terminate().then(
                    () =>
                      commandReject(
                        new Error(
                          `Child command ${String(command.command)} timed out after ${COMMAND_TIMEOUT_MS}ms`,
                        ),
                      ),
                    (error: unknown) =>
                      commandReject(error instanceof Error ? error : new Error(String(error))),
                  );
                }, COMMAND_TIMEOUT_MS);
                pending.push({ resolve: commandResolve, reject: commandReject, timer });
                child.stdin.write(`${JSON.stringify(command)}\n`);
              });
            },
            async close(): Promise<void> {
              if (!exited) child.stdin.write('{"command":"shutdown"}\n');
              if (!(await waitForExit(10_000))) {
                await terminate();
                throw new Error("Child shutdown timed out and was terminated");
              }
              if (exitCode !== 0) throw new Error(`Child exited ${exitCode}; ${stderr}`);
            },
          });
          continue;
        }
        const next = pending.shift();
        if (next) {
          clearTimeout(next.timer);
          next.resolve(event);
        }
      }
    });
    child.on("error", (error) => {
      if (!ready) void failStartup(error);
      else rejectPending(error);
    });
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      resolveExited?.();
      if (!ready) void failStartup(new Error(`Synthetic daemon child exited ${code}; ${stderr}`));
      else if (code !== 0)
        rejectPending(new Error(`Synthetic daemon child exited ${code}; ${stderr}`));
    });
    child.on("close", (code) => {
      if (exited) return;
      exited = true;
      exitCode = code;
      resolveExited?.();
      if (!ready) void failStartup(new Error(`Synthetic daemon child closed ${code}; ${stderr}`));
      else if (code !== 0)
        rejectPending(new Error(`Synthetic daemon child closed ${code}; ${stderr}`));
    });
  });
}

function seedSyntheticHistory(db: Db, turns: number): void {
  const sessions = Math.ceil(turns / 200);
  const workspaces = Math.min(10, sessions);
  const baseMs = Date.parse(WINDOW_FROM);
  const timestampFor = (turn: number): string =>
    new Date(baseMs + Math.floor((turn * 14 * DAY_MS) / turns)).toISOString();
  const insertWorkspace = db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?,?,?)",
  );
  const insertSession = db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
      state, turn_count, cost_equiv_u, hygiene_flags) VALUES (?,?,?,?,?,?,?,?,'[]')`,
  );
  const insertTurn = db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
      input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
      cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
      provisional, parser_version) VALUES (?,?,?,?,?,0,?,?,?,?,0,0,NULL,NULL,?,'LIST_EQUIV',0,'synthetic-v1')`,
  );
  db.transaction(() => {
    for (let workspace = 0; workspace < workspaces; workspace += 1) {
      // repo_path remains NULL: no local checkout is supplied to safe jobs.
      insertWorkspace.run(
        `synthetic-ws-${workspace}`,
        `synthetic-project-${workspace}`,
        WINDOW_FROM,
      );
    }
    for (let session = 0; session < sessions; session += 1) {
      const workspace = session % workspaces;
      const firstTurn = session * 200;
      const turnsInSession = Math.min(200, turns - firstTurn);
      insertSession.run(
        `synthetic-session-${session}`,
        `synthetic-ws-${workspace}`,
        `synthetic://session-${session}`,
        timestampFor(firstTurn),
        timestampFor(firstTurn + turnsInSession - 1),
        "RECONCILED",
        turnsInSession,
        turnsInSession * 100,
      );
      for (let offset = 0; offset < turnsInSession; offset += 1) {
        const turn = firstTurn + offset;
        insertTurn.run(
          `synthetic-message-${turn}`,
          `synthetic-session-${session}`,
          `synthetic-ws-${workspace}`,
          timestampFor(turn),
          "synthetic-model",
          400,
          80,
          200,
          100,
          100,
        );
      }
    }
  })();
}

const routes = (workspaceId: string, sessionId: string): Array<{ name: string; path: string }> => [
  { name: "overview", path: `/api/overview?${encodedWindow}` },
  { name: "workspaces", path: `/api/workspaces?${encodedWindow}` },
  { name: "trends", path: `/api/trends?${encodedWindow}&bucket=day` },
  { name: "flavor", path: `/api/overview/flavor?${encodedWindow}` },
  { name: "cache_write", path: `/api/trends/cache-write?${encodedWindow}` },
  { name: "recommendations", path: "/api/recommendations" },
  { name: "live", path: "/api/live" },
  { name: "hot_sessions", path: `/api/hot-sessions?${encodedWindow}` },
  { name: "status", path: "/api/status" },
  { name: "workspace_sessions", path: `/api/workspaces/${workspaceId}/sessions?${encodedWindow}` },
  { name: "session_turns", path: `/api/sessions/${sessionId}/turns?limit=100` },
  { name: "session_drivers", path: `/api/sessions/${sessionId}/drivers` },
];

async function profile(scale: number): Promise<Record<string, unknown>> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wrangler-synthetic-"));
  const dbPath = path.join(tempDir, "synthetic.sqlite");
  const claudeDir = path.join(tempDir, "empty-claude");
  fs.mkdirSync(claudeDir);
  let db: ReturnType<typeof openDb> | undefined;
  let child: ChildHarness | undefined;
  let result: Record<string, unknown> | undefined;
  let profileError: unknown;
  try {
    db = openDb(dbPath);
    runMigrations(db);
    seedSyntheticHistory(db, scale);
    db.close();
    db = undefined;
    child = await startChild(dbPath, claudeDir);
    const routeResults: Record<string, unknown>[] = [];
    for (const route of routes("synthetic-ws-0", "synthetic-session-0")) {
      const cold = await request(child.port, route.path);
      requireRouteSuccess(route.name, cold, scale);
      const warm: number[] = [];
      for (let index = 0; index < WARM_SAMPLES; index += 1) {
        const sample = await request(child.port, route.path);
        requireRouteSuccess(route.name, sample, scale);
        warm.push(sample.elapsedMs);
      }
      routeResults.push({
        name: route.name,
        cold_ms: Number(cold.elapsedMs.toFixed(3)),
        warm_p50_ms: Number(percentile(warm, 0.5).toFixed(3)),
        warm_p95_ms: Number(percentile(warm, 0.95).toFixed(3)),
      });
    }
    const safeJobs = await child.command({ command: "safe-jobs" });
    const idle = await child.command({ command: "idle", durationMs: IDLE_MS });
    result = {
      scale_turns: scale,
      routes: routeResults,
      safe_jobs: safeJobs.jobs,
      safe_job_dispatch: safeJobs.dispatch,
      idle: idle.sample,
    };
  } catch (error) {
    profileError = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    if (child) await child.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (db) db.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    removeSyntheticDirectory(tempDir);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (profileError && cleanupErrors.length)
    throw new AggregateError(
      [profileError, ...cleanupErrors],
      "Synthetic profile and cleanup failed",
    );
  if (profileError) throw profileError;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "Synthetic profile cleanup failed");
  if (!result) throw new Error("Synthetic profile completed without a result");
  return result;
}

async function main(): Promise<void> {
  const results: Record<string, unknown>[] = [];
  for (const scale of SCALES) results.push(await profile(scale));
  console.log(
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        synthetic_only: true,
        cold_definition:
          "first request to each route after fresh child boot and seed; it is not a process-startup timer",
        warm_definition: `${WARM_SAMPLES} sequential requests per route; p50 and nearest-rank p95`,
        idle_definition: `${IDLE_MS}ms after safe jobs complete; no production interval timers are started`,
        excluded: [
          "src/daemon/index.ts",
          "ingestion/tailers and scan roots",
          "credential discovery and GitHub outcomes",
          "git churn collector",
          "operator settings/config",
          "operator Claude transcript/history paths",
          "external network",
        ],
        results,
      },
      null,
      2,
    ),
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
