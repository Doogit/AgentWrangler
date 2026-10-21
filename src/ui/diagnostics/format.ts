/**
 * src/ui/diagnostics/format.ts — small display helpers shared by the diagnostics triage rows.
 */

import type { Trend } from "../../query/api/diagnostics-census";

export const money = (u: number | null): string =>
  u === null
    ? "—"
    : `$${(u / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const pct = (ratio: number | null, digits = 1): string =>
  ratio === null ? "—" : `${(ratio * 100).toFixed(digits)}%`;

export const count = (n: number): string => n.toLocaleString();

/** "1 failing turn", "3 failing turns". Every unit word is a plural that drops its final "s". */
export const countOf = (n: number, plural: string): string =>
  `${count(n)} ${n === 1 ? plural.replace(/s$/, "") : plural}`;

export const trendGlyph = (trend: Trend): string =>
  trend === "rising" ? "▲" : trend === "falling" ? "▼" : "—";

/** Rising is worse (more cost/friction); falling is better. Never color alone (§6). */
export const trendClass = (trend: Trend): string =>
  trend === "rising" ? "trend-rising" : trend === "falling" ? "trend-falling" : "trend-steady";

/** `#/sessions/<id>?anchor=<message_id>&turn=<n>`, or null when the anchor is incomplete. */
export function turnHref(
  sessionId: string,
  messageId: string | undefined,
  turnIndex: number | undefined,
): string | null {
  if (messageId === undefined || turnIndex === undefined) return null;
  const params = new URLSearchParams({ anchor: messageId, turn: String(turnIndex) });
  return `#/sessions/${encodeURIComponent(sessionId)}?${params}`;
}

export const sessionLabel = (sessionId: string, title: string | null): string =>
  title ?? (sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId);
