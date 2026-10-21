/**
 * scripts/parity/sec101-allow-list.ts
 *
 * SEC-101 metric allow-list for Gauge-1 safe evidence packets.
 *
 * FROZEN — this list is the ONLY source of which fields may enter a packet
 * that leaves the machine (the Gauge-1 Claude-prompt arm hits the external API).
 *
 * Basis: PRODUCT-DIRECTION.md §7.1 "metric codes D1/D2/D4/D6/D8/D10 + their anchor fields"
 * plus the 2026-09-21 friction widening (00-EXECUTION-PLAN-DW.md §2; ADR-112 amendment):
 * counts keyed by CLOSED enums for the friction detectors C2–C11/D14/H1 — never text.
 *
 * New fields require a named detector code and justification — never added dynamically.
 * The harness REFUSES (throws) any attempt to place a non-allow-listed field in a packet.
 */

/** Structural anchors: safe identifiers every packet may include. */
export const ANCHOR_FIELDS = new Set<string>([
  "session_id",
  "workspace_id",
  "window_start",
  "window_end",
  "turn_count",
]);

/**
 * Metric fields allowed per detector code.
 *
 * D1  CLAUDE.md/memory oversize         → context_inventory token totals
 * D2  Cache efficiency ratio             → cache read vs write token totals
 * D4  Rate-limit headroom                → headroom % fields (from OAuth; may be absent in seed)
 * D6  Tool-result bloat (carry-cost)     → tool_result_bytes_total, tool_event_count
 * D8  Cache-write churn                  → cache_write_5m/1h token totals + derived fields
 * D10 Long context / late auto-compact   → context_tokens_max per session
 *
 * Friction counts (2026-09-21 widening). Every value is a COUNT of a CHECK-/type-constrained
 * closed enum; the classifiers "never return, hash, or retain text" (tool-error-classifier.ts).
 * No command/error text, no local W-A slices — counts of closed labels only.
 * C2  Content not found                   → err_NOT_FOUND (tool_events.tool_error_class)
 * C3  Edit before read                    → err_NOT_READ
 * C4  Failed-edit recovery                → err_STALE_STRING, err_PATCH_FAILED, err_MODIFIED_SINCE_READ, err_MULTI_MATCH
 * C5  Same-error loop                      → tool_error_count (all classes, this session)
 * C7  Bash failure cluster                → bashfail_* (tool_events.bash_command_family)
 * C9  Denial friction                      → denial_count + per-label (ingest_metric_events.classifier_label)
 * C11 MCP output cap                       → err_MCP_CONTENT_TOO_LARGE, err_READ_OUTPUT_TOO_LARGE
 * D14 Interrupt / cancel                   → interrupt_count + per-kind (tool_events.interrupt_kind)
 * H1  Destructive operations               → destructive_op_count (ingest_metric_events.destructive_op)
 */
export const METRIC_FIELDS_BY_CODE = {
  D1: new Set<string>(["context_inventory_tokens_total", "context_inventory_file_count"]),
  D2: new Set<string>(["cache_read_tokens_total", "cache_write_tokens_total"]),
  D4: new Set<string>(["headroom_pct_5h", "headroom_pct_7d", "tokens_used_5h", "tokens_limit_5h"]),
  D6: new Set<string>(["tool_result_bytes_total", "tool_event_count"]),
  D8: new Set<string>(["cache_write_5m_tokens", "cache_write_1h_tokens"]),
  D10: new Set<string>(["context_tokens_max"]),
  C2: new Set<string>(["err_NOT_FOUND"]),
  C3: new Set<string>(["err_NOT_READ"]),
  C4: new Set<string>([
    "err_STALE_STRING",
    "err_PATCH_FAILED",
    "err_MODIFIED_SINCE_READ",
    "err_MULTI_MATCH",
  ]),
  C5: new Set<string>(["tool_error_count"]),
  C7: new Set<string>([
    "bashfail_BASH_GIT",
    "bashfail_BASH_NPM",
    "bashfail_BASH_PYTHON",
    "bashfail_BASH_TEST",
    "bashfail_BASH_BUILD",
    "bashfail_BASH_OTHER",
  ]),
  C9: new Set<string>([
    "denial_count",
    "denial_interrupt_cancel",
    "denial_user_rejected",
    "denial_hook_block",
    "denial_deny_rule",
  ]),
  C11: new Set<string>(["err_MCP_CONTENT_TOO_LARGE", "err_READ_OUTPUT_TOO_LARGE"]),
  D14: new Set<string>([
    "interrupt_count",
    "intr_PURE_INTERRUPT",
    "intr_KILLED_NO_PROMPT",
    "intr_HUMAN_DENY",
  ]),
  H1: new Set<string>(["destructive_op_count"]),
} as const satisfies Record<string, ReadonlySet<string>>;

/** Flat union of all allowed field names (anchors + all detector metric fields). */
export const ALL_ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>([
  ...ANCHOR_FIELDS,
  ...Object.values(METRIC_FIELDS_BY_CODE).flatMap((s) => [...s]),
]);

/**
 * Build a safe evidence packet from a raw row object.
 *
 * Throws with a SEC-101 error message if `row` contains any field not in
 * ALL_ALLOWED_FIELDS — the refusal the SEC-101 constraint requires.
 *
 * The packet is a shallow copy; caller-side mutation does not affect the original.
 */
export function buildSafePacket(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    if (!ALL_ALLOWED_FIELDS.has(key)) {
      throw new Error(
        `SEC-101: field "${key}" is not in the safe-evidence allow-list. ` +
          `Add it to METRIC_FIELDS_BY_CODE with a named detector code and justification.`,
      );
    }
  }
  return { ...row };
}
