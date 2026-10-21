/**
 * test/ingest/canary-purge.test.ts — P3.1-T3 (R1.2).
 *
 * The parity canary leaves transcripts under a temp workspace
 * (`…-agentwrangler-canary-<uuid>`). Discovery now skips those slugs; the boot
 * purge removes what an older daemon already ingested. Oracle: an ingest of only
 * the non-canary workspace.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { purgeCanaryRows } from "../../src/ingest/canary-purge.js";
import { Ingestor } from "../../src/ingest/index.js";
import { migratedMemDb } from "./dbutil.js";
import { type Line, assistant, toJsonl, userPrompt, userToolResult } from "./synth.js";

const OPTS = { now: () => new Date("2026-08-01T00:00:00.000Z"), activityWindowSecs: 300 };
const KEEP = "ws-keep";
const CANARY =
  "C--Users-dev-AppData-Local-Temp-agentwrangler-canary-00000000-0000-4000-8000-000000000000";
const S_KEEP = "aaaaaaaa-0000-4000-8000-000000000001";
const S_CANARY = "bbbbbbbb-0000-4000-8000-000000000002";

function lines(session: string, prefix: string): Line[] {
  return [
    userPrompt({ session, ts: "2026-01-05T10:00:00.000Z" }),
    assistant({
      id: `${prefix}1`,
      session,
      ts: "2026-01-05T10:00:05.000Z",
      cw1h: 50_000,
      toolUses: [{ id: `${prefix}tu1`, name: "Bash", command: "ls" }],
    }),
    userToolResult({
      session,
      ts: "2026-01-05T10:00:06.000Z",
      results: [{ toolUseId: `${prefix}tu1`, text: "ok" }],
    }),
    assistant({ id: `${prefix}2`, session, ts: "2026-01-05T10:01:00.000Z", cacheRead: 50_000 }),
  ];
}

function snapshot(db: Db) {
  const all = (sql: string) => db.prepare(sql).all();
  return {
    workspaces: all("SELECT workspace_id FROM workspaces ORDER BY 1"),
    sessions: all("SELECT session_id, workspace_id, turn_count FROM sessions ORDER BY 1"),
    turns: all("SELECT message_id, session_id FROM turns ORDER BY 1"),
    toolEvents: all("SELECT event_id, session_id FROM tool_events ORDER BY 1"),
    toolEventContent: all("SELECT event_id FROM tool_event_content ORDER BY 1"),
    metricEvents: all("SELECT session_id, COUNT(*) n FROM ingest_metric_events GROUP BY 1"),
    offsets: all("SELECT file_path FROM ingest_offsets ORDER BY 1"),
    metricBaselines: all("SELECT file_path FROM ingest_metric_baselines ORDER BY 1"),
    classifierBaselines: all("SELECT file_path_hash FROM ingest_classifier_baselines ORDER BY 1"),
  };
}

function seedDetectorRows(db: Db, workspace: string): void {
  db.prepare(
    `INSERT INTO detector_week_results
       (detector_id, scope_key, week_start, scope_workspace_id, fired, rank_value_u, evaluated_at)
     VALUES ('C9', ?, '2026-01-05', ?, 1, 1, '2026-01-06T00:00:00.000Z')`,
  ).run(`C9|${workspace}`, workspace);
  db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
        modeled_formula_json, evidence_json, target_metric, state, created_at, contract_status)
     VALUES (?, 'RULE', 'C9', 'errors', ?, 'lever', '{}', '{}', 'metric', 'PROPOSED',
             '2026-01-06T00:00:00.000Z', 'LEGACY_UNVERIFIED')`,
  ).run(`rec-C9-${workspace}`, workspace);
}

describe("canary purge (P3.1-T3)", () => {
  let root: string;
  let keepFile: string;
  let canaryFile: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-canary-"));
    fs.mkdirSync(path.join(root, KEEP));
    fs.mkdirSync(path.join(root, CANARY));
    keepFile = path.join(root, KEEP, `${S_KEEP}.jsonl`);
    canaryFile = path.join(root, CANARY, `${S_CANARY}.jsonl`);
    fs.writeFileSync(keepFile, toJsonl(lines(S_KEEP, "k")));
    fs.writeFileSync(canaryFile, toJsonl(lines(S_CANARY, "c")));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("removes ingested canary rows and nothing else", () => {
    const oracle = migratedMemDb();
    new Ingestor(oracle, [root], OPTS).ingestFile(keepFile, KEEP);
    seedDetectorRows(oracle, KEEP);

    const db = migratedMemDb();
    const ingestor = new Ingestor(db, [root], OPTS);
    ingestor.ingestFile(keepFile, KEEP);
    ingestor.ingestFile(canaryFile, CANARY); // what an older daemon stored
    seedDetectorRows(db, KEEP);
    seedDetectorRows(db, CANARY);
    expect(
      db.prepare("SELECT COUNT(*) n FROM sessions WHERE workspace_id = ?").get(CANARY),
    ).toEqual({ n: 1 });

    expect(purgeCanaryRows(db)).toEqual({ sessions: 1, recommendations: 1 });

    expect(snapshot(db)).toEqual(snapshot(oracle));
    const recs = "SELECT rec_id FROM recommendations ORDER BY 1";
    expect(db.prepare(recs).all()).toEqual(oracle.prepare(recs).all());
    const weeks = "SELECT scope_workspace_id FROM detector_week_results ORDER BY 1";
    expect(db.prepare(weeks).all()).toEqual(oracle.prepare(weeks).all());

    expect(purgeCanaryRows(db)).toEqual({ sessions: 0, recommendations: 0 });
  });

  it("a backscan never ingests a canary workspace", () => {
    const db = migratedMemDb();
    new Ingestor(db, [root], OPTS).runBackscan();
    expect(db.prepare("SELECT workspace_id FROM workspaces").all()).toEqual([
      { workspace_id: KEEP },
    ]);
  });
});
