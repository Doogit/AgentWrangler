/**
 * test/ingest/interrupt-relabel.test.ts — RC-D14 one-time repair.
 *
 * classifier-1 rows (substring match on tool_result text) are rewritten to what a clean
 * classifier-2 ingest stores: a tool_result that quotes the marker is cleared, the user Esc
 * records are flagged, and sessions.interrupt_count is recounted. Oracle: a clean ingest of the
 * same synthetic file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { Ingestor } from "../../src/ingest/index.js";
import { INTERRUPT_RELABEL_DONE, relabelInterrupts } from "../../src/ingest/interrupt-relabel.js";
import { migratedMemDb } from "./dbutil.js";
import { type Line, assistant, toJsonl, userPrompt } from "./synth.js";

const OPTS = { now: () => new Date("2026-08-01T00:00:00.000Z"), activityWindowSecs: 300 };
const S = "dddddddd-0000-4000-8000-000000000004";
const V = "2.1.22";
const user = (uuid: string, ts: string, content: unknown): Record<string, unknown> => ({
  type: "user",
  uuid,
  timestamp: ts,
  sessionId: S,
  version: V,
  message: { role: "user", content },
});
const lines: Line[] = [
  userPrompt({ session: S, ts: "2026-01-05T10:00:00.000Z" }),
  assistant({
    id: "m1",
    session: S,
    ts: "2026-01-05T10:00:01.000Z",
    toolUses: [{ id: "tu1", name: "Read", command: "x" }],
  }),
  // A file read whose text quotes the marker: classifier-1 flagged it.
  user("u-quote", "2026-01-05T10:00:02.000Z", [
    { type: "tool_result", tool_use_id: "tu1", content: 'MARK = "[Request interrupted by user]"' },
  ]),
  // Real Esc records (both variants): classifier-1 missed them.
  user("u-plain", "2026-01-05T10:00:03.000Z", [
    { type: "text", text: "[Request interrupted by user]" },
  ]),
  user("u-tool", "2026-01-05T10:00:04.000Z", [
    { type: "text", text: "[Request interrupted by user for tool use]" },
  ]),
];

const rows = (db: Db) =>
  db
    .prepare(
      `SELECT event_ts, is_interrupt, classifier_label, classifier_version FROM ingest_metric_events
        WHERE event_ts > '2026-01-05T10:00:01.000Z' ORDER BY event_ts`,
    )
    .all();
const interruptCount = (db: Db) =>
  (
    db.prepare("SELECT interrupt_count AS n FROM sessions WHERE session_id = ?").get(S) as {
      n: number;
    }
  ).n;

describe("interrupt relabel (RC-D14)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-d14-"));
    fs.mkdirSync(path.join(root, "ws-d14"));
    fs.writeFileSync(path.join(root, "ws-d14", `${S}.jsonl`), toJsonl(lines));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("rewrites classifier-1 rows to what a clean ingest stores, once", async () => {
    const clean = migratedMemDb();
    new Ingestor(clean, [root], OPTS).runBackscan();
    expect(rows(clean)).toEqual([
      {
        event_ts: "2026-01-05T10:00:02.000Z",
        is_interrupt: 0,
        classifier_label: null,
        classifier_version: "classifier-2",
      },
      {
        event_ts: "2026-01-05T10:00:03.000Z",
        is_interrupt: 1,
        classifier_label: "interrupt-cancel",
        classifier_version: "classifier-2",
      },
      {
        event_ts: "2026-01-05T10:00:04.000Z",
        is_interrupt: 1,
        classifier_label: null,
        classifier_version: "classifier-2",
      },
    ]);
    expect(interruptCount(clean)).toBe(2);

    // What classifier-1 stored.
    const db = migratedMemDb();
    new Ingestor(db, [root], OPTS).runBackscan();
    db.prepare(
      `UPDATE ingest_metric_events SET classifier_version = 'classifier-1',
          is_interrupt = CASE WHEN event_ts = '2026-01-05T10:00:02.000Z' THEN 1 ELSE 0 END,
          classifier_label = CASE WHEN event_ts = '2026-01-05T10:00:02.000Z' THEN 'interrupt-cancel' END
        WHERE event_ts > '2026-01-05T10:00:01.000Z'`,
    ).run();
    db.prepare("UPDATE sessions SET interrupt_count = 1").run();

    expect(await relabelInterrupts(db)).toEqual({ files: 1, lines: 3, changed: 3, sessions: 1 });
    expect(rows(db)).toEqual(rows(clean));
    expect(interruptCount(db)).toBe(2);

    // One-time: a second boot does nothing.
    db.prepare("UPDATE ingest_metric_events SET is_interrupt = 0").run();
    expect(await relabelInterrupts(db)).toEqual({ files: 0, lines: 0, changed: 0, sessions: 0 });
    expect(
      db.prepare("SELECT value FROM user_config WHERE key = ?").get(INTERRUPT_RELABEL_DONE),
    ).toEqual({ value: "done" });
  });

  it("keeps classifier-1 values when the transcript is gone", async () => {
    const db = migratedMemDb();
    new Ingestor(db, [root], OPTS).runBackscan();
    db.prepare(
      `UPDATE ingest_metric_events SET is_interrupt = 1, classifier_label = 'interrupt-cancel',
          classifier_version = 'classifier-1' WHERE event_ts = '2026-01-05T10:00:02.000Z'`,
    ).run();
    fs.rmSync(path.join(root, "ws-d14", `${S}.jsonl`));
    expect(await relabelInterrupts(db)).toEqual({ files: 0, lines: 0, changed: 0, sessions: 0 });
    expect(
      db
        .prepare("SELECT is_interrupt FROM ingest_metric_events WHERE event_ts = ?")
        .get("2026-01-05T10:00:02.000Z"),
    ).toEqual({ is_interrupt: 1 });
  });

  it("retries next boot when a file can't be read for a reason other than being gone", async () => {
    const db = migratedMemDb();
    new Ingestor(db, [root], OPTS).runBackscan();
    // A directory in the file's place: readFile fails with EISDIR, not ENOENT.
    const file = path.join(root, "ws-d14", `${S}.jsonl`);
    fs.rmSync(file);
    fs.mkdirSync(file);
    await relabelInterrupts(db);
    expect(
      db.prepare("SELECT value FROM user_config WHERE key = ?").get(INTERRUPT_RELABEL_DONE),
    ).toBeUndefined();
  });
});
