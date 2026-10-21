-- Local-only, bounded session label. Source preserves /rename precedence on replay.
ALTER TABLE sessions ADD COLUMN title TEXT;
ALTER TABLE sessions ADD COLUMN title_source TEXT;
