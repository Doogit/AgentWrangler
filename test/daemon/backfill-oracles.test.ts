/**
 * test/daemon/backfill-oracles.test.ts — P2-U1 oracles for slicing and loop lag.
 *
 * 1. Harness self-test: a forced 120 ms block inside a real HTTP server shows up
 *    in the harness's own /api/perf sampling + summary (M1), as in P0-U11.
 * 2. 7d completeness: at W0 done (today: the readiness slice), the count of turns
 *    in the last 7 days equals the uninterrupted ingest's count, at a fixed clock.
 *    Adversarial fixtures are written by hand here, independent of the generator.
 * 3. R-3 generator: deterministic, aggregate-shaped, mtimes over the dataset weeks.
 *
 * Synthetic content only (SEC-101).
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateBackfillCorpus,
  loadDistributions,
} from "../../scripts/benchmark/backfill-corpus.mjs";
import {
  HARNESS_NOW_MS,
  ingestFromScratch,
  sampleBackfill,
  sevenDayTurnCount,
  summarizeBackfill,
} from "../../scripts/benchmark/backfill-harness.mjs";
import { runMigrations } from "../../src/db/migrate.js";
import { Ingestor } from "../../src/ingest/index.js";
import { assistant, toJsonl, userPrompt } from "../ingest/synth.js";

const DAY = 86_400_000;
const NOW = HARNESS_NOW_MS;

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-p2u1-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── 1. harness self-test ─────────────────────────────────────────────────────

/**
 * A fake daemon: /api/perf serves loop lag from its own fresh event-loop histogram
 * (same settings as perf-monitor, which perf-monitor.test.ts covers), so test-file
 * import noise is outside the window; /api/status scripts the pipeline.
 */
async function fakeDaemon(blockMs: number): Promise<{ url: string; close: () => Promise<void> }> {
  let statusCalls = 0;
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const server = http.createServer((req, res) => {
    if (req.url === "/api/perf") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const ms = (ns: number) => ns / 1e6;
      res.end(
        JSON.stringify({
          loop_lag: { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max) },
        }),
      );
      return;
    }
    if (req.url === "/api/status") {
      statusCalls++;
      // reading for 4 polls (one forced block on the 2nd), then done
      if (statusCalls === 2 && blockMs > 0) {
        const start = Date.now();
        while (Date.now() - start < blockMs) {
          // intentional synchronous block — the injected delay is the oracle
        }
      }
      const phase = statusCalls >= 5 ? "done" : "reading";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ pipeline: { phase, weeks_done: 0, files_completed: 0 } }));
      return;
    }
    if (req.url === "/api/ready") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        h.disable();
        server.close(() => resolve());
      }),
  };
}

describe("harness self-test (M1 sampling sees a forced block)", () => {
  it("a forced 120 ms block during the backfill shows as M1 max >= 100 ms", async () => {
    const d = await fakeDaemon(120);
    try {
      const samples = await sampleBackfill(d.url, { intervalMs: 100, timeoutMs: 20_000 });
      expect(samples.length).toBeGreaterThanOrEqual(5);
      expect(samples.at(-1)?.phase).toBe("done");
      const summary = summarizeBackfill(samples, { corpusBytes: 1 });
      expect(summary.m1.max).toBeGreaterThanOrEqual(100);
      expect(summary.m8_ms).not.toBeNull();
    } finally {
      await d.close();
    }
  }, 30_000);
});

describe("summarizeBackfill (pure)", () => {
  const s = (
    t: number,
    phase: string,
    p99: number,
    max: number,
    rss: number,
    heap: number,
    ready = true,
  ) => ({
    t,
    phase,
    ready,
    weeksDone: null,
    lag: { p50: 10, p99, max },
    rss,
    heapUsed: heap,
  });
  it("M1 = p99-of-p99 and max over the backfill window; M6/M8 from the first done; M15 from rss/heap", () => {
    const samples = [
      s(0, "boot", 900, 900, 100, 10, false),
      s(500, "reading", 20, 30, 120, 20),
      s(1000, "reading", 400, 600, 200, 40),
      s(1500, "detecting", 30, 40, 150, 30),
      s(2000, "done", 15, 20, 140, 25),
      s(2500, "done", 15, 20, 140, 25),
    ];
    const r = summarizeBackfill(samples, { corpusBytes: 2_000_000 });
    // the pre-ready boot sample is outside the backfill window
    expect(r.m1.max).toBe(600);
    expect(r.m1.p99_of_p99).toBe(400);
    expect(r.ready_ms).toBe(500);
    expect(r.m8_ms).toBe(2000);
    // no slice fields yet: M6 falls back to pipeline done (plan §4 "today")
    expect(r.m6_ms).toBe(2000);
    expect(r.m15.rss_peak).toBe(200);
    expect(r.m15.heap_growth).toBe(25 - 10);
    expect(r.m15.mb_per_s).toBeCloseTo(2 / 2, 5);
  });
});

// ── 2. 7d completeness oracle + adversarial fixtures ─────────────────────────

const iso = (ms: number) => new Date(ms).toISOString();

/** One hand-written session file: `turns` assistant turns at the given times. */
function writeSession(
  root: string,
  slug: string,
  session: string,
  turnTimes: number[],
  mtimeMs: number,
): string {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [userPrompt({ session, ts: iso(turnTimes[0] as number) })];
  turnTimes.forEach((t, i) =>
    lines.push(assistant({ id: `msg_${session}_${i}`, session, ts: iso(t), input: 10, output: 5 })),
  );
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, toJsonl(lines), "utf8");
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

/** Turns at `count` evenly spaced times in [from, to]. */
function spread(from: number, to: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) =>
    Math.round(from + ((to - from) * i) / Math.max(1, count - 1)),
  );
}

/** P2-U4's W0 slice (files with mtime in the last 7 days), then the 7-day count at that moment. */
async function w0Count(root: string): Promise<number> {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const ingestor = new Ingestor(db, [root], { now: () => new Date(NOW) });
  const w0 = ingestor.planSlices().find((s) => s.index === 0);
  if (w0 !== undefined) expect((await ingestor.ingestSlice(w0)).rest).toEqual([]);
  const n = sevenDayTurnCount(db, NOW);
  db.close();
  return n;
}

function fullCount(root: string): number {
  const db = ingestFromScratch(root, NOW);
  const n = sevenDayTurnCount(db, NOW);
  db.close();
  return n;
}

describe("7d completeness oracle", () => {
  it("sevenDayTurnCount counts exactly the turns with ts >= now - 7d", () => {
    const root = path.join(tmp, "count");
    writeSession(
      root,
      "p",
      "s-count",
      [NOW - 8 * DAY, NOW - 7 * DAY, NOW - 7 * DAY + 1, NOW - DAY],
      NOW,
    );
    expect(fullCount(root)).toBe(3);
  });

  describe("adversarial fixtures (hand-written, independent of the generator)", () => {
    it("a session spanning the W0/W1 boundary (mtime in W0): W0 count is complete", async () => {
      const root = path.join(tmp, "span");
      writeSession(root, "p", "s-span", spread(NOW - 10 * DAY, NOW - 2 * DAY, 12), NOW - 2 * DAY);
      const full = fullCount(root);
      expect(full).toBeGreaterThan(0);
      expect(await w0Count(root)).toBe(full);
    });

    it("an old file touched today: ingested in W0, contributes 0 in-window turns, W0 count complete", async () => {
      const root = path.join(tmp, "touched");
      writeSession(root, "p", "s-old-touched", spread(NOW - 40 * DAY, NOW - 30 * DAY, 6), NOW);
      writeSession(root, "p", "s-recent", spread(NOW - 3 * DAY, NOW - DAY, 4), NOW - DAY);
      expect(fullCount(root)).toBe(4);
      expect(await w0Count(root)).toBe(4);
    });

    it("a W0-mtime file whose turns span 6 weeks: W0 count complete", async () => {
      const root = path.join(tmp, "sixweeks");
      writeSession(root, "p", "s-6w", spread(NOW - 42 * DAY, NOW - DAY, 30), NOW - DAY);
      const full = fullCount(root);
      expect(full).toBeGreaterThan(0);
      expect(await w0Count(root)).toBe(full);
    });

    it("a file whose mtime is older than its newest turn: W0 by mtime misses exactly its in-window turns (D4's stated assumption)", async () => {
      // D4: "every turn in the last 7 days sits in a file modified in the last 7 days".
      // This file breaks that on purpose (utimes back-dated); the documented behavior is
      // a known, bounded miss, which the oracle must detect rather than hide.
      const root = path.join(tmp, "backdated");
      writeSession(
        root,
        "p",
        "s-backdated",
        spread(NOW - 12 * DAY, NOW - 2 * DAY, 11),
        NOW - 9 * DAY,
      );
      writeSession(root, "p", "s-normal", spread(NOW - 3 * DAY, NOW - DAY, 5), NOW - DAY);
      const full = fullCount(root);
      const backdatedInWindow = spread(NOW - 12 * DAY, NOW - 2 * DAY, 11).filter(
        (t) => t >= NOW - 7 * DAY,
      ).length;
      expect(backdatedInWindow).toBeGreaterThan(0);
      expect(await w0Count(root)).toBe(full - backdatedInWindow);
    });
  });

  // E9: the U2 readiness slice was capped at 25 sessions / 24 MiB, so a W0 with more files
  // was incomplete at ready. P2-U4 removed the cap (D4).
  it("W0 with more files than the 25-session cap is complete at W0 done (P2-U4)", async () => {
    const root = path.join(tmp, "capped");
    for (let i = 0; i < 30; i++) {
      writeSession(
        root,
        "p",
        `s-w0-${i}`,
        spread(NOW - 5 * DAY, NOW - DAY, 3),
        NOW - DAY - i * 60_000,
      );
    }
    expect(fullCount(root)).toBe(90);
    expect(await w0Count(root)).toBe(90);
  }, 60_000);
});

// ── 3. R-3 generator ─────────────────────────────────────────────────────────

describe("R-3 corpus generator (distributions.json)", () => {
  const dist = loadDistributions();
  const spec = { seed: 7, files: 24, totalBytes: 6_000_000, weeks: 12 };

  it("is deterministic per seed and hits the byte target within 5%", () => {
    const a = generateBackfillCorpus(path.join(tmp, "gen-a"), spec, dist, NOW);
    const b = generateBackfillCorpus(path.join(tmp, "gen-b"), spec, dist, NOW);
    expect(a.files).toBe(24);
    expect(a.digest).toBe(b.digest);
    expect(Math.abs(a.totalBytes - spec.totalBytes) / spec.totalBytes).toBeLessThan(0.05);
  });

  it("starts from a clean generated tree: earlier proj-r3 files go, anything else stays", () => {
    const root = path.join(tmp, "gen-reuse");
    generateBackfillCorpus(root, { ...spec, files: 80 }, dist, NOW); // two slug dirs
    fs.writeFileSync(path.join(root, "keep.txt"), "x");
    fs.mkdirSync(path.join(root, "other-project"));
    const m = generateBackfillCorpus(root, { ...spec, files: 24 }, dist, NOW); // one slug dir
    expect(fs.existsSync(path.join(root, "proj-r3-1"))).toBe(false);
    const onDisk = fs
      .readdirSync(path.join(root, "proj-r3-0"), { recursive: true })
      .filter((f) => String(f).endsWith(".jsonl"));
    expect(onDisk.length).toBe(m.files);
    expect(fs.existsSync(path.join(root, "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "other-project"))).toBe(true);
  });

  it("spreads mtimes over the dataset weeks, newest turn within a minute of each file's mtime", () => {
    const root = path.join(tmp, "gen-weeks");
    const m = generateBackfillCorpus(root, spec, dist, NOW);
    const weeks = new Set(m.perFile.map((f) => Math.floor((NOW - f.mtimeMs) / (7 * DAY))));
    expect(Math.min(...weeks)).toBe(0);
    expect(Math.max(...weeks)).toBe(spec.weeks - 1);
    for (const f of m.perFile) {
      expect(fs.statSync(path.join(root, f.rel)).mtimeMs).toBeCloseTo(f.mtimeMs, -3);
      expect(f.mtimeMs - f.newestTurnMs).toBeGreaterThanOrEqual(0);
      expect(f.mtimeMs - f.newestTurnMs).toBeLessThan(60_000);
    }
  });

  it("is aggregate-shaped: nested files present, only allowlisted or synthetic tool names", () => {
    const root = path.join(tmp, "gen-shape");
    const m = generateBackfillCorpus(root, spec, dist, NOW);
    expect(m.perFile.some((f) => f.rel.split(/[\\/]/).length > 2)).toBe(true);
    const allowed = new Set([
      ...Object.keys(dist.toolMix).filter((k) => k !== "__other"),
      "mcp__synthetic__tool",
    ]);
    for (const name of Object.keys(m.toolCounts)) expect(allowed.has(name)).toBe(true);
    // the whole corpus ingests: every file parsed, turns > 0
    const db = ingestFromScratch(root, NOW);
    const turns = (db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n;
    db.close();
    expect(turns).toBeGreaterThan(0);
  }, 60_000);
});
