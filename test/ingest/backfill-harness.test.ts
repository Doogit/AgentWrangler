/**
 * test/ingest/backfill-harness.test.ts — P0-U11 R-1 / R-2 / O-3.
 *
 * R-1: the same corpus delivered from scratch vs in random append chunks (forced
 *      mid-line and mid-UTF-8 splits) yields equal table digests, plus equal
 *      detector_week_results / recommendations digests after a walk at a fixed clock.
 * R-2: hard-kill a child at each kill point, restart to done; digests equal AND the
 *      harness-measured "no chunk re-applied" replay counter is 0.
 * O-3: statement/row/byte counters vs a committed baseline (+10% budget).
 *
 * Synthetic content only (SEC-101).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CrashRunResult,
  type Digest,
  HARNESS_NOW_MS,
  O3_BASELINE_PATH,
  O3_SCENARIOS,
  corpusFiles,
  deliverChunked,
  detectorDigest,
  diffDigests,
  ingestDigest,
  ingestFromScratch,
  measureO3,
  o3Overruns,
  planSplits,
  runCrashScenario,
  withPinnedClock,
} from "../../scripts/benchmark/backfill-harness.mjs";
import { runMigrations } from "../../src/db/migrate.js";
import { Ingestor } from "../../src/ingest/index.js";
import { generateCorpus, writeCorpus } from "./synth.js";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-u11-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function fullDigest(db: Database.Database): Promise<Digest> {
  return { ...ingestDigest(db), ...(await detectorDigest(db)) };
}

describe("R-1: chunked append delivery equals a from-scratch ingest", () => {
  const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
  it.each(SEEDS)(
    "seed %i",
    async (seed) => {
      const corpus = generateCorpus(seed, { slugs: 2, filesPerSlug: 2, turnsPerFile: 12 });
      const files = corpusFiles(corpus);

      const scratchRoot = path.join(tmp, `r1-${seed}-scratch`);
      writeCorpus(scratchRoot, corpus);
      const scratch = ingestFromScratch(scratchRoot);
      const expected = await fullDigest(scratch);
      scratch.close();
      expect(expected.turns?.count ?? 0).toBeGreaterThan(0);
      expect(expected.detector_week_results?.count ?? 0).toBeGreaterThan(0);
      expect(expected.recommendations?.count ?? 0).toBeGreaterThan(0);
      expect(expected.detector_week_results?.duplicateKeys).toBe(0);
      expect(expected.recommendations?.duplicateKeys).toBe(0);

      const chunkedRoot = path.join(tmp, `r1-${seed}-chunked`);
      fs.mkdirSync(chunkedRoot, { recursive: true });
      const db = new Database(":memory:");
      db.pragma("foreign_keys = ON");
      runMigrations(db);
      const ingestor = new Ingestor(db, [chunkedRoot], { now: () => new Date(HARNESS_NOW_MS) });
      const plan = planSplits(seed, files);
      expect(plan.midLine).toBeGreaterThanOrEqual(1);
      expect(plan.midUtf8).toBeGreaterThanOrEqual(1);
      deliverChunked(chunkedRoot, files, plan, ingestor);
      const actual = await fullDigest(db);
      db.close();

      expect(diffDigests(expected, actual)).toEqual([]);
    },
    60_000,
  );
});

describe("R-1 oracle is not vacuous", () => {
  it("flags a delivery that never completes its last chunk", async () => {
    const corpus = generateCorpus(1, { slugs: 1, filesPerSlug: 2, turnsPerFile: 12 });
    const files = corpusFiles(corpus);
    const scratchRoot = path.join(tmp, "nv-scratch");
    writeCorpus(scratchRoot, corpus);
    const scratch = ingestFromScratch(scratchRoot);
    const expected = await fullDigest(scratch);
    scratch.close();

    const root = path.join(tmp, "nv-chunked");
    fs.mkdirSync(root, { recursive: true });
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const ingestor = new Ingestor(db, [root], { now: () => new Date(HARNESS_NOW_MS) });
    const plan = planSplits(1, files);
    const first = files[0];
    const key = `${first?.slug}/${first?.name}`;
    plan.splits.set(key, (plan.splits.get(key) as number[]).slice(0, -1));
    deliverChunked(root, files, plan, ingestor);
    const actual = await fullDigest(db);
    db.close();
    expect(diffDigests(expected, actual).length).toBeGreaterThan(0);
  }, 60_000);
});

describe("R-2: hard kill, restart to done", () => {
  const KILL_POINTS = [
    "file:2", // before the first chunk tx of the 2nd file
    "bytes:6000", // mid-chunk, inside the tx, after >= 6000 raw bytes applied
    "mid-tx:2", // mid-chunk inside the tx of the 2nd multi-line chunk
    "after-tx:2", // 2nd chunk tx committed (offset + baselines inside it, P0-U12), in-memory folds not yet run
    "mid-reconcile",
  ];
  const BUDGET = 3_000;

  let root: string;
  let expected: Digest;
  const results = new Map<string, CrashRunResult>();

  beforeAll(async () => {
    root = path.join(tmp, "r2-root");
    writeCorpus(root, generateCorpus(101, { slugs: 2, filesPerSlug: 2, turnsPerFile: 25 }));
    const scratch = ingestFromScratch(root);
    expected = await fullDigest(scratch);
    scratch.close();
    expect(expected.detector_week_results?.count ?? 0).toBeGreaterThan(0);
    expect(expected.recommendations?.count ?? 0).toBeGreaterThan(0);
  });

  function run(kp: string): CrashRunResult {
    let r = results.get(kp);
    if (r === undefined) {
      const workdir = path.join(tmp, `r2-${kp.replace(/[^a-z0-9]/gi, "_")}`);
      fs.mkdirSync(workdir, { recursive: true });
      r = runCrashScenario({ workdir, root, crashAt: kp, budget: BUDGET });
      results.set(kp, r);
    }
    return r;
  }

  for (const kp of KILL_POINTS) {
    describe(kp, () => {
      it("the seam fired at the intended point (kill marker) after some work was committed", () => {
        const r = run(kp);
        expect(r.crashed).toBe(true);
        expect(r.killMarker).toBe(kp);
        expect(r.committedBeforeCrash).toBeGreaterThan(0);
      }, 180_000);

      it("really crashes, then restarts to done with digests equal to a from-scratch ingest", async () => {
        const r = run(kp);
        expect(r.crashed).toBe(true);
        expect(r.killMarker).toBe(kp);
        expect(r.restartedToDone).toBe(true);
        const wdb = new Database(r.dbPath);
        wdb.pragma("foreign_keys = ON");
        const actual = await fullDigest(wdb);
        wdb.close();
        expect(diffDigests(expected, actual)).toEqual([]);
      }, 180_000);

      it("no chunk re-applied after restart (replay counter is 0)", () => {
        // Preconditions (crash really happened at kp, work was committed) are proven by
        // the plain test above, so a failure here can only be the replay counter.
        const r = run(kp);
        expect(r.replayCounter).toBe(0);
      }, 180_000);
    });
  }

  it("is a real check: a clean run replays nothing, and the seams are inert with AW_TEST_HOOKS off", () => {
    for (const hooks of [undefined, "off" as const]) {
      const workdir = path.join(tmp, `r2-inert-${hooks ?? "clean"}`);
      fs.mkdirSync(workdir, { recursive: true });
      const r = runCrashScenario({
        workdir,
        root,
        crashAt: hooks === undefined ? undefined : "after-tx:1",
        budget: BUDGET,
        ...(hooks === undefined ? {} : { hooks }),
      });
      expect(r.crashed).toBe(false);
      expect(r.restartedToDone).toBe(true);
      expect(r.replayCounter).toBe(0);
      expect(r.restartApplied).toBe(0);
    }
  }, 180_000);
});

describe("O-3: statement / row / byte counters vs the committed baseline", () => {
  const baseline = JSON.parse(fs.readFileSync(O3_BASELINE_PATH, "utf8")) as {
    scenarios: Record<string, Record<string, number>>;
  };
  it.each([...O3_SCENARIOS])(
    "%s stays within +10% of baseline",
    async (scenario) => {
      const dir = fs.mkdtempSync(path.join(tmp, "o3-"));
      const counts = await measureO3(scenario, dir);
      const base = baseline.scenarios[scenario];
      expect(base).toBeDefined();
      expect(o3Overruns(scenario, counts, base as Record<string, number>)).toEqual([]);
      expect(counts.statementsPrepared + counts.rowsStepped + counts.bytesParsed).toBeGreaterThan(
        0,
      );
    },
    120_000,
  );

  it("P3-U1 negative: a statement count +15% over the committed baseline fails the gate", () => {
    const base = baseline.scenarios["one-get-per-route"] as Record<string, number>;
    const bump = (pct: number) => ({
      statementsPrepared: Math.ceil((base.statementsPrepared as number) * (1 + pct)),
      statementExecutions: base.statementExecutions as number,
      rowsStepped: base.rowsStepped as number,
      bytesParsed: base.bytesParsed as number,
    });
    const over = o3Overruns("one-get-per-route", bump(0.15), base);
    expect(over).toHaveLength(1);
    expect(over[0]).toMatch(/one-get-per-route\.statementsPrepared/);
    expect(o3Overruns("one-get-per-route", bump(0.09), base)).toEqual([]);
    expect(o3Overruns("one-get-per-route", bump(0), base)).toEqual([]);
  });

  it("withPinnedClock pins Date.now() AND no-arg new Date(), then restores", async () => {
    const RealDate = Date;
    await withPinnedClock(async () => {
      expect(Date.now()).toBe(HARNESS_NOW_MS);
      expect(new Date().getTime()).toBe(HARNESS_NOW_MS);
      expect(new Date(5).getTime()).toBe(5);
      expect(new Date("2020-01-01T00:00:00Z").getTime()).toBe(Date.UTC(2020, 0, 1));
    });
    expect(Date).toBe(RealDate);
    expect(Math.abs(new Date().getTime() - RealDate.now())).toBeLessThan(5_000);
  });
});
