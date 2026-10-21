/**
 * src/detector/rec-id.ts — deterministic rec_id, split out of engine.ts (P3.L L2).
 *
 * Claim producers (claim-ledger.ts registrants under src/detector/detectors/) need the
 * same deterministic id engine.ts stamps onto recommendations, independent of whether a
 * recommendations row currently exists for that scope. Importing it from engine.ts would
 * cycle (engine.ts -> registry.ts -> detectors/*.ts -> engine.ts), so it lives here instead;
 * engine.ts imports it too, so this is a pure relocation with no behavior change.
 */
import * as crypto from "node:crypto";

/** Deterministic rec_id: rec-<detector_id>-<scope>-<sha1(scopeKey)[:16]>. */
export function recId(
  detectorId: string,
  scopeWorkspaceId: string | null,
  scopeKey: string,
): string {
  const scope = scopeWorkspaceId ?? "global";
  const hash = crypto.createHash("sha1").update(scopeKey).digest("hex").slice(0, 16);
  return `rec-${detectorId}-${scope}-${hash}`;
}
