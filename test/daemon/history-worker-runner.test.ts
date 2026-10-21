import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHistoryWorkerRunner } from "../../src/daemon/history-worker-runner.js";
import { getPerfSnapshot, resetWorkerGauges } from "../../src/daemon/perf-monitor.js";
import { createFixtureDb } from "../fixtures/seed.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  resetWorkerGauges();
});

it("runs a history walk on a separate connection and reports committed progress", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-history-worker-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "fixture.sqlite");
  const db = createFixtureDb(dbPath);
  const runner = createHistoryWorkerRunner(dbPath);
  const now = new Date("2026-08-01T00:00:00.000Z");
  const weeks: number[] = [];
  try {
    const statuses = await runner.run(now, (progress) => weeks.push(progress.weeks_done));
    expect(statuses).toHaveLength(31);
    expect(weeks[0]).toBe(1);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM detector_status_live WHERE evaluated_at = ?")
        .get(now.toISOString()),
    ).toEqual({ n: 31 });
    // instrumentWorkerSpawn records on the worker's "exit" event, which fires
    // asynchronously after this run() promise resolves (same as the P0-U2b test
    // below). Without this wait, the exit can land during a LATER test — after
    // this test's own afterEach has already reset the gauges — and double-count
    // there. Waiting here lets it land (and get reset) inside this test instead.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    runner.stop();
    db.close();
  }
});

it("a walk's writes get the lock while main writes in 25 ms steps that honour writeGate (G-P2 lock defect)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-history-worker-lock-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "fixture.sqlite");
  const db = createFixtureDb(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER PRIMARY KEY, v INTEGER)");
  const runner = createHistoryWorkerRunner(dbPath);
  // Same shape as yielding ingest: await the gate, hold the write lock for one 25 ms step,
  // then yield one full loop turn.
  let walking = true;
  let steps = 0;
  const writer = (async () => {
    const insert = db.prepare("INSERT INTO lock_probe (v) VALUES (?)");
    while (walking) {
      const gate = runner.writeGate();
      if (gate) await gate;
      db.transaction(() => {
        const t0 = performance.now();
        while (performance.now() - t0 < 25) insert.run(steps);
      })();
      steps++;
      await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    }
  })();
  try {
    const statuses = await runner.run(new Date("2026-08-01T00:00:00.000Z"));
    expect(statuses).toHaveLength(31);
    expect(steps).toBeGreaterThan(0);
    expect(runner.writeGate()).toBeNull();
  } finally {
    walking = false;
    await writer;
    await new Promise((resolve) => setTimeout(resolve, 50));
    runner.stop();
    db.close();
  }
}, 30_000);

it("records spawn/build-total timing under the 'history' worker kind (P0-U2b)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-history-worker-perf-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "fixture.sqlite");
  const db = createFixtureDb(dbPath);
  const runner = createHistoryWorkerRunner(dbPath);
  resetWorkerGauges();
  try {
    await runner.run(new Date("2026-08-01T00:00:00.000Z"));
    // instrumentWorkerSpawn records on the worker's "exit" event, which fires
    // asynchronously just after the runner's own promise resolves.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const gauge = getPerfSnapshot().workers?.history;
    expect(gauge).toBeDefined();
    expect(gauge?.count).toBe(1);
    expect(gauge?.buildTotalMs).toBeGreaterThanOrEqual(
      gauge?.spawnToFirstMessageMs ?? Number.POSITIVE_INFINITY,
    );
  } finally {
    runner.stop();
    db.close();
  }
});
