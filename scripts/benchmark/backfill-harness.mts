/**
 * scripts/benchmark/backfill-harness.mts — R-1/R-2 ingest correctness harness (P0-U11).
 *
 * The independent oracle for every ingest/detector-touching unit (audit §11.11):
 *   - table digests over every ingest-derived table (+ detector_week_results and
 *     recommendations after a detector walk at a fixed clock),
 *   - R-1 chunked-append delivery (split points forced mid-line and mid-UTF-8),
 *   - R-2 crash scenarios: a CHILD node process is hard-killed by an AW_TEST_CRASH_AT
 *     seam, then a fresh child restarts to done on the same DB + files,
 *   - the "no chunk re-applied" replay counter, measured from a journal the harness
 *     itself writes (applyLine calls + SQLite tx commit boundaries) — it never
 *     reads the ingestor's own offset/baseline bookkeeping,
 *   - the O-3 statement/row/byte counters (db.prepare + fs.readSync wraps).
 *
 * CLI: `node --import tsx/esm scripts/benchmark/backfill-harness.mts o3 [--write]`
 * Child (internal): `... child --db <file> --root <dir> --journal <file> --budget <bytes>`
 * Synthetic data only (SEC-101).
 */

import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import * as http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import * as net from "node:net";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { createHandler } from "../../src/daemon/http.js";
import { ROUTE_BUDGETS } from "../../src/daemon/route-budgets.js";
import { runMigrations } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/open.js";
import { runHistoryWalk } from "../../src/detector/engine.js";
import { Ingestor } from "../../src/ingest/index.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { generateCorpus, seededRandom, writeCorpus } from "../../test/ingest/synth.js";
import type { Line } from "../../test/ingest/synth.js";
import {
  type CorpusManifest,
  GENERATOR_VERSION,
  generateBackfillCorpus,
  loadDistributions,
} from "./backfill-corpus.mjs";

type Db = Database.Database;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const O3_BASELINE_PATH = path.join(HERE, "o3-baseline.json");

/** The fixed clock every harness run uses (AW_TEST_NOW and the detector walk). */
export const HARNESS_NOW_MS = Date.UTC(2026, 6, 20, 0, 0, 0);

// ── digests ──────────────────────────────────────────────────────────────────

interface TableSpec {
  table: string;
  key: string;
  sums: string[];
  /** Wall-clock / path-derived columns left out of the row-set hash. */
  volatile: string[];
}

export const INGEST_TABLES: TableSpec[] = [
  {
    table: "turns",
    key: "message_id",
    sums: [
      "cost_equiv_u",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_5m",
      "cache_write_1h",
      "cache_write_other",
      "tool_result_bytes",
      "thinking_tokens",
    ],
    volatile: [],
  },
  { table: "tool_events", key: "event_id", sums: ["input_bytes", "result_bytes"], volatile: [] },
  { table: "tool_event_metadata", key: "event_id", sums: ["block_index"], volatile: [] },
  {
    table: "ingest_metric_events",
    key: "event_id",
    sums: ["is_user_turn", "is_api_error", "is_interrupt", "event_position"],
    volatile: [],
  },
  {
    table: "subagent_meta",
    key: "agent_id",
    sums: ["spawn_depth", "description_len"],
    volatile: [],
  },
  {
    table: "sessions",
    key: "session_id",
    sums: [
      "turn_count",
      "user_turn_count",
      "cost_equiv_u",
      "compaction_count",
      "api_error_count",
      "interrupt_count",
    ],
    volatile: ["file_path"],
  },
];

export const DETECTOR_TABLES: TableSpec[] = [
  {
    table: "detector_week_results",
    key: "detector_id || '|' || scope_key || '|' || week_start",
    sums: ["fired", "rank_value_u"],
    volatile: ["evaluated_at"],
  },
  {
    table: "recommendations",
    key: "rec_id",
    sums: ["modeled_savings_u_per_wk"],
    volatile: ["created_at", "adopted_at", "computed_at"],
  },
];

export interface TableDigest {
  count: number;
  /** COUNT(*) - COUNT(DISTINCT key) — 0 unless the key is not unique. */
  duplicateKeys: number;
  sums: Record<string, number>;
  /** sha1 over the sorted, canonicalised rows minus volatile columns. */
  rowsHash: string;
}

export type Digest = Record<string, TableDigest>;

function digestTable(db: Db, spec: TableSpec): TableDigest {
  const cols = (db.prepare(`PRAGMA table_info(${spec.table})`).all() as Array<{ name: string }>)
    .map((c) => c.name)
    .filter((c) => !spec.volatile.includes(c));
  const sumSql = spec.sums.map((c) => `COALESCE(SUM(${c}), 0) AS "${c}"`).join(", ");
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT ${spec.key}) AS d${sumSql === "" ? "" : `, ${sumSql}`} FROM ${spec.table}`,
    )
    .get() as Record<string, number>;
  const rows = (
    db
      .prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM ${spec.table}`)
      .raw()
      .all() as unknown[][]
  )
    .map((r) => JSON.stringify(r))
    .sort();
  const hash = crypto.createHash("sha1");
  for (const r of rows) hash.update(r).update("\n");
  const sums: Record<string, number> = {};
  for (const c of spec.sums) sums[c] = Number(agg[c] ?? 0);
  return {
    count: Number(agg.n),
    duplicateKeys: Number(agg.n) - Number(agg.d),
    sums,
    rowsHash: hash.digest("hex"),
  };
}

export function ingestDigest(db: Db): Digest {
  const out: Digest = {};
  for (const spec of INGEST_TABLES) out[spec.table] = digestTable(db, spec);
  return out;
}

/** Runs the daemon's detector-walk entry point at the fixed clock, then digests its outputs. */
export async function detectorDigest(db: Db, nowMs = HARNESS_NOW_MS): Promise<Digest> {
  await runHistoryWalk(db, new Date(nowMs));
  const out: Digest = {};
  for (const spec of DETECTOR_TABLES) out[spec.table] = digestTable(db, spec);
  return out;
}

/** Human-readable list of differences between two digests ([] when equal). */
export function diffDigests(a: Digest, b: Digest): string[] {
  const diffs: string[] = [];
  for (const table of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[table];
    const y = b[table];
    if (x === undefined || y === undefined) {
      diffs.push(`${table}: missing on one side`);
      continue;
    }
    if (x.count !== y.count) diffs.push(`${table}.count ${x.count} != ${y.count}`);
    if (x.duplicateKeys !== y.duplicateKeys)
      diffs.push(`${table}.duplicateKeys ${x.duplicateKeys} != ${y.duplicateKeys}`);
    for (const k of Object.keys(x.sums)) {
      if (x.sums[k] !== y.sums[k]) diffs.push(`${table}.sum(${k}) ${x.sums[k]} != ${y.sums[k]}`);
    }
    if (x.rowsHash !== y.rowsHash) diffs.push(`${table}.rowsHash differs`);
  }
  return diffs;
}

// ── corpus helpers ───────────────────────────────────────────────────────────

export interface CorpusFile {
  slug: string;
  name: string;
  bytes: Buffer;
}

export function corpusFiles(corpus: Record<string, Record<string, Line[]>>): CorpusFile[] {
  const out: CorpusFile[] = [];
  for (const [slug, files] of Object.entries(corpus)) {
    for (const [name, lines] of Object.entries(files)) {
      const text = `${lines.map((l) => ("raw" in l ? l.raw : JSON.stringify(l))).join("\n")}\n`;
      out.push({ slug, name, bytes: Buffer.from(text, "utf8") });
    }
  }
  return out;
}

export function ingestFromScratch(root: string, nowMs = HARNESS_NOW_MS): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const ingestor = new Ingestor(db, [root], { now: () => new Date(nowMs) });
  ingestor.runBackscan();
  return db;
}

export interface SplitPlan {
  /** Ascending byte offsets per file (final entry === file length). */
  splits: Map<string, number[]>;
  midLine: number;
  midUtf8: number;
}

/** Random append points per file; ≥1 mid-line and ≥1 mid-UTF-8 split per file. */
export function planSplits(seed: number, files: CorpusFile[]): SplitPlan {
  const rnd = seededRandom(seed ^ 0x9e3779b9);
  const splits = new Map<string, number[]>();
  let midLine = 0;
  let midUtf8 = 0;
  for (const f of files) {
    const b = f.bytes;
    const points = new Set<number>();
    const continuation: number[] = [];
    const midLineCandidates: number[] = [];
    for (let p = 1; p < b.length; p++) {
      const cur = b[p] as number;
      if ((cur & 0xc0) === 0x80) continuation.push(p);
      else if (cur < 0x80 && b[p - 1] !== 0x0a && cur !== 0x0a) midLineCandidates.push(p);
    }
    if (continuation.length === 0 || midLineCandidates.length === 0)
      throw new Error("corpus file lacks multibyte or multi-byte lines");
    points.add(continuation[Math.floor(rnd() * continuation.length)] as number);
    points.add(midLineCandidates[Math.floor(rnd() * midLineCandidates.length)] as number);
    const extra = 2 + Math.floor(rnd() * 5);
    for (let i = 0; i < extra; i++) points.add(1 + Math.floor(rnd() * (b.length - 1)));
    const sorted = [...points].sort((x, y) => x - y);
    for (const p of sorted) {
      if (b[p - 1] !== 0x0a) midLine++;
      if (((b[p] as number) & 0xc0) === 0x80) midUtf8++;
    }
    sorted.push(b.length);
    splits.set(`${f.slug}/${f.name}`, sorted);
  }
  return { splits, midLine, midUtf8 };
}

/** Deliver the corpus into `root` in the planned append chunks; one back-scan per round. */
export function deliverChunked(
  root: string,
  files: CorpusFile[],
  plan: SplitPlan,
  ingestor: Ingestor,
): void {
  const rounds = Math.max(...[...plan.splits.values()].map((s) => s.length));
  const written = new Map<string, number>();
  for (let r = 0; r < rounds; r++) {
    for (const f of files) {
      const key = `${f.slug}/${f.name}`;
      const cuts = plan.splits.get(key) as number[];
      const upto = cuts[Math.min(r, cuts.length - 1)] as number;
      const from = written.get(key) ?? 0;
      if (upto <= from) continue;
      const dir = path.join(root, f.slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, f.name), f.bytes.subarray(from, upto));
      written.set(key, upto);
    }
    ingestor.runBackscan();
  }
}

// ── child process: journaled ingest with optional hard-kill seam ─────────────

export interface ChildArgs {
  db: string;
  root: string;
  journal: string;
  budget: number;
}

/** Every `.jsonl` under each slug dir, nested subagent transcripts included (sorted). */
function listCorpus(root: string): Array<{ slug: string; file: string }> {
  const out: Array<{ slug: string; file: string }> = [];
  const walk = (slug: string, dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(slug, p);
      else if (name.endsWith(".jsonl")) out.push({ slug, file: p });
    }
  };
  for (const slug of fs.readdirSync(root).sort()) {
    const dir = path.join(root, slug);
    if (fs.statSync(dir).isDirectory()) walk(slug, dir);
  }
  return out;
}

/**
 * Wrap `db.transaction` and the ingestor's `applyLine` so every applied line and
 * every OUTERMOST tx begin/commit is journaled (synchronously, so a hard kill
 * keeps everything written so far). The journal is the harness's own evidence:
 *   B            outermost tx opened
 *   L file no h  a line was applied (file basename, line number, sha1 of raw line)
 *   C            outermost tx committed (SQLite returned success)
 *   DONE         the child finished normally
 */
function attachJournal(db: Db, ingestor: Ingestor, journal: string): void {
  const write = (s: string) => fs.appendFileSync(journal, `${s}\n`);
  const d = db as unknown as {
    transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => unknown;
  };
  const origTx = d.transaction.bind(db);
  let depth = 0;
  d.transaction = (fn) => {
    const inner = origTx(fn);
    return (...args: unknown[]) => {
      const outer = depth === 0;
      if (outer) write("B");
      depth++;
      let result: unknown;
      try {
        result = inner(...args);
      } finally {
        depth--;
      }
      if (outer) write("C");
      return result;
    };
  };
  const target = ingestor as unknown as {
    applyLine: (
      raw: string,
      ctx: unknown,
      ws: string,
      filePath: string,
      lineNo: number,
      salt: string,
    ) => void;
  };
  const origApply = target.applyLine.bind(ingestor);
  target.applyLine = (raw, ctx, ws, filePath, lineNo, salt) => {
    origApply(raw, ctx, ws, filePath, lineNo, salt);
    write(
      `L\t${path.basename(filePath)}\t${lineNo}\t${crypto.createHash("sha1").update(raw).digest("hex")}`,
    );
  };
}

async function runChild(args: ChildArgs): Promise<void> {
  const db = openDb(args.db);
  runMigrations(db);
  const ingestor = new Ingestor(db, [args.root]);
  attachJournal(db, ingestor, args.journal);
  for (const f of listCorpus(args.root)) {
    await ingestor.ingestFileYielding(f.file, f.slug, args.budget);
  }
  (ingestor as unknown as { reconcileNow: () => void }).reconcileNow();
  fs.appendFileSync(args.journal, "DONE\n");
  db.close();
}

interface JournalFacts {
  done: boolean;
  /** keys of lines applied inside a tx that committed */
  committed: Set<string>;
  /** every applied line, in order */
  applied: string[];
  /** outermost transactions committed */
  commits: number;
}

export function readJournal(journal: string): JournalFacts {
  const facts: JournalFacts = { done: false, committed: new Set(), applied: [], commits: 0 };
  if (!fs.existsSync(journal)) return facts;
  let open: string[] = [];
  for (const line of fs.readFileSync(journal, "utf8").split("\n")) {
    if (line === "") continue;
    if (line === "DONE") facts.done = true;
    else if (line === "B") open = [];
    else if (line === "C") {
      facts.commits++;
      for (const k of open) facts.committed.add(k);
    } else if (line.startsWith("L\t")) {
      const key = line.slice(2);
      open.push(key);
      facts.applied.push(key);
    }
  }
  return facts;
}

export interface CrashRunResult {
  crashed: boolean;
  /** Seam label the crashed child reported on stderr just before its hard kill (null = none). */
  killMarker: string | null;
  restartedToDone: boolean;
  /** Lines the restart applied that the crashed run had already durably committed. */
  replayCounter: number;
  committedBeforeCrash: number;
  restartApplied: number;
  /** outermost transactions the first child committed */
  firstCommits: number;
  dbPath: string;
}

function spawnChild(
  args: ChildArgs,
  env: Record<string, string>,
): childProcess.SpawnSyncReturns<string> {
  return childProcess.spawnSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      HARNESS_PATH,
      "child",
      "--db",
      args.db,
      "--root",
      args.root,
      "--journal",
      args.journal,
      "--budget",
      String(args.budget),
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, AW_TEST_HOOKS: "1", AW_TEST_NOW: String(HARNESS_NOW_MS), ...env },
    },
  );
}

/**
 * R-2: hard-kill a child at `crashAt`, then restart a fresh child to done on the
 * same DB and files. `crashAt` undefined runs a clean child (seam-inert control).
 */
export function runCrashScenario(opts: {
  workdir: string;
  root: string;
  crashAt: string | undefined;
  budget: number;
  hooks?: "1" | "off";
  /** extra child env for BOTH runs (e.g. AW_TEST_TX_BUDGET_MS) */
  env?: Record<string, string>;
}): CrashRunResult {
  const dbPath = path.join(opts.workdir, "crash.sqlite");
  const j1 = path.join(opts.workdir, "journal-1.txt");
  const j2 = path.join(opts.workdir, "journal-2.txt");
  const env: Record<string, string> = { ...opts.env };
  if (opts.crashAt !== undefined) env.AW_TEST_CRASH_AT = opts.crashAt;
  if (opts.hooks === "off") env.AW_TEST_HOOKS = "0";
  const first = spawnChild({ db: dbPath, root: opts.root, journal: j1, budget: opts.budget }, env);
  const firstFacts = readJournal(j1);
  const crashed = !firstFacts.done && first.status !== 0;
  const restartEnv: Record<string, string> = { ...opts.env };
  const second = spawnChild(
    { db: dbPath, root: opts.root, journal: j2, budget: opts.budget },
    restartEnv,
  );
  const secondFacts = readJournal(j2);
  let replay = 0;
  for (const key of secondFacts.applied) if (firstFacts.committed.has(key)) replay++;
  return {
    crashed,
    killMarker: /^AW_TEST_KILL (\S+)$/m.exec(first.stderr ?? "")?.[1] ?? null,
    restartedToDone: second.status === 0 && secondFacts.done,
    replayCounter: replay,
    committedBeforeCrash: firstFacts.committed.size,
    restartApplied: secondFacts.applied.length,
    firstCommits: firstFacts.commits,
    dbPath,
  };
}

// ── O-3 counters ─────────────────────────────────────────────────────────────

export interface O3Counts {
  statementsPrepared: number;
  statementExecutions: number;
  rowsStepped: number;
  bytesParsed: number;
}

export interface O3Probe {
  snapshot: () => O3Counts;
  restore: () => void;
}

/** Wrap db.prepare (statements + rows stepped) and fs.readSync (bytes parsed) from now on. */
export function o3Instrument(db: Db): O3Probe {
  const c: O3Counts = {
    statementsPrepared: 0,
    statementExecutions: 0,
    rowsStepped: 0,
    bytesParsed: 0,
  };
  const d = db as unknown as { prepare: (sql: string) => Record<string, unknown> };
  const origPrepare = d.prepare.bind(db);
  // Executions are counted on the Statement prototype, so statements the code
  // under test prepared BEFORE this probe was installed are still counted.
  const proto = Object.getPrototypeOf(origPrepare("SELECT 1")) as Record<
    string,
    (...a: unknown[]) => unknown
  >;
  const saved: Record<string, (...a: unknown[]) => unknown> = {};
  const patch = (
    name: string,
    wrapper: (orig: (...a: unknown[]) => unknown) => (...a: unknown[]) => unknown,
  ) => {
    const orig = proto[name];
    if (typeof orig !== "function") return;
    saved[name] = orig;
    proto[name] = wrapper(orig);
  };
  const counted = (rows: (r: unknown) => number) => (orig: (...a: unknown[]) => unknown) =>
    function (this: unknown, ...a: unknown[]) {
      c.statementExecutions++;
      const r = orig.apply(this, a);
      c.rowsStepped += rows(r);
      return r;
    };
  patch(
    "run",
    counted((r) => Number((r as { changes?: number }).changes ?? 0)),
  );
  patch(
    "get",
    counted((r) => (r === undefined ? 0 : 1)),
  );
  patch(
    "all",
    counted((r) => (Array.isArray(r) ? r.length : 0)),
  );
  patch(
    "iterate",
    (orig) =>
      function (this: unknown, ...a: unknown[]) {
        c.statementExecutions++;
        const it = orig.apply(this, a) as Iterable<unknown>;
        return (function* () {
          for (const row of it) {
            c.rowsStepped++;
            yield row;
          }
        })();
      },
  );
  d.prepare = (sql: string) => {
    c.statementsPrepared++;
    return origPrepare(sql);
  };
  const origRead = fsDefault.readSync;
  (fsDefault as { readSync: unknown }).readSync = (...a: unknown[]) => {
    const n = (origRead as (...x: unknown[]) => number)(...a);
    c.bytesParsed += n;
    return n;
  };
  syncBuiltinESMExports();
  return {
    snapshot: () => ({ ...c }),
    restore: () => {
      d.prepare = origPrepare;
      for (const [name, fn] of Object.entries(saved)) proto[name] = fn;
      (fsDefault as { readSync: unknown }).readSync = origRead;
      syncBuiltinESMExports();
    },
  };
}

export const O3_SCENARIOS = ["append-1000-events", "w0-walk", "one-get-per-route"] as const;
export type O3Scenario = (typeof O3_SCENARIOS)[number];

/** Counters that exceed their committed baseline by more than `tolerance` (default +10%). */
export function o3Overruns(
  scenario: string,
  counts: O3Counts,
  base: Record<string, number>,
  tolerance = 0.1,
): string[] {
  const over: string[] = [];
  for (const [metric, value] of Object.entries(counts)) {
    const limit = Math.ceil((base[metric] ?? 0) * (1 + tolerance));
    if (value > limit)
      over.push(`${scenario}.${metric} ${value} > ${limit} (baseline ${base[metric]} +10%)`);
  }
  return over;
}

/** Budgeted routes the in-process GET pass skips: they read this machine's processes or home dir. */
const O3_HOST_DEPENDENT = new Set([
  "/api/idle-sessions",
  "/api/agents-liveness",
  "/api/hook-config",
  "/api/statusline-limits/preview",
  "/api/statusline-limits/status",
]);

/** Budgeted, non-stream, non-parametric, network-free GET routes (in registry order). */
export function o3GetRoutes(): string[] {
  return Object.entries(ROUTE_BUDGETS)
    .filter(
      ([route, b]) =>
        b.source !== "stream" &&
        b.untimed === undefined &&
        !route.includes(":id") &&
        !O3_HOST_DEPENDENT.has(route),
    )
    .map(([route]) => route);
}

/** One GET through the real daemon handler, in process (no socket): resolves once the response ends. */
function getInProcess(handler: ReturnType<typeof createHandler>, url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`in-process GET ${url} did not finish`)),
      60_000,
    );
    const res = {
      statusCode: 0,
      setHeader: () => res,
      getHeader: () => undefined,
      writeHead: (status: number) => {
        res.statusCode = status;
        return res;
      },
      end: () => {
        clearTimeout(timer);
        resolve(res.statusCode);
      },
    };
    handler({ method: "GET", url, headers: { host: "127.0.0.1" } } as never, res as never);
  });
}

/**
 * Runs `fn` with the wall clock pinned to HARNESS_NOW_MS for BOTH `Date.now()` and a no-argument
 * `new Date()` (handlers use either), then restores the real Date.
 */
export async function withPinnedClock<T>(fn: () => Promise<T>): Promise<T> {
  const RealDate = globalThis.Date;
  class PinnedDate extends RealDate {
    constructor(...args: unknown[]) {
      // biome-ignore lint/suspicious/noExplicitAny: forwarding the Date constructor overloads
      super(...((args.length === 0 ? [HARNESS_NOW_MS] : args) as [any]));
    }
    static override now(): number {
      return HARNESS_NOW_MS;
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** Budgeted routes that legitimately answer non-200 on the synthetic seed (need params/state). */
const O3_EXPECTED_NON_200: Record<string, number> = {
  "/api/outcomes/detail": 400,
  "/api/outcomes/sync-status": 503,
  "/api/recommendations/feedback": 400,
  "/api/recommendations/goal": 400,
};

/** Runs one O-3 scenario in a fresh temp dir on the fixed clock; returns its counters. */
export async function measureO3(scenario: O3Scenario, tmpRoot: string): Promise<O3Counts> {
  const root = path.join(tmpRoot, "root");
  if (scenario === "append-1000-events") {
    const gen = generateCorpus(11, { slugs: 1, filesPerSlug: 1, turnsPerFile: 700 });
    const [slug, files] = Object.entries(gen)[0] as [string, Record<string, Line[]>];
    const [name, lines] = Object.entries(files)[0] as [string, Line[]];
    const events = lines.slice(0, 1_100);
    writeCorpus(root, { [slug]: { [name]: events.slice(0, 100) } });
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const ingestor = new Ingestor(db, [root], { now: () => new Date(HARNESS_NOW_MS) });
    ingestor.runBackscan();
    const file = path.join(root, slug, name);
    fs.appendFileSync(
      file,
      `${events
        .slice(100)
        .map((l) => ("raw" in l ? l.raw : JSON.stringify(l)))
        .join("\n")}\n`,
    );
    const probe = o3Instrument(db);
    ingestor.ingestFile(file, slug);
    const counts = probe.snapshot();
    probe.restore();
    db.close();
    return counts;
  }
  if (scenario === "one-get-per-route") {
    // After the O-3 ingest + W0 walk: one GET per budgeted route, router handler on the harness DB.
    writeCorpus(root, generateCorpus(3));
    const db = ingestFromScratch(root);
    await runHistoryWalk(db, new Date(HARNESS_NOW_MS));
    setQueryDb(db);
    const handler = createHandler(db, 0, null);
    const probe = o3Instrument(db);
    try {
      // windows resolve from "now"; pin it so counts do not drift with the calendar
      const counts = await withPinnedClock(async () => {
        const bad: string[] = [];
        for (const route of o3GetRoutes()) {
          const status = await getInProcess(handler, route);
          if (status !== (O3_EXPECTED_NON_200[route] ?? 200)) bad.push(`${route}=${status}`);
        }
        if (bad.length > 0)
          throw new Error(`one-get-per-route: unexpected status ${bad.join(", ")}`);
        return probe.snapshot();
      });
      return counts;
    } finally {
      probe.restore();
      resetQueryDb();
      db.close();
    }
  }
  writeCorpus(root, generateCorpus(3));
  const db = ingestFromScratch(root);
  await runHistoryWalk(db, new Date(HARNESS_NOW_MS)); // populate closed-week cache
  const probe = o3Instrument(db);
  await runHistoryWalk(db, new Date(HARNESS_NOW_MS)); // the measured W0 walk
  const counts = probe.snapshot();
  probe.restore();
  db.close();
  return counts;
}

// ── P2-U1: 7d completeness, /api/perf sampling, backfill bench ───────────────

/** Oracle 2: turns with `ts` in the 7 days before `nowMs`. */
export function sevenDayTurnCount(db: Db, nowMs: number): number {
  const from = new Date(nowMs - 7 * 86_400_000).toISOString();
  return (db.prepare("SELECT COUNT(*) AS n FROM turns WHERE ts >= ?").get(from) as { n: number }).n;
}

export interface PerfSample {
  /** ms since the run's t0 (daemon spawn) when the sample was taken */
  t: number;
  phase: string | null;
  ready: boolean;
  /** `/api/status` history_coverage.weeks_done once P2-U4 ships it, else null */
  weeksDone: number | null;
  lag: { p50: number; p99: number; max: number };
  rss?: number;
  heapUsed?: number;
  ingestBytesPerSec?: number;
  /** M14: -wal file bytes, and off-main checkpoint count / max ms (P2-U4b) when present. */
  walBytes?: number;
  walCheckpoint?: { count: number; lastMs: number; maxMs: number };
}

function getJson(url: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        body += c;
      });
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? (JSON.parse(body) as Record<string, unknown>) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

/**
 * Samples `/api/perf`, `/api/status` and `/api/ready` every `intervalMs` until the
 * pipeline reports `done` (that sample is the last) or `timeoutMs` passes. Ticks
 * that get no `/api/perf` answer (daemon not listening yet) record nothing.
 */
export async function sampleBackfill(
  baseUrl: string,
  opts: { intervalMs?: number; timeoutMs: number; t0?: number },
): Promise<PerfSample[]> {
  const interval = opts.intervalMs ?? 500;
  const t0 = opts.t0 ?? performance.now();
  const samples: PerfSample[] = [];
  while (performance.now() - t0 < opts.timeoutMs) {
    const tick = performance.now();
    const [perf, status, ready] = await Promise.all([
      getJson(`${baseUrl}/api/perf`, 10_000),
      getJson(`${baseUrl}/api/status`, 10_000),
      getJson(`${baseUrl}/api/ready`, 10_000),
    ]);
    if (perf !== null) {
      const lag = perf.loop_lag as PerfSample["lag"];
      const proc = perf.process as { rssBytes: number; heapUsedBytes: number } | undefined;
      const ingest = perf.ingest as { bytesPerSecond: number } | undefined;
      const pipeline = status?.pipeline as { phase?: string } | undefined;
      const coverage = status?.history_coverage as { weeks_done?: number } | undefined;
      const s: PerfSample = {
        t: Math.round(tick - t0),
        phase: pipeline?.phase ?? null,
        ready: ready?.ready === true,
        weeksDone: coverage?.weeks_done ?? null,
        lag,
      };
      if (proc !== undefined) {
        s.rss = proc.rssBytes;
        s.heapUsed = proc.heapUsedBytes;
      }
      if (ingest !== undefined) s.ingestBytesPerSec = ingest.bytesPerSecond;
      const wal = perf.wal as
        | { bytes: number; checkpoint?: PerfSample["walCheckpoint"] }
        | undefined;
      if (wal !== undefined) {
        s.walBytes = wal.bytes;
        if (wal.checkpoint !== undefined) s.walCheckpoint = wal.checkpoint;
      }
      samples.push(s);
      if (s.phase === "done") break;
    }
    const wait = interval - (performance.now() - tick);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  return samples;
}

export interface BackfillSummary {
  /** Loop lag over the backfill window (first ready sample → first done sample). */
  m1: { p99_of_p99: number; max: number; samples: number };
  ready_ms: number | null;
  /** W0 complete: first `weeks_done >= 1`; until P2-U4 ships slices, pipeline done (plan §4). */
  m6_ms: number | null;
  /** Pipeline done. */
  m8_ms: number | null;
  m15: {
    rss_first: number;
    rss_peak: number;
    rss_last: number;
    heap_first: number;
    heap_peak: number;
    heap_last: number;
    heap_growth: number;
    /** corpus MB / M8 seconds */
    mb_per_s: number | null;
  };
}

export function summarizeBackfill(
  samples: PerfSample[],
  opts: { corpusBytes: number },
): BackfillSummary {
  const readyIdx = samples.findIndex((s) => s.ready);
  const doneIdx = samples.findIndex((s) => s.phase === "done");
  const end = doneIdx >= 0 ? doneIdx : samples.length - 1;
  const window = readyIdx >= 0 ? samples.slice(readyIdx, end + 1) : [];
  const p99s = window.map((s) => s.lag.p99).sort((a, b) => a - b);
  const m8 = doneIdx >= 0 ? (samples[doneIdx] as PerfSample).t : null;
  const w0 = samples.find((s) => (s.weeksDone ?? 0) >= 1);
  const upto = samples.slice(0, end + 1);
  const rss = upto.map((s) => s.rss).filter((x): x is number => x !== undefined);
  const heap = upto.map((s) => s.heapUsed).filter((x): x is number => x !== undefined);
  return {
    m1: {
      p99_of_p99:
        p99s.length === 0
          ? 0
          : (p99s[Math.min(p99s.length - 1, Math.floor(0.99 * p99s.length))] as number),
      max: Math.max(0, ...window.map((s) => s.lag.max)),
      samples: window.length,
    },
    ready_ms: readyIdx >= 0 ? (samples[readyIdx] as PerfSample).t : null,
    m6_ms: w0 !== undefined ? w0.t : m8,
    m8_ms: m8,
    m15: {
      rss_first: rss[0] ?? 0,
      rss_peak: Math.max(0, ...rss),
      rss_last: rss.at(-1) ?? 0,
      heap_first: heap[0] ?? 0,
      heap_peak: Math.max(0, ...heap),
      heap_last: heap.at(-1) ?? 0,
      heap_growth: (heap.at(-1) ?? 0) - (heap[0] ?? 0),
      mb_per_s: m8 === null || m8 === 0 ? null : opts.corpusBytes / 1e6 / (m8 / 1000),
    },
  };
}

export const BENCH_PORT = 47824;

/** The dataset corpus, generated once per UTC day (mtimes are relative to "now") and reused. */
function ensureCorpus(cacheDir: string, name: string): { root: string; manifest: CorpusManifest } {
  const dist = loadDistributions();
  const spec = dist.datasets[name];
  if (spec === undefined) throw new Error(`unknown dataset ${name}`);
  const nowMs = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const root = path.join(cacheDir, `${name}-g${GENERATOR_VERSION}-s${spec.seed}`);
  const manifestPath = `${root}.manifest.json`;
  const key = JSON.stringify({ spec, nowMs, generator: GENERATOR_VERSION });
  if (fs.existsSync(manifestPath)) {
    const saved = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      key: string;
      manifest: CorpusManifest;
    };
    if (saved.key === key) return { root, manifest: saved.manifest };
  }
  fs.rmSync(root, { recursive: true, force: true });
  const t = performance.now();
  const manifest = generateBackfillCorpus(root, spec, dist, nowMs);
  console.error(
    `generated ${name}: ${manifest.files} files, ${(manifest.totalBytes / 1e6).toFixed(1)} MB in ${Math.round(performance.now() - t)} ms`,
  );
  fs.writeFileSync(manifestPath, JSON.stringify({ key, manifest }));
  return { root, manifest };
}

/** Child env: isolated home/config dirs (no real ~/.claude), `gh` removed from PATH. */
function benchEnv(work: string, dbPath: string, scanRoot: string, port: number): NodeJS.ProcessEnv {
  const dirs = ["home", "appdata", "localappdata", "config", "temp", "empty-ui"].map((d) =>
    path.join(work, d),
  );
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  const [home, appData, localAppData, config, temp, ui] = dirs as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const ghDirs = new Set<string>();
  try {
    const where = process.platform === "win32" ? "where gh" : "command -v gh";
    for (const l of childProcess
      .execSync(where, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)) {
      if (l.trim() !== "") ghDirs.add(path.dirname(l.trim()).toLowerCase());
    }
  } catch {
    // gh not installed
  }
  const PATH = (process.env[pathKey] ?? "")
    .split(path.delimiter)
    .filter((p) => p !== "" && !ghDirs.has(path.resolve(p).toLowerCase()))
    .join(path.delimiter);
  const keep = (n: string) => (process.env[n] === undefined ? {} : { [n]: process.env[n] });
  return {
    ...keep("SystemRoot"),
    ...keep("WINDIR"),
    ...keep("ComSpec"),
    PATH,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: config,
    TEMP: temp,
    TMP: temp,
    AW_DB_PATH: dbPath,
    AW_SCAN_ROOT: scanRoot,
    AW_UI_ROOT: ui,
    AW_PORT: String(port),
    AW_NO_OPEN: "1",
    AW_USAGE_CLI: "off",
    AW_GITHUB_TOKEN: "",
    GH_PROMPT_DISABLED: "1",
  };
}

function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

/** One cold backfill: built daemon (`dist/daemon`) on a fresh DB over the dataset corpus. */
export async function runBackfillBench(opts: {
  dataset: string;
  outDir: string;
  label: string;
  cacheDir: string;
  port?: number;
  timeoutMs?: number;
}): Promise<BackfillSummary & { dataset: string; corpus_bytes: number; corpus_files: number }> {
  const port = opts.port ?? BENCH_PORT;
  const entry = path.join(REPO_ROOT, "dist", "daemon", "index.js");
  if (!fs.existsSync(entry)) throw new Error("dist/daemon missing: run npm run build:daemon");
  if (await portBusy(port)) throw new Error(`port ${port} busy; refusing`);
  const { root, manifest } = ensureCorpus(opts.cacheDir, opts.dataset);
  const os = await import("node:os");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "aw-backfill-"));
  fs.mkdirSync(opts.outDir, { recursive: true });
  const log = fs.openSync(path.join(opts.outDir, `${opts.label}-daemon.log`), "w");
  const t0 = performance.now();
  const child = childProcess.spawn(process.execPath, [entry, "--no-open"], {
    cwd: REPO_ROOT,
    env: benchEnv(work, path.join(work, "db.sqlite"), root, port),
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  const kill = () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    if (process.platform === "win32") {
      try {
        childProcess.execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: "ignore" });
      } catch {
        // already gone
      }
    } else child.kill("SIGKILL");
  };
  process.on("exit", kill);
  try {
    const samples = await sampleBackfill(`http://127.0.0.1:${port}`, {
      t0,
      timeoutMs: opts.timeoutMs ?? 30 * 60_000,
    });
    fs.writeFileSync(
      path.join(opts.outDir, `${opts.label}-samples.jsonl`),
      `${samples.map((s) => JSON.stringify(s)).join("\n")}\n`,
    );
    const summary = summarizeBackfill(samples, { corpusBytes: manifest.totalBytes });
    return {
      dataset: opts.dataset,
      corpus_bytes: manifest.totalBytes,
      corpus_files: manifest.files,
      ...summary,
    };
  } finally {
    kill();
    process.off("exit", kill);
    fs.closeSync(log);
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** (max − min) / min over the runs, for each headline metric. */
export function benchSpread(runs: BackfillSummary[]): Record<string, number | null> {
  const metric = (f: (r: BackfillSummary) => number | null) => {
    const v = runs.map(f).filter((x): x is number => x !== null && x > 0);
    return v.length < 2 ? null : (Math.max(...v) - Math.min(...v)) / Math.min(...v);
  };
  return {
    m1_max: metric((r) => r.m1.max),
    m1_p99_of_p99: metric((r) => r.m1.p99_of_p99),
    m6_ms: metric((r) => r.m6_ms),
    m8_ms: metric((r) => r.m8_ms),
    m15_rss_peak: metric((r) => r.m15.rss_peak),
    m15_heap_peak: metric((r) => r.m15.heap_peak),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function argOf(name: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) throw new Error(`missing ${name}`);
  return v;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  if (cmd === "child") {
    await runChild({
      db: argOf("--db"),
      root: argOf("--root"),
      journal: argOf("--journal"),
      budget: Number(argOf("--budget")),
    });
  } else if (cmd === "o3") {
    const os = await import("node:os");
    const scenarios: Record<string, O3Counts> = {};
    for (const s of O3_SCENARIOS) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-o3-"));
      try {
        scenarios[s] = await measureO3(s, dir);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    const out = {
      schema: 1,
      note: "O-3 baseline (P0-U11). A test fails when any counter exceeds baseline by more than 10%.",
      scenarios,
      parked: {},
    };
    if (process.argv.includes("--write")) {
      fs.writeFileSync(O3_BASELINE_PATH, `${JSON.stringify(out, null, 2)}\n`);
    }
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === "bench") {
    // npm run perf:backfill -- [--dataset X] [--runs 2] [--out <dir>] [--cache <dir>] [--port 47824]
    const os = await import("node:os");
    const opt = (n: string, d: string) => {
      const i = process.argv.indexOf(`--${n}`);
      return i >= 0 ? (process.argv[i + 1] ?? d) : d;
    };
    const dataset = opt("dataset", "X");
    const runs = Number(opt("runs", "2"));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = opt("out", path.join(os.tmpdir(), "aw-perf-backfill", stamp));
    const cacheDir = opt("cache", path.join(os.tmpdir(), "aw-perf-backfill", "corpus"));
    const results = [];
    for (let i = 1; i <= runs; i++) {
      const r = await runBackfillBench({
        dataset,
        outDir,
        cacheDir,
        label: `${dataset}-run${i}`,
        port: Number(opt("port", String(BENCH_PORT))),
      });
      console.error(
        `${dataset} run ${i}: M8 ${r.m8_ms} ms, M1 p99-of-p99 ${r.m1.p99_of_p99.toFixed(1)} / max ${r.m1.max.toFixed(1)} ms`,
      );
      results.push(r);
    }
    const report = { dataset, runs: results, spread: benchSpread(results), out: outDir };
    fs.writeFileSync(
      path.join(outDir, `${dataset}-report.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify(report, null, 2));
  } else {
    throw new Error("usage: child|o3 [--write]|bench [--dataset X|S5] [--runs n]");
  }
}
