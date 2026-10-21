/**
 * test/ingest/session-attribution-repair.test.ts — P3.2-F6.
 *
 * A conversation started by /clear writes a new transcript whose records carry
 * `sessionId` = the file's own id and `session_id` = the launcher session. The old
 * parser preferred `session_id`, filing the new conversation under the launcher.
 * Oracle: a clean ingest of the same files with the fixed parser.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { b1Detector } from "../../src/detector/detectors/b1_cache_read_collapse.js";
import { b4Detector } from "../../src/detector/detectors/b4_mid_session_prefix_break.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { Ingestor } from "../../src/ingest/index.js";
import {
  SESSION_ATTRIBUTION_REPAIR_KEY,
  repairSessionAttribution,
} from "../../src/ingest/session-attribution-repair.js";
import { migratedMemDb } from "./dbutil.js";
import { type Line, assistant, toJsonl, userPrompt, userToolResult } from "./synth.js";

const OPTS = { now: () => new Date("2026-08-01T00:00:00.000Z"), activityWindowSecs: 300 };
const CTX: DetectorContext = {
  now: new Date("2026-08-01T00:00:00.000Z"),
  fromIso: "2026-01-01T00:00:00.000Z",
  toIso: "2026-08-01T00:00:00.000Z",
};
const L = "aaaaaaaa-0000-4000-8000-000000000001"; // launcher session
const T = "bbbbbbbb-0000-4000-8000-000000000002"; // conversation after /clear
const SLUG = "ws-f6";

const launcherLines: Line[] = [
  userPrompt({ session: L, ts: "2026-01-05T10:00:00.000Z" }),
  assistant({
    id: "m1",
    session: L,
    ts: "2026-01-05T10:00:05.000Z",
    cw1h: 50_000,
    toolUses: [{ id: "tu1", name: "Bash", command: "ls" }],
  }),
  userToolResult({
    session: L,
    ts: "2026-01-05T10:00:06.000Z",
    results: [{ toolUseId: "tu1", text: "ok" }],
  }),
  assistant({ id: "m2", session: L, ts: "2026-01-05T10:01:00.000Z", cacheRead: 50_000, cw1h: 500 }),
];

/** The new conversation; `tagged` marks the records Claude Code tags with the launcher id. */
function clearedLines(tagged: (rec: Record<string, unknown>) => Record<string, unknown>): Line[] {
  return [
    userPrompt({ session: T, ts: "2026-01-05T10:02:00.000Z" }), // first record: no session_id
    tagged(userPrompt({ session: T, ts: "2026-01-05T10:02:10.000Z" })),
    tagged(assistant({ id: "m3", session: T, ts: "2026-01-05T10:02:20.000Z", cw1h: 60_000 })),
    tagged(
      assistant({
        id: "m4",
        session: T,
        ts: "2026-01-05T10:03:00.000Z",
        cacheRead: 60_000,
        cw1h: 400,
      }),
    ),
  ];
}
/** A legacy top-level subagent transcript (`<slug>/agent-*.jsonl`) of the new conversation. */
function agentLines(tagged: (rec: Record<string, unknown>) => Record<string, unknown>): Line[] {
  return [
    tagged(
      assistant({
        id: "s1",
        session: T,
        ts: "2026-01-05T10:02:40.000Z",
        cw5m: 8_000,
        sidechain: true,
      }),
    ),
  ];
}
const tagLauncher = (r: Record<string, unknown>) => ({ ...r, session_id: L });
const asLauncher = (r: Record<string, unknown>) => ({ ...r, sessionId: L });
// What Claude Code writes today.
const realCleared = { main: clearedLines(tagLauncher), agent: agentLines(tagLauncher) };
// What the old parser stored for those records: everything tagged with session_id went to L.
const oldAttribution = { main: clearedLines(asLauncher), agent: agentLines(asLauncher) };

function snapshot(db: Db) {
  return {
    turns: db
      .prepare(
        "SELECT message_id, session_id, cost_equiv_u, provisional FROM turns ORDER BY message_id",
      )
      .all(),
    sessions: db
      .prepare(
        `SELECT session_id, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u,
                user_turn_count, compaction_count, gap_n, hygiene_flags
           FROM sessions ORDER BY session_id`,
      )
      .all(),
    toolEvents: db
      .prepare("SELECT event_id, session_id, result_bytes FROM tool_events ORDER BY event_id")
      .all(),
    metricEvents: db
      .prepare(
        "SELECT session_id, COUNT(*) n FROM ingest_metric_events GROUP BY session_id ORDER BY session_id",
      )
      .all(),
  };
}

describe("session attribution (P3.2-F6)", () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-f6-"));
    dir = path.join(root, SLUG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${L}.jsonl`), toJsonl(launcherLines));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const writeCleared = (files: { main: Line[]; agent: Line[] }) => {
    fs.writeFileSync(path.join(dir, `${T}.jsonl`), toJsonl(files.main));
    fs.writeFileSync(path.join(dir, "agent-legacy1.jsonl"), toJsonl(files.agent));
  };

  it("files a /clear conversation under its own transcript session", () => {
    writeCleared(realCleared);
    const db = migratedMemDb();
    new Ingestor(db, [root], OPTS).runBackscan();

    expect(
      db.prepare("SELECT session_id FROM turns WHERE message_id IN ('m3','m4','s1')").all(),
    ).toEqual([{ session_id: T }, { session_id: T }, { session_id: T }]);
    // The new conversation's cold start is not a mid-session collapse.
    expect(b1Detector.evaluate(db, CTX).fired).toHaveLength(0);
    expect(b4Detector.evaluate(db, CTX).fired).toHaveLength(0);
  });

  it("repairs rows filed under the launcher to match a clean ingest", async () => {
    writeCleared(realCleared);
    const clean = migratedMemDb();
    new Ingestor(clean, [root], OPTS).runBackscan();

    // Reproduce the old attribution, then put the real transcript back.
    writeCleared(oldAttribution);
    const db = migratedMemDb();
    new Ingestor(db, [root], OPTS).runBackscan();
    expect(db.prepare("SELECT session_id FROM turns WHERE message_id = 'm3'").get()).toEqual({
      session_id: L,
    });
    expect(b1Detector.evaluate(db, CTX).fired).toHaveLength(1);
    writeCleared(realCleared);

    const result = await repairSessionAttribution(db, [root]);
    expect(result).toEqual({ groups: 1, repaired: 1, skipped: 0 });
    new Ingestor(db, [root], OPTS).runBackscan();

    expect(snapshot(db)).toEqual(snapshot(clean));
    expect(b1Detector.evaluate(db, CTX).fired).toHaveLength(0);
  });

  it("runs once: the marker makes a second call a no-op", async () => {
    writeCleared(oldAttribution);
    const db = migratedMemDb();
    new Ingestor(db, [root], OPTS).runBackscan();
    writeCleared(realCleared);
    expect(await repairSessionAttribution(db, [root])).toEqual({
      groups: 1,
      repaired: 1,
      skipped: 0,
    });
    expect(
      db.prepare("SELECT value FROM user_config WHERE key = ?").get(SESSION_ATTRIBUTION_REPAIR_KEY),
    ).toEqual({
      value: "done",
    });
    expect(await repairSessionAttribution(db, [root])).toEqual({
      groups: 0,
      repaired: 0,
      skipped: 0,
    });
  });

  it("leaves a group alone when one of its stored turns has no transcript on disk", async () => {
    writeCleared(oldAttribution);
    const db = migratedMemDb();
    new Ingestor(db, [root], OPTS).runBackscan();
    // A turn whose source transcript Claude Code has since deleted.
    db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version)
       VALUES ('gone', ?, ?, '2026-01-04T09:00:00.000Z', 'claude-sonnet-4-6', 'ingest-3')`,
    ).run(L, SLUG);
    writeCleared(realCleared);
    const before = snapshot(db);

    expect(await repairSessionAttribution(db, [root])).toEqual({
      groups: 1,
      repaired: 0,
      skipped: 1,
    });
    expect(snapshot(db)).toEqual(before);
  });

  it("forgets other paths of a repaired transcript, so P3-U7 cannot carry the old rows over", async () => {
    writeCleared(oldAttribution);
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "aw-f6-copy-"));
    try {
      fs.cpSync(root, copy, { recursive: true });
      const db = migratedMemDb();
      new Ingestor(db, [root, copy], OPTS).runBackscan();
      const copyRows = () =>
        db
          .prepare("SELECT COUNT(*) AS n FROM ingest_offsets WHERE file_path LIKE ?")
          .get(`${copy}%`);
      expect(copyRows()).toEqual({ n: 3 });

      writeCleared(realCleared);
      expect(await repairSessionAttribution(db, [root])).toMatchObject({ repaired: 1 });
      // The group (launcher + cleared conversation) owns all 3 files: forgotten at both paths.
      expect(copyRows()).toEqual({ n: 0 });
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });
});
