/**
 * test/detector-health/harness.ts — run ONE detector against ONE fixture on a fresh DB.
 * Fixture is copied to a temp root with timestamps shifted so the newest turn is NOW − 1 day.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shiftCorpus } from "../../scripts/lib/shift-corpus.js";
import { buildContext } from "../../src/detector/engine.js";
import { DETECTORS } from "../../src/detector/registry.js";
import type { AnyDetector, DetectorStatusKind } from "../../src/detector/types.js";
import { runBackscan } from "../../src/ingest/index.js";
import { migratedMemDb } from "../ingest/dbutil.js";
import { type CaseInput, type CaseRows, readRows } from "./manifest.js";

type Db = ReturnType<typeof migratedMemDb>;

export type CaseExpect = "fires" | "silent";

export interface CaseResult {
  pass: boolean;
  status: DetectorStatusKind;
  firedCount: number;
  note: string;
}

/**
 * `"<<fill:N>>"` in a fixture line expands to a JSON string of N "x" characters. Large tool
 * results stay in committed fixtures as one short token, so lines stay under the SEC-101
 * pre-commit guard's length limits.
 */
const FILL_TOKEN = /"<<fill:(\d+)>>"/g;

function expandFills(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) expandFills(full);
    else if (e.name.endsWith(".jsonl")) {
      const text = fs.readFileSync(full, "utf8");
      const out = text.replace(FILL_TOKEN, (_, n: string) => `"${"x".repeat(Number(n))}"`);
      if (out !== text) fs.writeFileSync(full, out);
    }
  }
}

/** Copy non-JSONL files (e.g. subagents/agent-<id>.meta.json) as-is; shiftCorpus copies only *.jsonl. */
function copySidecars(src: string, dest: string): void {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copySidecars(from, to);
    else if (!e.name.endsWith(".jsonl")) {
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Row columns holding ISO timestamps; shifted by the case's offset. */
const TS_COLS = new Set([
  "ts",
  "resets_at",
  "captured_at",
  "stale_after",
  "probed_at",
  "opened_at",
  "merged_at",
  "closed_at",
  "synced_at",
  "derived_at",
  "updated_at",
]);
/** Future-pointing columns: shifted, but never the anchor for a rows-only case. */
const FUTURE_COLS = new Set(["resets_at", "stale_after"]);

function isoMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** Rows-only offset: newest observation timestamp lands at NOW − 1 day (same rule as transcripts). */
function rowsShiftMs(rows: CaseRows, NOW: Date): number {
  let maxTs = Number.NEGATIVE_INFINITY;
  for (const list of Object.values(rows)) {
    for (const row of list ?? []) {
      for (const [col, v] of Object.entries(row)) {
        const ms = TS_COLS.has(col) && !FUTURE_COLS.has(col) ? isoMs(v) : null;
        if (ms !== null && ms > maxTs) maxTs = ms;
      }
    }
  }
  if (!Number.isFinite(maxTs))
    throw new Error("detector-health: rows have no timestamp to anchor on");
  return NOW.getTime() - DAY_MS - maxTs;
}

/** Insert rows (after ingest) with timestamp columns shifted; replaces migration seed rows. */
function insertRows(db: Db, rows: CaseRows, shiftMs: number): void {
  for (const [table, list] of Object.entries(rows)) {
    for (const row of list ?? []) {
      const cols = Object.keys(row);
      const vals = cols.map((c) => {
        const ms = TS_COLS.has(c) ? isoMs(row[c]) : null;
        return ms === null ? row[c] : new Date(ms + shiftMs).toISOString();
      });
      db.prepare(
        `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ).run(...vals);
    }
  }
}

/**
 * `detector` is a registry id, or a detector object (used by the harness mutation meta-test).
 * `input` is a transcript dir, or a case input with a transcript dir and/or a rows file.
 * The ingest workspace_id is the transcript dir's basename (its project slug).
 */
export function runCase(
  detector: string | AnyDetector,
  input: string | CaseInput,
  expect: CaseExpect,
  NOW: Date,
): CaseResult {
  const det = typeof detector === "string" ? DETECTORS.find((d) => d.id === detector) : detector;
  if (!det) throw new Error(`detector-health: unknown detector id ${String(detector)}`);
  return withCaseDb(input, NOW, (db) => {
    const out = det.evaluate(db, buildContext(NOW));
    const firedCount = out.fired.length;
    const pass = expect === "fires" ? out.status === "ACTIVE" && firedCount >= 1 : firedCount === 0;
    return { pass, status: out.status, firedCount, note: out.note };
  });
}

/** Load one case (ingest + rows) into a fresh DB, hand it to `fn`, then clean up (after a returned promise settles). */
export function withCaseDb<T>(input: string | CaseInput, NOW: Date, fn: (db: Db) => T): T {
  const { fixtureDir, rowsFile } =
    typeof input === "string" ? { fixtureDir: input, rowsFile: undefined } : input;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-dh-"));
  const db = migratedMemDb();
  const cleanup = (): void => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  let result: T;
  try {
    let shiftMs: number | null = null;
    if (fixtureDir) {
      const dest = path.join(root, path.basename(fixtureDir));
      ({ shiftMs } = shiftCorpus(fixtureDir, dest, NOW));
      copySidecars(fixtureDir, dest);
      expandFills(root);
      runBackscan(db, [root], { now: () => NOW, activityWindowSecs: 300 });
    }
    if (rowsFile) {
      const rows = readRows(rowsFile);
      insertRows(db, rows, shiftMs ?? rowsShiftMs(rows, NOW));
    }
    result = fn(db);
  } catch (e) {
    cleanup();
    throw e;
  }
  if (result instanceof Promise) return result.finally(cleanup) as T;
  cleanup();
  return result;
}
