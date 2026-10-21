/**
 * test/ingest/warm-restart-skip.test.ts — persisted file-version idle gating.
 *
 * A fresh Ingestor has no in-memory lastVersion entries. Matching persisted
 * file versions must still skip fully caught-up files, while an append remains
 * visible to normal offset-based tailing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { Ingestor } from "../../src/ingest/index.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, toJsonl, writeCorpus } from "./synth.js";

const NOW = () => new Date("2026-09-22T12:00:00.000Z");
const OPTIONS = { now: NOW, activityWindowSecs: 300 };

let db: Db;
let root: string;

beforeEach(() => {
  db = migratedMemDb();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-warm-restart-skip-"));
  writeCorpus(root, {
    "proj-warm": {
      "first.jsonl": [
        assistant({
          id: "warm-first",
          session: "warm-first-session",
          ts: "2026-09-22T11:00:00.000Z",
          input: 10,
          output: 1,
        }),
      ],
      "second.jsonl": [
        assistant({
          id: "warm-second",
          session: "warm-second-session",
          ts: "2026-09-22T11:01:00.000Z",
          input: 10,
          output: 1,
        }),
      ],
    },
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("warm restart idle-file skip", () => {
  it("skips persisted matching versions and still ingests an append", async () => {
    new Ingestor(db, [root], OPTIONS).runBackscan();

    // A new instance simulates a process restart: lastVersion is empty but
    // ingest_offsets retains the exact FileVersion written by the first pass.
    const restarted = await new Ingestor(db, [root], OPTIONS).runBackgroundBackfill(1);
    expect(restarted.files_total).toBe(2);
    expect(restarted.files_skipped).toBe(restarted.files_total);
    expect(restarted.files_with_new_data).toBe(0);

    const firstFile = path.join(root, "proj-warm", "first.jsonl");
    fs.appendFileSync(
      firstFile,
      toJsonl([
        assistant({
          id: "warm-appended",
          session: "warm-first-session",
          ts: "2026-09-22T11:02:00.000Z",
          input: 10,
          output: 1,
        }),
      ]),
    );

    const afterAppend = await new Ingestor(db, [root], OPTIONS).runBackgroundBackfill(1);
    expect(afterAppend.files_total).toBe(2);
    expect(afterAppend.files_skipped).toBe(1);
    expect(afterAppend.files_with_new_data).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM turns WHERE message_id = ?").get("warm-appended"),
    ).toEqual({ n: 1 });
  });
});
