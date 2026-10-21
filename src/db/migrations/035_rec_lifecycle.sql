-- migrate: foreign-keys-off
-- F5: admit RETIRED while preserving row data and the 026 contract tuple guards.
DROP INDEX idx_recommendations_contract_status;

CREATE TABLE recommendations_lifecycle (
  rec_id        TEXT PRIMARY KEY,
  provenance    TEXT NOT NULL CHECK (provenance IN ('RULE','CLAUDE_ANALYZED')),
  detector_id   TEXT,
  analysis_run_id TEXT REFERENCES analysis_runs(run_id),
  category      TEXT NOT NULL,
  scope_workspace_id TEXT,
  lever         TEXT NOT NULL,
  modeled_savings_u_per_wk INTEGER,
  modeled_formula_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  target_metric TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN
    ('PROPOSED','ADOPTED','DISMISSED','MEASURING',
     'MEASURED_EFFECTIVE','MEASURED_NO_EFFECT','RETIRED')),
  created_at TEXT NOT NULL,
  adopted_at TEXT,
  dismissed_until TEXT,
  contract_version INTEGER,
  template_id TEXT,
  contract_status TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED'
    CHECK (contract_status IN
      ('LEGACY_UNVERIFIED', 'V1_VALIDATED', 'V2_VALIDATED', 'DECISION_V1_VALIDATED')),
  rule_id TEXT
);

INSERT INTO recommendations_lifecycle (
  rec_id, provenance, detector_id, analysis_run_id, category, scope_workspace_id,
  lever, modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
  state, created_at, adopted_at, dismissed_until, contract_version, template_id,
  contract_status, rule_id
)
SELECT
  rec_id, provenance, detector_id, analysis_run_id, category, scope_workspace_id,
  lever, modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
  state, created_at, adopted_at, dismissed_until, contract_version, template_id,
  contract_status, rule_id
FROM recommendations;

DROP TABLE recommendations;
ALTER TABLE recommendations_lifecycle RENAME TO recommendations;

CREATE INDEX idx_recommendations_contract_status
  ON recommendations(contract_status, state, created_at);

CREATE TRIGGER recommendations_contract_tuple_insert
BEFORE INSERT ON recommendations
WHEN NOT (
  (NEW.contract_status = 'LEGACY_UNVERIFIED'
    AND NEW.contract_version IS NULL AND NEW.template_id IS NULL AND NEW.rule_id IS NULL)
  OR (NEW.contract_status = 'V1_VALIDATED'
    AND NEW.contract_version IS 1 AND NEW.template_id IS NOT NULL AND NEW.rule_id IS NULL)
  OR (NEW.contract_status = 'V2_VALIDATED'
    AND NEW.contract_version IS 2 AND NEW.template_id IS NULL AND NEW.rule_id IS NOT NULL)
  OR (NEW.contract_status = 'DECISION_V1_VALIDATED'
    AND NEW.contract_version IS 1 AND NEW.template_id IS 'RIQ_DECISION_V1'
    AND NEW.rule_id IS NULL AND NEW.rec_id LIKE 'riq-%')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid recommendation contract tuple');
END;

CREATE TRIGGER recommendations_contract_tuple_update
BEFORE UPDATE OF rec_id, contract_version, template_id, contract_status, rule_id ON recommendations
WHEN NOT (
  (NEW.contract_status = 'LEGACY_UNVERIFIED'
    AND NEW.contract_version IS NULL AND NEW.template_id IS NULL AND NEW.rule_id IS NULL)
  OR (NEW.contract_status = 'V1_VALIDATED'
    AND NEW.contract_version IS 1 AND NEW.template_id IS NOT NULL AND NEW.rule_id IS NULL)
  OR (NEW.contract_status = 'V2_VALIDATED'
    AND NEW.contract_version IS 2 AND NEW.template_id IS NULL AND NEW.rule_id IS NOT NULL)
  OR (NEW.contract_status = 'DECISION_V1_VALIDATED'
    AND NEW.contract_version IS 1 AND NEW.template_id IS 'RIQ_DECISION_V1'
    AND NEW.rule_id IS NULL AND NEW.rec_id LIKE 'riq-%')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid recommendation contract tuple');
END;
