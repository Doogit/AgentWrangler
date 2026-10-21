import type { ComparisonStatus, CycleState, TargetDirection } from "../../effects/types.js";
import type {
  Exclusion,
  LinkedObservation,
  MaterialityBand,
  RankingGoal,
  Warning,
  WhyReason,
} from "./decision-ranker-types.js";
import type { FamilyId, NextStep } from "./opportunity-composer-types.js";

/** RIQ5: whether a decision can open a measured cycle or only manual tracking. */
export interface DecisionTrackCapabilityView {
  mode: "TRACKABLE" | "MANUAL";
  reason: "NO_VALIDATED_METHOD" | "HANDLER_UNAVAILABLE" | "WRITER_DISABLED" | null;
}

/** RIQ5: lean summary of a decision's latest effect cycle. Structural fields only (SEC-101). */
export interface DecisionEffectCycle {
  /** Opaque cycle id — lets the UI stop/rollback via the existing cycle-keyed routes. */
  cycle_id: string;
  state: CycleState;
  target_direction: TargetDirection | null;
  comparison_status: ComparisonStatus | null;
  applied_at: string;
  scheduled_observation_to: string;
}

export interface DecisionView {
  rank: number;
  decision_identity: string;
  family: FamilyId;
  next_step: NextStep;
  why_ranked: WhyReason[];
  required_caveats: string[];
  alternative_explanations: string[];
  linked_observations: LinkedObservation[];
  materiality_band: MaterialityBand;
  cause_effect: {
    cause: string;
    effect: string;
  };
  projected_effect: {
    basis: "MEASURED" | "MODELED";
    expression: "DIRECTION" | "QUALITATIVE_BAND";
    label: string;
  };
  /** RIQ5: can this decision open a measured cycle, or only manual tracking? */
  track_capability: DecisionTrackCapabilityView;
  /** RIQ5: latest effect cycle for this decision, or null when never tracked. */
  effect_cycle: DecisionEffectCycle | null;
}

export interface DecisionViewResult {
  next_decisions: DecisionView[];
  rank_warnings: Warning[];
  overflow_count: number;
  excluded: Exclusion[];
  ranking_goal: RankingGoal;
  packet_identity_hash: string;
}
