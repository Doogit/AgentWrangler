-- migrate: foreign-keys-off
-- U15-SEC / SEC-101: make the persisted contract tuple fail closed on both
-- INSERT and UPDATE, and give non-detector RIQ effect sources a distinct exact
-- contract discriminator instead of treating free-form JSON as a recommendation.
DROP INDEX idx_recommendations_contract_status;

CREATE TABLE recommendations_contract_guarded (
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
     'MEASURED_EFFECTIVE','MEASURED_NO_EFFECT')),
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

WITH recommendation_contract_source AS (
  SELECT recommendations.*,
    (
      (contract_status = 'LEGACY_UNVERIFIED'
        AND contract_version IS NULL AND template_id IS NULL AND rule_id IS NULL)
      OR (contract_status = 'V1_VALIDATED'
        AND contract_version IS 1 AND template_id IS NOT NULL AND rule_id IS NULL)
      OR (contract_status = 'V2_VALIDATED'
        AND contract_version IS 2 AND template_id IS NULL AND rule_id IS NOT NULL)
      OR (contract_status = 'DECISION_V1_VALIDATED'
        AND contract_version IS 1 AND template_id IS 'RIQ_DECISION_V1'
        AND rule_id IS NULL AND rec_id LIKE 'riq-%')
    ) AS valid_contract_tuple
  FROM recommendations
)
INSERT INTO recommendations_contract_guarded (
  rec_id, provenance, detector_id, analysis_run_id, category, scope_workspace_id,
  lever, modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
  state, created_at, adopted_at, dismissed_until, contract_version, template_id,
  contract_status, rule_id
)
SELECT
  rec_id, provenance, detector_id, analysis_run_id, category, scope_workspace_id,
  lever, modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
  state, created_at, adopted_at, dismissed_until,
  CASE WHEN valid_contract_tuple THEN contract_version ELSE NULL END,
  CASE WHEN valid_contract_tuple THEN template_id ELSE NULL END,
  CASE WHEN valid_contract_tuple THEN contract_status ELSE 'LEGACY_UNVERIFIED' END,
  CASE WHEN valid_contract_tuple THEN rule_id ELSE NULL END
FROM recommendation_contract_source;

DROP TABLE recommendations;
ALTER TABLE recommendations_contract_guarded RENAME TO recommendations;

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
