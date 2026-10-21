/**
 * test/ingest/destructive-relabel.test.ts — card review F6.
 *
 * Rows labelled by the old substring match are relabelled from the raw transcript command.
 * Oracle: a clean ingest of the same file with the parsed classifier.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import {
  DESTRUCTIVE_RELABEL_DONE,
  relabelDestructiveOps,
} from "../../src/ingest/destructive-relabel.js";
import { Ingestor } from "../../src/ingest/index.js";
import { migratedMemDb } from "./dbutil.js";
import { type Line, assistant, toJsonl, userPrompt } from "./synth.js";

const OPTS = { now: () => new Date("2026-08-01T00:00:00.000Z"), activityWindowSecs: 300 };
const S = "cccccccc-0000-4000-8000-000000000003";
const COMMANDS = [
  'grep -n "rm -rf" notes.md',
  "rm -rf C:/Users/dev/AppData/Local/Temp/claude/C--proj/0a1b/scratchpad/shots",
  "rm -f a/r/f.txt",
  "rm -rf ../other",
];
const lines: Line[] = [
  userPrompt({ session: S, ts: "2026-01-05T10:00:00.000Z" }),
  ...COMMANDS.map((command, i) =>
    assistant({
      id: `m${i}`,
      session: S,
      ts: `2026-01-05T10:00:0${i + 1}.000Z`,
      toolUses: [{ id: `tu${i}`, name: "Bash", command }],
    }),
  ),
];

const labels = (db: Db) =>
  db
    .prepare(
      `SELECT event_ts, destructive_op FROM ingest_metric_events
        WHERE event_ts > '2026-01-05T10:00:00.000Z' ORDER BY event_ts`,
    )
    .all();

describe("destructive relabel (card review F6)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-h1-"));
    fs.mkdirSync(path.join(root, "ws-h1"));
    fs.writeFileSync(path.join(root, "ws-h1", `${S}.jsonl`), toJsonl(lines));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("relabels old substring-match rows to what a clean ingest stores", () => {
    const clean = migratedMemDb();
    new Ingestor(clean, [root], OPTS).runBackscan();
    expect(labels(clean)).toEqual([
      { event_ts: "2026-01-05T10:00:01.000Z", destructive_op: null },
      { event_ts: "2026-01-05T10:00:02.000Z", destructive_op: null },
      { event_ts: "2026-01-05T10:00:03.000Z", destructive_op: null },
      { event_ts: "2026-01-05T10:00:04.000Z", destructive_op: "rm-rf" },
    ]);

    // What the old match stored: every one of these as rm-rf.
    const db = migratedMemDb();
    new Ingestor(db, [root], OPTS).runBackscan();
    db.prepare(
      `UPDATE ingest_metric_events SET destructive_op = 'rm-rf'
        WHERE event_ts > '2026-01-05T10:00:00.000Z'`,
    ).run();
    db.prepare("UPDATE ingest_metric_events SET is_sidechain = 0").run();
    clean.prepare("UPDATE ingest_metric_events SET is_sidechain = 0").run();

    expect(relabelDestructiveOps(db)).toEqual({ checked: 4, changed: 3, missing: 0 });
    expect(labels(db)).toEqual(labels(clean));
    // One-time: a second boot does nothing.
    db.prepare("UPDATE ingest_metric_events SET destructive_op = 'rm-rf'").run();
    expect(relabelDestructiveOps(db)).toEqual({ checked: 0, changed: 0, missing: 0 });
    expect(
      db.prepare("SELECT value FROM user_config WHERE key = ?").get(DESTRUCTIVE_RELABEL_DONE),
    ).toEqual({ value: "done" });
  });

  it("keeps the label when the transcript line is gone", () => {
    const db = migratedMemDb();
    new Ingestor(db, [root], OPTS).runBackscan();
    db.prepare(
      `UPDATE ingest_metric_events SET destructive_op = 'rm-rf', is_sidechain = 0
        WHERE event_ts = '2026-01-05T10:00:01.000Z'`,
    ).run();
    fs.writeFileSync(path.join(root, "ws-h1", `${S}.jsonl`), "");
    // The row set here and the real run at 10:00:04, both kept.
    expect(relabelDestructiveOps(db)).toEqual({ checked: 2, changed: 0, missing: 2 });
  });
});
