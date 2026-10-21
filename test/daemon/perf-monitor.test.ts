/**
 * test/daemon/perf-monitor.test.ts — P0-U2 instrumentation unit tests, extended
 * by P0-U2b (worker, recs-key, WAL and process gauges).
 *
 * Covers the perf-monitor module directly (no HTTP app routing):
 *   1. Per-route duration recording produces correct p50/p95/max/count.
 *   2. The per-route ring caps at the last 500 durations (older ones evicted).
 *   3. Event-loop lag (Node's monitorEventLoopDelay, process-wide) picks up a
 *      genuine 120 ms synchronous block made inside a real HTTP server request.
 *   4. P0-U2b: worker spawn→first-message/build-total timing (a stub worker
 *      thread with an injected delay), spans, the WAL sampler (a test-written
 *      -wal file of known size), the ingest bytes/s gauge (known bytes over a
 *      known injected clock window), and RSS/heapUsed presence.
 *
 * Oracle: the injected/synthetic durations, byte counts and clock values, not
 * the module's own view of them.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOOP_SAMPLE_CAPACITY,
  finishRequest,
  formatBootMarks,
  formatDetectorPass,
  getBootMarks,
  getDetectorPass,
  getErroredFilesGauge,
  getIngestGauge,
  getLoopLag,
  getPerfSnapshot,
  getProcessGauge,
  getSpans,
  getWalGauge,
  getWorkerGauges,
  instrumentWorkerSpawn,
  markRequestStart,
  normalizeRoute,
  recordBootMark,
  recordDetectorPass,
  recordIngestBytes,
  recordLoopSample,
  recordSpan,
  resetBootMarks,
  resetDetectorPass,
  resetErroredFiles,
  resetIngestGauge,
  resetPerfMonitor,
  resetProcessSamplers,
  resetSpans,
  resetWorkerGauges,
  sampleProcessGauges,
  setErroredFiles,
  withSpan,
} from "../../src/daemon/perf-monitor.js";
import { getJobStats } from "../../src/daemon/schedule-job.js";
import {
  getTimerRegistrations,
  installTimerProbe,
  resetTimerProbe,
} from "../../src/daemon/timer-probe.js";

afterEach(() => {
  resetPerfMonitor();
  resetBootMarks();
  resetWorkerGauges();
  resetSpans();
  resetIngestGauge();
  resetProcessSamplers();
  resetDetectorPass();
  resetTimerProbe();
  resetErroredFiles();
  process.env.AW_PERF_PROBE = undefined;
});

function fakeRes(): http.ServerResponse {
  // The monitor only ever uses the response object as a WeakMap key.
  return {} as http.ServerResponse;
}

describe("per-route duration recording", () => {
  it("computes p50/p95/max/count from recorded durations", () => {
    const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    for (const d of durations) {
      const res = fakeRes();
      markRequestStart(res, "/api/synthetic");
      // Busy-wait exactly d ms so the recorded duration matches the oracle.
      const start = Date.now();
      while (Date.now() - start < d) {
        // intentional synchronous block
      }
      const result = finishRequest(res);
      expect(result).not.toBeNull();
      expect(result?.route).toBe("/api/synthetic");
      expect(result?.durationMs).toBeGreaterThanOrEqual(d);
    }
    const snap = getPerfSnapshot();
    const stats = snap.routes["/api/synthetic"];
    expect(stats).toBeDefined();
    expect(stats?.count).toBe(10);
    // p50 of 10 ascending-ish samples should sit around the middle, p95 near the top.
    expect(stats?.p50).toBeGreaterThanOrEqual(40);
    expect(stats?.p95).toBeGreaterThanOrEqual(80);
    expect(stats?.max).toBeGreaterThanOrEqual(100);
  });

  it("returns null from finishRequest when the response was never marked", () => {
    const res = fakeRes();
    expect(finishRequest(res)).toBeNull();
  });

  it("caps the per-route ring at the last 500 durations", () => {
    const route = "/api/synthetic-ring";
    for (let i = 1; i <= 550; i++) {
      const res = fakeRes();
      markRequestStart(res, route);
      finishRequest(res); // near-0 ms; count is what we assert, not the value
    }
    const snap = getPerfSnapshot();
    expect(snap.routes[route]?.count).toBe(500);
  });
});

describe("normalizeRoute (review fix: bounded route-key cardinality)", () => {
  it.each([
    ["/api/sessions/abc123", "/api/sessions/:id"],
    ["/api/sessions/abc123/turns", "/api/sessions/:id/turns"],
    ["/api/sessions/abc123/drivers", "/api/sessions/:id/drivers"],
    ["/api/sessions/abc123/diagnostics", "/api/sessions/:id/diagnostics"],
    ["/api/sessions/abc123/breakdown", "/api/sessions/:id/breakdown"],
    ["/api/workspaces/my-workspace/delivery", "/api/workspaces/:id/delivery"],
    ["/api/workspaces/my-workspace/context", "/api/workspaces/:id/context"],
    ["/api/workspaces/my-workspace/sessions", "/api/workspaces/:id/sessions"],
    ["/api/workspaces/my-workspace/self-churn", "/api/workspaces/:id/self-churn"],
    ["/api/recommendations/rec-1/apply", "/api/recommendations/:id/apply"],
    ["/api/recommendations/rec-1/open-terminal", "/api/recommendations/:id/open-terminal"],
    ["/api/recommendations/jobs/job-1", "/api/recommendations/jobs/:id"],
    ["/api/recommendations/jobs/job-1/confirm", "/api/recommendations/jobs/:id/confirm"],
    ["/api/recommendations/jobs/job-1/rollback", "/api/recommendations/jobs/:id/rollback"],
    ["/api/esf/session-observations/obs-1", "/api/esf/session-observations/:id"],
    ["/api/reports/2026-09-01", "/api/reports/:id"],
    // Static routes with no dynamic segment pass through unchanged.
    ["/api/overview", "/api/overview"],
    ["/api/status", "/api/status"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeRoute(input)).toBe(expected);
  });

  it("collapses distinct ids on the same parameterized route into one ring key", () => {
    for (const id of ["session-a", "session-b", "session-c"]) {
      const res = fakeRes();
      markRequestStart(res, `/api/sessions/${id}/turns`);
      finishRequest(res);
    }
    const snap = getPerfSnapshot();
    expect(Object.keys(snap.routes)).toEqual(["/api/sessions/:id/turns"]);
    expect(snap.routes["/api/sessions/:id/turns"]?.count).toBe(3);
  });
});

describe("event-loop lag", () => {
  it("reflects a genuine 120 ms synchronous block observed inside a real server request", async () => {
    const server = http.createServer((_req, res) => {
      const start = Date.now();
      while (Date.now() - start < 120) {
        // synchronous block — the event loop cannot service anything else
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const port = address.port;

    await new Promise<void>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: "/" }, (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve());
      });
      req.on("error", reject);
      req.end();
    });

    // monitorEventLoopDelay needs the loop to advance past the block to sample it.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    await new Promise<void>((resolve) => server.close(() => resolve()));

    const lag = getLoopLag();
    expect(lag.max).toBeGreaterThanOrEqual(100);
  });
});

describe("boot marks (P0-U4 / O-4)", () => {
  it("is undefined until process_start has been recorded", () => {
    expect(getBootMarks()).toBeUndefined();
    expect(formatBootMarks()).toBe("");
  });

  it("a stubbed 100 ms boot step shows a >=100 ms delta between its two marks", () => {
    recordBootMark("process_start", 1_000);
    recordBootMark("db_open", 1_005);
    // The stubbed slow step: 110 ms between its start and end mark.
    recordBootMark("catch_up_start", 1_010);
    recordBootMark("catch_up_end", 1_120);

    const marks = getBootMarks();
    expect(marks).toBeDefined();
    expect(marks?.process_start).toBe(0);
    expect(marks?.db_open).toBe(5);
    const delta = (marks?.catch_up_end ?? 0) - (marks?.catch_up_start ?? 0);
    expect(delta).toBeGreaterThanOrEqual(100);
  });

  it("is idempotent per name — only the first call for a mark is kept", () => {
    recordBootMark("process_start", 1_000);
    const firstRecorded = recordBootMark("listen", 1_200);
    const secondRecorded = recordBootMark("listen", 9_999); // e.g. a retried phase
    expect(firstRecorded).toBe(true);
    expect(secondRecorded).toBe(false);
    expect(getBootMarks()?.listen).toBe(200);
  });

  it("formats every recorded mark, in boot order, as one compact line", () => {
    recordBootMark("process_start", 500);
    recordBootMark("listen", 700);
    recordBootMark("db_open", 510);
    expect(formatBootMarks()).toBe("process_start=0 db_open=10 listen=200");
  });

  it("getPerfSnapshot exposes boot marks only once process_start is recorded", () => {
    expect(getPerfSnapshot().boot).toBeUndefined();
    recordBootMark("process_start", 42);
    expect(getPerfSnapshot().boot).toEqual({ process_start: 0 });
  });
});

describe("worker spawn/build timing (P0-U2b / M12)", () => {
  it("a stub worker whose first message is delayed >=100 ms reports spawn->first-message and build-total on /api/perf", async () => {
    // A minimal real worker_threads Worker (eval mode) that posts a message
    // after an injected 150 ms delay, then exits. Independent of any
    // production worker script — the oracle is the delay this test wrote.
    const worker = new Worker(
      `
      const { parentPort } = require("node:worker_threads");
      setTimeout(() => {
        parentPort.postMessage({ type: "result" });
      }, 150);
      `,
      { eval: true },
    );
    instrumentWorkerSpawn(worker, "test-kind");

    await new Promise<void>((resolve, reject) => {
      worker.once("exit", () => resolve());
      worker.once("error", reject);
    });

    const gauges = getWorkerGauges();
    const gauge = gauges["test-kind"];
    expect(gauge).toBeDefined();
    expect(gauge?.spawnToFirstMessageMs).toBeGreaterThanOrEqual(100);
    expect(gauge?.buildTotalMs).toBeGreaterThanOrEqual(
      gauge?.spawnToFirstMessageMs ?? Number.POSITIVE_INFINITY,
    );
    expect(gauge?.count).toBe(1);
    expect(getPerfSnapshot().workers?.["test-kind"]).toEqual(gauge);
  });

  it("is absent from /api/perf until a worker has completed", () => {
    expect(getPerfSnapshot().workers).toBeUndefined();
  });
});

describe("spans (P0-U2b / M13 — recs-key timing)", () => {
  it("records count and duration per named span", () => {
    recordSpan("recommendationsStateKey", 12);
    recordSpan("recommendationsStateKey", 8);
    const spans = getSpans();
    expect(spans.recommendationsStateKey).toEqual({
      count: 2,
      totalMs: 20,
      lastMs: 8,
      maxMs: 12,
    });
    expect(getPerfSnapshot().spans?.recommendationsStateKey).toEqual(spans.recommendationsStateKey);
  });

  it("withSpan times a synchronous call and returns its value", () => {
    const result = withSpan("expireRecommendationDismissals", () => {
      // Busy-wait on performance.now() — the same clock withSpan itself uses.
      // Date.now()'s coarser OS-timer resolution (~15 ms on Windows) can let this
      // loop exit a hair before 20 real ms have elapsed on the higher-resolution
      // clock, which is what withSpan records; aligning the two removes that gap.
      const start = performance.now();
      while (performance.now() - start < 20) {
        // intentional synchronous block — the injected delay is the oracle
      }
      return 3;
    });
    expect(result).toBe(3);
    expect(getSpans().expireRecommendationDismissals?.lastMs).toBeGreaterThanOrEqual(20);
  });

  it("is absent from /api/perf until a span has been recorded", () => {
    expect(getPerfSnapshot().spans).toBeUndefined();
  });
});

describe("WAL sampler (P0-U2b / M14)", () => {
  it("reports the byte size of a -wal file the test writes with a known size", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-perf-wal-"));
    const dbPath = path.join(dir, "fixture.sqlite");
    const walBytes = 12_345;
    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(walBytes));
    try {
      await sampleProcessGauges(dbPath);
      expect(getWalGauge()).toEqual({ bytes: walBytes });
      expect(getPerfSnapshot().wal).toEqual({ bytes: walBytes });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports 0 bytes when no -wal file exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-perf-wal-none-"));
    const dbPath = path.join(dir, "fixture.sqlite");
    try {
      await sampleProcessGauges(dbPath);
      expect(getWalGauge()).toEqual({ bytes: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is absent from /api/perf until sampled once", () => {
    expect(getPerfSnapshot().wal).toBeUndefined();
  });
});

describe("ingest bytes/s gauge (P0-U2b / M15)", () => {
  it("reports bytes/s consistent with a known number of bytes over a known injected window", () => {
    // 2,000,000 bytes recorded at t=0, then a 0-byte tick at t=2000 (an
    // injected clock, not a real sleep) — average rate is exactly computable:
    // 2,000,000 bytes / 2 s = 1,000,000 bytes/s.
    recordIngestBytes(2_000_000, 0);
    recordIngestBytes(0, 2_000);
    const gauge = getIngestGauge();
    expect(gauge).toEqual({ bytesPerSecond: 1_000_000, bytesTotal: 2_000_000 });
    expect(getPerfSnapshot().ingest).toEqual(gauge);
  });

  it("is absent from /api/perf until a chunk has been recorded", () => {
    expect(getPerfSnapshot().ingest).toBeUndefined();
  });
});

describe("process gauge — RSS/heapUsed (P0-U2b / M15)", () => {
  it("RSS and heapUsed are present on /api/perf once sampled", () => {
    sampleProcessGauges();
    const gauge = getProcessGauge();
    expect(gauge?.rssBytes).toBeGreaterThan(0);
    expect(gauge?.heapUsedBytes).toBeGreaterThan(0);
    expect(getPerfSnapshot().process).toEqual(gauge);
  });

  it("is absent from /api/perf until sampled once", () => {
    expect(getPerfSnapshot().process).toBeUndefined();
  });
});

describe("detector-pass counters (P0-U10 / storage + /api/perf exposure)", () => {
  it("is absent from /api/perf until a detector pass has been recorded", () => {
    expect(getDetectorPass()).toBeUndefined();
    expect(getPerfSnapshot().detectors).toBeUndefined();
  });

  it("stores and exposes a recorded detector pass verbatim", () => {
    const pass = {
      totalMs: 42,
      totalRows: 7,
      totalStmts: 3,
      detectorCount: 1,
      perDetector: { STUB: { ms: 42, stmts: 3, rows: 7 } },
    };
    recordDetectorPass(pass);
    expect(getDetectorPass()).toEqual(pass);
    expect(getPerfSnapshot().detectors).toEqual(pass);
  });

  it("formats a compact ranked (top 5) log line from a known snapshot", () => {
    const pass = {
      totalMs: 150,
      totalRows: 900,
      totalStmts: 12,
      detectorCount: 2,
      perDetector: {
        SLOW: { ms: 100, stmts: 8, rows: 700 },
        FAST: { ms: 50, stmts: 4, rows: 200 },
      },
    };
    const line = formatDetectorPass(pass);
    expect(line).toBe(
      "Detector pass: 150 ms, 900 rows, 12 stmts, 2 detectors; top: SLOW=100ms/700r, FAST=50ms/200r",
    );
  });
});

describe("timer-registration counter (P0-U10, AW_PERF_PROBE)", () => {
  it("is absent from /api/perf without AW_PERF_PROBE=1", () => {
    installTimerProbe();
    expect(getTimerRegistrations()).toBeUndefined();
    expect(getPerfSnapshot().timers).toBeUndefined();
  });

  it("counts setTimeout registrations by period once AW_PERF_PROBE=1 is set", () => {
    process.env.AW_PERF_PROBE = "1";
    installTimerProbe();
    const KNOWN_REGISTRATIONS = 3;
    const timers: NodeJS.Timeout[] = [];
    try {
      for (let i = 0; i < KNOWN_REGISTRATIONS; i++) {
        timers.push(setTimeout(() => {}, 20_000));
      }
      const registrations = getTimerRegistrations();
      expect(registrations).toBeDefined();
      expect(registrations?.["20000"]).toBe(KNOWN_REGISTRATIONS);
      expect(getPerfSnapshot().timers?.["20000"]).toBe(KNOWN_REGISTRATIONS);
    } finally {
      for (const t of timers) clearTimeout(t);
    }
  });
});

describe("errored-files gauge (P0-U13)", () => {
  it("reports the count and a bounded, hashed id list once set", () => {
    setErroredFiles(2, ["abc123", "def456"]);
    const gauge = getErroredFilesGauge();
    expect(gauge).toEqual({ count: 2, ids: ["abc123", "def456"] });
    expect(getPerfSnapshot().errored).toEqual(gauge);
  });

  it("is absent from /api/perf until a failure is recorded", () => {
    expect(getPerfSnapshot().errored).toBeUndefined();
  });
});

describe("per-span event-loop lag (P3-U1 / ?since=)", () => {
  // Injected samples live far in the future so the real 10 ms sampler's ticks never fall in a window.
  const T0 = Date.now() + 10_000_000;

  // Runs first in this describe: nothing in this file reads ?since= before it.
  it("the sampler is off at idle; a ?since= read arms it, and only spans after arming are covered", async () => {
    expect(getJobStats()["perf.loop-sample"]).toBeUndefined();
    const beforeArm = Date.now() - 1000;
    expect(getLoopLag(beforeArm).covered).toBe(false); // this read arms the sampler
    const armed = Date.now();
    await new Promise((r) => setTimeout(r, 120));
    expect(getJobStats()["perf.loop-sample"]?.count).toBeGreaterThan(0);
    const lag = getLoopLag(armed);
    expect(lag.covered).toBe(true);
    expect(lag.max).toBeGreaterThan(0); // real ticks landed in the span
    expect(getLoopLag(beforeArm).covered).toBe(false); // still not covered: it predates arming
  });

  it("includes only samples at/after since, and all of them (spike before excluded, spike after included)", () => {
    recordLoopSample(T0, 500); // spike before the span
    recordLoopSample(T0 + 500, 12);
    recordLoopSample(T0 + 1000, 12); // exactly at since: included
    recordLoopSample(T0 + 2000, 60); // spike inside the span
    const lag = getLoopLag(T0 + 1000);
    expect(lag.max).toBe(60);
    expect(lag.p99).toBe(60);
    expect(getLoopLag(T0 + 2001).max).toBe(0);
    expect(getLoopLag(T0).max).toBe(500);
  });

  it("getPerfSnapshot(since) reflects the span; no since keeps the 60 s histogram shape", () => {
    recordLoopSample(T0 + 20_000, 77);
    expect(getPerfSnapshot(T0 + 20_000).loop_lag.max).toBe(77);
    const plain = getPerfSnapshot().loop_lag;
    expect(Object.keys(plain).sort()).toEqual(["max", "p50", "p99"]);
  });

  it("keeps enough history to cover a 3-minute span: no in-span sample is lost", () => {
    expect(LOOP_SAMPLE_CAPACITY).toBeGreaterThanOrEqual(180 * 100);
    const base = T0 + 100_000;
    recordLoopSample(base, 91); // the oldest in-span sample
    for (let i = 1; i <= 100 * 120; i++) recordLoopSample(base + i * 10, 11);
    expect(getLoopLag(base).max).toBe(91);
  });
});
