-- migrate: foreign-keys-off
-- U11 / SEC-101: admit validated V2 finding envelopes without rewriting V1
-- payloads or releasing quarantined legacy rows. SQLite cannot alter the CHECK
-- introduced by migration 023, so rebuild the table with the same columns plus
-- a rule_id discriminator and the additive V2 status.
DROP INDEX idx_recommendations_contract_status;

CREATE TABLE recommendations_v2 (
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
    CHECK (contract_status IN ('LEGACY_UNVERIFIED', 'V1_VALIDATED', 'V2_VALIDATED')),
  rule_id TEXT
);

INSERT INTO recommendations_v2 (
  rec_id, provenance, detector_id, analysis_run_id, category, scope_workspace_id,
  lever, modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
  state, created_at, adopted_at, dismissed_until, contract_version, template_id,
  contract_status, rule_id
)
SELECT
  rec_id, provenance, detector_id, analysis_run_id, category, scope_workspace_id,
  lever, modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
  state, created_at, adopted_at, dismissed_until, contract_version, template_id,
  contract_status, NULL
FROM recommendations;

DROP TABLE recommendations;
ALTER TABLE recommendations_v2 RENAME TO recommendations;

CREATE INDEX idx_recommendations_contract_status
  ON recommendations(contract_status, state, created_at);
