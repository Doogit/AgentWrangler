/**
 * test/daemon/route-snapshot-oracle.ts — shared by the P1-U8 route tests (delivery, practices).
 *
 * `oldWindow` is the pre-U8 router's parseWindowFilter + resolveWindow, copied verbatim so the
 * snapshot-served responses are graded against the old synchronous path, not against the code
 * under test.
 */

import * as http from "node:http";
import { Worker } from "node:worker_threads";
import { createServer } from "../../src/daemon/http.js";
import type { RouteSnapshotService } from "../../src/daemon/route-snapshot.js";
import type { Db } from "../../src/db/open.js";

interface WindowFilter {
  preset?: "24h" | "7d" | "30d";
  from?: string;
  to?: string;
}

const MAX_WINDOW_TS = 8.64e15 - 7 * 24 * 60 * 60 * 1000;
function parseDateParam(v: string | null): string | undefined {
  if (v === null) return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t) || Math.abs(t) > MAX_WINDOW_TS) return undefined;
  return v;
}

function parseWindowFilter(url: string): WindowFilter {
  const qs = url.split("?")[1] ?? "";
  const params = new URLSearchParams(qs);
  const filter: WindowFilter = {};
  const preset = params.get("preset");
  if (preset === "24h" || preset === "7d" || preset === "30d") filter.preset = preset;
  const from = parseDateParam(params.get("from"));
  if (from !== undefined) filter.from = from;
  const to = parseDateParam(params.get("to"));
  if (to !== undefined) filter.to = to;
  return filter;
}

const PRESET_DAYS = { "24h": 1, "7d": 7, "30d": 30 } as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function resolveWindow(
  filters: WindowFilter,
  now: Date = new Date(),
): { from: string; to: string } {
  const nowIso = now.toISOString();
  if (filters.preset !== undefined) {
    return {
      from: new Date(now.getTime() - PRESET_DAYS[filters.preset] * MS_PER_DAY).toISOString(),
      to: nowIso,
    };
  }
  if (filters.from !== undefined && filters.to !== undefined)
    return { from: filters.from, to: filters.to };
  if (filters.from !== undefined) return { from: filters.from, to: nowIso };
  if (filters.to !== undefined) {
    return {
      from: new Date(new Date(filters.to).getTime() - 7 * MS_PER_DAY).toISOString(),
      to: filters.to,
    };
  }
  return { from: new Date(now.getTime() - 7 * MS_PER_DAY).toISOString(), to: nowIso };
}

/** The old handler's window, plus `persistedStrip` as /api/practices derived it. */
export function oldWindow(url: string): { from: string; to: string; persistedStrip: boolean } {
  const filter = parseWindowFilter(url);
  return {
    ...resolveWindow(filter),
    persistedStrip: filter.to === undefined || !!filter.preset,
  };
}

/** JSON round-trip, so an oracle value compares like a parsed response body. */
export function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

export function request(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

export async function listen(
  db: Db,
  routeSnapshot: RouteSnapshotService,
): Promise<{ server: http.Server; port: number }> {
  const server = createServer(db, 0, null, null, null, null, undefined, undefined, routeSnapshot);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

export function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A real worker thread that spins for `ms`: a build that is slow but off the event loop. */
export function busyWorker(ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `const t = Date.now(); while (Date.now() - t < ${ms}) {} require("node:worker_threads").parentPort.postMessage(0);`,
      { eval: true },
    );
    worker.once("message", () => {
      void worker.terminate();
      resolve();
    });
    worker.once("error", reject);
  });
}
