-- 021_recommendation_feedback.sql — RIQ3 additive relevance-feedback + goal-preference storage.
-- SEC-101: enums, ids, scope keys, counts and timestamps only. No free-text, no raw content.

CREATE TABLE recommendation_feedback (
  feedback_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  rec_identity TEXT NOT NULL,
  feedback TEXT NOT NULL CHECK (feedback IN
    ('NOT_APPLICABLE', 'ALREADY_DONE', 'ACCEPTED_TRADEOFF', 'NOT_USEFUL')),
  cooldown_until TEXT,
  dismissed_materiality_band TEXT CHECK (dismissed_materiality_band IS NULL
    OR dismissed_materiality_band IN ('SMALL', 'MODERATE', 'LARGE', 'UNKNOWN')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX idx_rec_feedback_active
  ON recommendation_feedback(scope_key, rec_identity) WHERE deleted_at IS NULL;

CREATE TABLE recommendation_goal_preference (
  scope_key TEXT PRIMARY KEY,
  goal TEXT NOT NULL CHECK (goal IN
    ('PRESERVE_QUALITY', 'REDUCE_RESOURCE_USE', 'INVESTIGATE_FRICTION')),
  updated_at TEXT NOT NULL
);
