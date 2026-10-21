-- SEC-101 W-A: targeted content-slice retention (ADR-112 distribution-boundary
-- rescope). The local daemon DB MAY retain the bounded, secrets-filtered content
-- slices a NAMED detector consumes. Retention is additive and local-only; the
-- distribution boundary (W-B) still forbids this content in any commit/export.
--
-- Consumers (audit register mirrored in test/daemon/sec101.test.ts):
--   content_json.command  -> C5 (SAME_ERROR_LOOP), D7 (loop/retry) — shell command
--                            shape needed to detect repeated (including failing)
--                            invocations.
--   content_json.error    -> C5, D7 — bounded error excerpt to match repeated errors.
-- Both slices are secrets-filtered at capture (W-C) before insert.
--
-- Capture scope (as-built): the `command` slice is retained for EVERY shell
-- tool_use (Bash/PowerShell/Shell), not only failing ones — the loop/retry
-- consumers need every invocation of a repeated command to count the repeats,
-- and a success baseline to distinguish a flaky loop from a hard failure. The
-- `error` slice is retained for EVERY errored tool_result (any tool). Both are
-- bounded (4000 chars) + secrets-filtered + local-only. Data-minimization
-- (narrowing command capture to correlated-failing events) is a DEFERRED
-- decision owned by the consuming detector lane (hre-runtime); see
-- docs/plans/spec-sec101-rescope.md.

CREATE TABLE tool_event_content (
  event_id         TEXT PRIMARY KEY REFERENCES tool_events(event_id) ON DELETE CASCADE,
  content_json     TEXT NOT NULL CHECK (json_valid(content_json)),
  content_included INTEGER NOT NULL DEFAULT 1 CHECK (content_included IN (0, 1))
);
