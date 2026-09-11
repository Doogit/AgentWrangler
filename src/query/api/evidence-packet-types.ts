/** Safe, versioned aggregate contract for RIQ1 evidence packets. */

export const EVIDENCE_PACKET_VERSION = "riq1-1" as const;
export const EVIDENCE_QUERY_DEFINITION_VERSION = "riq1-query-1" as const;

export type ToolClass =
  | "FILE_READ"
  | "FILE_WRITE"
  | "SEARCH"
  | "SHELL"
  | "WEB"
  | "CUSTOM_TOOL"
  | "UNKNOWN";

export type UnavailableReason = "NO_ELIGIBLE_DATA" | "NOT_REPORTED" | "UNSUPPORTED";

export interface UnavailableFact {
  state: "UNAVAILABLE" | "UNKNOWN";
  reason: UnavailableReason;
  method: string;
}

export interface MeasuredFact<T> {
  value: T;
  unit: string;
  denominator: number;
  method: string;
  provenance: string[];
  evidence_ids: string[];
}

export type EvidenceFact<T> = MeasuredFact<T> | UnavailableFact;

export interface EvidencePacketScope {
  workspaceId: string | null;
  from: string;
  to: string;
  toolClass?: ToolClass;
  evidenceAsOf?: string;
  sourceRevision?: string;
  /** The release time of the method used to read this packet. */
  methodRevisionAt?: string;
  prior?: {
    workspaceId: string | null;
    from: string;
    to: string;
    toolClass?: ToolClass;
  };
}

export interface EvidencePacket {
  packet_version: typeof EVIDENCE_PACKET_VERSION;
  query_definition_version: typeof EVIDENCE_QUERY_DEFINITION_VERSION;
  packet_identity_hash: string;
  evidence_as_of: string;
  source_revision: string;
  scope: {
    workspace_id: string | null;
    tool_class: ToolClass | null;
    current_window: { from: string; to: string };
    prior_window: { from: string; to: string } | null;
    maturity_filters: { session_state: "RECONCILED"; provisional_turns_excluded: true };
  };
  freshness: { status: "CURRENT" | "EXPIRED"; reason: string | null };
  coverage: {
    eligible_session_count: number;
    excluded_live_session_count: number;
    unpriced_turn_count: number;
    exclusions: string[];
  };
  facts: {
    current_list_price_equivalent_u: EvidenceFact<number>;
    prior_list_price_equivalent_u: EvidenceFact<number>;
    comparison: EvidenceFact<{ delta: number; direction: "INCREASE" | "DECREASE" | "UNCHANGED" }>;
    raw_token_buckets: EvidenceFact<Record<string, number>>;
    session_cost_distribution_u: EvidenceFact<{ min: number; median: number; max: number }>;
    model_mix: EvidenceFact<Array<{ model_id: string; turn_count: number }>>;
    task_mix: EvidenceFact<never>;
    modeled_cap_headroom: EvidenceFact<never>;
    tool_observations: EvidenceFact<
      Array<{ tool_id: string; tool_class: ToolClass; event_count: number }>
    >;
    target_observations: EvidenceFact<never>;
    guardrail_observations: EvidenceFact<never>;
  };
  related_actions: { active_rec_ids: string[]; completed_rec_ids: string[] };
  overlap_groups: Array<{ evidence_id: string; fact_keys: string[]; session_count: number }>;
}
