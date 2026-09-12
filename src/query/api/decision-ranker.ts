/**
 * RIQ3 decision ranker — pure function, ranking-policy-1.
 * No DB handle, no SQL, no provider calls, no persisted state, no Date.now().
 * SEC-101: enum labels, ids, counts only — no raw content derived from transcripts.
 */

import {
  type CooldownInput,
  type Exclusion,
  type LinkedObservation,
  type MaterialityBand,
  RANKING_POLICY_VERSION,
  type RankedDecision,
  type RankingGoal,
  type RankingOptions,
  type RankingResult,
  type Warning,
  type WhyReason,
} from "./decision-ranker-types.js";
import type {
  FamilyEntry,
  FamilyId,
  OpportunityComposition,
  OpportunityEntry,
} from "./opportunity-composer-types.js";

// ---------------------------------------------------------------------------
// Decision identity (§2)
// ---------------------------------------------------------------------------

/** Stable, deterministic decision identity from family + sorted evidence ids. */
function deriveIdentity(family: FamilyId, evidenceIds: readonly string[]): string {
  return `${family}:${[...evidenceIds].sort().join(",")}`;
}

// ---------------------------------------------------------------------------
// Class derivation helpers
// ---------------------------------------------------------------------------

type EvidenceClass = "COMPARABLE_MEASURED" | "MEASURED_SINGLE_WINDOW" | "PARTIAL";
type GoalRelevance = "PRIMARY" | "SECONDARY" | "NEUTRAL";
type GuardrailClass = "SAFE" | "CONFLICTED";
type EffortClass = "INVESTIGATION" | "MEASURED_TRIAL";

/** Class 2 — evidence/comparability class (§6). */
function evidenceClass(entry: OpportunityEntry): EvidenceClass {
  if (entry.detail.kind === "USAGE_CHANGE") return "COMPARABLE_MEASURED";
  if (entry.detail.kind === "TOOL_CONCENTRATION") return "MEASURED_SINGLE_WINDOW";
  // CACHE_BEHAVIOR: PARTIAL if ratio null or cause unknown
  const d = entry.detail;
  if (d.cache_hit_ratio === null || d.miss_cause === "UNKNOWN") return "PARTIAL";
  return "MEASURED_SINGLE_WINDOW";
}

/** Class 3 — goal relevance (§7, frozen family × goal map). */
const GOAL_MAP: Record<FamilyId, Record<RankingGoal, GoalRelevance>> = {
  EXPLAIN_USAGE_CHANGE: {
    PRESERVE_QUALITY: "SECONDARY",
    REDUCE_RESOURCE_USE: "PRIMARY",
    INVESTIGATE_FRICTION: "NEUTRAL",
  },
  TOOL_OUTPUT_RETRY_CONCENTRATION: {
    PRESERVE_QUALITY: "PRIMARY",
    REDUCE_RESOURCE_USE: "SECONDARY",
    INVESTIGATE_FRICTION: "PRIMARY",
  },
  CONTEXT_CACHE_BEHAVIOR: {
    PRESERVE_QUALITY: "NEUTRAL",
    REDUCE_RESOURCE_USE: "PRIMARY",
    INVESTIGATE_FRICTION: "SECONDARY",
  },
};

/** Class 4 — materiality band (§8). */
function materialityBand(entry: OpportunityEntry): MaterialityBand {
  if (entry.detail.kind === "USAGE_CHANGE") {
    const d = entry.detail.decomposition;
    const baseline = d.mean_prior_u * d.n_prior;
    if (baseline === 0) return "SMALL";
    const ratio = Math.abs(d.observed_delta_u) / baseline;
    if (ratio >= 0.5) return "LARGE";
    if (ratio >= 0.2) return "MODERATE";
    return "SMALL";
  }
  if (entry.detail.kind === "TOOL_CONCENTRATION") {
    const top = entry.detail.candidates.reduce((best, c) =>
      c.byte_share > best.byte_share ? c : best,
    );
    const share = top.byte_share;
    if (share >= 0.5) return "LARGE";
    if (share >= 0.25) return "MODERATE";
    return "SMALL";
  }
  // CACHE_BEHAVIOR
  const ratio = entry.detail.cache_hit_ratio;
  if (ratio === null) return "UNKNOWN";
  if (ratio < 0.25) return "LARGE";
  if (ratio < 0.5) return "MODERATE";
  return "SMALL";
}

/** Unit group for class 4 comparability gating (§8). */
function unitGroup(entry: OpportunityEntry): string {
  if (entry.detail.kind === "USAGE_CHANGE") return "MICRO_USD_DELTA";
  if (entry.detail.kind === "TOOL_CONCENTRATION") return "BYTE_SHARE";
  return "CACHE_RATIO";
}

/** Class 4 recurrence — BYTE_SHARE only; top candidate failure_event_count ≥ 3 (§8). */
function isRecurring(entry: OpportunityEntry): boolean {
  if (entry.detail.kind !== "TOOL_CONCENTRATION") return false;
  const top = entry.detail.candidates.reduce((best, c) =>
    c.byte_share > best.byte_share ? c : best,
  );
  return top.failure_event_count >= 3;
}

// ---------------------------------------------------------------------------
// Internal candidate representation
// ---------------------------------------------------------------------------

interface Candidate {
  entry: OpportunityEntry;
  identity: string;
  evClass: EvidenceClass;
  goalRel: GoalRelevance;
  matBand: MaterialityBand;
  uGroup: string;
  recurring: boolean;
  effort: EffortClass;
  guardrail: GuardrailClass;
  resurfaced: boolean;
  tiebreak: boolean; // set after sort
  linked: LinkedObservation[];
}

function buildCandidate(
  entry: OpportunityEntry,
  goal: RankingGoal,
  activeConflicts: ReadonlySet<string>,
): Candidate {
  const identity = deriveIdentity(entry.family, entry.evidence_ids);
  return {
    entry,
    identity,
    evClass: evidenceClass(entry),
    goalRel: GOAL_MAP[entry.family][goal],
    matBand: materialityBand(entry),
    uGroup: unitGroup(entry),
    recurring: isRecurring(entry),
    effort: entry.next_step.kind === "INVESTIGATION" ? "INVESTIGATION" : "MEASURED_TRIAL",
    guardrail: activeConflicts.has(identity) ? "CONFLICTED" : "SAFE",
    resurfaced: false,
    tiebreak: false,
    linked: [],
  };
}

// ---------------------------------------------------------------------------
// Lexicographic comparator (§4) — returns { order, decidingClass }
// ---------------------------------------------------------------------------

const BAND_ORDER: MaterialityBand[] = ["LARGE", "MODERATE", "SMALL", "UNKNOWN"];

function compareFullOrder(a: Candidate, b: Candidate): { order: number; decidingClass: number } {
  // Class 1 — guardrail
  const g = (a.guardrail === "SAFE" ? 0 : 1) - (b.guardrail === "SAFE" ? 0 : 1);
  if (g !== 0) return { order: g, decidingClass: 1 };

  // Class 2 — evidence
  const evOrder = ["COMPARABLE_MEASURED", "MEASURED_SINGLE_WINDOW", "PARTIAL"] as const;
  const e = evOrder.indexOf(a.evClass) - evOrder.indexOf(b.evClass);
  if (e !== 0) return { order: e, decidingClass: 2 };

  // Class 3 — goal relevance
  const gOrder = ["PRIMARY", "SECONDARY", "NEUTRAL"] as const;
  const r = gOrder.indexOf(a.goalRel) - gOrder.indexOf(b.goalRel);
  if (r !== 0) return { order: r, decidingClass: 3 };

  // Class 4 — materiality + recurrence (same unit group only)
  if (a.uGroup === b.uGroup) {
    const m = BAND_ORDER.indexOf(a.matBand) - BAND_ORDER.indexOf(b.matBand);
    if (m !== 0) return { order: m, decidingClass: 4 };
    // Same band: recurrence (BYTE_SHARE only)
    if (a.uGroup === "BYTE_SHARE") {
      const rec = (a.recurring ? 0 : 1) - (b.recurring ? 0 : 1);
      if (rec !== 0) return { order: rec, decidingClass: 4 };
    }
  }
  // Different unit groups → class 4 tie

  // Class 5 — effort
  const efOrder = ["INVESTIGATION", "MEASURED_TRIAL"] as const;
  const ef = efOrder.indexOf(a.effort) - efOrder.indexOf(b.effort);
  if (ef !== 0) return { order: ef, decidingClass: 5 };

  // Class 6 — stable identity (code-point order)
  if (a.identity < b.identity) return { order: -1, decidingClass: 6 };
  if (a.identity > b.identity) return { order: 1, decidingClass: 6 };
  return { order: 0, decidingClass: 6 };
}

// ---------------------------------------------------------------------------
// Overlap sweep (§10)
// ---------------------------------------------------------------------------

function setsIntersect(as: readonly string[], bs: readonly string[]): boolean {
  const setA = new Set(as);
  return bs.some((id) => setA.has(id));
}

/**
 * Deterministic overlap sweep. Mutates linked[] on primaries; returns the flat
 * list of surviving primaries (each carries its linked observations).
 */
function overlapSweep(candidates: Candidate[]): Candidate[] {
  const pool = [...candidates];
  const primaries: Candidate[] = [];

  while (pool.length > 0) {
    // Find candidates with at least one overlap partner in the current pool
    const withPartner = pool.filter((c) =>
      pool.some(
        (other) => other !== c && setsIntersect(c.entry.evidence_ids, other.entry.evidence_ids),
      ),
    );

    if (withPartner.length === 0) {
      // All remaining are standalone — add as primaries
      primaries.push(...pool);
      break;
    }

    // Pick §4-best among candidates that have overlap partners
    const overlapSorted = [...withPartner].sort((a, b) => compareFullOrder(a, b).order);
    // withPartner.length > 0 guaranteed by the guard above
    const primary = overlapSorted[0] as Candidate;

    // Direct intersections with the primary's own evidence become linked
    const primaryEvidSet = new Set(primary.entry.evidence_ids);
    const toRemove = new Set<Candidate>([primary]);

    for (const c of pool) {
      if (c === primary) continue;
      if (c.entry.evidence_ids.some((id) => primaryEvidSet.has(id))) {
        primary.linked.push({ family: c.entry.family, evidence_ids: [...c.entry.evidence_ids] });
        toRemove.add(c);
      }
    }

    primaries.push(primary);
    pool.splice(0, pool.length, ...pool.filter((c) => !toRemove.has(c)));
  }

  return primaries;
}

// ---------------------------------------------------------------------------
// Cooldown / re-surface gate (§9, §3)
// ---------------------------------------------------------------------------

const BAND_RANK: Record<MaterialityBand, number> = {
  SMALL: 1,
  MODERATE: 2,
  LARGE: 3,
  UNKNOWN: 0, // UNKNOWN is never "higher than anything"
};

/**
 * Apply cooldowns to primaries after the overlap sweep.
 * Returns { eligible, cooldownExcluded }.
 */
function applyCooldowns(
  primaries: Candidate[],
  cooldowns: readonly CooldownInput[],
  asOfIso: string,
): { eligible: Candidate[]; cooldownExcluded: Exclusion[] } {
  const cooldownMap = new Map<string, CooldownInput>();
  for (const cd of cooldowns) cooldownMap.set(cd.decision_identity, cd);

  const eligible: Candidate[] = [];
  const cooldownExcluded: Exclusion[] = [];

  for (const c of primaries) {
    const cd = cooldownMap.get(c.identity);
    if (cd === undefined || cd.until_iso <= asOfIso) {
      // No active cooldown — admit
      eligible.push(c);
      continue;
    }
    // Active cooldown: check re-surface condition (§9)
    const currentRank = BAND_RANK[c.matBand];
    const dismissedRank = BAND_RANK[cd.dismissed_materiality_band];
    if (currentRank > dismissedRank) {
      // Strictly higher band → re-surface
      c.resurfaced = true;
      eligible.push(c);
    } else {
      cooldownExcluded.push({ subject: c.identity, reason: "COOLDOWN_ACTIVE" });
    }
  }

  return { eligible, cooldownExcluded };
}

// ---------------------------------------------------------------------------
// why_ranked builder (§12) — exhaustive, class order
// ---------------------------------------------------------------------------

function buildWhyRanked(c: Candidate): WhyReason[] {
  const reasons: WhyReason[] = [];

  // Class 1 — guardrail
  reasons.push(c.guardrail === "SAFE" ? "GUARDRAIL_SAFE" : "GUARDRAIL_CONFLICTED");

  // Class 2 — evidence
  const evMap: Record<EvidenceClass, WhyReason> = {
    COMPARABLE_MEASURED: "EVIDENCE_COMPARABLE_MEASURED",
    MEASURED_SINGLE_WINDOW: "EVIDENCE_MEASURED_SINGLE_WINDOW",
    PARTIAL: "EVIDENCE_PARTIAL",
  };
  reasons.push(evMap[c.evClass]);

  // Class 3 — goal relevance
  const goalMap: Record<GoalRelevance, WhyReason> = {
    PRIMARY: "GOAL_PRIMARY",
    SECONDARY: "GOAL_SECONDARY",
    NEUTRAL: "GOAL_NEUTRAL",
  };
  reasons.push(goalMap[c.goalRel]);

  // Class 4 — materiality band
  const matMap: Record<MaterialityBand, WhyReason> = {
    LARGE: "MATERIALITY_LARGE",
    MODERATE: "MATERIALITY_MODERATE",
    SMALL: "MATERIALITY_SMALL",
    UNKNOWN: "MATERIALITY_UNKNOWN",
  };
  reasons.push(matMap[c.matBand]);

  // Recurrence (class 4 sub-criterion — emitted immediately after materiality)
  if (c.recurring) reasons.push("RECURRING_FAILURES");

  // Class 5 — effort
  reasons.push(c.effort === "INVESTIGATION" ? "EFFORT_INVESTIGATION" : "EFFORT_MEASURED_TRIAL");

  // Conditional — class 6 tiebreak (set by sort pass)
  if (c.tiebreak) reasons.push("TIEBREAK_STABLE_IDENTITY");

  // Conditional — re-surface (§9)
  if (c.resurfaced) reasons.push("RESURFACED_MATERIAL_CHANGE");

  return reasons;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rank an RIQ2 OpportunityComposition according to ranking-policy-1.
 * Pure function: identical inputs → deep-equal output. No Date.now(), no randomness.
 */
export function rankDecisions(
  composition: OpportunityComposition,
  options: RankingOptions,
): RankingResult {
  const { goal, freshness, cooldowns, active_conflicts, as_of_iso } = options;
  const activeConflictsSet = new Set(active_conflicts);

  const warnings: Warning[] = [];
  const excluded: Exclusion[] = [];

  // --- Step 1: Candidacy split + freshness gate + structural validity ---

  const opportunityCandidates: Candidate[] = [];

  for (const entry of composition.families) {
    if (entry.outcome === "HEALTHY") {
      excluded.push({ subject: entry.family, reason: "HEALTHY" });
      continue;
    }
    if (entry.outcome === "NO_CHANGE") {
      excluded.push({ subject: entry.family, reason: "NO_CHANGE" });
      continue;
    }
    if (entry.outcome === "INSUFFICIENT_EVIDENCE") {
      warnings.push({ code: "MISSING_EVIDENCE", detail: entry.unavailable_reason });
      continue;
    }
    // OPPORTUNITY entry
    const identity = deriveIdentity(entry.family, entry.evidence_ids);

    // Freshness gate
    if (freshness.status === "EXPIRED") {
      excluded.push({ subject: identity, reason: "PACKET_EXPIRED" });
      continue;
    }

    // Structural validity
    if (entry.evidence_ids.length === 0 || entry.required_caveats.length === 0) {
      excluded.push({ subject: identity, reason: "MALFORMED_CANDIDATE" });
      continue;
    }

    opportunityCandidates.push(buildCandidate(entry, goal, activeConflictsSet));
  }

  // One PACKET_EXPIRED warning when freshness is EXPIRED
  if (freshness.status === "EXPIRED") {
    warnings.push({ code: "PACKET_EXPIRED" });
    return {
      ranking_policy_version: RANKING_POLICY_VERSION,
      goal,
      packet_identity_hash: composition.packet_identity_hash,
      next_decisions: [],
      overflow_count: 0,
      warnings,
      excluded,
    };
  }

  if (opportunityCandidates.length === 0) {
    return {
      ranking_policy_version: RANKING_POLICY_VERSION,
      goal,
      packet_identity_hash: composition.packet_identity_hash,
      next_decisions: [],
      overflow_count: 0,
      warnings,
      excluded,
    };
  }

  // --- Step 2: Overlap sweep (§10) — before cooldown/conflict gate ---
  const primaries = overlapSweep(opportunityCandidates);

  // --- Step 3: Cooldown / re-surface gate on surviving primaries ---
  const { eligible, cooldownExcluded } = applyCooldowns(primaries, cooldowns, as_of_iso);
  excluded.push(...cooldownExcluded);

  if (eligible.length === 0) {
    return {
      ranking_policy_version: RANKING_POLICY_VERSION,
      goal,
      packet_identity_hash: composition.packet_identity_hash,
      next_decisions: [],
      overflow_count: 0,
      warnings,
      excluded,
    };
  }

  // --- Step 4: Lexicographic sort ---
  const sorted = [...eligible].sort((a, b) => compareFullOrder(a, b).order);

  // Detect class 6 tiebreaks: mark candidates where any pair is decided by class 6
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const ci = sorted[i] as Candidate;
      const cj = sorted[j] as Candidate;
      if (compareFullOrder(ci, cj).decidingClass === 6) {
        ci.tiebreak = true;
        cj.tiebreak = true;
      }
    }
  }

  // --- Step 5: Slot budget (§11) ---
  const slotted = sorted.slice(0, 3);
  const overflowCount = Math.max(0, sorted.length - 3);

  const nextDecisions: RankedDecision[] = slotted.map((c, idx) => ({
    rank: idx + 1,
    decision_identity: c.identity,
    family: c.entry.family,
    why_ranked: buildWhyRanked(c),
    linked_observations: c.linked,
    required_caveats: [...c.entry.required_caveats],
    alternative_explanations: [...c.entry.alternative_explanations],
    next_step: { ...c.entry.next_step },
  }));

  return {
    ranking_policy_version: RANKING_POLICY_VERSION,
    goal,
    packet_identity_hash: composition.packet_identity_hash,
    next_decisions: nextDecisions,
    overflow_count: overflowCount,
    warnings,
    excluded,
  };
}
