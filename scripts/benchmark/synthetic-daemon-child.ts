import * as fs from "node:fs";
/** Isolated child used by synthetic-history.ts.  It accepts only temp paths. */
import type * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { runEffectMeasurementPass } from "../../src/daemon/effect-pass.js";
import { createServer } from "../../src/daemon/http.js";
import { createOutcomesPassRunner } from "../../src/daemon/outcomes-pass.js";
import { openDb } from "../../src/db/open.js";
import { configGet as bptConfigGet } from "../../src/detector/calibration.js";
import { runContextProbe } from "../../src/detector/context-probe.js";
import { runDetectors } from "../../src/detector/index.js";
import { runMeasurementPass } from "../../src/detector/measurement.js";
import { setPostIngestHook } from "../../src/ingest/detector-hook.js";
import { Ingestor, runBackscan } from "../../src/ingest/index.js";
import type { GithubClient } from "../../src/outcomes/github/client.js";
import { writeObservedOutcomes } from "../../src/outcomes/derive.js";
import { extractAllFindings } from "../../src/outcomes/findings.js";
import { linkSessions } from "../../src/outcomes/linker.js";
import { syncAllWorkspaces } from "../../src/outcomes/sync.js";
import { generateWeeklyReport } from "../../src/query/api/reports.js";
import { setQueryDb } from "../../src/query/db-context.js";

type Command = {
  command:
    | "safe-jobs"
    | "idle"
    | "shutdown"
    | "route-metrics"
    | "query-plans"
    | "ingest-catchup"
    | "recurring-jobs"
    | "direct-jobs";
  durationMs?: number;
  corpusDir?: string;
  windowMs?: number;
  /** recurring-jobs: floors 0 restore the pre-PERF5 ungated per-tick behavior. */
  gatingOff?: boolean;
  /** recurring-jobs: disable the growth appender to measure an idle window. */
  growthOff?: boolean;
};

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
): { dbPath: string; claudeDir: string; root: string } {
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
  return { dbPath: resolvedDb, claudeDir: resolvedClaudeDir, root };
}

/** The ingest corpus must live beside the synthetic database, named ingest-corpus. */
function requireSyntheticCorpusDir(corpusDir: string, root: string): string {
  if (!path.isAbsolute(corpusDir))
    throw new Error("Child requires an absolute synthetic corpus path");
  const stat = fs.lstatSync(corpusDir);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error("Child rejects linked or invalid corpus paths");
  const resolved = fs.realpathSync(corpusDir);
  if (path.basename(resolved) !== "ingest-corpus" || path.dirname(resolved) !== root)
    throw new Error("Child accepts only the harness synthetic ingest corpus");
  return resolved;
}

interface QueryInstrumentation {
  total: number;
  /** sql → { count, firstArgs } captured at execution time (for EXPLAIN binding). */
  bySql: Map<string, { count: number; firstArgs: unknown[] }>;
}

type PreparedStatement = ReturnType<ReturnType<typeof openDb>["prepare"]>;

/**
 * Count every prepared-statement execution by wrapping db.prepare. The first
 * bound argument list per distinct SQL is retained so EXPLAIN QUERY PLAN can
 * later prepare the same statement with valid bindings.
 */
function instrumentDb(db: ReturnType<typeof openDb>): {
  counter: QueryInstrumentation;
  rawPrepare: (sql: string) => PreparedStatement;
} {
  const counter: QueryInstrumentation = { total: 0, bySql: new Map() };
  const rawPrepare = db.prepare.bind(db);
  const record = (sql: string, args: unknown[]): void => {
    counter.total += 1;
    const entry = counter.bySql.get(sql);
    if (entry) entry.count += 1;
    else counter.bySql.set(sql, { count: 1, firstArgs: args });
  };
  const wrapped = (sql: string): PreparedStatement => {
    const statement = rawPrepare(sql);
    for (const method of ["run", "get", "all", "iterate"] as const) {
      const original = (
        statement[method] as unknown as (...args: unknown[]) => unknown
      ).bind(statement);
      (statement as unknown as Record<string, unknown>)[method] = (
        ...args: unknown[]
      ): unknown => {
        record(sql, args);
        return original(...args);
      };
    }
    return statement;
  };
  (db as unknown as Record<string, unknown>).prepare = wrapped;
  return { counter, rawPrepare };
}

interface RouteMetricSample {
  path: string;
  service_ms: number;
  query_count: number;
  status: number;
  overlapped: boolean;
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
  const { counter, rawPrepare } = instrumentDb(db);
  setQueryDb(db);
  const server = createServer(db, 0, null);

  // Child-side route service time: request arrival to response finish, with the
  // executed-query delta. Overlapping requests contaminate each other's query
  // deltas, so any sample whose lifetime overlapped another is flagged. The
  // daemon handler runs synchronously in its own earlier "request" listener, so
  // this listener must be PREPENDED to snapshot time/queries before that work.
  const routeMetrics: RouteMetricSample[] = [];
  const activeRequests = new Set<{ overlapped: boolean }>();
  server.prependListener("request", (request, response) => {
    const tracker = { overlapped: false };
    const started = performance.now();
    const startedQueries = counter.total;
    activeRequests.add(tracker);
    if (activeRequests.size > 1) for (const active of activeRequests) active.overlapped = true;
    response.on("finish", () => {
      activeRequests.delete(tracker);
      routeMetrics.push({
        path: request.url ?? "",
        service_ms: Number((performance.now() - started).toFixed(3)),
        query_count: counter.total - startedQueries,
        status: response.statusCode,
        overlapped: tracker.overlapped,
      });
    });
  });

  const port = await listen(server);
  // Child-vantage readiness resources: this process's own CPU and RSS at the
  // moment the loopback server is accepting (controller resources are not a
  // stand-in for daemon startup cost).
  const readyCpu = process.cpuUsage();
  emit({
    event: "ready",
    port,
    pid: process.pid,
    cpu_ms: Number(((readyCpu.user + readyCpu.system) / 1_000).toFixed(3)),
    rss_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
  });

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
    if (command.command === "route-metrics") {
      emit({ event: "route-metrics", samples: routeMetrics.splice(0, routeMetrics.length) });
      return;
    }
    if (command.command === "query-plans") {
      const plans: Record<string, unknown>[] = [];
      for (const [sql, entry] of counter.bySql) {
        let plan: string[] | null = null;
        let planError: string | null = null;
        try {
          const statement = rawPrepare(`EXPLAIN QUERY PLAN ${sql}`);
          const rows = (statement.all as (...args: unknown[]) => unknown[])(
            ...entry.firstArgs,
          ) as Array<{ detail?: unknown }>;
          plan = rows.map((row) => String(row.detail ?? ""));
        } catch (error) {
          planError = error instanceof Error ? error.message : String(error);
        }
        plans.push({
          sql: sql.replace(/\s+/g, " ").trim().slice(0, 300),
          executions: entry.count,
          plan,
          ...(planError === null ? {} : { plan_error: planError }),
        });
      }
      plans.sort((a, b) => Number(b.executions) - Number(a.executions));
      emit({ event: "query-plans", total_queries: counter.total, statements: plans });
      return;
    }
    if (command.command === "ingest-catchup") {
      const corpusDir = requireSyntheticCorpusDir(command.corpusDir ?? "", paths.root);
      emit({ event: "ingest-catchup-started" });
      // Give the controller time to put interference reads in flight before the
      // synchronous backscan blocks this event loop.
      await delay(50);
      const loop = monitorEventLoopDelay({ resolution: 10 });
      loop.enable();
      const beforeCpu = process.cpuUsage();
      const before = performance.now();
      // A zero-delay timer scheduled before the synchronous scan directly
      // measures how long the event loop stalls behind it.
      let stallMs = 0;
      const stallProbe = new Promise<void>((resolve) =>
        setTimeout(() => {
          stallMs = performance.now() - before;
          resolve();
        }, 0),
      );
      const counters = runBackscan(db, [corpusDir], { now: () => new Date("2026-01-15T12:00:00.000Z") });
      await stallProbe;
      const elapsedMs = performance.now() - before;
      const cpu = process.cpuUsage(beforeCpu);
      loop.disable();
      emit({
        event: "ingest-catchup",
        elapsed_ms: Number(elapsedMs.toFixed(3)),
        cpu_ms: Number(((cpu.user + cpu.system) / 1_000).toFixed(3)),
        rss_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
        event_loop_p50_ms: Number((loop.percentile(50) / 1e6).toFixed(3)),
        event_loop_p95_ms: Number((loop.percentile(95) / 1e6).toFixed(3)),
        event_loop_max_ms: Number((loop.max / 1e6).toFixed(3)),
        event_loop_stall_ms: Number(stallMs.toFixed(3)),
        turns_ingested: counters.turnsIngested,
        turns_per_second: Number(
          ((counters.turnsIngested / Math.max(elapsedMs, 1)) * 1_000).toFixed(3),
        ),
        files_seen: counters.filesSeen,
        files_parsed: counters.filesParsed,
        lines_quarantined: counters.linesQuarantined,
        duplicate_drops: counters.duplicateDrops,
      });
      return;
    }
    if (command.command === "recurring-jobs") {
      const corpusDir = requireSyntheticCorpusDir(command.corpusDir ?? "", paths.root);
      const windowMs = Math.max(5_000, Math.min(120_000, command.windowMs ?? 35_000));
      const fixedNow = (): Date => new Date("2026-01-15T12:00:00.000Z");

      // Per-family raw samples. Families are tagged boot_/window_ so initial-scan
      // work never contaminates cadence-window attribution.
      const families = new Map<string, { elapsed_ms: number[]; cpu_ms: number[] }>();
      const record = (family: string, elapsedMs: number, cpuMs: number): void => {
        let entry = families.get(family);
        if (!entry) {
          entry = { elapsed_ms: [], cpu_ms: [] };
          families.set(family, entry);
        }
        entry.elapsed_ms.push(Number(elapsedMs.toFixed(3)));
        entry.cpu_ms.push(Number(cpuMs.toFixed(3)));
      };
      let phase: "boot" | "window" = "boot";

      // Production parity: the daemon wires the post-ingest detector pass before
      // startTail, so discovery ticks pay the full detector cost. Without this
      // the 30s tick under-reports by the whole runDetectors pass.
      setPostIngestHook((detectorDb, hookNow) => runDetectors(detectorDb, { now: hookNow }));

      // NOTE: fixedNow freezes the injected clock, so the idle floors never
      // elapse during the window — idle-window runs measure pure gated-skip
      // cost, and gatingOff:true (floors 0) measures the ungated baseline.
      const ingestor = new Ingestor(db, [corpusDir], {
        now: fixedNow,
        ...(command.gatingOff === true
          ? { reconcileIdleFloorMs: 0, detectorIdleFloorMs: 0 }
          : {}),
      });
      // Attribute the real instance methods the timers call. reconcileNow and
      // runPostIngest are private in TS but runtime-patchable in this benchmark.
      const target = ingestor as unknown as Record<string, (...args: unknown[]) => unknown>;
      const wrapSync = (method: string, family: string): void => {
        const original = target[method];
        if (typeof original !== "function") throw new Error(`Cannot wrap Ingestor.${method}`);
        const bound = original.bind(ingestor);
        target[method] = (...args: unknown[]): unknown => {
          const beforeCpu = process.cpuUsage();
          const before = performance.now();
          try {
            return bound(...args);
          } finally {
            const cpu = process.cpuUsage(beforeCpu);
            record(`${phase}_${family}`, performance.now() - before, (cpu.user + cpu.system) / 1_000);
          }
        };
      };
      const wrapAsync = (method: string, family: string): void => {
        const original = target[method];
        if (typeof original !== "function") throw new Error(`Cannot wrap Ingestor.${method}`);
        const bound = original.bind(ingestor) as (...args: unknown[]) => Promise<unknown>;
        target[method] = async (...args: unknown[]): Promise<unknown> => {
          const beforeCpu = process.cpuUsage();
          const before = performance.now();
          try {
            return await bound(...args);
          } finally {
            const cpu = process.cpuUsage(beforeCpu);
            record(`${phase}_${family}`, performance.now() - before, (cpu.user + cpu.system) / 1_000);
          }
        };
      };
      wrapSync("reconcileNow", "reconcile");
      wrapSync("runPostIngest", "post_ingest_detectors");
      wrapAsync("ingestFileYielding", "file_ingest");

      // Tag the ORIGINAL-cadence interval callbacks by their registration delay
      // (2s tail dispatch, 30s synchronous discovery). The tail callback returns
      // immediately (async pass); its body cost is the wrapped instance methods.
      const realSetInterval = globalThis.setInterval;
      const intervalFamilies = new Map<number, string>([
        [2_000, "tail_tick_dispatch"],
        [30_000, "discovery_tick"],
      ]);
      (globalThis as { setInterval: unknown }).setInterval = ((
        fn: (...args: unknown[]) => unknown,
        ms?: number,
        ...rest: unknown[]
      ) => {
        const family = ms === undefined ? undefined : intervalFamilies.get(ms);
        if (family === undefined) return realSetInterval(fn, ms, ...rest);
        const wrapped = (...args: unknown[]): void => {
          const beforeCpu = process.cpuUsage();
          const before = performance.now();
          try {
            fn(...args);
          } finally {
            const cpu = process.cpuUsage(beforeCpu);
            record(`${phase}_${family}`, performance.now() - before, (cpu.user + cpu.system) / 1_000);
          }
        };
        return realSetInterval(wrapped, ms, ...rest);
      }) as typeof setInterval;

      let handle: { stop(): void } | undefined;
      let bootElapsedMs = 0;
      let bootCpuMs = 0;
      const healthBefore = ingestor.healthSnapshot();
      try {
        const bootCpuBefore = process.cpuUsage();
        const bootBefore = performance.now();
        handle = await ingestor.startTailBatched();
        bootElapsedMs = performance.now() - bootBefore;
        const bootCpu = process.cpuUsage(bootCpuBefore);
        bootCpuMs = (bootCpu.user + bootCpu.system) / 1_000;
      } finally {
        globalThis.setInterval = realSetInterval;
      }
      phase = "window";

      // Growth workload: append fresh synthetic assistant turns (new ids; zero
      // content — SEC-101) to one corpus file each tail period so window ticks
      // ingest real bytes instead of measuring only the no-new-bytes fast path.
      const growthFile = (() => {
        const slugDir = fs.readdirSync(corpusDir).find((entry) =>
          fs.statSync(path.join(corpusDir, entry)).isDirectory(),
        );
        if (!slugDir) return null;
        const slugPath = path.join(corpusDir, slugDir);
        const file = fs.readdirSync(slugPath).find((entry) => entry.endsWith(".jsonl"));
        return file ? { filePath: path.join(slugPath, file), sessionId: file.replace(/\.jsonl$/, "") } : null;
      })();
      let growthTurns = 0;
      const growthTimer = realSetInterval(() => {
        if (!growthFile || command.growthOff === true) return;
        const beforeCpu = process.cpuUsage();
        const before = performance.now();
        const lines: string[] = [];
        for (let index = 0; index < 25; index += 1) {
          growthTurns += 1;
          lines.push(
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-01-14T12:00:00.000Z",
              sessionId: growthFile.sessionId,
              message: {
                id: `synthetic-tailgrow-msg-${growthTurns}`,
                model: "claude-sonnet-4-6",
                usage: {
                  input_tokens: 1_000,
                  output_tokens: 100,
                  cache_read_input_tokens: 4_000,
                  cache_creation_input_tokens: 300,
                },
              },
            }),
          );
        }
        fs.appendFileSync(growthFile.filePath, `${lines.join("\n")}\n`);
        const cpu = process.cpuUsage(beforeCpu);
        record("window_corpus_append", performance.now() - before, (cpu.user + cpu.system) / 1_000);
      }, 2_000);

      emit({ event: "recurring-jobs-started", window_ms: windowMs });
      const loop = monitorEventLoopDelay({ resolution: 10 });
      loop.enable();
      const windowCpuBefore = process.cpuUsage();
      const windowBefore = performance.now();
      await delay(windowMs);
      const windowElapsedMs = performance.now() - windowBefore;
      const windowCpu = process.cpuUsage(windowCpuBefore);
      loop.disable();
      clearInterval(growthTimer);
      handle?.stop();
      // Let a suspended tail pass reach its next file boundary before reporting.
      await delay(100);
      const healthAfter = ingestor.healthSnapshot();

      emit({
        event: "recurring-jobs",
        window_ms: Number(windowElapsedMs.toFixed(1)),
        gating: command.gatingOff === true ? "off (floors 0 — pre-PERF5 behavior)" : "on (defaults)",
        growth: command.growthOff === true ? "off (idle window)" : "on (25 turns / 2s)",
        cadence: { tail_ms: 2_000, discovery_ms: 30_000, dispatch: "original production cadences" },
        boot_scan: {
          elapsed_ms: Number(bootElapsedMs.toFixed(3)),
          cpu_ms: Number(bootCpuMs.toFixed(3)),
        },
        window_cpu_ms: Number(((windowCpu.user + windowCpu.system) / 1_000).toFixed(3)),
        window_event_loop: {
          p50_ms: Number((loop.percentile(50) / 1e6).toFixed(3)),
          p95_ms: Number((loop.percentile(95) / 1e6).toFixed(3)),
          max_ms: Number((loop.max / 1e6).toFixed(3)),
        },
        rss_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
        growth_turns_appended: growthTurns,
        health_delta: {
          files_parsed: healthAfter.filesParsed - healthBefore.filesParsed,
          turns_ingested: healthAfter.turnsIngested - healthBefore.turnsIngested,
        },
        families: Object.fromEntries(
          [...families.entries()].map(([family, samples]) => [
            family,
            { count: samples.elapsed_ms.length, elapsed_ms: samples.elapsed_ms, cpu_ms: samples.cpu_ms },
          ]),
        ),
        notes: [
          "boot_* families attribute initial-scan sub-steps; window_* families attribute cadence-window work.",
          "window_file_ingest elapsed includes cooperative yields and any interleaved HTTP service; cpu_ms is the honest per-invocation compute bound.",
          "tail_tick_dispatch measures only the synchronous interval callback (busy-guard + async pass launch); the pass body is attributed via file_ingest/reconcile.",
        ],
      });
      return;
    }
    if (command.command === "direct-jobs") {
      const now = new Date("2026-01-15T12:00:00.000Z");
      const jobs: Record<string, unknown>[] = [];
      await nextTimer();
      jobs.push(
        await sampleJob("weekly_report_direct", async () => {
          await generateWeeklyReport(db, now);
        }),
      );
      await nextTimer();
      jobs.push(
        await sampleJob("effect_measurement_current", async () => {
          runEffectMeasurementPass(db, now);
        }),
      );
      await nextTimer();
      jobs.push(
        await sampleJob("context_probe", async () => {
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
        await sampleJob("calibration_gated_check", async () => {
          bptConfigGet(db, "bytes_per_token_calibration_enabled");
        }),
      );

      // Outcomes pass with a synthetic injected provider (no subprocesses, no
      // network): attributes the DB-side cost of each step separately.
      const stubClient: GithubClient = {
        enabled: true,
        listPRs: async () => ({ ok: true, data: [] }),
        getPRHeadKey: async () => ({ ok: true, data: null }),
        getCheckConclusion: async () => ({ ok: true, data: "NONE" }),
        listPRCommits: async () => ({ ok: true, data: [] }),
        listPullsForCommit: async () => ({ ok: true, data: [] }),
        getPRBody: async () => ({ ok: true, data: "" }),
        getPRDiff: async () => ({ ok: true, data: "" }),
        getReviewThreads: async () => ({ ok: true, data: [] }),
      };
      const stepSample = async (name: string, task: () => Promise<void>): Promise<void> => {
        await nextTimer();
        jobs.push(await sampleJob(name, task));
      };
      const runner = createOutcomesPassRunner({
        db,
        probe: () => {},
        readToken: async () => ({ ok: true, data: "synthetic-token" }),
        createClient: () => stubClient,
        sync: async (passDb, client) => {
          await stepSample("outcomes_sync_stub", () => syncAllWorkspaces(passDb, client));
        },
        link: async (passDb, client) => {
          await stepSample("outcomes_link_stub", () => linkSessions(passDb, client));
        },
        derive: (passDb) => {
          const beforeCpu = process.cpuUsage();
          const before = performance.now();
          writeObservedOutcomes(passDb);
          const cpu = process.cpuUsage(beforeCpu);
          jobs.push({
            name: "outcomes_derive",
            elapsed_ms: Number((performance.now() - before).toFixed(3)),
            cpu_ms: Number(((cpu.user + cpu.system) / 1_000).toFixed(3)),
            rss_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
          });
        },
        findings: async (passDb, client) => {
          await stepSample("outcomes_findings_stub", () => extractAllFindings(passDb, client));
        },
        log: () => {},
        error: () => {},
      });
      const outcomesResult = await runner.run();

      emit({
        event: "direct-jobs",
        dispatch: "one-shot setTimeout(0) before each job; outcomes steps via injected stub provider",
        outcomes_result: outcomesResult,
        jobs,
      });
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
