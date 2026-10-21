/**
 * src/ingest/canary-purge.ts — boot purge of parity-canary rows (P3.1-T3, R1.2).
 *
 * Discovery skips canary workspaces (`CANARY_SLUG_MARK`), but an older daemon
 * ingested them: their sessions reach detectors and show as C9/D4 cards. This
 * deletes those sessions with their ingest-derived rows, offsets and baselines,
 * the canary workspaces, their cached week results and their PROPOSED recs. Recs
 * the user acted on are kept (they carry FK children). Idempotent and cheap when
 * nothing matches, so it runs on every boot.
 */

import type { Db } from "../db/open.js";
import { CANARY_SLUG_MARK } from "./discovery.js";
import { bumpEnrichmentEpoch } from "./enrichment-epoch.js";
import { classifierBaselinePathHash } from "./ingestor.js";

export interface CanaryPurgeResult {
  sessions: number;
  recommendations: number;
}

export function purgeCanaryRows(db: Db): CanaryPurgeResult {
  const isCanary = (col: string) => `instr(${col}, '${CANARY_SLUG_MARK}') > 0`;
  const sessions = `SELECT session_id FROM sessions WHERE ${isCanary("workspace_id")}`;
  return db.transaction((): CanaryPurgeResult => {
    const sessionCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM (${sessions})`).get() as {
        n: number;
      }
    ).n;
    const events = `SELECT event_id FROM tool_events WHERE session_id IN (${sessions})`;
    db.prepare(`DELETE FROM tool_event_content WHERE event_id IN (${events})`).run();
    db.prepare(`DELETE FROM tool_event_metadata WHERE event_id IN (${events})`).run();
    for (const table of [
      "tool_events",
      "turns",
      "ingest_metric_events",
      "session_churn",
      "session_work_links",
      "subagent_meta",
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE session_id IN (${sessions})`).run();
    }
    db.prepare(`DELETE FROM sessions WHERE ${isCanary("workspace_id")}`).run();
    db.prepare(`DELETE FROM workspaces WHERE ${isCanary("workspace_id")}`).run();

    const files = db
      .prepare(
        `SELECT file_path FROM ingest_offsets WHERE ${isCanary("file_path")}
         UNION SELECT file_path FROM ingest_metric_baselines WHERE ${isCanary("file_path")}`,
      )
      .all() as { file_path: string }[];
    const stClassifier = db.prepare(
      "DELETE FROM ingest_classifier_baselines WHERE file_path_hash = ?",
    );
    for (const { file_path } of files) stClassifier.run(classifierBaselinePathHash(file_path));
    db.prepare(`DELETE FROM ingest_offsets WHERE ${isCanary("file_path")}`).run();
    db.prepare(`DELETE FROM ingest_metric_baselines WHERE ${isCanary("file_path")}`).run();

    db.prepare(`DELETE FROM detector_week_results WHERE ${isCanary("scope_workspace_id")}`).run();
    const recs = db
      .prepare(
        `DELETE FROM recommendations
          WHERE ${isCanary("scope_workspace_id")} AND state = 'PROPOSED'`,
      )
      .run().changes;
    if (sessionCount > 0) bumpEnrichmentEpoch(db);
    return { sessions: sessionCount, recommendations: recs };
  })();
}
