/**
 * S1d: attribute each sidechain turn to the subagent that produced it.
 *
 * Subagent transcripts live at `<session>/subagents/agent-<id>.jsonl` and, for
 * workflow agents, `<session>/subagents/workflows/<wf>/agent-<id>.jsonl`. The
 * `<id>` equals every line's `agentId`, so the file name is the attribution.
 */
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/open.js";
import { awaitDbWriteGate } from "../db/write-gate.js";
import { bumpEnrichmentEpoch } from "./enrichment-epoch.js";

const AGENT_FILE = /^agent-(.+)\.jsonl$/;
export const AGENT_ID_BACKFILL_KEY = "turns_agent_id_backfill_v1";
const YIELD_BUDGET_MS = 12;

/** The subagent id for a transcript under a `subagents/` directory; else null. */
export function agentIdForTranscript(filePath: string): string | null {
  const match = AGENT_FILE.exec(path.basename(filePath));
  if (match?.[1] === undefined) return null;
  return path.dirname(filePath).split(/[\\/]/).includes("subagents") ? match[1] : null;
}

/**
 * One-time fill of `turns.agent_id` for sidechain rows ingested before 038. The
 * boot scan skips unchanged files, so new ingest code never revisits them.
 * Only NULL rows are touched; completion is recorded in user_config so later
 * boots return immediately. Yields to the event loop between files.
 */
export async function backfillTurnAgentIds(db: Db, filePaths: string[]): Promise<number> {
  if (
    db.prepare("SELECT 1 FROM user_config WHERE key = ?").get(AGENT_ID_BACKFILL_KEY) !== undefined
  ) {
    return 0;
  }
  const setAgentId = db.prepare(
    "UPDATE turns SET agent_id = ? WHERE message_id = ? AND is_sidechain = 1 AND agent_id IS NULL",
  );
  let updated = 0;
  let lastYieldAt = Date.now();
  // P2-U4: nothing to fill (e.g. a DB ingested entirely by post-038 code) → read no
  // file. On the X corpus the reads cost 5 s for 0 updates.
  const pending =
    db.prepare("SELECT 1 FROM turns WHERE is_sidechain = 1 AND agent_id IS NULL LIMIT 1").get() !==
    undefined;
  await awaitDbWriteGate();
  for (const filePath of pending ? filePaths : []) {
    const agentId = agentIdForTranscript(filePath);
    if (agentId === null) continue;
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue; // vanished since discovery
    }
    db.transaction(() => {
      for (const line of text.split("\n")) {
        if (!line.includes('"assistant"')) continue;
        let rec: Record<string, unknown>;
        try {
          rec = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (rec.type !== "assistant") continue;
        const message = rec.message as Record<string, unknown> | undefined;
        // Same dedupe id as parser.ts (message.id, else the record uuid).
        const messageId =
          typeof message?.id === "string"
            ? message.id
            : typeof rec.uuid === "string"
              ? rec.uuid
              : null;
        if (messageId !== null) updated += setAgentId.run(agentId, messageId).changes;
      }
    })();
    if (Date.now() - lastYieldAt >= YIELD_BUDGET_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await awaitDbWriteGate();
      lastYieldAt = Date.now();
    }
  }
  if (updated > 0) bumpEnrichmentEpoch(db);
  db.prepare("INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)").run(
    AGENT_ID_BACKFILL_KEY,
    String(updated),
    new Date().toISOString(),
  );
  return updated;
}
