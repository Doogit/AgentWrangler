/**
 * test/ingest/slices.test.ts — P2-U4: the backfill runs as slices of files grouped by
 * mtime week, newest first (W0 = mtime within 7 days of now).
 *
 * - W0 holds every turn of the last 7 days (an append-only file's mtime is never older
 *   than its newest turn), so it is complete for 7d the moment it is done (M6).
 * - A time guard can cut W0 short at a file boundary: partial_week, then a W0b slice.
 * - Each slice reconciles only the sessions it touched, in time-budgeted batches,
 *   instead of one full reconcile at the end of reading (the X M1 max).
 * - One ingest pass at a time per Ingestor, and the tail never reads a file whose
 *   slice is still pending.
 * - Sliced (W0, floored walk, the rest, full walk) == monolithic, on the full
 *   recommendations and week tables; the floored walk's recs ⊆ the final set.
 *
 * Synthetic content only (SEC-101).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HARNESS_NOW_MS,
  detectorDigest,
  diffDigests,
  ingestDigest,
  ingestFromScratch,
} from "../../scripts/benchmark/backfill-harness.mjs";
import { getDataVersion } from "../../src/daemon/data-version.js";
import { runMigrations } from "../../src/db/migrate.js";
import { runHistoryWalk } from "../../src/detector/engine.js";
import { Ingestor } from "../../src/ingest/index.js";
import { FIRST_SLICE_DEFAULT_MAX_MS, firstSliceLimits } from "../../src/ingest/ingestor.js";
import { testSeams } from "../../src/ingest/test-seams.js";
import { type Line, assistant, generateCorpus, toJsonl } from "./synth.js";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const NOW = HARNESS_NOW_MS;
const OPTS = { now: () => new Date(NOW), activityWindowSecs: 300 };

let tmp: string;
let db: Database.Database;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-p2u4-"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});
afterEach(() => {
  testSeams.txBudgetMs = null;
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const iso = (ms: number) => new Date(ms).toISOString();

/** One session file; mtime = its newest turn unless `mtimeMs` is given. */
function writeSession(
  root: string,
  name: string,
  turnTimes: number[],
  mtimeMs = Math.max(...turnTimes),
): string {
  const dir = path.join(root, "proj-slices");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  const lines = turnTimes.map((t, i) =>
    assistant({ id: `${name}-${i}`, session: name, ts: iso(t), input: 10, output: 1 }),
  );
  fs.writeFileSync(file, toJsonl(lines), "utf8");
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

/** Names sort oldest week first, the reverse of slice order, so discovery order differs. */
const weekName = (k: number) => `${String(99 - k)}-week-${k}`;

/** `weeks` files, one per mtime week k = 0 … weeks − 1 (turns 1 day into the week). */
function writeWeeks(root: string, weeks: number): void {
  for (let k = 0; k < weeks; k++) {
    const t = NOW - k * WEEK - DAY;
    writeSession(root, weekName(k), [t - 120_000, t - 60_000, t]);
  }
}

const sessionStates = () =>
  Object.fromEntries(
    (
      db.prepare("SELECT session_id, state FROM sessions ORDER BY session_id").all() as {
        session_id: string;
        state: string;
      }[]
    ).map((r) => [r.session_id, r.state]),
  );

describe("planSlices", () => {
  it("groups files by mtime week, newest first, one slice per non-empty week", () => {
    writeWeeks(tmp, 13);
    const slices = new Ingestor(db, [tmp], OPTS).planSlices();
    expect(slices.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(slices.map((s) => s.files.length)).toEqual(new Array(13).fill(1));
    expect(slices[0]).toMatchObject({ startMs: NOW - WEEK, endMs: NOW });
    expect(slices[12]).toMatchObject({ startMs: NOW - 13 * WEEK, endMs: NOW - 12 * WEEK });
  });

  it("skips empty weeks", () => {
    writeSession(tmp, "w0", [NOW - DAY]);
    writeSession(tmp, "w3", [NOW - 3 * WEEK - DAY]);
    expect(new Ingestor(db, [tmp], OPTS).planSlices().map((s) => s.index)).toEqual([0, 3]);
  });
});

describe("slice loop", () => {
  it("a 13-week backfill completes 13 slices newest first, bumping data_version and coverage at each", async () => {
    writeWeeks(tmp, 13);
    const ingestor = new Ingestor(db, [tmp], OPTS);
    const seen: Array<{ index: number; version: number; done: number; through: number | null }> =
      [];
    await ingestor.runBackgroundBackfill(1, undefined, {
      onSlice: (slice, result) =>
        seen.push({
          index: slice.index,
          version: getDataVersion(),
          done: result.coverage.weeks_done,
          through: result.coverage.complete_through_ms,
        }),
    });
    expect(seen.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]?.version).toBeGreaterThan(seen[i - 1]?.version ?? 0);
      expect(seen[i]?.done).toBe((seen[i - 1]?.done ?? 0) + 1);
      expect(seen[i]?.through).toBeLessThan(seen[i - 1]?.through ?? 0);
    }
    expect(seen.at(-1)).toMatchObject({ done: 13, through: NOW - 13 * WEEK });
  });

  // The 7d-completeness oracle (P2-U1 #2) and its adversarial fixtures live in
  // test/daemon/backfill-oracles.test.ts and run against the W0 slice.

  it("the time guard cuts W0 at a file boundary: partial_week, then the rest runs as W0b", async () => {
    for (let i = 0; i < 3; i++) writeSession(tmp, `w0-${i}`, [NOW - DAY - i * 60_000]);
    const ingestor = new Ingestor(db, [tmp], OPTS);
    const [w0] = ingestor.planSlices();
    if (w0 === undefined) throw new Error("no W0");

    const first = await ingestor.ingestSlice(w0, { maxMs: 0 });
    expect(first.rest).toHaveLength(2); // the first file is always admitted
    expect(first.coverage).toMatchObject({ weeks_done: 0, partial_week: true });

    const w0b = await ingestor.ingestSlice({ ...w0, files: first.rest });
    expect(w0b.rest).toEqual([]);
    expect(w0b.coverage).toMatchObject({ weeks_done: 1, partial_week: false });
    expect(Object.keys(sessionStates())).toHaveLength(3);

    const bytes = await new Ingestor(db, [tmp], OPTS).ingestSlice(w0, { maxBytes: 1 });
    expect(bytes.rest).toHaveLength(2);
  });

  it("reads the guard from AW_FIRST_SLICE_MAX_MS / AW_FIRST_SLICE_MAX_BYTES", () => {
    expect(firstSliceLimits({})).toEqual({ maxMs: FIRST_SLICE_DEFAULT_MAX_MS });
    expect(FIRST_SLICE_DEFAULT_MAX_MS).toBe(15_000);
    expect(firstSliceLimits({ AW_FIRST_SLICE_MAX_MS: "1" })).toEqual({ maxMs: 1 });
    expect(firstSliceLimits({ AW_FIRST_SLICE_MAX_BYTES: "2048" })).toEqual({
      maxMs: FIRST_SLICE_DEFAULT_MAX_MS,
      maxBytes: 2048,
    });
    expect(firstSliceLimits({ AW_FIRST_SLICE_MAX_MS: "" })).toEqual({
      maxMs: FIRST_SLICE_DEFAULT_MAX_MS,
    });
  });

  it("a slice reconciles only the sessions it touched, in time-budgeted batches", async () => {
    for (let i = 0; i < 4; i++) writeSession(tmp, `w1-${i}`, [NOW - WEEK - DAY - i * 60_000]);
    writeSession(tmp, "w2", [NOW - 2 * WEEK - DAY]);
    // A session from an earlier run, still LIVE: a full reconcile would close it.
    db.prepare(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-x', 'ws-x', ?)",
    ).run(iso(NOW));
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
         state, turn_count, cost_equiv_u, hygiene_flags, user_turn_count)
       VALUES ('earlier', 'ws-x', '/fixture/earlier.jsonl', ?, ?, 'LIVE', 0, 0, '[]', 0)`,
    ).run(iso(NOW - 20 * DAY), iso(NOW - 20 * DAY));

    const ingestor = new Ingestor(db, [tmp], OPTS);
    const w1 = ingestor.planSlices().find((s) => s.index === 1);
    if (w1 === undefined) throw new Error("no W1");
    testSeams.txBudgetMs = 0; // one session per reconcile batch
    const result = await ingestor.ingestSlice(w1);

    expect(result.sessions).toBe(4);
    expect(result.reconcile_batches).toBe(4);
    expect(result.reconcile_ms).toBeGreaterThanOrEqual(0);
    expect(sessionStates()).toEqual({
      earlier: "LIVE",
      "w1-0": "RECONCILED",
      "w1-1": "RECONCILED",
      "w1-2": "RECONCILED",
      "w1-3": "RECONCILED",
    });
  });

  it("the whole backfill ends reconciled, like the monolithic scan", async () => {
    writeWeeks(tmp, 4);
    await new Ingestor(db, [tmp], OPTS).runBackgroundBackfill(1);
    const oracle = ingestFromScratch(tmp, NOW);
    expect(diffDigests(ingestDigest(oracle), ingestDigest(db))).toEqual([]);
    expect(sessionStates()).toEqual(
      Object.fromEntries(
        (
          oracle.prepare("SELECT session_id, state FROM sessions ORDER BY session_id").all() as {
            session_id: string;
            state: string;
          }[]
        ).map((r) => [r.session_id, r.state]),
      ),
    );
    oracle.close();
  });
});

describe("one ingest pass at a time", () => {
  it("two concurrent passes never interleave their steps", async () => {
    const a = writeSession(
      tmp,
      "a",
      Array.from({ length: 30 }, (_, i) => NOW - DAY + i * 1000),
    );
    const b = writeSession(
      tmp,
      "b",
      Array.from({ length: 30 }, (_, i) => NOW - DAY + i * 1000),
    );
    const ingestor = new Ingestor(db, [tmp], OPTS);
    const target = ingestor as unknown as { ingestFileChunk: (...args: unknown[]) => unknown };
    const original = target.ingestFileChunk.bind(ingestor);
    const order: string[] = [];
    target.ingestFileChunk = (...args) => {
      order.push(path.basename(String(args[0])));
      return original(...args);
    };

    // A small byte budget forces many steps per file, with a loop turn between each.
    await Promise.all([
      ingestor.ingestFileYielding(a, "proj-slices", 400),
      ingestor.ingestFileYielding(b, "proj-slices", 400),
      ingestor.ingestFileYielding(a, "proj-slices", 400),
    ]);
    expect(order.filter((f) => f === "a.jsonl").length).toBeGreaterThan(2);
    const runs = order.filter((f, i) => i === 0 || f !== order[i - 1]);
    expect(runs).toEqual(["a.jsonl", "b.jsonl", "a.jsonl"]);
  });

  it("a tail tick during the slice loop never reads a file of a pending slice", async () => {
    writeWeeks(tmp, 6);
    const writeGateDelayMs = 15;
    const ingestor = new Ingestor(db, [tmp], {
      ...OPTS,
      tailIntervalMs: 5,
      discoveryIntervalMs: 60_000,
      writeGate: () => new Promise<void>((resolve) => setTimeout(resolve, writeGateDelayMs)),
    });
    const target = ingestor as unknown as {
      ingestFileYielding: (file: string, ...rest: unknown[]) => Promise<{ parsedAny: boolean }>;
    };
    const original = target.ingestFileYielding.bind(ingestor);
    const firstParsed: string[] = [];
    target.ingestFileYielding = async (file, ...rest) => {
      const out = await original(file, ...rest);
      if (out.parsedAny) firstParsed.push(path.basename(file));
      return out;
    };

    const slices = ingestor.planSlices();
    const w0 = slices.shift();
    if (w0 === undefined) throw new Error("no W0");
    await ingestor.ingestSlice(w0);
    const tail = ingestor.startTailAfterBackground();
    try {
      await ingestor.runBackgroundBackfill(1, undefined, { slices });
    } finally {
      tail.stop();
    }
    expect(firstParsed).toEqual([0, 1, 2, 3, 4, 5].map((k) => `${weekName(k)}.jsonl`));
  });

  it("arms the tail and the discovery tick separately", async () => {
    const dir = path.join(tmp, "proj-slices");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(
      file,
      toJsonl([{ ...assistant({ id: "t-1", session: "s", ts: iso(NOW - DAY) }), cwd: "/w" }]),
    );
    // Only the discovery tick looks up git remotes.
    let remoteLookups = 0;
    const ingestor = new Ingestor(db, [tmp], {
      ...OPTS,
      tailIntervalMs: 10,
      discoveryIntervalMs: 10,
      readRemote: () => {
        remoteLookups++;
        return null;
      },
    });
    const turns = () => (db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

    const tailOnly = ingestor.startTailAfterBackground({ discovery: false });
    await settle();
    tailOnly.stop();
    expect(turns()).toBe(1);
    expect(remoteLookups).toBe(0);

    const discoveryOnly = ingestor.startTailAfterBackground({ tail: false });
    fs.appendFileSync(file, toJsonl([assistant({ id: "t-2", session: "s", ts: iso(NOW) })]));
    await settle();
    discoveryOnly.stop();
    expect(remoteLookups).toBeGreaterThan(0);
    expect(turns()).toBe(1);
  });

  it("a tail tick during the slice loop never runs the full reconcile", async () => {
    writeWeeks(tmp, 6);
    const live = path.join(tmp, "proj-slices", `${weekName(0)}.jsonl`);
    const ingestor = new Ingestor(db, [tmp], {
      ...OPTS,
      tailIntervalMs: 5,
      discoveryIntervalMs: 60_000,
      writeGate: () => new Promise<void>((resolve) => setTimeout(resolve, 30)),
    });
    const target = ingestor as unknown as {
      reconcileNow: () => void;
      ingestFileYielding: (file: string, ...rest: unknown[]) => Promise<{ parsedAny: boolean }>;
      pendingSliceFiles: Set<string>;
    };
    // Pending slice files when each full reconcile ran / when the tail parsed the live file.
    const fullReconciles: number[] = [];
    const liveParsed: number[] = [];
    const reconcileNow = target.reconcileNow.bind(ingestor);
    target.reconcileNow = () => {
      fullReconciles.push(target.pendingSliceFiles.size);
      reconcileNow();
    };
    const ingestFileYielding = target.ingestFileYielding.bind(ingestor);
    target.ingestFileYielding = async (file, ...rest) => {
      const out = await ingestFileYielding(file, ...rest);
      if (file === live && out.parsedAny) liveParsed.push(target.pendingSliceFiles.size);
      return out;
    };

    const slices = ingestor.planSlices();
    const w0 = slices.shift();
    if (w0 === undefined) throw new Error("no W0");
    await ingestor.ingestSlice(w0);
    const tail = ingestor.startTailAfterBackground();
    try {
      const backfill = ingestor.runBackgroundBackfill(1, undefined, { slices });
      // The active session keeps writing while older weeks load.
      fs.appendFileSync(
        live,
        // An hour old: outside the 5 min activity window, so a reconcile closes it.
        toJsonl([assistant({ id: "live-1", session: "live", ts: iso(NOW - 3_600_000) })]),
      );
      await backfill;
    } finally {
      tail.stop();
    }
    expect(liveParsed.some((pending) => pending > 0)).toBe(true); // the tail ran mid-loop
    expect(fullReconciles.filter((pending) => pending > 0)).toEqual([]);
    expect(sessionStates().live).toBe("RECONCILED");
  });
});

describe("sliced backfill vs monolithic (engine guard)", () => {
  /** generateCorpus files moved into mtime weeks, plus the adversarial shapes. */
  function writeWeekCorpus(root: string): void {
    const corpus = generateCorpus(7, { slugs: 2, filesPerSlug: 4, turnsPerFile: 16 });
    // Base timestamps sit ~10 days before NOW; shift whole files by these weeks.
    const shifts = [1, 1, 0, 0, -1, -2, -4, -6];
    let i = 0;
    for (const [slug, files] of Object.entries(corpus)) {
      fs.mkdirSync(path.join(root, slug), { recursive: true });
      for (const [name, lines] of Object.entries(files)) {
        const shift = (shifts[i] ?? 0) * WEEK;
        const shifted: Line[] = lines.map((l) =>
          "raw" in l || typeof l.timestamp !== "string"
            ? l
            : { ...l, timestamp: iso(Date.parse(l.timestamp) + shift) },
        );
        const times = shifted.flatMap((l) =>
          "raw" in l || typeof l.timestamp !== "string" ? [] : [Date.parse(l.timestamp)],
        );
        const file = path.join(root, slug, name);
        fs.writeFileSync(file, toJsonl(shifted), "utf8");
        // The last file is an old file touched today (its turns are 6+ weeks old).
        const mtime = i === 7 ? NOW - 3_600_000 : Math.max(...times);
        fs.utimesSync(file, new Date(mtime), new Date(mtime));
        i++;
      }
    }
  }

  it("ends with equal recommendations and week tables, and the post-W0 recs are a subset", async () => {
    writeWeekCorpus(tmp);
    const oracle = ingestFromScratch(tmp, NOW);
    const expected = { ...ingestDigest(oracle), ...(await detectorDigest(oracle, NOW)) };
    const finalRecs = (
      oracle.prepare("SELECT rec_id FROM recommendations").all() as { rec_id: string }[]
    ).map((r) => r.rec_id);
    oracle.close();
    expect(expected.recommendations?.count ?? 0).toBeGreaterThan(0);

    const ingestor = new Ingestor(db, [tmp], OPTS);
    const slices = ingestor.planSlices();
    expect(slices.length).toBeGreaterThan(3);
    const w0 = slices.shift();
    if (w0 === undefined) throw new Error("no W0");
    const { coverage } = await ingestor.ingestSlice(w0);
    const floor = coverage.complete_through_ms;
    if (floor === null) throw new Error("W0 not complete");
    await runHistoryWalk(db, new Date(NOW), { completeThroughMs: floor });

    const interim = db
      .prepare(
        `SELECT rec_id, COALESCE(json_extract(evidence_json, '$.facts.last_seen_week_start'),
                                 json_extract(evidence_json, '$.recency.last_seen_week_start')) AS anchor
           FROM recommendations`,
      )
      .all() as { rec_id: string; anchor: string }[];
    for (const r of interim) {
      expect(finalRecs).toContain(r.rec_id);
      expect(Date.parse(r.anchor)).toBeGreaterThanOrEqual(floor);
    }

    await ingestor.runBackgroundBackfill(1, undefined, { slices });
    const actual = { ...ingestDigest(db), ...(await detectorDigest(db, NOW)) };
    expect(diffDigests(expected, actual)).toEqual([]);
  }, 60_000);
});
