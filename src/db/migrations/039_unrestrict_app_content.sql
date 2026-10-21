-- ADR-112 amendment (2026-09-25): no in-app content restriction. The local DB may
-- store command values; the distribution boundary (export.mjs, pre-commit scan,
-- fixture CI gate) is unchanged. Integrity triggers (contract tuple, classifier
-- format, immutability) stay.

DROP TRIGGER IF EXISTS trg_sec4_command_marker_guard_insert;
DROP TRIGGER IF EXISTS trg_sec4_command_marker_guard_update;
DROP TRIGGER IF EXISTS tool_events_shell_hash_privacy_insert;
DROP TRIGGER IF EXISTS tool_events_shell_hash_privacy_update;
