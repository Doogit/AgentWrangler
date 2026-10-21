import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillSessionsUx } from "../../scripts/backfill-sessions-ux.js";
import { runMigrations } from "../../src/db/migrate.js";
import { type Db, openDb } from "../../src/db/open.js";
import { Ingestor } from "../../src/ingest/index.js";
import { assistant, writeCorpus } from "../ingest/synth.js";

const SESSION = "session-synthetic-ux";
const ts = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
const turn = (id: string, minute: number, sidechain = false) =>
  assistant({ id, session: SESSION, ts: ts(minute), input: 100, output: 10, sidechain });
const boundary = (minute: number) => ({
  type: "assistant",
  subtype: "compact_boundary",
  timestamp: ts(minute),
  sessionId: SESSION,
  message: { content: [] },
});
const summary = (minute: number) => ({
  type: "assistant",
  timestamp: ts(minute),
  sessionId: SESSION,
  isCompactSummary: true,
  message: { content: [] },
});

let root: string;
let db: Db;
let file: string;

type Snapshot = {
  title: string | null;
  title_source: string | null;
  turns: Array<{ message_id: string; is_compaction_boundary: number }>;
};

function snapshot(): Snapshot {
  const session = db
    .prepare("SELECT title, title_source FROM sessions WHERE session_id = ?")
    .get(SESSION) as Pick<Snapshot, "title" | "title_source">;
  const turns = db
    .prepare(
      "SELECT message_id, is_compaction_boundary FROM turns WHERE session_id = ? ORDER BY message_id",
    )
    .all(SESSION) as Snapshot["turns"];
  return { ...session, turns };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-sessions-ux-"));
  db = openDb(path.join(root, "synthetic.sqlite"));
  runMigrations(db);
  file = path.join(root, "project-synthetic", `${SESSION}.jsonl`);
  writeCorpus(root, {
    "project-synthetic": {
      [`${SESSION}.jsonl`]: [
        turn("turn-0", 0),
        { type: "ai-title", sessionId: SESSION, aiTitle: "  First synthetic label  " },
        { type: "ai-title", sessionId: SESSION, aiTitle: "  Second synthetic label  " },
        boundary(1),
        summary(2),
        turn("sidechain-1", 3, true),
        turn("turn-1", 4),
        turn("turn-2", 5),
        summary(6),
        turn("turn-3", 7),
        { type: "custom-title", sessionId: SESSION, customTitle: "  Custom synthetic label  " },
        { type: "ai-title", sessionId: SESSION, aiTitle: "  Ignored synthetic label  " },
      ],
    },
  });
  new Ingestor(db, [root], {
    now: () => new Date("2026-08-01T00:00:00.000Z"),
    activityWindowSecs: 300,
  }).ingestFile(file, "project-synthetic");
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function clearUx(): void {
  db.prepare("UPDATE sessions SET title = NULL, title_source = NULL WHERE session_id = ?").run(
    SESSION,
  );
  db.prepare("UPDATE turns SET is_compaction_boundary = 0 WHERE session_id = ?").run(SESSION);
}

describe("session UX backfill", () => {
  it("restores the ingestor oracle; second run and dry-run each change 0", async () => {
    const oracle = snapshot();
    expect(oracle.title).toBe("Custom synthetic label");
    expect(oracle.title_source).toBe("custom");
    expect(
      oracle.turns
        .filter((turn) => turn.is_compaction_boundary === 1)
        .map((turn) => turn.message_id),
    ).toEqual(["turn-1", "turn-3"]);
    expect(
      oracle.turns.find((turn) => turn.message_id === "sidechain-1")?.is_compaction_boundary,
    ).toBe(0);
    clearUx();

    // First run: restores everything.
    const first = await backfillSessionsUx(db);
    expect(first).toMatchObject({
      sessionsScanned: 1,
      titlesSet: 1,
      boundaryTurnsSet: 2,
    });
    expect(snapshot()).toEqual(oracle);

    // Second run: nothing to change.
    const second = await backfillSessionsUx(db);
    expect(second.titlesSet).toBe(0);
    expect(second.boundaryTurnsSet).toBe(0);
    expect(snapshot()).toEqual(oracle);

    // Dry-run on correct state: still reports 0 changes, writes nothing.
    clearUx();
    const dryOnEmpty = await backfillSessionsUx(db, { dryRun: true });
    expect(dryOnEmpty).toMatchObject({ titlesSet: 1, boundaryTurnsSet: 2 });
    expect(snapshot()).toEqual({
      ...oracle,
      title: null,
      title_source: null,
      turns: oracle.turns.map((t) => ({ ...t, is_compaction_boundary: 0 })),
    });
  });

  it("reports dry-run changes without writing them", async () => {
    clearUx();
    const before = snapshot();
    const counts = await backfillSessionsUx(db, { dryRun: true });
    expect(counts).toMatchObject({ titlesSet: 1, boundaryTurnsSet: 2 });
    expect(snapshot()).toEqual(before);
  });

  it("restores boundaries from DB even when the transcript file is missing", async () => {
    clearUx();
    fs.rmSync(file);
    const counts = await backfillSessionsUx(db);
    expect(counts).toMatchObject({
      sessionsScanned: 1,
      filesMissing: 1,
      titlesSet: 0, // file missing → no title
      boundaryTurnsSet: 2, // boundaries come from DB events, not the file
    });
    // Title is still null (file missing) but boundaries are restored.
    const snap = snapshot();
    expect(snap.title).toBeNull();
    expect(
      snap.turns.filter((t) => t.is_compaction_boundary === 1).map((t) => t.message_id),
    ).toEqual(["turn-1", "turn-3"]);
  });

  it("second run after a null-then-backfill cycle reports 0 boundary changes", async () => {
    clearUx();
    await backfillSessionsUx(db); // first run: restores 2 boundaries
    const second = await backfillSessionsUx(db); // second run: nothing to change
    expect(second.boundaryTurnsSet).toBe(0);
  });

  it("dry-run on an already-correct state reports 0 boundary changes", async () => {
    // Ingestor already set the correct boundaries in beforeEach.
    const counts = await backfillSessionsUx(db, { dryRun: true });
    expect(counts.boundaryTurnsSet).toBe(0);
  });
});
