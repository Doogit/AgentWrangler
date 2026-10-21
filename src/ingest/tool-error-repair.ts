/**
 * src/ingest/tool-error-repair.ts — one-time repair for rec-reset U2.
 *
 * Before the classifier accepted the `<tool_use_error>` wrapper, wrapped errors were
 * stored unclassified (class NULL, version NULL). This reclassifies those rows from the
 * stored secrets-filtered error text (tool_event_content.content_json $.error). Each
 * update goes (NULL, NULL) -> (class, 'tool-error-1'), which migration 025's update
 * trigger allows. Rows the classifier still cannot label stay (NULL, NULL), exactly as
 * ingest leaves them. Done-marker in user_config, like session-attribution-repair.
 * v2 (U7): reruns once for DBs that did v1, to label the MODIFIED_SINCE_READ, MULTI_MATCH
 * and READ_OUTPUT_TOO_LARGE rows. Still only touches version-NULL rows.
 */

import type { Db } from "../db/open.js";
import { configGet, configSet } from "../detector/calibration.js";
import { bumpEnrichmentEpoch } from "./enrichment-epoch.js";
import { TOOL_ERROR_CLASSIFIER_VERSION, classifyToolResultError } from "./tool-error-classifier.js";

export const TOOL_ERROR_REPAIR_KEY = "tool_error_repair_v2";

export interface ToolErrorRepairResult {
  checked: number;
  reclassified: number;
}

interface CandidateRow {
  event_id: string;
  error: string;
  cc_version: string | null;
}

export function repairToolErrorClasses(db: Db): ToolErrorRepairResult {
  const result: ToolErrorRepairResult = { checked: 0, reclassified: 0 };
  if (configGet(db, TOOL_ERROR_REPAIR_KEY) !== null) return result;

  const rows = db
    .prepare(
      `SELECT e.event_id, json_extract(c.content_json, '$.error') AS error, m.cc_version
         FROM tool_events e
         JOIN tool_event_content c ON c.event_id = e.event_id
         LEFT JOIN ingest_metric_events m ON m.event_id = e.event_id
        WHERE e.tool_error_classifier_version IS NULL
          AND json_extract(c.content_json, '$.error') IS NOT NULL`,
    )
    .all() as CandidateRow[];
  const update = db.prepare(
    `UPDATE tool_events SET tool_error_class = ?, tool_error_classifier_version = ?
      WHERE event_id = ? AND tool_error_classifier_version IS NULL`,
  );
  db.transaction(() => {
    for (const row of rows) {
      result.checked++;
      // Stored rows often have no cc_version (never captured). The version gate is a
      // guard against future transcript formats, so a missing version is treated as 2.1.x.
      const label = classifyToolResultError(row.error, row.cc_version ?? "2.1.0");
      if (label === null) continue;
      result.reclassified += update.run(label, TOOL_ERROR_CLASSIFIER_VERSION, row.event_id).changes;
    }
    if (result.reclassified > 0) bumpEnrichmentEpoch(db);
    configSet(db, TOOL_ERROR_REPAIR_KEY, "done");
  })();
  return result;
}
