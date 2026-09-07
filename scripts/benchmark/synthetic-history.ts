/**
 * Reproducible synthetic-history profile for the Overview HTTP route.
 *
 * Run from the repository root:
 *   node --import tsx/esm scripts/benchmark/synthetic-history.ts
 *
 * This harness creates one temporary on-disk SQLite database for each scale,
 * applies the normal migrations, and inserts synthetic identifiers and token
 * counts only. It never reads Claude transcripts or any operator configuration.
 * Client and server share this process: the socket timeout is not a hard query
 * deadline, and idle samples describe this harness without daemon background jobs.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createServer } from "../../src/daemon/http.js";
import { runMigrations } from "../../src/db/migrate.js";
import { type Db, openDb } from "../../src/db/open.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";

const SCALES = [1_000, 10_000, 100_000] as const;
const WARM_SAMPLES = 30;
const IDLE_MS = 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOW_FROM = "2026-01-01T00:00:00.000Z";
const WINDOW_TO = "2026-01-15T00:00:00.000Z";

interface HttpResult {
  status: number;
  body: string;
}

interface ScaleResult {
  turns: number;
  cold_ms: number;
  warm_ms: { samples: number; p50: number; p95: number };
  idle: { duration_ms: number; cpu_delta_us: number; rss_bytes: number; event_loop_p95_ms: number };
}

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? 0;
}

function request(port: number): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path: `/api/overview?from=${encodeURIComponent(WINDOW_FROM)}&to=${encodeURIComponent(WINDOW_TO)}`,
        headers: { host: `127.0.0.1:${port}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("Overview request timed out")));
    req.end();
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected an ephemeral TCP port");
  return address.port;
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seedSyntheticHistory(db: Db, turns: number): void {
  const sessions = Math.ceil(turns / 200);
  const workspaces = Math.min(10, sessions);
  const baseMs = Date.parse(WINDOW_FROM);
  const timestampFor = (turn: number) =>
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
      const firstTs = timestampFor(firstTurn);
      const lastTs = timestampFor(firstTurn + turnsInSession - 1);
      insertSession.run(
        `synthetic-session-${session}`,
        `synthetic-ws-${workspace}`,
        `synthetic://session-${session}`,
        firstTs,
        lastTs,
        "RECONCILED",
        turnsInSession,
        turnsInSession * 100,
      );
      for (let offset = 0; offset < turnsInSession; offset += 1) {
        const turn = firstTurn + offset;
        const timestamp = timestampFor(turn);
        insertTurn.run(
          `synthetic-message-${turn}`,
          `synthetic-session-${session}`,
          `synthetic-ws-${workspace}`,
          timestamp,
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

function requireSuccess(result: HttpResult, expectedTurns: number): void {
  if (result.status !== 200) throw new Error(`Overview returned HTTP ${result.status}`);
  const body = JSON.parse(result.body) as { data?: { turns?: number } };
  if (body.data?.turns !== expectedTurns) {
    throw new Error(
      `Overview returned ${String(body.data?.turns)} turns; expected ${expectedTurns}`,
    );
  }
}

function removeSyntheticDirectory(tempDir: string): void {
  const resolved = path.resolve(tempDir);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("agentwrangler-synthetic-history-")
  )
    throw new Error("Refusing cleanup outside the synthetic temporary directory");
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function profileScale(turns: number): Promise<ScaleResult> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentwrangler-synthetic-history-"));
  let db: Db | undefined;
  let server: http.Server | undefined;
  try {
    db = openDb(path.join(tempDir, "history.sqlite"));
    runMigrations(db);
    seedSyntheticHistory(db, turns);
    setQueryDb(db);
    server = createServer(db, 0, null);
    const port = await listen(server);

    const coldStart = performance.now();
    const cold = await request(port);
    const coldMs = performance.now() - coldStart;
    requireSuccess(cold, turns);

    const warmSamples: number[] = [];
    for (let sample = 0; sample < WARM_SAMPLES; sample += 1) {
      const started = performance.now();
      const result = await request(port);
      warmSamples.push(performance.now() - started);
      requireSuccess(result, turns);
    }

    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    const cpuBefore = process.cpuUsage();
    await sleep(IDLE_MS);
    const cpu = process.cpuUsage(cpuBefore);
    const idle = {
      duration_ms: IDLE_MS,
      cpu_delta_us: cpu.user + cpu.system,
      rss_bytes: process.memoryUsage().rss,
      event_loop_p95_ms: loopDelay.percentile(95) / 1_000_000,
    };
    loopDelay.disable();

    return {
      turns,
      cold_ms: coldMs,
      warm_ms: {
        samples: warmSamples.length,
        p50: percentile(warmSamples, 0.5),
        p95: percentile(warmSamples, 0.95),
      },
      idle,
    };
  } finally {
    resetQueryDb();
    try {
      if (server?.listening) await close(server);
    } finally {
      db?.close();
      removeSyntheticDirectory(tempDir);
    }
  }
}

async function main(): Promise<void> {
  const metadata = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    memory_bytes: os.totalmem(),
    endpoint: "GET /api/overview",
    warm_samples_per_scale: WARM_SAMPLES,
    synthetic_only: true,
  };
  const results: ScaleResult[] = [];
  for (const turns of SCALES) results.push(await profileScale(turns));
  console.log(JSON.stringify({ metadata, results }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
