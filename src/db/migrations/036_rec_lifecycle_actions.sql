-- F5: opaque idempotency keys for explicit decision reversals.
CREATE TABLE recommendation_lifecycle_actions (
  idempotency_key TEXT PRIMARY KEY,
  rec_id TEXT NOT NULL REFERENCES recommendations(rec_id),
  action TEXT NOT NULL CHECK (action IN ('UNDO_ADOPT','REOPEN')),
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_recommendation_lifecycle_actions_rec
  ON recommendation_lifecycle_actions(rec_id, action);

-- Legacy NO_EFFECT verdicts are actionable again. Keep INCONCLUSIVE rows
-- separate: their effect history has no measured direction.
UPDATE recommendations SET state='PROPOSED', adopted_at=NULL
WHERE state='MEASURED_NO_EFFECT'
  AND (SELECT e.verdict FROM recommendation_effects e
       WHERE e.rec_id=recommendations.rec_id
       ORDER BY e.measured_at DESC LIMIT 1)='NO_EFFECT';
