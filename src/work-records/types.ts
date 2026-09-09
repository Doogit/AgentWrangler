export const TASK_INTENTS = [
  "IMPLEMENT",
  "DEBUG",
  "REVIEW",
  "RESEARCH_PLAN",
  "OTHER",
  "UNKNOWN",
] as const;
export const OUTCOME_STATES = [
  "ACTIVE",
  "USEFUL",
  "PARTIAL",
  "UNSUCCESSFUL",
  "ABANDONED",
  "UNKNOWN",
] as const;
export const REPAIR_BANDS = ["NONE", "MINOR", "MAJOR", "UNREPORTED", "UNKNOWN"] as const;
export const EFFORT_BANDS = ["LOW", "MEDIUM", "HIGH", "UNREPORTED", "UNKNOWN"] as const;
export const FEEDBACK_SOURCES = ["USER_CLOSEOUT", "USER_EDIT", "NONE"] as const;

export type TaskIntent = (typeof TASK_INTENTS)[number];
export type OutcomeState = (typeof OUTCOME_STATES)[number];
export type RepairBand = (typeof REPAIR_BANDS)[number];
export type EffortBand = (typeof EFFORT_BANDS)[number];
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number];

export type OpaqueIdKind =
  | "WORK_RECORD"
  | "MUTATION"
  | "EXTERNAL_REF"
  | "CONTEXT_REF"
  | "ALLOCATION_REVISION";

export interface IssuedOpaqueId {
  id: string;
  expires_at: string;
}

export interface WorkRevision {
  revision_no: number;
  task_intent: TaskIntent;
  outcome_state: OutcomeState;
  repair_band: RepairBand;
  effort_band: EffortBand;
  feedback_source: FeedbackSource;
  reported_at: string | null;
  recorded_at: string;
  mutation_id: string;
}

export interface WorkSessionLink {
  session_id: string;
  linked_revision_no: number;
  linked_at: string;
  unlinked_revision_no: number | null;
  unlinked_at: string | null;
}

export interface WorkContextRef {
  context_kind: "WORKTREE";
  context_ref_id: string;
  linked_revision_no: number;
  linked_at: string;
  unlinked_revision_no: number | null;
  unlinked_at: string | null;
}

export interface WorkRecordView {
  work_record_id: string;
  workspace_id: string;
  created_at: string;
  updated_at: string;
  current_revision_no: number;
  archived_at: string | null;
  external_ref_id: string | null;
  external_ref_kind: "ISSUE" | "PULL_REQUEST" | "TASK" | "OTHER" | null;
  current: WorkRevision;
  session_links: WorkSessionLink[];
  context_refs: WorkContextRef[];
}

export interface MutationResult {
  record: WorkRecordView;
  replayed: boolean;
}

export interface DeleteResult {
  work_record_id: string;
  deleted_at: string;
  delete_mutation_id: string;
  replayed: boolean;
}

export type AllocationDisposition =
  | "OWNED"
  | "UNALLOCATED_UNGROUPED"
  | "UNALLOCATED_SHARED"
  | "UNALLOCATED_AMBIGUOUS"
  | "UNALLOCATED_UNSUPPORTED";

export interface EsfAllocationSessionInput {
  session_id: string;
  priced_cost_u: number;
  priced_turn_count: number;
  unpriced_turn_count: number;
  cost_claim_counts: Array<{ value: string; count: number }>;
  parser_version_counts: Array<{ value: string; count: number }>;
}

export interface EsfObservationInput {
  cohort_definition_version: string;
  allocation_sessions: EsfAllocationSessionInput[];
  watermark: unknown;
}

export type ObservationProvider = (opts: {
  workspaceId: string;
  from: string;
  to: string;
}) => EsfObservationInput;

export interface AllocationSummary {
  allocation_revision_id: string;
  workspace_id: string;
  cohort_from: string;
  cohort_to: string;
  evidence_as_of: string;
  report_status: "COMPLETE" | "PARTIAL" | "SOURCE_DELETED";
  eligible_session_count: number;
  allocated_session_count: number;
  unallocated_ungrouped_count: number;
  unallocated_shared_count: number;
  eligible_priced_cost_u: number;
  allocated_priced_cost_u: number;
  unallocated_priced_cost_u: number;
  priced_turn_count: number;
  unpriced_turn_count: number;
  unpriced_session_count: number;
  records_total: number;
  records_with_feedback: number;
  reported_terminal_records: number;
  outcome_counts: Record<OutcomeState | "UNREPORTED", number>;
  archived_count: number;
  source_deleted_count: number;
  useful_work_rate: { numerator: number; denominator: number; value: number | null };
  feedback_coverage: { numerator: number; denominator: number; value: number | null };
  allocation_session_coverage: { numerator: number; denominator: number; value: number | null };
  allocation_cost_coverage: { numerator_u: number; denominator_u: number; value: number | null };
  terminal_attempt_priced_cost_u: number;
  cost_per_useful_u: number | null;
  cost_per_useful_unavailable_reason: "NO_USEFUL_RECORDS" | "INCOMPLETE_COST_COVERAGE" | null;
  sessions: Array<{
    session_id: string;
    owner_snapshot_id: string | "DELETED_RECORD" | null;
    disposition: AllocationDisposition;
    priced_cost_u: number;
    priced_turn_count: number;
    unpriced_turn_count: number;
  }>;
}

export class WorkRecordError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 410 | 422,
    public readonly code:
      | "INVALID_REQUEST"
      | "NOT_FOUND"
      | "REVISION_CONFLICT"
      | "IDEMPOTENCY_CONFLICT"
      | "MEMBERSHIP_CONFLICT"
      | "SOURCE_DELETED"
      | "WORKSPACE_MISMATCH"
      | "INSUFFICIENT_EVIDENCE"
      | "UNSUPPORTED_VERSION"
      | "STALE_SOURCE",
    message: string,
  ) {
    super(message);
    this.name = "WorkRecordError";
  }
}
