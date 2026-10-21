/**
 * OV-12 Phase 2 U4 seed: backfill limit_snapshots from DB backups (calibrations + last-good
 * API reading) and from transcript "weekly limit" API errors. Idempotent; dry run writes nothing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillLimitSnapshots } from "../../scripts/backfill-limit-snapshots.js";
import { runMigrations } from "../../src/db/migrate.js";

let dir: string;
let target: Database.Database;

function backup(name: string, rows: [string, string, string][]): void {
  const db = new Database(path.join(dir, name));
  db.exec("CREATE TABLE user_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  const ins = db.prepare("INSERT INTO user_config VALUES (?, ?, ?)");
  for (const r of rows) ins.run(...r);
  db.close();
}

const calib = (at: string, pct: number, resets: string): [string, string, string][] => [
  ["limit_provenance", `calibrated ${at.slice(0, 10)} @ ${pct.toFixed(1)}%; cap-weighted`, at],
  ["limit_resets_at", resets, at],
];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-backfill-"));
  fs.mkdirSync(path.join(dir, "backups"));
  backup(
    "backups/db-pre-reset.sqlite",
    calib("2026-09-12T07:01:45.382Z", 20, "2026-09-18T06:00:00.130692+00:00"),
  );
  // Same calibration in a second backup → one row.
  backup(
    "db.sqlite.pp2-backup-20260914",
    calib("2026-09-12T07:01:45.382Z", 20, "2026-09-18T06:00:00.130692+00:00"),
  );
  // Scratch copies under evidence/ are not backups → ignored.
  fs.mkdirSync(path.join(dir, "evidence", "g2"), { recursive: true });
  backup(
    "evidence/g2/scratch.sqlite",
    calib("2026-09-03T04:21:36.947Z", 24, "2026-09-04T05:59:59.753278+00:00"),
  );
  backup("db.pre-x.sqlite", [
    ...calib("2026-09-23T21:10:17.789Z", 79, "2026-09-25T05:59:59.683599+00:00"),
    [
      "usage_last_good",
      JSON.stringify({
        asOf: "2026-09-24T10:00:00.000Z",
        data: {
          five_hour: { utilization: 0.1, resets_at: null },
          seven_day: { utilization: 0.88, resets_at: "2026-09-25T05:59:59.683599+00:00" },
        },
      }),
      "2026-09-24T10:00:00.000Z",
    ],
  ]);
  fs.writeFileSync(path.join(dir, "db.pre-x.sqlite-wal"), "not a db");

  const transcript = path.join(dir, "s1.jsonl");
  fs.writeFileSync(
    transcript,
    [
      // Chat text quoting the phrase is not an API error.
      JSON.stringify({
        type: "user",
        timestamp: "2026-09-24T20:00:00.000Z",
        message: { content: "You've hit your weekly limit" },
      }),
      JSON.stringify({
        type: "assistant",
        isApiErrorMessage: true,
        timestamp: "2026-09-24T21:08:53.000Z",
        message: { content: [{ type: "text", text: "You've hit your weekly limit · resets Thu" }] },
      }),
      JSON.stringify({
        type: "assistant",
        isApiErrorMessage: true,
        timestamp: "2026-09-24T21:20:00.000Z",
        message: { content: [{ type: "text", text: "You've hit your weekly limit · resets Thu" }] },
      }),
      JSON.stringify({
        type: "assistant",
        isApiErrorMessage: true,
        timestamp: "2026-10-08T09:00:00.000Z",
        message: { content: [{ type: "text", text: "You've hit your weekly limit" }] },
      }),
    ].join("\n"),
  );

  target = new Database(path.join(dir, "db.sqlite"));
  runMigrations(target);
  // The target's own last-good reading is already logged forward → not a backup sample.
  target
    .prepare("INSERT INTO user_config (key, value, updated_at) VALUES ('usage_last_good', ?, ?)")
    .run(
      JSON.stringify({
        asOf: "2026-10-04T18:55:43.840Z",
        data: {
          five_hour: { utilization: 0, resets_at: null },
          seven_day: { utilization: 0.07, resets_at: "2026-10-09T05:59:59.860Z" },
        },
      }),
      "2026-10-04T18:55:43.840Z",
    );
  target.pragma("foreign_keys = OFF");
  target
    .prepare(
      "INSERT INTO sessions (session_id, workspace_id, file_path, state, api_error_count) VALUES ('s1', 'w', ?, 'RECONCILED', 3)",
    )
    .run(transcript);
}, 30_000);
afterEach(() => {
  target.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const stored = () =>
  target.prepare("SELECT ts, resets_at, used_pct, source FROM limit_snapshots ORDER BY ts").all();

describe("backfillLimitSnapshots", () => {
  it("collects calibrations, last-good readings and first limit hit per week", async () => {
    const r = await backfillLimitSnapshots(target, { home: dir });
    expect(r.inserted).toBe(5);
    expect(stored()).toEqual([
      {
        ts: "2026-09-12T07:01:45.382Z",
        resets_at: "2026-09-18T06:00:00.130Z",
        used_pct: 20,
        source: "calibration-backup",
      },
      {
        ts: "2026-09-23T21:10:17.789Z",
        resets_at: "2026-09-25T05:59:59.683Z",
        used_pct: 79,
        source: "calibration-backup",
      },
      {
        ts: "2026-09-24T10:00:00.000Z",
        resets_at: "2026-09-25T05:59:59.683Z",
        used_pct: 88,
        source: "api-backup",
      },
      // Reset taken from a known reading in the same week.
      {
        ts: "2026-09-24T21:08:53.000Z",
        resets_at: "2026-09-25T05:59:59.683Z",
        used_pct: 100,
        source: "limit-hit",
      },
      // No known reading that week → next Friday 06:00Z.
      {
        ts: "2026-10-08T09:00:00.000Z",
        resets_at: "2026-10-09T06:00:00.000Z",
        used_pct: 100,
        source: "limit-hit",
      },
    ]);
  });

  it("is idempotent", async () => {
    await backfillLimitSnapshots(target, { home: dir });
    const again = await backfillLimitSnapshots(target, { home: dir });
    expect(again.inserted).toBe(0);
    expect(stored()).toHaveLength(5);
  });

  it("dry run reports samples but writes nothing", async () => {
    const r = await backfillLimitSnapshots(target, { home: dir, dryRun: true });
    expect(r.samples).toHaveLength(5);
    expect(stored()).toHaveLength(0);
  });
});
