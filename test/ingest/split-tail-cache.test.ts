/**
 * test/ingest/split-tail-cache.test.ts — P2-U4a per-step cost: a time-sliced
 * chunk is read from disk ONCE. The sub-steps after a split reuse the lines
 * already read instead of re-reading, decoding and splitting up to 1 MiB each
 * time. The cache is dropped when the file changes between steps, and the end
 * state still equals a from-scratch ingest (digest oracle, P0-U11).
 *
 * Synthetic content only (SEC-101).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HARNESS_NOW_MS,
  diffDigests,
  ingestDigest,
  ingestFromScratch,
} from "../../scripts/benchmark/backfill-harness.mjs";
import { runMigrations } from "../../src/db/migrate.js";
import { Ingestor } from "../../src/ingest/index.js";
import * as tail from "../../src/ingest/tail.js";
import { testSeams } from "../../src/ingest/test-seams.js";
import { generateCorpus, writeCorpus } from "./synth.js";

vi.mock("../../src/ingest/tail.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/ingest/tail.js")>();
  return { ...mod, tailFileChunk: vi.fn(mod.tailFileChunk) };
});

const reads = vi.mocked(tail.tailFileChunk);

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-p2u4a-cache-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  reads.mockClear();
  testSeams.txBudgetMs = 0; // one line per transaction on the yielding path
});
afterEach(() => {
  testSeams.txBudgetMs = null;
});

function corpusFile(dir: string, turns: number): { root: string; slug: string; file: string } {
  const root = path.join(tmp, dir);
  writeCorpus(root, generateCorpus(41, { slugs: 1, filesPerSlug: 1, turnsPerFile: turns }));
  const [slug] = fs.readdirSync(root);
  const [name] = fs.readdirSync(path.join(root, slug as string));
  return { root, slug: slug as string, file: path.join(root, slug as string, name as string) };
}

function freshIngestor(root: string): { db: Database.Database; ingestor: Ingestor } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return { db, ingestor: new Ingestor(db, [root], { now: () => new Date(HARNESS_NOW_MS) }) };
}

/** Steps taken: one per committed write transaction on the split path. */
function countSteps(ingestor: Ingestor): () => number {
  const walls = stepWalls(ingestor);
  return () => walls.length;
}

/** Wall time of every synchronous step (the event-loop block between yields). */
function stepWalls(ingestor: Ingestor): number[] {
  const target = ingestor as unknown as { ingestFileChunk: (...a: unknown[]) => unknown };
  const orig = target.ingestFileChunk.bind(ingestor);
  const walls: number[] = [];
  target.ingestFileChunk = (...a: unknown[]) => {
    const t0 = performance.now();
    try {
      return orig(...a);
    } finally {
      walls.push(performance.now() - t0);
    }
  };
  return walls;
}

function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // intentional synchronous delay — the injected cost is the oracle
  }
}

function digestMatchesScratch(root: string, db: Database.Database, ingestor: Ingestor): void {
  (ingestor as unknown as { reconcileNow: () => void }).reconcileNow();
  const scratch = ingestFromScratch(root);
  const want = ingestDigest(scratch);
  scratch.close();
  expect(diffDigests(want, ingestDigest(db))).toEqual([]);
}

describe("P2-U4a: a split chunk is read once", () => {
  it("one tailFileChunk read for a sub-1 MiB chunk split into many steps, end state equal", async () => {
    const { root, slug, file } = corpusFile("once", 40);
    expect(fs.statSync(file).size).toBeLessThan(1024 * 1024);
    const { db, ingestor } = freshIngestor(root);
    const steps = countSteps(ingestor);
    await ingestor.ingestFileYielding(file, slug);
    expect(steps()).toBeGreaterThan(5); // the split really happened
    expect(reads).toHaveBeenCalledTimes(1);
    digestMatchesScratch(root, db, ingestor);
    db.close();
  }, 60_000);

  it("drops the cached lines when the file grows between steps; appended lines are ingested", async () => {
    const { root, slug, file } = corpusFile("grow", 40);
    const full = fs.readFileSync(file, "utf8");
    const all = full.split("\n").filter((l) => l.length > 0);
    const half = Math.floor(all.length / 2);
    fs.writeFileSync(file, `${all.slice(0, half).join("\n")}\n`);
    const rest = `${all.slice(half).join("\n")}\n`;

    const { db, ingestor } = freshIngestor(root);
    const steps = countSteps(ingestor);
    let appended = false;
    // Grows the file on the first loop turn, i.e. between two split steps.
    const ticker = setInterval(() => {
      if (appended) return;
      appended = true;
      fs.appendFileSync(file, rest);
    }, 0);
    try {
      await ingestor.ingestFileYielding(file, slug);
    } finally {
      clearInterval(ticker);
    }
    expect(appended).toBe(true);
    expect(steps()).toBeGreaterThan(5);
    // First read (half the file), then one fresh read after the growth; no more.
    expect(reads).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(file, "utf8")).toBe(full);
    digestMatchesScratch(root, db, ingestor);
    db.close();
  }, 60_000);
});

describe("P2-U4a: the time budget covers the whole step, not just the transaction", () => {
  // Retried: a wall-clock bound on a shared machine. A budget measured from the transaction start
  // makes the first step ≥ 30 + 25 + 2 ms every time, so a real regression fails all three tries.
  it(
    "a 30 ms read before the transaction still leaves every step ≤ 50 ms",
    { retry: 2, timeout: 60_000 },
    async () => {
      const { tailFileChunk: realTail } = await vi.importActual<
        typeof import("../../src/ingest/tail.js")
      >("../../src/ingest/tail.js");
      const { root, slug, file } = corpusFile("whole-step", 80);
      const { db, ingestor } = freshIngestor(root);
      const target = ingestor as unknown as { applyLine: (...a: unknown[]) => void };
      const apply = target.applyLine.bind(ingestor);
      target.applyLine = (...a: unknown[]) => {
        apply(...a);
        busyWait(2); // > 50 ms of row work in total, so the chunk must split
      };
      reads.mockImplementationOnce((...a) => {
        busyWait(30); // a slow read: work done before the transaction opens
        return realTail(...a);
      });
      const walls = stepWalls(ingestor);
      testSeams.txBudgetMs = null; // the production budget
      await ingestor.ingestFileYielding(file, slug);
      expect(walls.length).toBeGreaterThanOrEqual(2);
      for (const w of walls) expect(w).toBeLessThanOrEqual(50);
      digestMatchesScratch(root, db, ingestor);
      db.close();
    },
  );
});
