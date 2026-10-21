/**
 * test/daemon/boot-detector-race.test.ts — P0-U4 review fix regression.
 *
 * The independent reviewer of P0-U4 found that `runDeferredBootWork()` gated
 * `runProbePass("boot")` (the O-4 `probe`/`effect_pass` marks) behind
 * `await recsSnapshot.get()` — a worker-built snapshot that can itself be a
 * slow, cold build. Meanwhile the first detector cycle
 * (`first_detector_cycle_start`) proceeds on an independent chain
 * (armBootFallback → kickBootScan → readiness slice → background backfill)
 * that nothing sequences against that await. On a cold/slow recs-snapshot
 * build, `first_detector_cycle_start` could land before `probe`/`effect_pass`,
 * inverting the order the plan's boot-critical-path fix (E2) requires.
 *
 * This test stubs the recs-snapshot/report-bootstrap path slow via the
 * existing AW_TEST_HOOKS=1 + AW_TEST_BOOT_REPORT_DELAY_MS seam (index.ts) —
 * the exact lever that gated the probe pass pre-fix — while leaving the
 * detector-cycle chain untouched (an empty scan root makes the readiness
 * slice and background backfill essentially instant). It polls the aggregate
 * GET /api/perf boot marks (never session/path content — SEC-101 safe) until
 * both `probe` and `first_detector_cycle_start` have been recorded, then
 * asserts `probe`/`effect_pass` are strictly earlier — using the marks' own
 * `performance.now()`-derived values, not poll-arrival order, so the
 * assertion holds regardless of when the test happens to observe it.
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isolatedEnvironment } from "../../scripts/benchmark/production-daemon-profile.js";
import type { BootMarks, PerfSnapshot } from "../../src/daemon/perf-monitor.js";

const BOOT_REPORT_DELAY_MS = 1_000;
const POLL_TIMEOUT_MS = 30_000;

const roots: string[] = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Allocates a free loopback port synchronously-ish, then releases it. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("could not allocate a free port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

function getPerf(port: number): Promise<PerfSnapshot> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/api/perf", timeout: 10_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as PerfSnapshot);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("GET /api/perf timed out")));
    req.on("error", reject);
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("spawned daemon — P0-U4 review fix: probe/effect_pass vs first_detector_cycle_start", () => {
  it("records probe/effect_pass boot marks before first_detector_cycle_start even when the recs-snapshot/report bootstrap is stubbed slow", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-boot-race-"));
    roots.push(root);
    const dbPath = path.join(root, "boot-race.sqlite");
    const port = await getFreePort();
    const env: NodeJS.ProcessEnv = {
      ...isolatedEnvironment(root, dbPath),
      AW_PORT: String(port),
      AW_TEST_HOOKS: "1",
      AW_TEST_BOOT_REPORT_DELAY_MS: String(BOOT_REPORT_DELAY_MS),
    };
    const entrypoint = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/daemon/index.ts",
    );
    const child = childProcess.spawn(process.execPath, ["--import", "tsx/esm", entrypoint], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      const listenDeadline = Date.now() + POLL_TIMEOUT_MS;
      while (!stdout.includes("Listening on")) {
        if (Date.now() > listenDeadline) {
          throw new Error(
            `daemon did not log "Listening on" in time; stderr: ${stderr}; stdout so far: ${stdout}`,
          );
        }
        await delay(20);
      }

      // Poll /api/perf's aggregate boot marks until both sides of the race
      // have landed: the probe pass and the detector-cycle chain.
      let boot: Partial<BootMarks> | undefined;
      const raceDeadline = Date.now() + POLL_TIMEOUT_MS;
      for (;;) {
        const snap = await getPerf(port);
        boot = snap.boot;
        if (boot?.probe !== undefined && boot?.first_detector_cycle_start !== undefined) break;
        if (Date.now() > raceDeadline) {
          throw new Error(
            `boot marks did not settle in time; last snapshot: ${JSON.stringify(boot)}; stdout: ${stdout}`,
          );
        }
        await delay(20);
      }

      expect(boot?.probe).toBeDefined();
      expect(boot?.effect_pass).toBeDefined();
      expect(boot?.first_detector_cycle_start).toBeDefined();
      // The marks are performance.now()-derived (relative to process_start), so
      // this compares actual recorded order, not poll-arrival order.
      expect(boot?.probe as number).toBeLessThan(boot?.first_detector_cycle_start as number);
      expect(boot?.effect_pass as number).toBeLessThan(boot?.first_detector_cycle_start as number);
    } finally {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, delay(5_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 45_000);
});
