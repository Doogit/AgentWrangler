-- ESF2 versioned recommendation-effect cycles. Additive: legacy W4 rows remain untouched.

CREATE TABLE effect_cycles (
  cycle_id TEXT PRIMARY KEY,
  rec_id TEXT NOT NULL REFERENCES recommendations(rec_id),
  cycle_no INTEGER NOT NULL CHECK (cycle_no > 0),
  contract_version TEXT NOT NULL,
  query_definition_version TEXT NOT NULL,
  detector_id TEXT NOT NULL,
  metric_id TEXT NOT NULL,
  method_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('OPEN_SETTLING','OPEN_MEASURING','STOPPED','FINALIZED','UNSUPPORTED')),
  created_at TEXT NOT NULL,
  tracking_requested_at TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  application_source TEXT NOT NULL CHECK (application_source IN
    ('MACHINE_CONFIRMED','USER_ATTESTED')),
  action_revision TEXT,
  track_idempotency_key TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  cohort_json TEXT NOT NULL CHECK (json_valid(cohort_json)),
  target_definition_json TEXT NOT NULL CHECK (json_valid(target_definition_json)),
  guardrail_definitions_json TEXT NOT NULL CHECK (json_valid(guardrail_definitions_json)),
  baseline_from TEXT NOT NULL,
  baseline_to TEXT NOT NULL,
  observation_from TEXT NOT NULL,
  scheduled_observation_to TEXT NOT NULL,
  observation_to TEXT,
  baseline_evidence_json TEXT NOT NULL CHECK (json_valid(baseline_evidence_json)),
  provisional_evidence_json TEXT CHECK (provisional_evidence_json IS NULL OR json_valid(provisional_evidence_json)),
  final_evidence_json TEXT CHECK (final_evidence_json IS NULL OR json_valid(final_evidence_json)),
  target_direction TEXT CHECK (target_direction IS NULL OR target_direction IN
    ('IMPROVED','UNCHANGED','WORSENED','INSUFFICIENT_DATA')),
  comparison_status TEXT CHECK (comparison_status IS NULL OR comparison_status IN
    ('DESCRIPTIVE','COMPARABLE','CONFOUNDED')),
  comparison_reasons_json TEXT CHECK (comparison_reasons_json IS NULL OR json_valid(comparison_reasons_json)),
  terminal_at TEXT,
  terminal_reason TEXT,
  stop_idempotency_key TEXT,
  stop_reason TEXT,
  attribution_closed_at TEXT,
  attribution_close_reason TEXT,
  closure_idempotency_key TEXT,
  finalizer_revision TEXT,
  concurrent_change_json TEXT CHECK (concurrent_change_json IS NULL OR json_valid(concurrent_change_json)),
  rollback_status TEXT CHECK (rollback_status IS NULL OR rollback_status IN
    ('PENDING','SUCCEEDED','CONFLICT','FAILED','USER_ATTESTED','MANUAL','UNSUPPORTED')),
  rollback_at TEXT,
  rollback_attestation_source TEXT,
  UNIQUE (rec_id, cycle_no),
  UNIQUE (rec_id, track_idempotency_key)
);

CREATE UNIQUE INDEX idx_effect_cycles_one_open_rec
  ON effect_cycles(rec_id)
  WHERE state IN ('OPEN_SETTLING','OPEN_MEASURING');
CREATE INDEX idx_effect_cycles_pass
  ON effect_cycles(state, scheduled_observation_to, applied_at);
CREATE INDEX idx_effect_cycles_rec
  ON effect_cycles(rec_id, cycle_no DESC);
CREATE INDEX idx_effect_cycles_overlap
  ON effect_cycles(contract_version, query_definition_version, observation_from);

CREATE TABLE effect_guardrail_results (
  cycle_id TEXT NOT NULL REFERENCES effect_cycles(cycle_id) ON DELETE CASCADE,
  guardrail_id TEXT NOT NULL,
  method_version TEXT NOT NULL,
  availability TEXT NOT NULL CHECK (availability IN ('SUPPORTED','UNSUPPORTED')),
  unit TEXT NOT NULL,
  before_value REAL,
  after_value REAL,
  before_denominator REAL,
  after_denominator REAL,
  before_eligible_n INTEGER,
  after_eligible_n INTEGER,
  direction TEXT NOT NULL CHECK (direction IN
    ('IMPROVED','STABLE','ADVERSE','INSUFFICIENT_DATA')),
  reason_codes_json TEXT NOT NULL CHECK (json_valid(reason_codes_json)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  PRIMARY KEY (cycle_id, guardrail_id)
);

CREATE TABLE effect_rollback_operations (
  operation_id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES effect_cycles(cycle_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('PENDING','SUCCEEDED','CONFLICT','FAILED','USER_ATTESTED','MANUAL','UNSUPPORTED')),
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  inverse_kind TEXT NOT NULL,
  expected_revision TEXT,
  restoration_revision TEXT,
  failure_class TEXT,
  attestation_source TEXT,
  actual_rollback_at TEXT,
  UNIQUE (cycle_id, idempotency_key)
);
CREATE UNIQUE INDEX idx_effect_rollbacks_one_pending
  ON effect_rollback_operations(cycle_id) WHERE status = 'PENDING';

CREATE TABLE effect_mutation_keys (
  cycle_id TEXT NOT NULL REFERENCES effect_cycles(cycle_id) ON DELETE CASCADE,
  mutation_kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (cycle_id, mutation_kind, idempotency_key)
);
