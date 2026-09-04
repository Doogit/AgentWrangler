/**
 * D7 ingestion-to-recommendation integration.
 *
 * Uses only fabricated transcript structure. The assertions intentionally
 * verify that raw tool path/result strings do not cross the persistence or
 * recommendation boundaries while a fresh corpus still produces D7 output.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDetectors } from "../../src/detector/index.js";
import { runBackscan } from "../../src/ingest/index.js";
import { listRecommendations } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { migratedMemDb } from "../ingest/dbutil.js";
import { assistant, userToolResult, writeCorpus } from "../ingest/synth.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const INGEST_OPTS = { now: () => NOW, activityWindowSecs: 300 };
const RAW_PATH = "C:/fabricated/private/d7-integration.ts";
const EQUIVALENT_PATHS = [
  RAW_PATH,
  "C:\\fabricated\\private\\nested\\..\\d7-integration.ts",
  "C:/fabricated/./private/d7-integration.ts",
] as const;
const RAW_RESULT = "fabricated D7 integration result";

let db: ReturnType<typeof migratedMemDb>;
let root: string;

beforeEach(() => {
  db = migratedMemDb();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-d7-integration-"));
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("D7 fresh ingestion integration", () => {
  it("persists and surfaces a reconciled retry/read recommendation without raw tool content", () => {
    const session = "d7-integration-session";
    const lines = Array.from({ length: 3 }, (_, index) => {
      const toolUseId = `d7-integration-read-${index}`;
      const ts = `2027-01-02T00:00:0${index}.000Z`;
      return [
        assistant({
          id: `d7-integration-owner-${index}`,
          session,
          ts,
          input: 100,
          toolUses: [
            { id: toolUseId, name: "Read", input: { file_path: EQUIVALENT_PATHS[index] } },
          ],
        }),
        userToolResult({
          session,
          ts: `2027-01-02T00:00:1${index}.000Z`,
          results: [{ toolUseId, text: RAW_RESULT, isError: false }],
        }),
      ];
    }).flat();
    writeCorpus(root, { "d7-integration": { "session.jsonl": lines } });

    runBackscan(db, [root], INGEST_OPTS);
    const detectorStatuses = runDetectors(db, { now: NOW });

    const statuses = db.prepare("SELECT state FROM sessions WHERE session_id = ?").get(session) as {
      state: string;
    };
    expect(statuses.state).toBe("RECONCILED");
    expect(detectorStatuses.find((status) => status.detector_id === "D7")?.status).toBe("ACTIVE");

    const detectorRows = db
      .prepare("SELECT detector_id, evidence_json FROM recommendations WHERE detector_id = 'D7'")
      .all() as Array<{ detector_id: string; evidence_json: string }>;
    expect(detectorRows).toHaveLength(1);

    const view = listRecommendations().data;
    if (view === null) throw new Error("expected recommendations view");
    const rec = view.active.find((candidate) => candidate.detector_id === "D7");
    expect(rec?.target_metric).toBe("loop_flagged_turn_share");
    expect(rec?.evidence.redundant_read_event_count).toBe(3);

    const persisted = JSON.stringify(
      db
        .prepare(
          `SELECT e.input_hash, e.exit_class, m.file_path_hash, m.owner_message_id, m.block_index
             FROM tool_events e JOIN tool_event_metadata m ON m.event_id = e.event_id
            WHERE e.session_id = ? ORDER BY e.event_id`,
        )
        .all(session),
    );
    const identities = db
      .prepare(
        `SELECT COUNT(DISTINCT e.input_hash) AS input_count,
                COUNT(DISTINCT m.file_path_hash) AS path_count
           FROM tool_events e JOIN tool_event_metadata m ON m.event_id = e.event_id
          WHERE e.session_id = ?`,
      )
      .get(session) as { input_count: number; path_count: number };
    expect(identities).toEqual({ input_count: 1, path_count: 1 });
    const surfaced = JSON.stringify({ detectorRows, rec });
    for (const raw of [...EQUIVALENT_PATHS, RAW_RESULT]) {
      expect(persisted).not.toContain(raw);
      expect(surfaced).not.toContain(raw);
    }
  });
});
