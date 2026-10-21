/** U3 background pipeline: post-ready cooperative ingest and detector boundary. */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeBackgroundDetectorPhase,
  createDetectorPassRunner,
} from "../../src/daemon/detector-pass.js";
import { createServer } from "../../src/daemon/http.js";
import type { Db } from "../../src/db/open.js";
import { Ingestor } from "../../src/ingest/index.js";
import type { BackgroundPipelineProgress } from "../../src/ingest/ingestor.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { migratedMemDb } from "../ingest/dbutil.js";
import { assistant, toJsonl } from "../ingest/synth.js";

const NOW = () => new Date("2026-08-01T00:00:00.000Z");
const OPTIONS = { now: NOW, activityWindowSecs: 300 };

function writeBacklog(
  root: string,
  rows = 1,
  modifiedAt = "2026-07-01T00:00:00.000Z",
  files = 1,
): void {
  const dir = path.join(root, "proj-background");
  fs.mkdirSync(dir, { recursive: true });
  const mtime = new Date(modifiedAt);
  // Spread the rows across `files` session files. With runBackgroundBackfill's
  // per-batch yield, more files = more cooperative yield points, so the backfill
  // stays genuinely active across a concurrent request instead of completing in a
  // single synchronous burst (which would make the NFR-105 budget test prove
  // nothing / flake on a single wall-clock sample).
  for (let f = 0; f < files; f++) {
    const count = Math.floor(rows / files) + (f < rows % files ? 1 : 0);
    const corpus = Array.from({ length: count }, (_, i) =>
      assistant({
        id: `background-${f}-${i}`,
        session: `background-session-${f}`,
        ts: `2026-07-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
        input: 10,
        output: 1,
      }),
    );
    const file = path.join(dir, `backlog-${f}.jsonl`);
    fs.writeFileSync(file, toJsonl(corpus), "utf8");
    fs.utimesSync(file, mtime, mtime);
  }
}

function requestOverview(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/overview",
        headers: { host: `127.0.0.1:${port}` },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(performance.now() - started));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** The W0 readiness slice (P2-U4). */
async function ingestW0(ingestor: Ingestor): Promise<void> {
  const w0 = ingestor.planSlices().find((s) => s.index === 0);
  if (w0 !== undefined) await ingestor.ingestSlice(w0);
}

function progress(): BackgroundPipelineProgress {
  return {
    phase: "reading",
    files_total: 1,
    files_completed: 1,
    files_skipped: 0,
    files_with_new_data: 1,
    detector_runs: 0,
  };
}

let db: Db | undefined;
let root: string | undefined;
let server: http.Server | undefined;

afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  resetQueryDb();
  db?.close();
  db = undefined;
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("U3 background pipeline", () => {
  it("backfills after readiness and runs detectors at the reading → detecting → done boundary", async () => {
    db = migratedMemDb();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-background-"));
    writeBacklog(root);
    const ingestor = new Ingestor(db, [root], OPTIONS);
    const reports: BackgroundPipelineProgress[] = [];

    const reading = await ingestor.runBackgroundBackfill(1, (snapshot) => reports.push(snapshot));
    const detector = createDetectorPassRunner({
      db,
      now: NOW,
      run: () => [
        { detector_id: "D_SYNTH", name: "Synthetic", status: "INACTIVE", note: "synthetic" },
      ],
    });
    await completeBackgroundDetectorPhase(reading, detector, (snapshot) => reports.push(snapshot));

    expect(reports.map((item) => item.phase)).toEqual(["reading", "reading", "detecting", "done"]);
    expect(reports.at(-1)).toMatchObject({
      files_total: 1,
      files_completed: 1,
      files_skipped: 0,
      files_with_new_data: 1,
      detector_runs: 1,
    });
  });

  it("keeps /api/overview within the NFR-105 250 ms budget while 1 MiB-chunked backfill is active", async () => {
    db = migratedMemDb();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-background-http-"));
    // Spread across many files so batchSize=1 yields between each, keeping the
    // backfill demonstrably active while the request is served.
    writeBacklog(root, 10_000, "2026-07-01T00:00:00.000Z", 40);
    setQueryDb(db);
    server = createServer(db, 0, null);
    const port = await new Promise<number>((resolve, reject) => {
      server?.listen(0, "127.0.0.1", () => resolve((server?.address() as { port: number }).port));
      server?.on("error", reject);
    });
    const ingestor = new Ingestor(db, [root], OPTIONS);

    let completed = false;
    const backfill = ingestor.runBackgroundBackfill(1);
    void backfill.then(() => {
      completed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The backfill has yielded at least once and is still running: readiness/HTTP
    // is not gated on it.
    expect(completed).toBe(false);
    const latencyMs = await requestOverview(port);
    await backfill;

    expect(latencyMs).toBeLessThanOrEqual(250);
  }, 30_000); // a 10,000-file backfill (3–4 s alone); the 250 ms budget above is the assertion

  it("halts at the reading boundary when a backfill chunk fails", async () => {
    db = migratedMemDb();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-background-fail-"));
    writeBacklog(root, 2);
    const ingestor = new Ingestor(db, [root], OPTIONS);
    const reports: BackgroundPipelineProgress[] = [];
    const target = ingestor as unknown as { applyLine: (...args: unknown[]) => void };
    const original = target.applyLine.bind(ingestor);
    target.applyLine = (...args) => {
      original(...args);
      throw new Error("synthetic backfill failure");
    };

    await expect(
      ingestor.runBackgroundBackfill(1, (snapshot) => reports.push(snapshot)),
    ).rejects.toThrow("synthetic backfill failure");
    expect(reports.map((item) => item.phase)).toEqual(["reading"]);
  });

  // P2H (spec-rec-page-history-walk.md §Boot): this case used to assert NO detector
  // work when the backfill found nothing new. That short-circuit is the restart
  // gap the spec fixes — the history walk now runs on every boot.
  it("runs the history walk on boot even when no backlog extends beyond the 7d readiness window", async () => {
    db = migratedMemDb();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-background-caught-up-"));
    writeBacklog(root, 1, "2026-07-31T00:00:00.000Z");
    const ingestor = new Ingestor(db, [root], OPTIONS);
    const reports: BackgroundPipelineProgress[] = [];

    await ingestW0(ingestor);
    const reading = await ingestor.runBackgroundBackfill(1, (snapshot) => reports.push(snapshot));
    // Default runner = the real history walk.
    const runner = createDetectorPassRunner({ db, now: NOW });
    const weeks: number[] = [];
    await completeBackgroundDetectorPhase(
      reading,
      runner,
      (snapshot) => reports.push(snapshot),
      (p) => weeks.push(p.weeks_done),
    );

    expect(reading.files_with_new_data).toBe(0);
    expect(reports.map((item) => item.phase).slice(-2)).toEqual(["detecting", "done"]);
    expect(reports.at(-1)?.detector_runs).toBeGreaterThan(0);
    // The only turn (2026-07-01) is older than W0 = [07-25, 08-01), so the walk
    // covers W0 plus closed grid weeks back to the week holding 07-01.
    expect(weeks[0]).toBe(1);
    // W0's evaluated marker: week_start = NOW − 7d = 2026-07-25T00:00:00.000Z.
    expect(
      db
        .prepare("SELECT week_start FROM detector_week_marks WHERE week_end = ?")
        .get(NOW().toISOString()),
    ).toEqual({ week_start: "2026-07-25T00:00:00.000Z" });
  });

  it("forceDetectors re-runs detectors on a detecting-failure retry even when the re-read finds no new files", async () => {
    db = migratedMemDb();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-background-retry-"));
    writeBacklog(root, 1, "2026-07-31T00:00:00.000Z");
    const ingestor = new Ingestor(db, [root], OPTIONS);
    const reports: BackgroundPipelineProgress[] = [];

    await ingestW0(ingestor);
    // A retry re-reads offset-incrementally, so no new files this pass.
    const reading = await ingestor.runBackgroundBackfill(1, (snapshot) => reports.push(snapshot));
    let calls = 0;
    const runner = createDetectorPassRunner({
      db,
      run: () => {
        calls++;
        return [];
      },
    });
    await completeBackgroundDetectorPhase(reading, runner, (snapshot) => reports.push(snapshot));

    expect(reading.files_with_new_data).toBe(0);
    expect(calls).toBe(1);
    expect(reports.map((item) => item.phase).at(-1)).toBe("done");
    expect(reports.some((item) => item.phase === "detecting")).toBe(true);
  });
});

describe("P2H detector-pass runner (history walk)", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("coalesces overlapping requests into exactly one follow-up and surfaces its failure", async () => {
    db = migratedMemDb();
    const walks = [deferred<[]>(), deferred<[]>()];
    let calls = 0;
    const runner = createDetectorPassRunner({
      db,
      now: NOW,
      run: () => walks[calls++]?.promise ?? Promise.resolve([]),
    });

    const first = runner.runIfDue(true);
    // Two requests while walk 1 is in flight share ONE follow-up (walk 2).
    const second = runner.runIfDue(true);
    const third = runner.runIfDue(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    expect(runner.isRunning).toBe(true);

    walks[0]?.resolve([]);
    await expect(first).resolves.toEqual({ ran: true, detector_runs: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(2);

    walks[1]?.reject(new Error("synthetic follow-up failure"));
    await expect(second).rejects.toThrow("synthetic follow-up failure");
    await expect(third).rejects.toThrow("synthetic follow-up failure");
    expect(calls).toBe(2);
    expect(runner.isRunning).toBe(false);
  });

  it("a retry during an in-flight walk reports the follow-up's failure, not an early done", async () => {
    db = migratedMemDb();
    const inFlight = deferred<[]>();
    let calls = 0;
    const runner = createDetectorPassRunner({
      db,
      now: NOW,
      run: () => {
        calls++;
        if (calls === 1) return inFlight.promise;
        throw new Error("synthetic walk failure");
      },
    });
    const hookWalk = runner.runIfDue(true); // e.g. the post-ingest hook's walk
    const reports: BackgroundPipelineProgress[] = [];
    const retry = completeBackgroundDetectorPhase(progress(), runner, (s) => reports.push(s));
    inFlight.resolve([]);
    await hookWalk;

    await expect(retry).rejects.toThrow("synthetic walk failure");
    // The daemon's catch turns this into setPipelineFailed("detecting"): no "done" reported.
    expect(reports.map((r) => r.phase)).toEqual(["detecting"]);
  });

  it("P2-U4: a shared follow-up is floored only when every request was, at the lowest floor", async () => {
    db = migratedMemDb();
    const gates = [deferred<[]>(), deferred<[]>(), deferred<[]>(), deferred<[]>()];
    const floors: Array<number | undefined> = [];
    const runner = createDetectorPassRunner({
      db,
      now: NOW,
      run: (_db, _at, _onWeek, floor) => {
        floors.push(floor);
        return gates[floors.length - 1]?.promise ?? Promise.resolve([]);
      },
    });

    const first = runner.runIfDue(true, undefined, undefined, 300);
    const b = runner.runIfDue(true); // a full walk wins, even over a later floored request
    const a = runner.runIfDue(true, undefined, undefined, 200);
    gates[0]?.resolve([]);
    await first;
    gates[1]?.resolve([]);
    await Promise.all([a, b]);

    const c = runner.runIfDue(true, undefined, undefined, 500);
    const d = runner.runIfDue(true, undefined, undefined, 400);
    const e = runner.runIfDue(true, undefined, undefined, 450);
    gates[2]?.resolve([]);
    await c;
    gates[3]?.resolve([]);
    await Promise.all([d, e]);
    expect(floors).toEqual([300, undefined, 500, 400]);
  });

  it("runs the walk at the caller's injected clock (post-ingest hook, NFR-107)", async () => {
    db = migratedMemDb();
    const seen: string[] = [];
    const runner = createDetectorPassRunner({
      db,
      now: () => new Date("2099-01-01T00:00:00.000Z"),
      run: (_db, at) => {
        seen.push(at.toISOString());
        return [];
      },
    });
    await runner.runIfDue(true, undefined, new Date("2026-08-01T00:00:00.000Z"));
    expect(seen).toEqual(["2026-08-01T00:00:00.000Z"]);
  });
});
