/**
 * src/ingest/session-attribution-repair.ts — one-time repair for P3.2-F6.
 *
 * Until the parser preferred `sessionId`, a conversation started by /clear was filed
 * under its launcher session (records carry `session_id` = launcher, `sessionId` = the
 * transcript's own id). This finds each launcher and the conversations folded into it,
 * deletes their ingest-derived rows and session rows and resets their files' offsets, so
 * the next scan re-ingests them with the fixed parser. A session row still referenced by
 * a manual link or work record is kept with zeroed aggregates. A group is skipped when
 * any of its stored turns is no longer in a transcript on disk (re-ingest would lose it).
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Db } from "../db/open.js";
import { awaitDbWriteGate } from "../db/write-gate.js";
import { configGet, configSet } from "../detector/calibration.js";
import { discoverFiles, sessionStemFor } from "./discovery.js";
import { bumpEnrichmentEpoch } from "./enrichment-epoch.js";
import { classifierBaselinePathHash } from "./ingestor.js";

export const SESSION_ATTRIBUTION_REPAIR_KEY = "session_attribution_repair_v1";

export interface SessionAttributionRepairResult {
  groups: number;
  repaired: number;
  skipped: number;
}

async function* records(
  filePath: string,
  wanted: (line: string) => boolean,
): AsyncGenerator<Record<string, unknown>> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of rl) {
    if (!wanted(line)) continue;
    try {
      const rec: unknown = JSON.parse(line);
      if (typeof rec === "object" && rec !== null && !Array.isArray(rec)) {
        yield rec as Record<string, unknown>;
      }
    } catch {
      // Malformed lines are the ingestor's concern (quarantine), not the repair's.
    }
  }
}

/** Path-derived owner: the stem, or the parent session of a nested subagent file. */
function pathOwner(filePath: string): string {
  const parent = path.dirname(filePath);
  return path.basename(parent) === "subagents"
    ? path.basename(path.dirname(parent))
    : sessionStemFor(filePath);
}

export async function repairSessionAttribution(
  db: Db,
  roots: string[],
): Promise<SessionAttributionRepairResult> {
  const result: SessionAttributionRepairResult = { groups: 0, repaired: 0, skipped: 0 };
  if (configGet(db, SESSION_ATTRIBUTION_REPAIR_KEY) !== null) return result;
  if (db.prepare("SELECT 1 FROM turns LIMIT 1").get() === undefined) {
    await awaitDbWriteGate();
    configSet(db, SESSION_ATTRIBUTION_REPAIR_KEY, "done");
    return result;
  }

  const files = discoverFiles(roots).map((f) => f.filePath);

  // launcher session -> sessions whose records the old parser filed under it, and the
  // sessions each file's records belong to (legacy top-level agent-*.jsonl files carry
  // their parent's sessionId, so the path alone is not enough).
  const absorbed = new Map<string, Set<string>>();
  const fileSessions = new Map<string, Set<string>>();
  for (const file of files) {
    const owners = new Set([pathOwner(file)]);
    fileSessions.set(file, owners);
    let sawSessionId = false;
    const wanted = (line: string) =>
      line.includes('"session_id":"') || (!sawSessionId && line.includes('"sessionId":"'));
    for await (const rec of records(file, wanted)) {
      const launcher = rec.session_id;
      const own = rec.sessionId;
      if (!sawSessionId && typeof own === "string" && own !== "") {
        owners.add(own);
        sawSessionId = true;
      }
      if (typeof launcher !== "string" || typeof own !== "string" || launcher === own) continue;
      if (launcher === "" || own === "") continue;
      owners.add(launcher).add(own);
      const set = absorbed.get(launcher) ?? new Set<string>();
      set.add(own);
      absorbed.set(launcher, set);
    }
  }

  const stTurnIds = db.prepare("SELECT message_id FROM turns WHERE session_id = ?");
  for (const [launcher, others] of absorbed) {
    result.groups++;
    const group = new Set([launcher, ...others]);
    const groupFiles = files.filter((f) =>
      [...(fileSessions.get(f) ?? [])].some((s) => group.has(s)),
    );

    const onDisk = new Set<string>();
    for (const file of groupFiles) {
      for await (const rec of records(file, (line) => line.includes('"usage"'))) {
        const message = rec.message as Record<string, unknown> | undefined;
        const id = typeof message?.id === "string" ? message.id : rec.uuid;
        if (typeof id === "string") onDisk.add(id);
      }
    }
    const complete = [...group].every((sessionId) =>
      (stTurnIds.all(sessionId) as { message_id: string }[]).every((t) => onDisk.has(t.message_id)),
    );
    if (!complete) {
      result.skipped++;
      continue;
    }

    await awaitDbWriteGate();
    resetGroup(db, [...group], groupFiles);
    result.repaired++;
  }

  await awaitDbWriteGate();
  configSet(db, SESSION_ATTRIBUTION_REPAIR_KEY, "done");
  return result;
}

function resetGroup(db: Db, sessionIds: string[], groupFiles: string[]): void {
  const inSessions = `(${sessionIds.map(() => "?").join(",")})`;
  db.transaction(() => {
    bumpEnrichmentEpoch(db); // rows are deleted here and re-ingested later
    const events = `SELECT event_id FROM tool_events WHERE session_id IN ${inSessions}`;
    db.prepare(`DELETE FROM tool_event_content WHERE event_id IN (${events})`).run(...sessionIds);
    db.prepare(`DELETE FROM tool_event_metadata WHERE event_id IN (${events})`).run(...sessionIds);
    db.prepare(`DELETE FROM tool_events WHERE session_id IN ${inSessions}`).run(...sessionIds);
    db.prepare(`DELETE FROM turns WHERE session_id IN ${inSessions}`).run(...sessionIds);
    db.prepare(`DELETE FROM ingest_metric_events WHERE session_id IN ${inSessions}`).run(
      ...sessionIds,
    );
    // Derived per-session rows the daemon rebuilds (churn collector, outcomes linker).
    db.prepare(`DELETE FROM session_churn WHERE session_id IN ${inSessions}`).run(...sessionIds);
    db.prepare(
      `DELETE FROM session_work_links WHERE session_id IN ${inSessions} AND method != 'MANUAL'`,
    ).run(...sessionIds);
    // Unreferenced rows are recreated by ingest exactly as a fresh scan would; rows a
    // manual link or work record still points at are kept and zeroed instead.
    db.prepare(
      `DELETE FROM sessions WHERE session_id IN ${inSessions}
         AND NOT EXISTS (SELECT 1 FROM session_work_links l WHERE l.session_id = sessions.session_id)
         AND NOT EXISTS (SELECT 1 FROM work_record_session_links l WHERE l.session_id = sessions.session_id)
         AND NOT EXISTS (SELECT 1 FROM work_session_allocations l WHERE l.session_id = sessions.session_id)`,
    ).run(...sessionIds);
    db.prepare(
      `UPDATE sessions SET first_turn_at = NULL, last_turn_at = NULL, state = 'LIVE',
              turn_count = 0, cost_equiv_u = 0, hygiene_flags = '[]', user_turn_count = 0,
              compaction_count = 0, api_error_count = 0, interrupt_count = 0,
              gap_median_s = NULL, gap_p90_s = NULL, long_gap_count = 0, gap_n = 0,
              title = NULL, title_source = NULL
        WHERE session_id IN ${inSessions}`,
    ).run(...sessionIds);
    const stFilePath = db.prepare("UPDATE sessions SET file_path = ? WHERE session_id = ?");
    // P3-U7: the same transcript tracked at another path (a copy or a rename) would
    // be carried over instead of re-read, so forget those paths too.
    const stSameHead = db.prepare(
      `SELECT o2.file_path FROM ingest_offsets o1
         JOIN ingest_offsets o2 ON o2.file_hash_head = o1.file_hash_head
        WHERE o1.file_path = ? AND o2.file_path <> o1.file_path`,
    );
    const forget = groupFiles.flatMap((file) => [
      file,
      ...(stSameHead.all(file) as { file_path: string }[]).map((r) => r.file_path),
    ]);
    for (const file of groupFiles) {
      if (path.basename(path.dirname(file)) !== "subagents") {
        stFilePath.run(file, sessionStemFor(file));
      }
    }
    for (const file of new Set(forget)) {
      db.prepare("DELETE FROM ingest_offsets WHERE file_path = ?").run(file);
      db.prepare("DELETE FROM ingest_metric_baselines WHERE file_path = ?").run(file);
      db.prepare("DELETE FROM ingest_classifier_baselines WHERE file_path_hash = ?").run(
        classifierBaselinePathHash(file),
      );
    }
  })();
}
