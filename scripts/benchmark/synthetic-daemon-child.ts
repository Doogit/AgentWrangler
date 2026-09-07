import * as fs from "node:fs";
/** Isolated child used by synthetic-history.ts.  It accepts only temp paths. */
import type * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createServer } from "../../src/daemon/http.js";
import { openDb } from "../../src/db/open.js";
import { runContextProbe } from "../../src/detector/context-probe.js";
import { runDetectors } from "../../src/detector/index.js";
import { runMeasurementPass } from "../../src/detector/measurement.js";
import { generateWeeklyReport } from "../../src/query/api/reports.js";
import { setQueryDb } from "../../src/query/db-context.js";

type Command = { command: "safe-jobs" | "idle" | "shutdown"; durationMs?: number };

const arg = (name: string): string => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const emit = (value: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nextTimer = (): Promise<void> => delay(0);

function requireSyntheticTempPaths(
  dbPath: string,
  claudeDir: string,
): { dbPath: string; claudeDir: string } {
  if (!path.isAbsolute(dbPath) || !path.isAbsolute(claudeDir))
    throw new Error("Child requires absolute synthetic temporary paths");
  const databaseStat = fs.lstatSync(dbPath);
  const claudeStat = fs.lstatSync(claudeDir);
  if (
    databaseStat.isSymbolicLink() ||
    claudeStat.isSymbolicLink() ||
    !databaseStat.isFile() ||
    !claudeStat.isDirectory()
  )
    throw new Error("Child rejects linked or invalid synthetic paths");
  const resolvedDb = fs.realpathSync(dbPath);
  const resolvedClaudeDir = fs.realpathSync(claudeDir);
  const root = path.dirname(resolvedDb);
  const tempRoot = fs.realpathSync(os.tmpdir());
  if (
    path.basename(resolvedDb) !== "synthetic.sqlite" ||
    path.basename(resolvedClaudeDir) !== "empty-claude" ||
    path.dirname(resolvedClaudeDir) !== root ||
    path.dirname(root) !== tempRoot ||
    !path.basename(root).startsWith("agent-wrangler-synthetic-")
  )
    throw new Error("Child accepts only the harness synthetic temporary directory");
  return { dbPath: resolvedDb, claudeDir: resolvedClaudeDir };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Child server did not bind a TCP port");
  return address.port;
}

async function sampleJob(
  name: string,
  task: () => Promise<void>,
): Promise<Record<string, unknown>> {
  const beforeCpu = process.cpuUsage();
  const before = performance.now();
  await task();
  const elapsedMs = performance.now() - before;
  const cpu = process.cpuUsage(beforeCpu);
  return {
    name,
    elapsed_ms: Number(elapsedMs.toFixed(3)),
    cpu_ms: Number(((cpu.user + cpu.system) / 1_000).toFixed(3)),
    rss_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
  };
}

async function sampleIdle(durationMs: number): Promise<Record<string, unknown>> {
  const duration = Math.max(100, Math.min(10_000, durationMs));
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const beforeCpu = process.cpuUsage();
  const before = performance.now();
  await delay(duration);
  const elapsedMs = performance.now() - before;
  const cpu = process.cpuUsage(beforeCpu);
  loop.disable();
  return {
    duration_ms: Number(elapsedMs.toFixed(1)),
    cpu_ms: Number(((cpu.user + cpu.system) / 1_000).toFixed(3)),
    cpu_percent: Number((((cpu.user + cpu.system) / 1_000 / elapsedMs) * 100).toFixed(2)),
    rss_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
    event_loop_p50_ms: Number((loop.percentile(50) / 1e6).toFixed(3)),
    event_loop_p95_ms: Number((loop.percentile(95) / 1e6).toFixed(3)),
  };
}

async function main(): Promise<void> {
  const paths = requireSyntheticTempPaths(arg("--db"), arg("--claude-dir"));
  const db = openDb(paths.dbPath);
  setQueryDb(db);
  const server = createServer(db, 0, null);
  const port = await listen(server);
  emit({ event: "ready", port, pid: process.pid });

  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line.trim()) continue;
      void handle(JSON.parse(line) as Command);
    }
  });

  async function handle(command: Command): Promise<void> {
    if (command.command === "safe-jobs") {
      const now = new Date("2026-01-15T12:00:00.000Z");
      const jobs: Record<string, unknown>[] = [];
      await nextTimer();
      jobs.push(
        await sampleJob("context_probe_empty_temp", async () => {
          await runContextProbe(db, now, { claudeDir: paths.claudeDir });
        }),
      );
      await nextTimer();
      jobs.push(
        await sampleJob("detectors", async () => {
          await runDetectors(db, { now });
        }),
      );
      await nextTimer();
      jobs.push(
        await sampleJob("measurement_force", async () => {
          await runMeasurementPass(db, now, { force: true });
        }),
      );
      await nextTimer();
      jobs.push(
        await sampleJob("weekly_report", async () => {
          await generateWeeklyReport(db, now);
        }),
      );
      emit({ event: "safe-jobs", dispatch: "one-shot setTimeout(0) before each job", jobs });
      return;
    }
    if (command.command === "idle") {
      emit({ event: "idle", sample: await sampleIdle(command.durationMs ?? 1_000) });
      return;
    }
    if (command.command === "shutdown") {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      db.close();
      emit({ event: "shutdown" });
      process.exit(0);
    }
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
