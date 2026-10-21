/**
 * RIQ5 family → validated ESF-method registry.
 *
 * Maps a served decision FAMILY to the ESF effect-handler that measures its
 * projected effect. A family appears here ONLY when a synthetic test proves the
 * handler's cycle actually measures that family's effect (spec §RIQ5: "do not
 * silently inherit a D1/D2/D4/D8 handler"). Unmapped families are MANUAL by
 * design — the track flow records a completed-change attestation with no cycle.
 *
 * D1 is never a target here: its handler requires a resolvable source tuple
 * (component + fileRef) that a decision — keyed on family + opaque evidence ids —
 * does not carry, so a D1 mapping can never be TRACKABLE.
 *
 * SEC-101: value types only — no raw content.
 */

import type { FamilyId } from "./opportunity-composer-types.js";

export const FAMILY_METHOD_REGISTRY_VERSION = "riq5-family-method-1" as const;

export interface FamilyMethod {
  /** Non-D1 detector whose handler needs only detector_id + target_metric + workspace. */
  detectorId: "D2" | "D4" | "D7" | "D8";
  /** A registry metricId or alias so findHandler(detectorId, targetMetric) resolves. */
  targetMetric: string;
  /** Display bucket for the synthesized recommendation row (recommendations.category). */
  category: string;
}

/**
 * The validated family → method mappings. CONTEXT_CACHE_BEHAVIOR → D8 cache-ratio
 * is the single validated mapping (see decision-track.test.ts D8 validation): the
 * D8 handler measures sum(cache reads)/sum(cache creation), the same phenomenon
 * the CONTEXT_CACHE_BEHAVIOR family projects. The other two families have no
 * validated method and stay MANUAL.
 */
export const FAMILY_METHOD_REGISTRY: Partial<Record<FamilyId, FamilyMethod>> = {
  CONTEXT_CACHE_BEHAVIOR: { detectorId: "D8", targetMetric: "d8-cache-ratio", category: "CACHE" },
};

/** The validated method for a family, or null when the family is manual-only. */
export function methodForFamily(family: FamilyId): FamilyMethod | null {
  return FAMILY_METHOD_REGISTRY[family] ?? null;
}
