/**
 * src/ingest/destructive-relabel.ts — one-time repair for card review F6 (2026-10-04).
 *
 * `destructive_op` was set at ingest by a substring match, and the enrich step never overwrites it
 * (`COALESCE`), so rows ingested before the parsed classifier (`destructive.ts`) keep a wrong
 * label: a grep pattern, a scratch cleanup, an `rm -f`. This re-reads the transcript line behind
 * each labelled main-chain row, classifies its raw Bash command again and stores the new label
 * (null when it is not a run). The stored command slice can't be used: the secrets filter redacts
 * long paths in it. A row whose line is no longer on disk keeps its label. Rows the old match
 * missed (`rm -fr`) are not searched for; new ingest labels them.
 */

import fs from "node:fs";
import type { Db } from "../db/open.js";
import { configGet, configSet } from "../detector/calibration.js";
import { classifyDestructiveOp } from "./destructive.js";
import { bumpEnrichmentEpoch } from "./enrichment-epoch.js";
import type { DestructiveOp } from "./types.js";

/** The `user_config` row that marks the repair done. */
export const DESTRUCTIVE_RELABEL_DONE = "destructive_relabel_v1";

export interface DestructiveRelabelResult {
  checked: number;
  changed: number;
  missing: number;
}

/** The new label for the Bash call(s) on the transcript lines written at `ts`; undefined if none. */
function relabel(text: string, ts: string): DestructiveOp | null | undefined {
  const key = `"timestamp":"${ts}"`;
  let found = false;
  for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, at + key.length)) {
    const end = text.indexOf("\n", at);
    const line = text.slice(text.lastIndexOf("\n", at) + 1, end < 0 ? undefined : end);
    let content: unknown;
    try {
      content = JSON.parse(line)?.message?.content;
    } catch {
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use" || block.name !== "Bash") continue;
      if (typeof block.input?.command !== "string") continue;
      found = true;
      // As the parser does: the first Bash command on the line that classifies.
      const op = classifyDestructiveOp(block.input.command);
      if (op !== null) return op;
    }
  }
  return found ? null : undefined;
}

export function relabelDestructiveOps(db: Db): DestructiveRelabelResult {
  const result: DestructiveRelabelResult = { checked: 0, changed: 0, missing: 0 };
  if (configGet(db, DESTRUCTIVE_RELABEL_DONE) !== null) return result;
  const rows = db
    .prepare(
      `SELECT e.event_id, e.event_ts, e.destructive_op, s.file_path
         FROM ingest_metric_events e JOIN sessions s ON s.session_id = e.session_id
        WHERE e.destructive_op IS NOT NULL AND e.is_sidechain = 0 AND e.event_ts IS NOT NULL
        ORDER BY s.file_path`,
    )
    .all() as Array<{
    event_id: string;
    event_ts: string;
    destructive_op: DestructiveOp;
    file_path: string | null;
  }>;
  const update = db.prepare(
    "UPDATE ingest_metric_events SET destructive_op = ? WHERE event_id = ?",
  );
  let file: string | null = null;
  let text = "";
  db.transaction(() => {
    for (const row of rows) {
      result.checked++;
      if (row.file_path !== file) {
        file = row.file_path;
        try {
          text = file === null ? "" : fs.readFileSync(file, "utf8");
        } catch {
          text = "";
        }
      }
      const op = relabel(text, row.event_ts);
      if (op === undefined) {
        result.missing++;
        continue;
      }
      if (op === row.destructive_op) continue;
      update.run(op, row.event_id);
      result.changed++;
    }
    if (result.changed > 0) bumpEnrichmentEpoch(db);
    configSet(db, DESTRUCTIVE_RELABEL_DONE, "done");
  })();
  return result;
}
