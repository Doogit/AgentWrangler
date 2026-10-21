/**
 * test/ingest/time-sliced-tx.test.ts — P2-U4a: ingest write transactions ≤ 50 ms.
 *
 * A single sub-1 MiB chunk is made slow with a fake slow-write hook (every applied
 * line busy-waits 2 ms). Today the whole chunk is one transaction (~400 ms); after
 * P2-U4a the harness must observe ≥ 2 committed transactions for that chunk, each
 * ≤ 50 ms wall, with the event loop getting a turn between them, and the end state
 * equal to an un-hooked from-scratch ingest (digest oracle, P0-U11). The R-1/R-2
 * oracles in backfill-harness.test.ts re-run unchanged on the split path.
 *
 * Synthetic content only (SEC-101).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HARNESS_NOW_MS,
  diffDigests,
  ingestDigest,
  ingestFromScratch,
  runCrashScenario,
} from "../../scripts/benchmark/backfill-harness.mjs";
import { runMigrations } from "../../src/db/migrate.js";
import { Ingestor } from "../../src/ingest/index.js";
import { generateCorpus, writeCorpus } from "./synth.js";

const SLOW_MS_PER_LINE = 2;

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-p2u4a-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Db = Database.Database;

/** Times every OUTERMOST transaction that commits (the harness's own evidence). */
function recordTransactions(db: Db): Array<{ ms: number }> {
  const txs: Array<{ ms: number }> = [];
  const d = db as unknown as {
    transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => unknown;
  };
  const orig = d.transaction.bind(db);
  let depth = 0;
  d.transaction = (fn) => {
    const inner = orig(fn);
    return (...args: unknown[]) => {
      const outer = depth === 0;
      const t0 = performance.now();
      depth++;
      try {
        const r = inner(...args);
        if (outer) txs.push({ ms: performance.now() - t0 });
        return r;
      } finally {
        depth--;
      }
    };
  };
  return txs;
}

/** Fake slow-write hook: every applied line busy-waits SLOW_MS_PER_LINE. */
function slowWrites(ingestor: Ingestor): void {
  const target = ingestor as unknown as { applyLine: (...a: unknown[]) => void };
  const orig = target.applyLine.bind(ingestor);
  target.applyLine = (...a: unknown[]) => {
    orig(...a);
    const end = performance.now() + SLOW_MS_PER_LINE;
    while (performance.now() < end) {
      // intentional synchronous delay — the injected cost is the oracle
    }
  };
}

describe("P2-U4a: a slow chunk commits in ≤ 50 ms transactions", () => {
  it("≥ 2 committed transactions for one sub-1 MiB chunk, each ≤ 50 ms, loop turns between, end state equal", async () => {
    const root = path.join(tmp, "slow");
    writeCorpus(root, generateCorpus(41, { slugs: 1, filesPerSlug: 1, turnsPerFile: 80 }));
    const [slug] = fs.readdirSync(root);
    const [name] = fs.readdirSync(path.join(root, slug as string));
    const file = path.join(root, slug as string, name as string);
    expect(fs.statSync(file).size).toBeLessThan(1024 * 1024); // one chunk under the old rule

    const expected = ingestFromScratch(root);
    const want = ingestDigest(expected);
    const lines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.length > 0).length;
    expected.close();
    expect(lines * SLOW_MS_PER_LINE).toBeGreaterThan(100); // > 50 ms of row-writing work

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const ingestor = new Ingestor(db, [root], { now: () => new Date(HARNESS_NOW_MS) });
    slowWrites(ingestor);
    const txs = recordTransactions(db);
    let loopTurns = 0;
    const ticker = setInterval(() => {
      loopTurns++;
    }, 0);
    try {
      await ingestor.ingestFileYielding(file, slug as string);
    } finally {
      clearInterval(ticker);
    }
    const writeTxs = txs.filter((t) => t.ms >= SLOW_MS_PER_LINE); // drop the cheap metadata-only txs
    expect(writeTxs.length).toBeGreaterThanOrEqual(2);
    for (const t of writeTxs) expect(t.ms).toBeLessThanOrEqual(50);
    expect(loopTurns).toBeGreaterThanOrEqual(writeTxs.length - 1);
    // ingestFromScratch (runBackscan) reconciles after ingest; every daemon caller
    // of ingestFileYielding does too, so reconcile before comparing digests.
    (ingestor as unknown as { reconcileNow: () => void }).reconcileNow();
    expect(diffDigests(want, ingestDigest(db))).toEqual([]);
    db.close();
  }, 60_000);
});

describe("PERF ingest-lag: the whole step fits the budget, not just its lines", () => {
  it(
    "with a slow post-line tail (offset/baseline writes), committed transactions after the first stay <= budget",
    { retry: 2, timeout: 60_000 },
    async () => {
      const root = path.join(tmp, "slow-tail");
      writeCorpus(root, generateCorpus(43, { slugs: 1, filesPerSlug: 1, turnsPerFile: 80 }));
      const [slug] = fs.readdirSync(root);
      const [name] = fs.readdirSync(path.join(root, slug as string));
      const file = path.join(root, slug as string, name as string);

      const db = new Database(":memory:");
      db.pragma("foreign_keys = ON");
      runMigrations(db);
      const ingestor = new Ingestor(db, [root], { now: () => new Date(HARNESS_NOW_MS) });
      slowWrites(ingestor);
      // The classifier-baseline write runs once per step, after the last line, inside the tx.
      const TAIL_MS = 10;
      const target = ingestor as unknown as {
        stSetClassifierBaseline: { run: (...a: unknown[]) => unknown };
      };
      const stmt = target.stSetClassifierBaseline;
      target.stSetClassifierBaseline = {
        run: (...a: unknown[]) => {
          const r = stmt.run(...a);
          const end = performance.now() + TAIL_MS;
          while (performance.now() < end) {
            // intentional synchronous delay — the injected tail cost is the oracle
          }
          return r;
        },
      };
      const txs = recordTransactions(db);
      await ingestor.ingestFileYielding(file, slug as string);
      const writeTxs = txs.filter((t) => t.ms >= TAIL_MS); // the line-writing steps
      expect(writeTxs.length).toBeGreaterThanOrEqual(3);
      // The first step has no tail estimate yet; every later one stops its lines early enough.
      // Slack: one 2 ms line (the check runs between lines) + 2 ms timer noise.
      for (const t of writeTxs.slice(1))
        expect(t.ms).toBeLessThanOrEqual(25 + SLOW_MS_PER_LINE + 2);
      db.close();
    },
  );
});

describe("P2-U4b: yielding ingest waits on the write gate", () => {
  it("no write transaction starts while the gate's promise is pending; ingest resumes after", async () => {
    const root = path.join(tmp, "gate");
    writeCorpus(root, generateCorpus(43, { slugs: 1, filesPerSlug: 1, turnsPerFile: 80 }));
    const [slug] = fs.readdirSync(root);
    const [name] = fs.readdirSync(path.join(root, slug as string));
    const file = path.join(root, slug as string, name as string);

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    let gateCalls = 0;
    let release: (() => void) | undefined;
    const ingestor = new Ingestor(db, [root], {
      now: () => new Date(HARNESS_NOW_MS),
      writeGate: () => {
        gateCalls++;
        if (gateCalls !== 2) return null;
        return new Promise<void>((r) => {
          release = r;
        });
      },
    });
    slowWrites(ingestor); // several steps per chunk
    const txs = recordTransactions(db);
    const run = ingestor.ingestFileYielding(file, slug as string);
    while (release === undefined) await new Promise((r) => setImmediate(r));
    const held = txs.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(txs.length).toBe(held);
    release();
    await run;
    expect(txs.length).toBeGreaterThan(held);
    expect(gateCalls).toBeGreaterThan(2);
    db.close();
  }, 60_000);
});

describe("P2-U4a: R-2 on the split path (one line per tx via AW_TEST_TX_BUDGET_MS=0)", () => {
  const SPLIT = { AW_TEST_TX_BUDGET_MS: "0" };
  const BUDGET = 3_000;
  let root: string;
  let want: ReturnType<typeof ingestDigest>;

  beforeAll(() => {
    root = path.join(tmp, "r2-split");
    writeCorpus(root, generateCorpus(101, { slugs: 2, filesPerSlug: 2, turnsPerFile: 25 }));
    const scratch = ingestFromScratch(root);
    want = ingestDigest(scratch);
    scratch.close();
  });

  const digestOf = (dbPath: string) => {
    const db = new Database(dbPath);
    const d = ingestDigest(db);
    db.close();
    return d;
  };

  it("the split really happens: a clean run commits more transactions than the default budget", () => {
    const run = (env: Record<string, string> | undefined, dir: string) => {
      const workdir = path.join(tmp, dir);
      fs.mkdirSync(workdir, { recursive: true });
      return runCrashScenario({
        workdir,
        root,
        crashAt: undefined,
        budget: BUDGET,
        ...(env ? { env } : {}),
      });
    };
    const base = run(undefined, "r2-split-base");
    const split = run(SPLIT, "r2-split-clean");
    expect(split.restartedToDone && base.restartedToDone).toBe(true);
    expect(split.firstCommits).toBeGreaterThan(base.firstCommits);
    expect(diffDigests(want, digestOf(split.dbPath))).toEqual([]);
  }, 180_000);

  it.each(["after-tx:5", "after-tx:40", "bytes:6000", "file:3"])(
    "kill at %s → restart to done, digests equal, no line re-applied",
    (kp) => {
      const workdir = path.join(tmp, `r2-split-${kp.replace(/[^a-z0-9]/gi, "_")}`);
      fs.mkdirSync(workdir, { recursive: true });
      const r = runCrashScenario({ workdir, root, crashAt: kp, budget: BUDGET, env: SPLIT });
      expect(r.crashed).toBe(true);
      expect(r.killMarker).toBe(kp);
      expect(r.committedBeforeCrash).toBeGreaterThan(0);
      expect(r.restartedToDone).toBe(true);
      expect(diffDigests(want, digestOf(r.dbPath))).toEqual([]);
      expect(r.replayCounter).toBe(0);
    },
    180_000,
  );
});
