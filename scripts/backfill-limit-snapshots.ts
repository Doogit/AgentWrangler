/**
 * OV-12 Phase 2 U4 seed (one-off, local): fill limit_snapshots with weekly limit readings
 * recovered from before forward logging existed.
 *
 *   - calibration-backup: limit_provenance ("@ N%") + limit_resets_at in any SQLite DB under
 *     ~/.agentwrangler (each backup is a snapshot of user_config). evidence/ scratch copies are
 *     skipped: the operator ruled their 09-03 calibration out (2026-10-04);
 *   - api-backup: usage_last_good (last good API reading) in those same DBs;
 *   - limit-hit: "You've hit your weekly limit" API-error records in transcripts = 100%. Only
 *     sessions the DB flags with api errors are read. The reset comes from a known reading in the
 *     same week, else the next Friday 06:00Z. First hit per week only.
 *
 * Percentages and timestamps only (SEC-101); values stay in the local DB. Idempotent.
 * Dry run prints the samples and the implied weekly max $ for each, and writes nothing.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Db } from "../src/db/open.js";

export interface Sample {
  ts: string;
  resetsAt: string;
  usedPct: number;
  source: "calibration-backup" | "api-backup" | "limit-hit";
}

const WEEK_MS = 7 * 864e5;
const LIMIT_HIT = "hit your weekly limit";

const iso = (s: string): string | null => {
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

function sqliteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "evidence") out.push(...sqliteFiles(p));
    } else if (e.name.includes(".sqlite") && !/-(wal|shm|journal)$/.test(e.name)) out.push(p);
  }
  return out;
}

function fromBackup(file: string): Sample[] {
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  try {
    const get = (key: string) =>
      db.prepare("SELECT value, updated_at FROM user_config WHERE key = ?").get(key) as
        | { value: string | null; updated_at: string }
        | undefined;
    const out: Sample[] = [];
    const prov = get("limit_provenance");
    const resets = get("limit_resets_at");
    const pct = prov?.value?.match(/@ ([\d.]+)%/)?.[1];
    const resetsAt = resets?.value ? iso(resets.value) : null;
    const ts = prov ? iso(prov.updated_at) : null;
    if (pct !== undefined && resetsAt !== null && ts !== null) {
      out.push({ ts, resetsAt, usedPct: Number(pct), source: "calibration-backup" });
    }
    const lastGood = get("usage_last_good");
    if (lastGood?.value) {
      const v = JSON.parse(lastGood.value) as {
        asOf?: string;
        data?: { seven_day?: { utilization?: number; resets_at?: string | null } };
      };
      const week = v.data?.seven_day;
      const at = v.asOf ? iso(v.asOf) : null;
      const r = week?.resets_at ? iso(week.resets_at) : null;
      if (at !== null && r !== null && typeof week?.utilization === "number") {
        out.push({ ts: at, resetsAt: r, usedPct: week.utilization * 100, source: "api-backup" });
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function limitHitTimes(db: Db): Promise<string[]> {
  const files = db
    .prepare("SELECT file_path FROM sessions WHERE api_error_count > 0 AND file_path IS NOT NULL")
    .all() as { file_path: string }[];
  const out: string[] = [];
  for (const { file_path } of files) {
    if (!fs.existsSync(file_path)) continue;
    const lines = readline.createInterface({
      input: fs.createReadStream(file_path, { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (!line.includes(LIMIT_HIT) || !line.includes('"isApiErrorMessage":true')) continue;
      try {
        const rec = JSON.parse(line) as { isApiErrorMessage?: boolean; timestamp?: string };
        const ts = rec.isApiErrorMessage === true && rec.timestamp ? iso(rec.timestamp) : null;
        if (ts !== null) out.push(ts);
      } catch {
        // Malformed line: skip.
      }
    }
  }
  return out;
}

function nextFriday0600Z(ts: string): string {
  const d = new Date(ts);
  const friday = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7),
      6,
    ),
  );
  if (friday.getTime() <= d.getTime()) friday.setUTCDate(friday.getUTCDate() + 7);
  return friday.toISOString();
}

export async function collectSamples(db: Db, home: string): Promise<Sample[]> {
  const byTs = new Map<string, Sample>();
  const self = path.resolve(db.name);
  for (const f of sqliteFiles(home)) {
    for (const s of fromBackup(f)) {
      // The target's own last-good reading is already logged forward (source 'api').
      if (s.source === "api-backup" && path.resolve(f) === self) continue;
      byTs.set(s.ts, s);
    }
  }
  const known = [...byTs.values()];
  const hitWeeks = new Set<string>();
  for (const ts of (await limitHitTimes(db)).sort()) {
    const t = Date.parse(ts);
    const resetsAt =
      known.find((k) => Date.parse(k.resetsAt) > t && Date.parse(k.resetsAt) - WEEK_MS <= t)
        ?.resetsAt ?? nextFriday0600Z(ts);
    if (hitWeeks.has(resetsAt)) continue;
    hitWeeks.add(resetsAt);
    byTs.set(ts, { ts, resetsAt, usedPct: 100, source: "limit-hit" });
  }
  return [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

export async function backfillLimitSnapshots(
  db: Db,
  opts: { home: string; dryRun?: boolean },
): Promise<{ samples: Sample[]; inserted: number }> {
  const samples = await collectSamples(db, opts.home);
  if (opts.dryRun) return { samples, inserted: 0 };
  const ins = db.prepare(
    "INSERT OR IGNORE INTO limit_snapshots (ts, resets_at, used_pct, source) VALUES (?, ?, ?, ?)",
  );
  let inserted = 0;
  db.transaction(() => {
    for (const s of samples) inserted += ins.run(s.ts, s.resetsAt, s.usedPct, s.source).changes;
  })();
  return { samples, inserted };
}

/** List-price spend in [reset − 7d, ts) ÷ used% — the implied weekly max, for the dry-run table. */
function impliedMaxUsd(db: Db, s: Sample): number {
  const reset = Math.round(Date.parse(s.resetsAt) / 36e5) * 36e5;
  const row = db
    .prepare("SELECT COALESCE(SUM(cost_equiv_u), 0) AS u FROM turns WHERE ts >= ? AND ts < ?")
    .get(new Date(reset - WEEK_MS).toISOString(), s.ts) as { u: number };
  return row.u / 1e6 / (s.usedPct / 100);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const home = path.join(os.homedir(), ".agentwrangler");
  let dbPath = path.join(home, "db.sqlite");
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--db" && args[i + 1] !== undefined) dbPath = args[++i] as string;
    else throw new Error("Usage: backfill:limit-snapshots [--db <path>] [--dry-run]");
  }
  const db = new Database(dbPath, { fileMustExist: true, readonly: dryRun });
  try {
    const r = await backfillLimitSnapshots(db, { home, dryRun });
    for (const s of r.samples) {
      process.stdout.write(
        `${s.ts}  ${s.source.padEnd(18)} ${s.usedPct.toFixed(1).padStart(5)}%  resets ${s.resetsAt}  implied max $${impliedMaxUsd(db, s).toFixed(0)}\n`,
      );
    }
    process.stdout.write(
      `samples=${r.samples.length} inserted=${r.inserted}${dryRun ? " (dry run)" : ""}\n`,
    );
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
