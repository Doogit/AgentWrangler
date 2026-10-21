import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { Ingestor } from "../../src/ingest/index.js";
import { getSession, listSessions } from "../../src/query/api/overview.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, toJsonl, writeCorpus } from "./synth.js";

let db: Db;
let root: string;
const opts = { now: () => new Date("2026-08-01T00:00:00.000Z"), activityWindowSecs: 300 };
const ts = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
const turn = (id: string, minute: number, session = "session-positions") =>
  assistant({ id, session, ts: ts(minute), input: 100, output: 10 });
const boundary = (minute: number, session = "session-positions") => ({
  type: "assistant",
  subtype: "compact_boundary",
  timestamp: ts(minute),
  sessionId: session,
  message: { content: [] },
});
const summary = (minute: number, session = "session-positions") => ({
  type: "assistant",
  timestamp: ts(minute),
  sessionId: session,
  isCompactSummary: true,
  message: { content: [] },
});

beforeEach(() => {
  db = migratedMemDb();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-compaction-positions-"));
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("compaction turn positions", () => {
  it("locates two compactions across incremental ingest and replay", () => {
    const file = path.join(root, "project-synthetic", "session-positions.jsonl");
    writeCorpus(root, {
      "project-synthetic": {
        "session-positions.jsonl": [turn("t0", 0), turn("t1", 1), boundary(2)],
      },
    });
    new Ingestor(db, [root], opts).ingestFile(file, "project-synthetic");
    fs.appendFileSync(
      file,
      toJsonl([
        summary(3),
        turn("t2", 4),
        turn("t3", 5),
        boundary(6),
        turn("t4", 7),
        turn("t5", 8),
      ]),
    );
    const restarted = new Ingestor(db, [root], opts);
    restarted.ingestFile(file, "project-synthetic");
    restarted.ingestFile(file, "project-synthetic");

    const session = getSession("session-positions").data;
    expect(session?.compaction_turn_indices).toEqual([2, 4]);
    expect(session?.compaction_turn_indices).toHaveLength(session?.compaction_count ?? -1);
    const listed = listSessions("project-synthetic", { from: ts(0), to: ts(9) }).data?.items[0];
    expect(listed?.compaction_turn_indices).toEqual([2, 4]);
  });

  it("returns an empty position array when no compaction occurred", () => {
    writeCorpus(root, {
      "project-synthetic": {
        "session-plain.jsonl": [turn("plain-0", 0, "session-plain")],
      },
    });
    new Ingestor(db, [root], opts).runBackscan();

    expect(getSession("session-plain").data?.compaction_turn_indices).toEqual([]);
  });

  it("flags the summary turn once when it follows a boundary", () => {
    writeCorpus(root, {
      "project-synthetic": {
        "session-positions.jsonl": [
          turn("t0", 0),
          boundary(1),
          assistant({
            id: "summary-turn",
            session: "session-positions",
            ts: ts(2),
            extra: { isCompactSummary: true },
          }),
          turn("t1", 3),
        ],
      },
    });
    new Ingestor(db, [root], opts).runBackscan();

    const session = getSession("session-positions").data;
    expect(session?.compaction_turn_indices).toEqual([1]);
    expect(session?.compaction_count).toBe(1);
  });

  it("flags the correct turn when compact-boundary and the following turn are in different files of the same session", () => {
    // File A: two turns + a compact-boundary event (line numbers 1..3).
    // File B: two more turns for the SAME session (line numbers 1..2, overlapping with A).
    // Old position-based logic would mix files and find 0 boundaries because the
    // compact-boundary position from file A doesn't match any turn position in the
    // DB (which reflects file B's line numbers).  The timestamp-based logic finds
    // the correct boundary regardless of which file each record came from.
    const SESSION = "session-crossfile";
    const fileA = path.join(root, "project-synthetic", `${SESSION}.jsonl`);
    const fileB = path.join(root, "project-synthetic", `${SESSION}-resumed.jsonl`);

    // File A: turns t0, t1 and then a compact-boundary (at minute 2, before any turn in file B).
    writeCorpus(root, {
      "project-synthetic": {
        [`${SESSION}.jsonl`]: [
          turn("t0", 0, SESSION),
          turn("t1", 1, SESSION),
          boundary(2, SESSION),
        ],
        // File B starts with turns whose timestamps are AFTER the boundary.
        [`${SESSION}-resumed.jsonl`]: [
          turn("t2", 3, SESSION), // first main-chain turn after boundary → gets the flag
          turn("t3", 4, SESSION),
        ],
      },
    });

    const ing = new Ingestor(db, [root], opts);
    ing.ingestFile(fileA, "project-synthetic");
    ing.ingestFile(fileB, "project-synthetic");

    const session = getSession(SESSION).data;
    // t2 is the first main-chain turn after the compact-boundary at minute 2.
    expect(session?.compaction_turn_indices).toEqual([2]);
    expect(session?.compaction_count).toBe(1);
  });

  it("produces one flagged turn when two back-to-back compactions precede the next main-chain turn", () => {
    const SESSION = "session-double";
    writeCorpus(root, {
      "project-synthetic": {
        [`${SESSION}.jsonl`]: [
          turn("d0", 0, SESSION),
          boundary(1, SESSION),
          boundary(2, SESSION), // second compaction immediately after the first
          turn("d1", 3, SESSION), // first main-chain turn after BOTH → flagged once
          turn("d2", 4, SESSION),
        ],
      },
    });
    new Ingestor(db, [root], opts).runBackscan();

    const session = getSession(SESSION).data;
    // Both compact-boundary events resolve to the same turn (d1), so only one flag.
    expect(session?.compaction_turn_indices).toEqual([1]);
    expect(session?.compaction_count).toBe(2);
  });

  it("never flags a sidechain turn after a compaction", () => {
    const SESSION = "session-sidechain-check";
    writeCorpus(root, {
      "project-synthetic": {
        [`${SESSION}.jsonl`]: [
          turn("m0", 0, SESSION),
          boundary(1, SESSION),
          // Sidechain turn at minute 2 — must NOT get the flag even though ts > boundary ts.
          assistant({
            id: "sc1",
            session: SESSION,
            ts: ts(2),
            input: 10,
            output: 5,
            sidechain: true,
          }),
          turn("m1", 3, SESSION), // first MAIN-chain turn after boundary → flagged
        ],
      },
    });
    new Ingestor(db, [root], opts).runBackscan();

    const session = getSession(SESSION).data;
    // Indices count ALL turns (sidechain included): m0=0, sc1=1, m1=2.
    expect(session?.compaction_turn_indices).toEqual([2]);
    // Verify the sidechain turn itself has no boundary flag.
    const scBoundary = db
      .prepare("SELECT is_compaction_boundary FROM turns WHERE session_id = ? AND message_id = ?")
      .get(SESSION, "sc1") as { is_compaction_boundary: number } | undefined;
    expect(scBoundary?.is_compaction_boundary).toBe(0);
  });
});
