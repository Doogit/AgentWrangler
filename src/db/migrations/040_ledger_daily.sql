-- P3.L L7: midnight-aligned 7-day blocks of the claim ledger, aggregated per UTC day.
-- Daily aggregates only; per-turn claims are never persisted. Derived, so safe to rebuild.

CREATE TABLE ledger_daily (
  block_start TEXT NOT NULL,             -- ISO of the block's start (midnight UTC)
  day         TEXT NOT NULL,             -- 'YYYY-MM-DD', UTC day of the claim's turn ts
  lane        TEXT NOT NULL,             -- 'spend' | 'reliability'
  detector_id TEXT NOT NULL,
  rec_id      TEXT NOT NULL DEFAULT '',  -- claim.recId ?? ''
  component   TEXT NOT NULL,
  value_u     REAL NOT NULL,             -- sum of claim value_u (unrounded)
  tokens      INTEGER NOT NULL,          -- sum of claim tokens (allocated, clamped)
  pos0_u REAL NOT NULL DEFAULT 0,
  pos1_u REAL NOT NULL DEFAULT 0,
  pos2_u REAL NOT NULL DEFAULT 0,
  pos3_u REAL NOT NULL DEFAULT 0,
  pos4_u REAL NOT NULL DEFAULT 0,
  pos5_u REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (block_start, day, lane, detector_id, rec_id, component)
);
CREATE INDEX ledger_daily_day ON ledger_daily(day, lane, detector_id);

CREATE TABLE ledger_daily_top (          -- per day, per detector: its largest (detector, turn) sum
  block_start TEXT NOT NULL,
  day         TEXT NOT NULL,
  lane        TEXT NOT NULL,
  detector_id TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  ts          TEXT NOT NULL,
  value_u     REAL NOT NULL,
  PRIMARY KEY (block_start, day, lane, detector_id)
);

CREATE TABLE ledger_daily_sessions (     -- per day, per detector, per session with value_u > 0
  block_start TEXT NOT NULL,
  day         TEXT NOT NULL,
  lane        TEXT NOT NULL,
  detector_id TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  value_u     REAL NOT NULL,
  PRIMARY KEY (block_start, day, lane, detector_id, session_id)
);

CREATE TABLE ledger_daily_marks (
  block_start     TEXT PRIMARY KEY,
  block_end       TEXT NOT NULL,
  turns_rowid_hwm INTEGER NOT NULL,
  producers_sig   TEXT NOT NULL,
  inputs_sig      TEXT NOT NULL,
  turns_fp        TEXT NOT NULL DEFAULT '',  -- count|Σprovisional|Σcost|snapshot ids over the block's turns
  written_at      TEXT NOT NULL
);
