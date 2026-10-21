import type { Db } from "../db/open.js";
import { assertRecommendationPayloadV1 } from "./privacy-contract.js";

/** Source tuple used to correlate a D1 recommendation with inventory history. */
export interface D1SourceIdentity {
  component: string;
  fileRef: string;
}

export interface D1SourceBackedRecommendation {
  detector_id: string | null;
  target_metric: string | null;
}

/**
 * Parse a validated V1 D1 payload and derive its trusted, non-persisted file reference.
 */
export function parseD1SourceIdentity(evidenceJson: string): D1SourceIdentity | null {
  try {
    const value: unknown = JSON.parse(evidenceJson);
    assertRecommendationPayloadV1(value, "D1");
    if (value.template_id !== "D1_CONTEXT_ALWAYS_LOADED") return null;
    const component = value.facts.component;
    const fileRef =
      component === "CLAUDE_MD"
        ? "CLAUDE.md"
        : component === "MEMORY"
          ? "MEMORY.md"
          : ".claude/settings.json";
    return { component, fileRef };
  } catch {
    // Legacy or malformed evidence has no usable source identity.
  }
  return null;
}

/**
 * The `file_ref` the context probe stores for a D1 source. The probe stores an absolute path,
 * while `D1SourceIdentity.fileRef` is a bare label that is also part of persisted identity
 * digests, so the label stays and history lookups use this. The probe keeps one source per
 * workspace and component; the latest row's path wins. No history → the label.
 */
export function d1HistoryFileRef(db: Db, workspaceId: string, source: D1SourceIdentity): string {
  const row = db
    .prepare(
      `SELECT file_ref FROM context_inventory_history
        WHERE workspace_id = ? AND component = ?
        ORDER BY observed_at DESC, id DESC LIMIT 1`,
    )
    .get(workspaceId, source.component) as { file_ref: string } | undefined;
  return row?.file_ref ?? source.fileRef;
}

/** D1 recommendations, including the legacy target-metric encoding. */
export function isD1SourceBackedRecommendation(rec: D1SourceBackedRecommendation): boolean {
  return rec.detector_id === "D1" || (rec.target_metric ?? "").startsWith("CONTEXT_TOKENS:");
}
