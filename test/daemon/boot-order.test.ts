/**
 * test/daemon/boot-order.test.ts — P0-U4 spawned-daemon boot-order test.
 *
 * src/daemon/index.ts is a top-level script with no exports, so no spy can
 * reach it: this test spawns the real entrypoint (via `tsx/esm`, matching
 * `npm run daemon`) against an isolated, empty synthetic environment and
 * asserts on its stdout log order and live HTTP behavior — never the live
 * daemon, never port 2929.
 *
 * Asserts:
 *   1. `Listening on` is logged before `ContextProbe[boot]` and before the
 *      weekly-report line (P0-U4: both moved off the pre-listen critical path).
 *   2. `GET /api/status` answers while a stubbed slow report build is still in
 *      flight, proving the deferred boot work does not block the HTTP server.
 *      The slow build is a real event-loop yield behind the test-only
 *      `AW_TEST_HOOKS=1` + `AW_TEST_BOOT_REPORT_DELAY_MS` seam (index.ts).
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

const BOOT_REPORT_DELAY_MS = 500;
const STDOUT_WAIT_TIMEOUT_MS = 30_000;

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

interface StatusResponse {
  status: number;
  body: string;
}

function getStatus(port: number): Promise<StatusResponse> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/api/status", timeout: 10_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("GET /api/status timed out")));
    req.on("error", reject);
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("spawned daemon — P0-U4 boot order", () => {
  it("logs Listening on before the boot probe/report, and answers /api/status while the report build is stubbed slow", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-boot-order-"));
    roots.push(root);
    const dbPath = path.join(root, "boot-order.sqlite");
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

    const lines: string[] = [];
    let buffer = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) lines.push(line);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      const listenDeadline = Date.now() + STDOUT_WAIT_TIMEOUT_MS;
      while (!lines.some((line) => line.includes("Listening on"))) {
        if (Date.now() > listenDeadline) {
          throw new Error(
            `daemon did not log "Listening on" in time; stderr: ${stderr}; stdout so far: ${lines.join(" | ")}`,
          );
        }
        await delay(20);
      }

      // The weekly-report build is stubbed to take BOOT_REPORT_DELAY_MS via a
      // real event-loop yield (AW_TEST_HOOKS=1) — a request fired right after
      // "Listening on" must resolve well before that yield completes.
      const status = await getStatus(port);
      expect(status.status).toBe(200);
      expect(() => JSON.parse(status.body)).not.toThrow();

      const deferredDeadline = Date.now() + STDOUT_WAIT_TIMEOUT_MS;
      while (
        !lines.some((line) => line.includes("ContextProbe[boot]")) ||
        !lines.some((line) => line.includes("Weekly report:"))
      ) {
        if (Date.now() > deferredDeadline) {
          throw new Error(
            `daemon did not complete deferred boot work in time; stdout: ${lines.join(" | ")}`,
          );
        }
        await delay(20);
      }

      const listenIndex = lines.findIndex((line) => line.includes("Listening on"));
      const probeIndex = lines.findIndex((line) => line.includes("ContextProbe[boot]"));
      const reportIndex = lines.findIndex((line) => line.includes("Weekly report:"));
      expect(listenIndex).toBeGreaterThanOrEqual(0);
      expect(probeIndex).toBeGreaterThan(listenIndex);
      expect(reportIndex).toBeGreaterThan(listenIndex);
    } finally {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, delay(5_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 45_000);
});
