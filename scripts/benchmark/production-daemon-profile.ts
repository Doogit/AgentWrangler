/**
 * Synthetic production-entrypoint profile. The child runs src/daemon/index.ts,
 * while a preload guard confines home/config paths and blocks external I/O.
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/open.js";
import { seedSyntheticHistory } from "./synthetic-fixture.js";

const SCALES = [1_000, 10_000, 100_000] as const;
const STARTUP_TIMEOUT_MS = 60_000;
const QUIESCENT_IDLE_MS = 1_000;
const PRODUCTION_CADENCE_MS = 5_000;
const ACCELERATED_MS = 2_000;

type ProfileEvent = Record<string, unknown> & { awProfile: true; event: string };
type SampleEvent = ProfileEvent & {
  cpuUserUs: number;
  cpuSystemUs: number;
  rssBytes: number;
  eventLoopP50Ns: number;
  eventLoopP95Ns: number;
  eventLoopMaxNs: number;
  boundaryAttempts: number;
};

interface RunningChild {
  events: ProfileEvent[];
  logs: string[];
  waitFor(predicate: (event: ProfileEvent) => boolean, timeoutMs?: number): Promise<ProfileEvent>;
  sample(): Promise<SampleEvent>;
  command(
    command: "start-timers" | "stop-timers",
    mode?: "production" | "accelerated",
  ): Promise<void>;
  hasExited(): boolean;
  close(): Promise<void>;
}

export function isExpectedControlledExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  closeInitiated: boolean,
): boolean {
  return code === 0 || (closeInitiated && code === null && signal === "SIGTERM");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeProfileDirectory(tempDir: string): void {
  const resolved = path.resolve(tempDir);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("agent-wrangler-production-profile-")
  ) {
    throw new Error("Refusing cleanup outside the synthetic production-profile directory");
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
}

export function isolatedEnvironment(root: string, dbPath: string): NodeJS.ProcessEnv {
  const home = path.join(root, "home");
  const appData = path.join(root, "appdata");
  const localAppData = path.join(root, "localappdata");
  const config = path.join(root, "config");
  const temp = path.join(root, "temp");
  const scanRoot = path.join(root, "empty-scan");
  const uiRoot = path.join(root, "empty-ui");
  for (const directory of [home, appData, localAppData, config, temp, scanRoot, uiRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const inherited = (name: string): string | undefined => process.env[name];
  return {
    ...(inherited("PATH") ? { PATH: inherited("PATH") } : {}),
    ...(inherited("SystemRoot") ? { SystemRoot: inherited("SystemRoot") } : {}),
    ...(inherited("WINDIR") ? { WINDIR: inherited("WINDIR") } : {}),
    ...(inherited("ComSpec") ? { ComSpec: inherited("ComSpec") } : {}),
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: config,
    TEMP: temp,
    TMP: temp,
    AW_PROFILE_SYNTHETIC_ROOT: root,
    AW_DB_PATH: dbPath,
    AW_SCAN_ROOT: scanRoot,
    AW_UI_ROOT: uiRoot,
    AW_PORT: "0",
    AW_NO_OPEN: "1",
    AW_GITHUB_TOKEN: "",
    GH_PROMPT_DISABLED: "1",
    NO_PROXY: "*",
  };
}

function startProductionChild(root: string, dbPath: string): Promise<RunningChild> {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const guard = path.join(scriptDir, "production-daemon-guard.cjs");
  const entrypoint = path.resolve(scriptDir, "../../src/daemon/index.ts");
  const child = childProcess.spawn(
    process.execPath,
    ["--require", guard, "--import", "tsx/esm", entrypoint, "--no-open", "--port", "0"],
    {
      env: isolatedEnvironment(root, dbPath),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  const events: ProfileEvent[] = [];
  const logs: string[] = [];
  const waiters: Array<{
    predicate: (event: ProfileEvent) => boolean;
    resolve: (event: ProfileEvent) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let closeInitiated = false;
  let requestId = 0;
  let output = "";
  let errors = "";
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) throw new Error("Production child requires piped stdout and stderr");
  let resolveExit: (() => void) | undefined;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const rejectWaiters = (error: Error): void => {
    while (waiters.length) {
      const waiter = waiters.shift();
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    output += chunk;
    for (;;) {
      const newline = output.indexOf("\n");
      if (newline < 0) break;
      const line = output.slice(0, newline).trim();
      output = output.slice(newline + 1);
      if (line) logs.push(line);
    }
  });
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    errors += chunk;
  });
  child.on("message", (message: unknown) => {
    const event = message as ProfileEvent;
    if (!event || event.awProfile !== true || typeof event.event !== "string") return;
    events.push(event);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter?.predicate(event)) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    }
  });
  child.on("error", (error) => rejectWaiters(error));
  const exitDescription = (): string =>
    exitSignal ? `signal ${exitSignal}` : `code ${String(exitCode)}`;
  const exitedSuccessfully = (): boolean =>
    isExpectedControlledExit(exitCode, exitSignal, closeInitiated);
  child.on("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
    resolveExit?.();
    if (!exitedSuccessfully())
      rejectWaiters(new Error(`Production child exited with ${exitDescription()}: ${errors}`));
  });

  const waitFor = (
    predicate: (event: ProfileEvent) => boolean,
    timeoutMs = STARTUP_TIMEOUT_MS,
  ): Promise<ProfileEvent> => {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (exited)
      return Promise.reject(
        new Error(`Production child already exited with ${exitDescription()}: ${errors}`),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.reject === reject);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for production child event; stderr: ${errors}`));
      }, timeoutMs);
      waiters.push({ predicate, resolve, reject, timer });
    });
  };
  const sendAndWait = async (
    command: "sample" | "start-timers" | "stop-timers",
    mode?: "production" | "accelerated",
  ): Promise<ProfileEvent> => {
    const id = ++requestId;
    const expected =
      command === "sample"
        ? "sample"
        : command === "start-timers"
          ? "timers-started"
          : "timers-stopped";
    child.send({ awProfile: true, command, requestId: id, mode });
    return waitFor((event) => event.event === expected && event.requestId === id);
  };

  return Promise.resolve({
    events,
    logs,
    waitFor,
    hasExited(): boolean {
      return exited;
    },
    async sample(): Promise<SampleEvent> {
      return (await sendAndWait("sample")) as SampleEvent;
    },
    async command(command, mode): Promise<void> {
      await sendAndWait(command, mode);
    },
    async close(): Promise<void> {
      if (exited) {
        if (!exitedSuccessfully())
          throw new Error(`Production child exited with ${exitDescription()}: ${errors}`);
        return;
      }
      closeInitiated = true;
      if (!child.kill("SIGTERM")) {
        throw new Error("Production child shutdown signal was not delivered");
      }
      const exitedBeforeDeadline = await Promise.race([
        exitPromise,
        delay(10_000).then(() => false),
      ]);
      if (exitedBeforeDeadline === false) {
        child.kill("SIGKILL");
        const exitedAfterForce = await Promise.race([exitPromise, delay(10_000).then(() => false)]);
        if (exitedAfterForce === false) {
          throw new Error("Production child shutdown timed out without a confirmed child exit");
        }
      }
      if (!exitedSuccessfully())
        throw new Error(`Production child exited with ${exitDescription()}: ${errors}`);
    },
  });
}

function loopbackRequest(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { hostname: "127.0.0.1", port, path: "/", headers: { Accept: "text/html" }, timeout: 5_000 },
      (response) => {
        response.resume();
        response.on("end", resolve);
      },
    );
    request.on("timeout", () => request.destroy(new Error("Production daemon trigger timed out")));
    request.on("error", reject);
  });
}

function phaseDelta(
  start: SampleEvent,
  end: SampleEvent,
  durationMs: number,
): Record<string, number> {
  const cpuMs = (end.cpuUserUs + end.cpuSystemUs - start.cpuUserUs - start.cpuSystemUs) / 1_000;
  return {
    duration_ms: durationMs,
    cpu_ms: Number(cpuMs.toFixed(3)),
    cpu_percent: Number(((cpuMs / durationMs) * 100).toFixed(2)),
    rss_mb: Number((end.rssBytes / 1024 / 1024).toFixed(2)),
    event_loop_p50_ms: Number((end.eventLoopP50Ns / 1e6).toFixed(3)),
    event_loop_p95_ms: Number((end.eventLoopP95Ns / 1e6).toFixed(3)),
    event_loop_max_ms: Number((end.eventLoopMaxNs / 1e6).toFixed(3)),
  };
}

async function profile(scale: number): Promise<Record<string, unknown>> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wrangler-production-profile-"));
  const dbPath = path.join(root, "synthetic.sqlite");
  let child: RunningChild | undefined;
  let profileError: unknown;
  let result: Record<string, unknown> | undefined;
  try {
    const db = openDb(dbPath);
    runMigrations(db);
    seedSyntheticHistory(db, scale);
    db.close();

    const started = performance.now();
    child = await startProductionChild(root, dbPath);
    await child.waitFor((event) => event.event === "guard-ready");
    const baseline = await child.sample();
    const listening = await child.waitFor((event) => event.event === "server-listening");
    const address = listening.address as { address?: string; port?: number } | undefined;
    if (
      address?.address !== "127.0.0.1" ||
      !Number.isInteger(address.port) ||
      Number(address.port) <= 0
    ) {
      throw new Error("Production child did not bind an ephemeral loopback port");
    }
    await loopbackRequest(Number(address.port));
    while (!child.logs.some((line) => line.includes("Ingestion: initial scan complete"))) {
      if (performance.now() - started > STARTUP_TIMEOUT_MS) {
        throw new Error(`Production startup did not complete; logs: ${child.logs.join(" | ")}`);
      }
      await delay(20);
    }
    while (!child.logs.some((line) => line.includes("Outcomes: GitHub token not configured"))) {
      if (performance.now() - started > STARTUP_TIMEOUT_MS) {
        throw new Error(
          `Guarded outcomes bootstrap did not settle; logs: ${child.logs.join(" | ")}`,
        );
      }
      await delay(20);
    }
    const startup = await child.sample();
    const startupMs = performance.now() - started;

    const idleStart = await child.sample();
    await delay(QUIESCENT_IDLE_MS);
    const idleEnd = await child.sample();

    await child.command("start-timers", "production");
    const cadenceStart = await child.sample();
    await delay(PRODUCTION_CADENCE_MS);
    const cadenceEnd = await child.sample();
    await child.command("stop-timers");

    await child.command("start-timers", "accelerated");
    const acceleratedStart = await child.sample();
    await delay(ACCELERATED_MS);
    const acceleratedEnd = await child.sample();
    await child.command("stop-timers");

    const registered = child.events
      .filter((event) => event.event === "timer-registered")
      .map((event) => Number(event.originalDelayMs))
      .sort((a, b) => a - b);
    const acceleratedFires = child.events
      .filter((event) => event.event === "timer-fired" && event.mode === "accelerated")
      .reduce<Record<string, number>>((counts, event) => {
        const key = String(event.originalDelayMs);
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {});
    if (
      ![2_000, 30_000, 10 * 60_000, 7 * 24 * 60 * 60_000].every((delayMs) =>
        registered.includes(delayMs),
      )
    ) {
      throw new Error(`Production timers were not all registered: ${registered.join(",")}`);
    }
    if (acceleratedEnd.boundaryAttempts < 2) {
      throw new Error("Expected credential and git subprocess boundaries were not blocked");
    }
    result = {
      scale_turns: scale,
      startup: {
        elapsed_ms: Number(startupMs.toFixed(3)),
        cpu_ms: Number(
          (
            (startup.cpuUserUs + startup.cpuSystemUs - baseline.cpuUserUs - baseline.cpuSystemUs) /
            1_000
          ).toFixed(3),
        ),
        rss_mb: Number((startup.rssBytes / 1024 / 1024).toFixed(2)),
      },
      idle_timers_paused: phaseDelta(idleStart, idleEnd, QUIESCENT_IDLE_MS),
      production_cadence_5s: phaseDelta(cadenceStart, cadenceEnd, PRODUCTION_CADENCE_MS),
      accelerated_callback_window: phaseDelta(acceleratedStart, acceleratedEnd, ACCELERATED_MS),
      registered_interval_ms: registered,
      accelerated_fires: acceleratedFires,
      blocked_boundary_attempts: acceleratedEnd.boundaryAttempts,
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
  if (!child || child.hasExited()) {
    try {
      removeProfileDirectory(root);
    } catch (error) {
      cleanupErrors.push(error);
    }
  } else {
    cleanupErrors.push(
      new Error("Retained profile directory because the production child exit was not confirmed"),
    );
  }
  if (profileError && cleanupErrors.length) {
    throw new AggregateError(
      [profileError, ...cleanupErrors],
      "Production profile and cleanup failed",
    );
  }
  if (profileError) throw profileError;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "Production profile cleanup failed");
  if (!result) throw new Error("Production profile completed without a result");
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
        entrypoint: "src/daemon/index.ts",
        isolation: {
          home_config_data_and_temp: "unique temporary directories per scale",
          database: "synthetic aggregate rows only",
          port: "ephemeral loopback",
          blocked: ["all child_process APIs", "global fetch", "non-loopback net/tls"],
          inherited_environment: ["PATH", "SystemRoot", "WINDIR", "ComSpec"],
        },
        phases: {
          startup:
            "guard preload through completed empty-root scan and disabled outcomes bootstrap",
          idle_timers_paused: `${QUIESCENT_IDLE_MS}ms quiescent baseline after startup`,
          production_cadence_5s: `${PRODUCTION_CADENCE_MS}ms at original intervals; observes 2s tail only`,
          accelerated_callback_window: `${ACCELERATED_MS}ms; each registered interval fires at most twice`,
        },
        results,
        limitations: [
          "accelerated callback windows attribute production callbacks but do not represent production cadence",
          "the five-second production-cadence window does not reach 30-second, 10-minute, or weekly intervals",
          "empty scan roots exclude transcript parsing, filesystem churn, and populated repository mapping",
          "network, credentials, GitHub, browser open, hooks, and operator settings are intentionally blocked",
          "source entrypoint profiling does not establish installed-package or cross-platform behavior",
        ],
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
