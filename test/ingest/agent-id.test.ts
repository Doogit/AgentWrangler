/**
 * S1d — every sidechain turn carries the id of the subagent that produced it.
 * Synthetic fixtures only (SEC-101): fake ids, zeroed usage.
 */
import fsModule, * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/open.js";
import {
  AGENT_ID_BACKFILL_KEY,
  agentIdForTranscript,
  backfillTurnAgentIds,
} from "../../src/ingest/agent-id-backfill.js";
import { Ingestor } from "../../src/ingest/index.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, toJsonl } from "./synth.js";

const OPTS = { now: () => new Date("2026-08-01T00:00:00.000Z"), activityWindowSecs: 300 };
const SESSION = "session-s1d";
const SLUG = "proj-s1d";

let db: Db;
let tmp: string;
let files: string[];

function turnAgents(): Record<string, string | null> {
  const rows = db
    .prepare("SELECT message_id, agent_id FROM turns ORDER BY message_id")
    .all() as Array<{ message_id: string; agent_id: string | null }>;
  return Object.fromEntries(rows.map((r) => [r.message_id, r.agent_id]));
}

const EXPECTED = {
  "main-1": null,
  "main-2": null,
  "a-1": "alpha",
  "a-2": "alpha",
  "b-1": "beta",
  "b-2": "beta",
};

beforeEach(() => {
  db = migratedMemDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-s1d-"));
  const sessionDir = path.join(tmp, SLUG, SESSION);
  const direct = path.join(sessionDir, "subagents");
  const workflow = path.join(direct, "workflows", "wf_fixture");
  fs.mkdirSync(workflow, { recursive: true });
  const at = (minute: number) => `2026-07-31T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const turn = (id: string, minute: number, sidechain: boolean) =>
    assistant({ id, session: SESSION, ts: at(minute), sidechain });
  // Turns from alpha (direct layout) and beta (workflow layout) interleave in time.
  files = [
    path.join(tmp, SLUG, `${SESSION}.jsonl`),
    path.join(direct, "agent-alpha.jsonl"),
    path.join(workflow, "agent-beta.jsonl"),
  ];
  fs.writeFileSync(
    files[0] as string,
    toJsonl([turn("main-1", 0, false), turn("main-2", 9, false)]),
  );
  fs.writeFileSync(files[1] as string, toJsonl([turn("a-1", 1, true), turn("a-2", 3, true)]));
  fs.writeFileSync(files[2] as string, toJsonl([turn("b-1", 2, true), turn("b-2", 4, true)]));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("agentIdForTranscript", () => {
  it("reads the id from agent files under a subagents directory only", () => {
    expect(agentIdForTranscript(files[1] as string)).toBe("alpha");
    expect(agentIdForTranscript(files[2] as string)).toBe("beta");
    expect(agentIdForTranscript(files[0] as string)).toBeNull();
    expect(agentIdForTranscript(path.join(tmp, SLUG, "agent-stray.jsonl"))).toBeNull();
  });
});

describe("turns.agent_id on ingest", () => {
  it("gives each interleaved subagent turn its own agent id; main turns stay NULL", () => {
    new Ingestor(db, [tmp], OPTS).runBackscan();
    expect(turnAgents()).toEqual(EXPECTED);
  });
});

describe("one-time agent_id backfill", () => {
  it("fills pre-existing NULL sidechain rows once, then never runs again", async () => {
    new Ingestor(db, [tmp], OPTS).runBackscan();
    db.prepare("UPDATE turns SET agent_id = NULL").run(); // rows ingested before 038

    expect(await backfillTurnAgentIds(db, files)).toBe(4);
    expect(turnAgents()).toEqual(EXPECTED);
    expect(
      db.prepare("SELECT value FROM user_config WHERE key = ?").get(AGENT_ID_BACKFILL_KEY),
    ).toEqual({ value: "4" });

    // Recorded as done: a second run is a no-op even if NULL rows reappear.
    db.prepare("UPDATE turns SET agent_id = NULL WHERE message_id = 'a-1'").run();
    expect(await backfillTurnAgentIds(db, files)).toBe(0);
    expect(turnAgents()["a-1"]).toBeNull();
  });

  // P2-U4: on a fresh DB every sidechain row already carries its id (ingest sets it), and
  // reading every subagent file again cost 5 s with a 189 ms block on the X corpus.
  it("reads no file when no sidechain turn lacks an agent id, and records itself done", async () => {
    new Ingestor(db, [tmp], OPTS).runBackscan();
    const reads = vi.spyOn(fsModule, "readFileSync");
    try {
      expect(await backfillTurnAgentIds(db, files)).toBe(0);
      expect(reads.mock.calls.filter(([p]) => files.includes(String(p)))).toEqual([]);
    } finally {
      reads.mockRestore();
    }
    expect(
      db.prepare("SELECT value FROM user_config WHERE key = ?").get(AGENT_ID_BACKFILL_KEY),
    ).toEqual({ value: "0" });
  });

  it("runs after the background scan even when every file is skipped as unchanged", async () => {
    new Ingestor(db, [tmp], OPTS).runBackscan();
    db.prepare("UPDATE turns SET agent_id = NULL").run();

    const progress = await new Ingestor(db, [tmp], OPTS).runBackgroundBackfill();

    expect(progress.files_skipped).toBe(3);
    expect(turnAgents()).toEqual(EXPECTED);
  });
});
