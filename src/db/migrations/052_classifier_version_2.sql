-- RC-D14: classifier-2 takes is_interrupt / interrupt-cancel from the user Esc record instead of a
-- substring of tool_result text. The 023 privacy triggers pin classifier_version to a closed set;
-- widen it to both versions (classifier-1 rows stay until interrupt-relabel.ts rewrites them).
-- Triggers only: no table, column or data change.
DROP TRIGGER IF EXISTS ingest_metric_events_privacy_insert;
DROP TRIGGER IF EXISTS ingest_metric_events_privacy_update;

CREATE TRIGGER ingest_metric_events_privacy_insert
BEFORE INSERT ON ingest_metric_events
WHEN NOT (
  (NEW.cc_version IS NULL OR
    (typeof(NEW.cc_version) = 'text' AND length(NEW.cc_version) BETWEEN 1 AND 32
      AND NEW.cc_version NOT GLOB '*[^0-9A-Za-z._-]*'))
  AND (NEW.classifier_version IS NULL OR NEW.classifier_version IN ('classifier-1', 'classifier-2'))
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
  AND (NEW.classifier_version IS NULL OR NEW.classifier_version IN ('classifier-1', 'classifier-2'))
  AND (NEW.event_ts IS NULL OR
    (typeof(NEW.event_ts) = 'text' AND length(NEW.event_ts) = 24
      AND NEW.event_ts GLOB '????-??-??T??:??:??.???Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.event_ts) = NEW.event_ts))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid classifier boundary contract');
END;
