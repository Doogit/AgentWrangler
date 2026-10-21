/**
 * src/ingest/interrupt-relabel.ts — one-time repair for RC-D14 (classifier-2).
 *
 * classifier-1 set `is_interrupt` / `interrupt-cancel` when any tool_result text *contained*
 * "[Request interrupted by user]". That missed every real Esc (a user record whose content is the
 * marker alone) and flagged tool_results that quote the marker (file reads). The enrich step never
 * overwrites these columns (`COALESCE`), so this re-reads every tracked transcript once, re-projects
 * the lines that can carry either label, and stores what a clean classifier-2 ingest would. Then it
 * recounts `sessions.interrupt_count` for the sessions it changed. A row whose line is no longer on
 * disk keeps its classifier-1 values (D14 reads classifier-2 rows only).
 *
 * Files are read asynchronously, one at a time, so the boot scan does not block the event loop; a
 * file without any of the needles is skipped without decoding.
 */

import fs from "node:fs";
import type { Db } from "../db/open.js";
import { awaitDbWriteGate } from "../db/write-gate.js";
import { configGet, configSet } from "../detector/calibration.js";
import { sessionStemFor } from "./discovery.js";
import { bumpEnrichmentEpoch } from "./enrichment-epoch.js";
import { metricEventId } from "./ingestor.js";
import { projectLine } from "./parser.js";
import { CLASSIFIER_VERSION } from "./types.js";

/** The `user_config` row that marks the repair done. */
export const INTERRUPT_RELABEL_DONE = "interrupt_relabel_v1";

/** Every line whose old or new interrupt label can differ contains one of these. */
const NEEDLES = [
  "[Request interrupted by user",
  "toolDenialKind",
  "The user doesn't want to take this action right now",
];
const NEEDLE_BUFS = NEEDLES.map((n) => Buffer.from(n, "utf8"));

export interface InterruptRelabelResult {
  /** Tracked transcript files read. */
  files: number;
  /** Lines re-projected (those containing a needle). */
  lines: number;
  /** Stored rows whose is_interrupt or classifier_label changed. */
  changed: number;
  /** Sessions whose interrupt_count was recounted. */
  sessions: number;
}

export async function relabelInterrupts(db: Db): Promise<InterruptRelabelResult> {
  const result: InterruptRelabelResult = { files: 0, lines: 0, changed: 0, sessions: 0 };
  if (configGet(db, INTERRUPT_RELABEL_DONE) !== null) return result;
  const files = db
    .prepare("SELECT file_path FROM ingest_offsets ORDER BY file_path")
    .all() as Array<{
    file_path: string;
  }>;
  const wanted = new Map<string, { isInterrupt: 0 | 1; label: string | null }>();
  // A file that could not be read for any reason but being gone (a lock, EBUSY) is retried next boot.
  let retry = false;
  for (const { file_path } of files) {
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(file_path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") retry = true;
      continue;
    }
    result.files++;
    if (!NEEDLE_BUFS.some((n) => buf.includes(n))) continue;
    const defaultSessionId = sessionStemFor(file_path);
    for (const raw of buf.toString("utf8").split("\n")) {
      if (!NEEDLES.some((n) => raw.includes(n))) continue;
      // The raw line exactly as the ingestor splits it: a line without a uuid is keyed by its hash.
      const proj = projectLine(raw, { defaultSessionId });
      if (proj.kind !== "record") continue;
      result.lines++;
      wanted.set(metricEventId(raw, proj), {
        isInterrupt: proj.isInterrupt ? 1 : 0,
        label: proj.classifierLabel,
      });
    }
  }

  const getRow = db.prepare(
    "SELECT session_id, is_interrupt, classifier_label FROM ingest_metric_events WHERE event_id = ?",
  );
  const update = db.prepare(
    `UPDATE ingest_metric_events SET is_interrupt = ?, classifier_label = ?, classifier_version = ?
      WHERE event_id = ?`,
  );
  const recount = db.prepare(
    `UPDATE sessions SET interrupt_count =
       (SELECT COUNT(*) FROM ingest_metric_events WHERE session_id = ? AND is_interrupt = 1)
      WHERE session_id = ?`,
  );
  await awaitDbWriteGate();
  db.transaction(() => {
    const sessions = new Set<string>();
    for (const [eventId, want] of wanted) {
      const row = getRow.get(eventId) as
        | { session_id: string; is_interrupt: number; classifier_label: string | null }
        | undefined;
      if (row === undefined) continue;
      if (row.is_interrupt === want.isInterrupt && row.classifier_label === want.label) continue;
      update.run(want.isInterrupt, want.label, CLASSIFIER_VERSION, eventId);
      sessions.add(row.session_id);
      result.changed++;
    }
    for (const sessionId of sessions) recount.run(sessionId, sessionId);
    result.sessions = sessions.size;
    if (result.changed > 0) bumpEnrichmentEpoch(db);
    if (!retry) configSet(db, INTERRUPT_RELABEL_DONE, "done");
  })();
  return result;
}
