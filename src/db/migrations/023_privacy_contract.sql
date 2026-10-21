-- U9 / SEC-101: version persisted detector output and remove raw classifier paths.
-- Existing recommendations are deliberately quarantined until their stable rec_id
-- is emitted again through the V1 validation boundary.
ALTER TABLE recommendations ADD COLUMN contract_version INTEGER;
ALTER TABLE recommendations ADD COLUMN template_id TEXT;
ALTER TABLE recommendations ADD COLUMN contract_status TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED'
  CHECK (contract_status IN ('LEGACY_UNVERIFIED', 'V1_VALIDATED'));

CREATE INDEX idx_recommendations_contract_status
  ON recommendations(contract_status, state, created_at);

-- Plain hashes of low-entropy shell commands are dictionary-reversible. Keep
-- only the closed command_shape classifier in ingest_metric_events.
UPDATE tool_events
   SET input_hash = NULL
 WHERE tool_name IN ('Bash', 'PowerShell', 'Shell');

CREATE TRIGGER tool_events_shell_hash_privacy_insert
BEFORE INSERT ON tool_events
WHEN NEW.tool_name IN ('Bash', 'PowerShell', 'Shell') AND NEW.input_hash IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'shell command input hashes are forbidden');
END;

CREATE TRIGGER tool_events_shell_hash_privacy_update
BEFORE UPDATE OF tool_name, input_hash ON tool_events
WHEN NEW.tool_name IN ('Bash', 'PowerShell', 'Shell') AND NEW.input_hash IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'shell command input hashes are forbidden');
END;

DROP TABLE ingest_classifier_baselines;
CREATE TABLE ingest_classifier_baselines (
  file_path_hash TEXT PRIMARY KEY
    CHECK (typeof(file_path_hash) = 'text'
      AND length(file_path_hash) = 64
      AND file_path_hash NOT GLOB '*[^0-9a-f]*'),
  seeded_offset INTEGER NOT NULL CHECK (seeded_offset >= 0)
);

-- SQLite cannot add CHECK constraints to existing columns. These symmetric
-- triggers make the same constraint effective for both inserts and updates.
CREATE TRIGGER ingest_metric_events_privacy_insert
BEFORE INSERT ON ingest_metric_events
WHEN NOT (
  (NEW.cc_version IS NULL OR
    (typeof(NEW.cc_version) = 'text' AND length(NEW.cc_version) BETWEEN 1 AND 32
      AND NEW.cc_version NOT GLOB '*[^0-9A-Za-z._-]*'))
  AND (NEW.classifier_version IS NULL OR NEW.classifier_version = 'classifier-1')
  AND (NEW.event_ts IS NULL OR
    (typeof(NEW.event_ts) = 'text' AND length(NEW.event_ts) = 24
      AND NEW.event_ts GLOB '????-??-??T??:??:??.???Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.event_ts) = NEW.event_ts))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid classifier boundary contract');
END;

CREATE TRIGGER ingest_metric_events_privacy_update
BEFORE UPDATE OF cc_version, classifier_version, event_ts ON ingest_metric_events
WHEN NOT (
  (NEW.cc_version IS NULL OR
    (typeof(NEW.cc_version) = 'text' AND length(NEW.cc_version) BETWEEN 1 AND 32
      AND NEW.cc_version NOT GLOB '*[^0-9A-Za-z._-]*'))
  AND (NEW.classifier_version IS NULL OR NEW.classifier_version = 'classifier-1')
  AND (NEW.event_ts IS NULL OR
    (typeof(NEW.event_ts) = 'text' AND length(NEW.event_ts) = 24
      AND NEW.event_ts GLOB '????-??-??T??:??:??.???Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.event_ts) = NEW.event_ts))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid classifier boundary contract');
END;
