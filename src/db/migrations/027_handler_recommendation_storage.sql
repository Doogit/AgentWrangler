-- HRE-1 additive linked-record storage. The legacy recommendations and
-- effect_cycles tables remain authoritative for old readers until cutover.

CREATE TABLE hre_capability_profiles (
  profile_id TEXT PRIMARY KEY,
  profile_version TEXT NOT NULL,
  claude_code_version TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('WINDOWS','MACOS','LINUX','UNKNOWN')),
  workspace_scope_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE TABLE hre_capability_observations (
  profile_id TEXT NOT NULL REFERENCES hre_capability_profiles(profile_id) ON DELETE CASCADE,
  capability_code TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('SUPPORTED','UNSUPPORTED','UNKNOWN','CONTRADICTED')),
  source TEXT NOT NULL CHECK (source IN ('LOCAL_CANARY','VERSION_GATE','SETTING','RESEARCH_ONLY')),
  canary_version TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, capability_code, source),
  CHECK (source <> 'LOCAL_CANARY' OR canary_version IS NOT NULL)
);

CREATE TABLE hre_handler_history (
  handler_family TEXT NOT NULL,
  handler_version TEXT NOT NULL,
  registry_version TEXT NOT NULL,
  snapshot_schema_version INTEGER NOT NULL CHECK (snapshot_schema_version = 1),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  retired_at TEXT,
  PRIMARY KEY (handler_family, handler_version, registry_version)
);

CREATE TABLE hre_handler_retirements (
  handler_family TEXT NOT NULL,
  handler_version TEXT NOT NULL,
  registry_version TEXT NOT NULL,
  retired_at TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  PRIMARY KEY (handler_family, handler_version, registry_version),
  FOREIGN KEY (handler_family, handler_version, registry_version)
    REFERENCES hre_handler_history(handler_family, handler_version, registry_version)
    ON DELETE CASCADE
);

CREATE TABLE hre_composition_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  composition_version INTEGER NOT NULL CHECK (composition_version > 0),
  registry_version TEXT NOT NULL,
  ranking_policy_version TEXT NOT NULL,
  price_version TEXT NOT NULL,
  capability_profile_id TEXT REFERENCES hre_capability_profiles(profile_id),
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','PUBLISHED')),
  UNIQUE (snapshot_id, composition_version),
  CHECK (window_to > window_from)
);

CREATE TABLE hre_findings (
  finding_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('LEGACY','NATIVE')),
  legacy_rec_id TEXT UNIQUE REFERENCES recommendations(rec_id) ON DELETE CASCADE,
  detector_id TEXT NOT NULL,
  detector_contract_version INTEGER NOT NULL CHECK (detector_contract_version > 0),
  scope_hash TEXT,
  window_from TEXT,
  window_to TEXT,
  finding_count INTEGER CHECK (finding_count IS NULL OR finding_count > 0),
  affected_sessions INTEGER CHECK (affected_sessions IS NULL OR affected_sessions >= 0),
  exclusive_ceu REAL CHECK (exclusive_ceu IS NULL OR exclusive_ceu >= 0),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  safe_anchors_json TEXT CHECK (safe_anchors_json IS NULL OR (json_valid(safe_anchors_json) AND json_type(safe_anchors_json) = 'array')),
  provenance_code TEXT,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('OPEN','ACTIONED','DISMISSED')),
  observed_at TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (source_kind = 'LEGACY' AND legacy_rec_id IS NOT NULL AND scope_hash IS NULL
      AND window_from IS NULL AND window_to IS NULL AND finding_count IS NULL
      AND affected_sessions IS NULL AND exclusive_ceu IS NULL AND confidence IS NULL
      AND safe_anchors_json IS NULL AND provenance_code IS NULL)
    OR
    (source_kind = 'NATIVE' AND legacy_rec_id IS NULL AND scope_hash IS NOT NULL
      AND window_from IS NOT NULL AND window_to IS NOT NULL AND window_to > window_from
      AND finding_count IS NOT NULL AND affected_sessions IS NOT NULL
      AND safe_anchors_json IS NOT NULL AND provenance_code IS NOT NULL)
  )
);

CREATE TABLE hre_recommendations (
  recommendation_id TEXT PRIMARY KEY,
  active_revision_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE hre_recommendation_revisions (
  recommendation_revision_id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL REFERENCES hre_recommendations(recommendation_id) ON DELETE CASCADE,
  supersedes_revision_id TEXT REFERENCES hre_recommendation_revisions(recommendation_revision_id),
  composition_snapshot_id TEXT NOT NULL REFERENCES hre_composition_snapshots(snapshot_id),
  handler_family TEXT NOT NULL,
  handler_version TEXT NOT NULL,
  registry_version TEXT NOT NULL,
  ranking_policy_version TEXT NOT NULL,
  expected_value REAL,
  expected_value_unit TEXT NOT NULL CHECK (expected_value_unit IN ('CEU_PER_WEEK','USD_PER_WEEK','FRACTION')),
  value_method_id TEXT NOT NULL,
  value_method_version TEXT NOT NULL,
  value_window_from TEXT NOT NULL,
  value_window_to TEXT NOT NULL,
  uncertainty_lower REAL,
  uncertainty_upper REAL,
  reason_codes_json TEXT NOT NULL CHECK (json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'),
  created_at TEXT NOT NULL,
  UNIQUE (recommendation_id, recommendation_revision_id),
  CHECK (supersedes_revision_id IS NULL OR supersedes_revision_id <> recommendation_revision_id),
  CHECK (expected_value IS NULL OR expected_value >= 0),
  CHECK (value_window_to > value_window_from)
);

CREATE TABLE hre_ceu_pools (
  composition_snapshot_id TEXT NOT NULL REFERENCES hre_composition_snapshots(snapshot_id) ON DELETE CASCADE,
  ceu_pool_id TEXT NOT NULL,
  total_ceu_per_week REAL NOT NULL CHECK (total_ceu_per_week >= 0),
  PRIMARY KEY (composition_snapshot_id, ceu_pool_id)
);

CREATE TABLE hre_recommendation_findings (
  recommendation_revision_id TEXT NOT NULL REFERENCES hre_recommendation_revisions(recommendation_revision_id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL REFERENCES hre_findings(finding_id) ON DELETE CASCADE,
  composition_snapshot_id TEXT NOT NULL,
  ceu_pool_id TEXT NOT NULL,
  evidence_role TEXT NOT NULL CHECK (evidence_role IN ('PRIMARY','SUPPORTING')),
  contribution_ceu_per_week REAL NOT NULL CHECK (contribution_ceu_per_week >= 0),
  owns_value INTEGER NOT NULL CHECK (owns_value IN (0,1)),
  PRIMARY KEY (recommendation_revision_id, finding_id),
  FOREIGN KEY (composition_snapshot_id, ceu_pool_id)
    REFERENCES hre_ceu_pools(composition_snapshot_id, ceu_pool_id)
);

CREATE UNIQUE INDEX idx_hre_ceu_pool_one_owner
  ON hre_recommendation_findings(composition_snapshot_id, ceu_pool_id)
  WHERE owns_value = 1;
CREATE INDEX idx_hre_revision_findings_finding
  ON hre_recommendation_findings(finding_id, recommendation_revision_id);

CREATE TABLE hre_recommendation_lifecycle_events (
  recommendation_id TEXT NOT NULL REFERENCES hre_recommendations(recommendation_id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  recommendation_revision_id TEXT NOT NULL REFERENCES hre_recommendation_revisions(recommendation_revision_id),
  from_state TEXT CHECK (from_state IS NULL OR from_state IN
    ('ACTIONABLE','INVESTIGATE','PARTIALLY_ACTIONED','ACTIONED','MEASURING',
     'MEASURED_IMPROVED','MEASURED_NO_EFFECT','MEASURED_INCONCLUSIVE','MEASURED_WORSE',
     'MEASUREMENT_UNSUPPORTED','DISMISSED','SNOOZED','STALE')),
  to_state TEXT NOT NULL CHECK (to_state IN
    ('ACTIONABLE','INVESTIGATE','PARTIALLY_ACTIONED','ACTIONED','MEASURING',
     'MEASURED_IMPROVED','MEASURED_NO_EFFECT','MEASURED_INCONCLUSIVE','MEASURED_WORSE',
     'MEASUREMENT_UNSUPPORTED','DISMISSED','SNOOZED','STALE')),
  reason_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (recommendation_id, sequence_no),
  FOREIGN KEY (recommendation_id, recommendation_revision_id)
    REFERENCES hre_recommendation_revisions(recommendation_id, recommendation_revision_id),
  CHECK (from_state IS NULL OR from_state <> to_state)
);

CREATE TABLE hre_artifact_revisions (
  artifact_revision_id TEXT PRIMARY KEY,
  recommendation_revision_id TEXT NOT NULL REFERENCES hre_recommendation_revisions(recommendation_revision_id),
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN
    ('installable_hook','config_diff','claude_md_rule','skill','subagent_def','cc_prompt','advice')),
  artifact_hash TEXT NOT NULL,
  capability_profile_version TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('VALIDATED','REJECTED')),
  rollback_available INTEGER NOT NULL CHECK (rollback_available IN (0,1)),
  supersedes_artifact_revision_id TEXT REFERENCES hre_artifact_revisions(artifact_revision_id),
  created_at TEXT NOT NULL,
  CHECK (supersedes_artifact_revision_id IS NULL OR supersedes_artifact_revision_id <> artifact_revision_id)
);

CREATE TABLE hre_measurement_methods (
  measurement_method_id TEXT PRIMARY KEY,
  artifact_revision_id TEXT NOT NULL REFERENCES hre_artifact_revisions(artifact_revision_id),
  method_version TEXT NOT NULL,
  target_metric_code TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('AUTOMATIC','VALIDATED_PROXY','MANUAL','UNMEASURABLE')),
  frozen_definition_json TEXT NOT NULL CHECK (json_valid(frozen_definition_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE hre_artifact_applications (
  artifact_application_id TEXT PRIMARY KEY,
  artifact_revision_id TEXT NOT NULL REFERENCES hre_artifact_revisions(artifact_revision_id),
  observed_recommendation_revision_id TEXT NOT NULL REFERENCES hre_recommendation_revisions(recommendation_revision_id),
  authorization_id TEXT NOT NULL,
  application_source TEXT NOT NULL CHECK (application_source IN ('MACHINE_CONFIRMED','USER_ATTESTED')),
  base_hash TEXT NOT NULL,
  post_hash TEXT,
  result TEXT NOT NULL CHECK (result IN ('APPLIED','FAILED','ROLLED_BACK')),
  rollback_state TEXT NOT NULL CHECK (rollback_state IN ('AVAILABLE','UNAVAILABLE','COMPLETED')),
  applied_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (length(authorization_id) > 0),
  CHECK (length(base_hash) > 0),
  CHECK (post_hash IS NULL OR length(post_hash) > 0),
  CHECK (result <> 'APPLIED' OR (post_hash IS NOT NULL AND applied_at IS NOT NULL))
);

CREATE TABLE hre_effect_cycle_links (
  cycle_id TEXT PRIMARY KEY REFERENCES effect_cycles(cycle_id) ON DELETE CASCADE,
  recommendation_id TEXT NOT NULL REFERENCES hre_recommendations(recommendation_id),
  recommendation_revision_id TEXT NOT NULL REFERENCES hre_recommendation_revisions(recommendation_revision_id),
  artifact_revision_id TEXT NOT NULL REFERENCES hre_artifact_revisions(artifact_revision_id),
  artifact_application_id TEXT NOT NULL UNIQUE REFERENCES hre_artifact_applications(artifact_application_id),
  measurement_method_id TEXT NOT NULL REFERENCES hre_measurement_methods(measurement_method_id),
  intervention_lock_key TEXT NOT NULL,
  bridge_kind TEXT NOT NULL CHECK (bridge_kind = 'ARTIFACT_BOUND'),
  created_at TEXT NOT NULL,
  FOREIGN KEY (recommendation_id, recommendation_revision_id)
    REFERENCES hre_recommendation_revisions(recommendation_id, recommendation_revision_id),
  CHECK (length(intervention_lock_key) > 0)
);

CREATE TABLE hre_intervention_locks (
  lock_id TEXT PRIMARY KEY,
  intervention_lock_key TEXT NOT NULL,
  cycle_id TEXT NOT NULL UNIQUE REFERENCES hre_effect_cycle_links(cycle_id) ON DELETE CASCADE,
  artifact_application_id TEXT NOT NULL UNIQUE REFERENCES hre_artifact_applications(artifact_application_id),
  state TEXT NOT NULL CHECK (state IN ('OPEN','RELEASED')),
  confounded_override INTEGER NOT NULL DEFAULT 0 CHECK (confounded_override IN (0,1)),
  conflicts_with_lock_id TEXT REFERENCES hre_intervention_locks(lock_id),
  conflict_reason_code TEXT,
  created_at TEXT NOT NULL,
  released_at TEXT,
  CHECK ((state = 'OPEN' AND released_at IS NULL) OR (state = 'RELEASED' AND released_at IS NOT NULL)),
  CHECK (
    (confounded_override = 0 AND conflicts_with_lock_id IS NULL AND conflict_reason_code IS NULL)
    OR
    (confounded_override = 1 AND conflicts_with_lock_id IS NOT NULL AND conflict_reason_code IS NOT NULL)
  )
);

-- Immutable records. Mutable state uses append-only events or guarded pointer/CAS changes.
CREATE TRIGGER hre_findings_immutable_update BEFORE UPDATE ON hre_findings BEGIN
  SELECT RAISE(ABORT, 'hre finding is immutable');
END;
CREATE TRIGGER hre_revisions_immutable_update BEFORE UPDATE ON hre_recommendation_revisions BEGIN
  SELECT RAISE(ABORT, 'hre recommendation revision is immutable');
END;
CREATE TRIGGER hre_handler_history_immutable_update BEFORE UPDATE ON hre_handler_history BEGIN
  SELECT RAISE(ABORT, 'hre handler history is immutable');
END;
CREATE TRIGGER hre_handler_retirements_immutable_update BEFORE UPDATE ON hre_handler_retirements BEGIN
  SELECT RAISE(ABORT, 'hre handler retirement is immutable');
END;
CREATE TRIGGER hre_composition_snapshot_identity_immutable
BEFORE UPDATE OF snapshot_id, composition_version, registry_version, ranking_policy_version,
  price_version, capability_profile_id, window_from, window_to, created_at
ON hre_composition_snapshots
BEGIN
  SELECT RAISE(ABORT, 'hre composition snapshot is immutable');
END;
CREATE TRIGGER hre_lifecycle_events_immutable_update BEFORE UPDATE ON hre_recommendation_lifecycle_events BEGIN
  SELECT RAISE(ABORT, 'hre lifecycle event is immutable');
END;
CREATE TRIGGER hre_recommendation_findings_immutable_update BEFORE UPDATE ON hre_recommendation_findings BEGIN
  SELECT RAISE(ABORT, 'hre recommendation finding link is immutable');
END;
CREATE TRIGGER hre_artifact_revisions_immutable_update BEFORE UPDATE ON hre_artifact_revisions BEGIN
  SELECT RAISE(ABORT, 'hre artifact revision is immutable');
END;
CREATE TRIGGER hre_measurement_methods_immutable_update BEFORE UPDATE ON hre_measurement_methods BEGIN
  SELECT RAISE(ABORT, 'hre measurement method is immutable');
END;
CREATE TRIGGER hre_artifact_applications_immutable_update BEFORE UPDATE ON hre_artifact_applications BEGIN
  SELECT RAISE(ABORT, 'hre artifact application is immutable');
END;
CREATE TRIGGER hre_effect_cycle_links_immutable_update BEFORE UPDATE ON hre_effect_cycle_links BEGIN
  SELECT RAISE(ABORT, 'hre effect link is immutable');
END;

CREATE TRIGGER hre_recommendations_identity_immutable
BEFORE UPDATE ON hre_recommendations
WHEN NEW.recommendation_id <> OLD.recommendation_id OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'hre recommendation identity is immutable');
END;

CREATE TRIGGER hre_active_revision_insert_guard
BEFORE INSERT ON hre_recommendations
WHEN NEW.active_revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'hre recommendation must be created before its first revision');
END;

CREATE TRIGGER hre_active_revision_cas_guard
BEFORE UPDATE OF active_revision_id ON hre_recommendations
WHEN NEW.active_revision_id IS NOT OLD.active_revision_id AND NOT EXISTS (
  SELECT 1 FROM hre_recommendation_revisions next
   WHERE next.recommendation_revision_id = NEW.active_revision_id
     AND next.recommendation_id = OLD.recommendation_id
     AND next.supersedes_revision_id IS OLD.active_revision_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid hre active revision transition');
END;

CREATE TRIGGER hre_revision_supersession_guard
BEFORE INSERT ON hre_recommendation_revisions
WHEN NEW.supersedes_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM hre_recommendation_revisions prior
   WHERE prior.recommendation_revision_id = NEW.supersedes_revision_id
     AND prior.recommendation_id = NEW.recommendation_id
)
BEGIN
  SELECT RAISE(ABORT, 'cross-recommendation hre supersession');
END;

CREATE TRIGGER hre_revision_snapshot_binding_guard
BEFORE INSERT ON hre_recommendation_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM hre_composition_snapshots snapshot
   WHERE snapshot.snapshot_id = NEW.composition_snapshot_id
     AND snapshot.registry_version = NEW.registry_version
     AND snapshot.ranking_policy_version = NEW.ranking_policy_version
)
BEGIN
  SELECT RAISE(ABORT, 'invalid hre recommendation snapshot binding');
END;

CREATE TRIGGER hre_lifecycle_sequence_guard
BEFORE INSERT ON hre_recommendation_lifecycle_events
WHEN
  NOT EXISTS (
    SELECT 1 FROM hre_recommendations recommendation
     WHERE recommendation.recommendation_id = NEW.recommendation_id
       AND recommendation.active_revision_id = NEW.recommendation_revision_id
  )
  OR
  (NEW.sequence_no = 1 AND (NEW.from_state IS NOT NULL OR NEW.to_state NOT IN ('ACTIONABLE','INVESTIGATE')))
  OR
  (NEW.sequence_no > 1 AND NOT EXISTS (
    SELECT 1 FROM hre_recommendation_lifecycle_events prior
     WHERE prior.recommendation_id = NEW.recommendation_id
       AND prior.sequence_no = NEW.sequence_no - 1
       AND prior.to_state = NEW.from_state
  ))
  OR NOT (
    NEW.sequence_no = 1
    OR (NEW.from_state IN ('ACTIONABLE','INVESTIGATE','SNOOZED') AND NEW.to_state IN ('ACTIONABLE','INVESTIGATE','PARTIALLY_ACTIONED','ACTIONED','DISMISSED','SNOOZED','STALE'))
    OR (NEW.from_state = 'PARTIALLY_ACTIONED' AND NEW.to_state IN ('ACTIONED','DISMISSED','STALE'))
    OR (NEW.from_state = 'ACTIONED' AND NEW.to_state IN ('MEASURING','DISMISSED','STALE'))
    OR (NEW.from_state = 'MEASURING' AND NEW.to_state IN ('MEASURED_IMPROVED','MEASURED_NO_EFFECT','MEASURED_INCONCLUSIVE','MEASURED_WORSE','MEASUREMENT_UNSUPPORTED'))
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid hre lifecycle transition');
END;

CREATE TRIGGER hre_artifact_application_binding_guard
BEFORE INSERT ON hre_artifact_applications
WHEN NOT EXISTS (
  SELECT 1 FROM hre_artifact_revisions artifact
   WHERE artifact.artifact_revision_id = NEW.artifact_revision_id
     AND artifact.recommendation_revision_id = NEW.observed_recommendation_revision_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid hre artifact application binding');
END;

CREATE TRIGGER hre_artifact_supersession_guard
BEFORE INSERT ON hre_artifact_revisions
WHEN NEW.supersedes_artifact_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM hre_artifact_revisions prior_artifact
    JOIN hre_recommendation_revisions prior_revision
      ON prior_revision.recommendation_revision_id = prior_artifact.recommendation_revision_id
    JOIN hre_recommendation_revisions next_revision
      ON next_revision.recommendation_revision_id = NEW.recommendation_revision_id
     AND next_revision.recommendation_id = prior_revision.recommendation_id
   WHERE prior_artifact.artifact_revision_id = NEW.supersedes_artifact_revision_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid hre artifact supersession');
END;

CREATE TRIGGER hre_published_snapshot_guard
BEFORE UPDATE OF state ON hre_composition_snapshots
WHEN OLD.state <> NEW.state AND (
  OLD.state <> 'DRAFT' OR NEW.state <> 'PUBLISHED'
  OR NOT EXISTS (
    SELECT 1 FROM hre_ceu_pools pool
     WHERE pool.composition_snapshot_id = OLD.snapshot_id
  )
  OR EXISTS (
    SELECT 1 FROM hre_ceu_pools pool
     WHERE pool.composition_snapshot_id = OLD.snapshot_id
       AND (
         (SELECT COUNT(*) FROM hre_recommendation_findings link
           WHERE link.composition_snapshot_id = pool.composition_snapshot_id
             AND link.ceu_pool_id = pool.ceu_pool_id AND link.owns_value = 1) <> 1
         OR ABS((SELECT COALESCE(SUM(link.contribution_ceu_per_week), 0)
                   FROM hre_recommendation_findings link
                  WHERE link.composition_snapshot_id = pool.composition_snapshot_id
                    AND link.ceu_pool_id = pool.ceu_pool_id) - pool.total_ceu_per_week) > 0.000001
       )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid hre snapshot publication');
END;

CREATE TRIGGER hre_published_pool_insert BEFORE INSERT ON hre_ceu_pools
WHEN EXISTS (SELECT 1 FROM hre_composition_snapshots WHERE snapshot_id = NEW.composition_snapshot_id AND state = 'PUBLISHED')
BEGIN SELECT RAISE(ABORT, 'published hre snapshot is immutable'); END;
CREATE TRIGGER hre_published_pool_update BEFORE UPDATE ON hre_ceu_pools
WHEN EXISTS (SELECT 1 FROM hre_composition_snapshots WHERE snapshot_id = OLD.composition_snapshot_id AND state = 'PUBLISHED')
BEGIN SELECT RAISE(ABORT, 'published hre snapshot is immutable'); END;
CREATE TRIGGER hre_published_links_insert BEFORE INSERT ON hre_recommendation_findings
WHEN EXISTS (SELECT 1 FROM hre_composition_snapshots WHERE snapshot_id = NEW.composition_snapshot_id AND state = 'PUBLISHED')
BEGIN SELECT RAISE(ABORT, 'published hre snapshot is immutable'); END;
CREATE TRIGGER hre_published_links_update BEFORE UPDATE ON hre_recommendation_findings
WHEN EXISTS (SELECT 1 FROM hre_composition_snapshots WHERE snapshot_id = OLD.composition_snapshot_id AND state = 'PUBLISHED')
BEGIN SELECT RAISE(ABORT, 'published hre snapshot is immutable'); END;

CREATE TRIGGER hre_recommendation_finding_snapshot_guard
BEFORE INSERT ON hre_recommendation_findings
WHEN NOT EXISTS (
  SELECT 1 FROM hre_recommendation_revisions revision
   WHERE revision.recommendation_revision_id = NEW.recommendation_revision_id
     AND revision.composition_snapshot_id = NEW.composition_snapshot_id
)
BEGIN
  SELECT RAISE(ABORT, 'cross-snapshot hre finding link');
END;

CREATE TRIGGER hre_effect_link_binding_guard
BEFORE INSERT ON hre_effect_cycle_links
WHEN NOT EXISTS (
  SELECT 1
    FROM hre_artifact_applications application
    JOIN hre_artifact_revisions artifact
      ON artifact.artifact_revision_id = application.artifact_revision_id
    JOIN hre_measurement_methods method
      ON method.measurement_method_id = NEW.measurement_method_id
     AND method.artifact_revision_id = artifact.artifact_revision_id
   WHERE application.artifact_application_id = NEW.artifact_application_id
     AND application.artifact_revision_id = NEW.artifact_revision_id
     AND application.observed_recommendation_revision_id = NEW.recommendation_revision_id
     AND application.result = 'APPLIED'
     AND artifact.recommendation_revision_id = NEW.recommendation_revision_id
     AND artifact.validation_status = 'VALIDATED'
     AND EXISTS (
       SELECT 1
         FROM effect_cycles cycle
         JOIN hre_recommendation_findings revision_finding
           ON revision_finding.recommendation_revision_id = NEW.recommendation_revision_id
         JOIN hre_findings finding
           ON finding.finding_id = revision_finding.finding_id
          AND finding.source_kind = 'LEGACY'
          AND finding.legacy_rec_id = cycle.rec_id
        WHERE cycle.cycle_id = NEW.cycle_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid hre effect binding');
END;

CREATE TRIGGER hre_linked_effect_cycle_rec_immutable
BEFORE UPDATE OF rec_id ON effect_cycles
WHEN NEW.rec_id IS NOT OLD.rec_id AND EXISTS (
  SELECT 1 FROM hre_effect_cycle_links link WHERE link.cycle_id = OLD.cycle_id
)
BEGIN
  SELECT RAISE(ABORT, 'linked hre effect recommendation provenance is immutable');
END;

CREATE TRIGGER hre_intervention_lock_conflict
BEFORE INSERT ON hre_intervention_locks
WHEN NEW.state = 'OPEN' AND NEW.confounded_override = 0 AND EXISTS (
  SELECT 1 FROM hre_intervention_locks existing
   WHERE existing.intervention_lock_key = NEW.intervention_lock_key
     AND existing.state = 'OPEN'
)
BEGIN
  SELECT RAISE(ABORT, 'hre intervention lock conflict');
END;

CREATE TRIGGER hre_intervention_lock_binding_guard
BEFORE INSERT ON hre_intervention_locks
WHEN NOT EXISTS (
  SELECT 1 FROM hre_effect_cycle_links link
   WHERE link.cycle_id = NEW.cycle_id
     AND link.artifact_application_id = NEW.artifact_application_id
     AND link.intervention_lock_key = NEW.intervention_lock_key
)
BEGIN
  SELECT RAISE(ABORT, 'invalid hre intervention lock binding');
END;

CREATE TRIGGER hre_intervention_override_guard
BEFORE INSERT ON hre_intervention_locks
WHEN NEW.confounded_override = 1 AND NOT EXISTS (
  SELECT 1 FROM hre_intervention_locks existing
   WHERE existing.lock_id = NEW.conflicts_with_lock_id
     AND existing.intervention_lock_key = NEW.intervention_lock_key
     AND existing.state = 'OPEN'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid hre intervention override');
END;

CREATE TRIGGER hre_intervention_lock_update_guard
BEFORE UPDATE ON hre_intervention_locks
WHEN NEW.lock_id <> OLD.lock_id
  OR NEW.intervention_lock_key <> OLD.intervention_lock_key
  OR NEW.cycle_id <> OLD.cycle_id
  OR NEW.artifact_application_id <> OLD.artifact_application_id
  OR NEW.confounded_override <> OLD.confounded_override
  OR NEW.conflicts_with_lock_id IS NOT OLD.conflicts_with_lock_id
  OR NEW.conflict_reason_code IS NOT OLD.conflict_reason_code
  OR NEW.created_at <> OLD.created_at
  OR OLD.state <> 'OPEN'
  OR NEW.state <> 'RELEASED'
  OR NEW.released_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid hre intervention lock transition');
END;
