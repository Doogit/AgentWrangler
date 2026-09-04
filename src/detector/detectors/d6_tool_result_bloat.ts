/**
 * src/detector/detectors/d6_tool_result_bloat.ts — D6 TOOL_RESULT_BLOAT.
 *
 * Fires PER-SESSION when a session carries a large volume of tool-result output
 * (size only, never content — the privacy boundary holds). A tool_result rides
 * in context and is re-processed at the cached rate on every later turn, so a
 * bloated session pays a recurring carry cost.
 *
 * A session qualifies when (UNVALIDATED defaults, labeled in every rec):
 *   - summed tool_result_bytes ≥ 30% of the session's cap-weighted total, AND
 *   - summed tool_result_bytes ≥ 200 KB (absolute floor; skips tiny sessions).
 * The detector only surfaces recs when ≥ 3 such sessions exist in the window
 * (a recurrence gate, so one-off large dumps don't fire).
 *
 * When event metadata is available, D6 annotates the session with the largest
 * recurring tool-name class and a directional carry estimate. This remains size-only:
 * no tool input/output content is read or persisted.
 *
 * modeled_savings (R12 — opt-in calibration gate):
 *   modeled_savings_u_per_wk is non-null ONLY when a calibrated bytes_per_token
 *   is present in user_config (requires explicit opt-in). Without calibration it
 *   stays null — an honest default: we make no $ claim on the raw heuristic.
 *
 * scopeKey: "D6|<session_id>".
 */

import type { Db } from "../../db/open.js";
import { LIST_PRICES, modelTier } from "../../ingest/pricing.js";
import { capWeightedTokens } from "../../query/cap-weighted.js";
import { resolveBytesPerToken } from "../calibration.js";
import type { BytesPerTokenResolution } from "../calibration.js";
import {
  D6_ABS_FLOOR_BYTES,
  D6_AVOIDANCE_FRACTION,
  D6_BLOAT_SHARE,
  D6_MIN_SESSIONS,
  d6Savings,
} from "../savings.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";

interface SessionRow {
  session_id: string;
  workspace_id: string;
  tool_result_bytes: number;
  turns: number;
}

interface ToolEventRow {
  event_id: string;
  tool_name: string;
  result_bytes: number | null;
  block_index: number | null;
  owner_message_id: string | null;
}

interface TurnOrderRow {
  message_id: string;
  ts: string;
}

interface SessionPricingRow {
  cache_read_tokens: number;
  model: string;
  unit_prices_json: string | null;
}

interface D6Attribution {
  attributed_tool: string | null;
  attributed_result_bytes: number | null;
  carry_turns: number | null;
  carry_exposure_tokens_directional: number | null;
}

/** Resolve cache-read price ($/MTok = µUSD/token) from a pricing snapshot or list price. */
function cacheReadPrice(unitPricesJson: string | null, model: string): number {
  if (unitPricesJson) {
    try {
      const arr = JSON.parse(unitPricesJson) as number[];
      if (typeof arr[2] === "number") return arr[2];
    } catch {
      // fall through to list price
    }
  }
  const tier = modelTier(model);
  const lp = tier ? LIST_PRICES[tier] : undefined;
  return lp ? lp[2] : 0;
}

/**
 * Compute the blended cache-read price ($/MTok) for a session, weighted by
 * cache_read_tokens across all turns — mirrors D8's blended write-price approach.
 */
function blendedCacheReadPriceForSession(
  db: Db,
  sessionId: string,
  fromIso: string,
  toIso: string,
): number {
  const rows = db
    .prepare(
      `SELECT t.cache_read_tokens, t.model, ps.unit_prices_json
         FROM turns t
         LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
        WHERE t.session_id = ? AND t.ts >= ? AND t.ts < ? AND t.provisional = 0`,
    )
    .all(sessionId, fromIso, toIso) as SessionPricingRow[];

  let totalCrTokens = 0;
  let totalCrSpend = 0;
  for (const r of rows) {
    const price = cacheReadPrice(r.unit_prices_json, r.model);
    totalCrTokens += r.cache_read_tokens;
    totalCrSpend += r.cache_read_tokens * price;
  }
  return totalCrTokens > 0 ? totalCrSpend / totalCrTokens : 0;
}

function d6DirectionalFormula(
  toolResultBytes: number,
  bloatShare: number,
  sessionCapWeightedTokens: number,
  bytesPerToken: number,
): Fired["modeled_formula"] {
  return {
    model: "D6_TOOL_RESULT_BLOAT_V1",
    kind: "DIRECTIONAL",
    inputs: {
      tool_result_bytes: toolResultBytes,
      bytes_per_token: bytesPerToken,
      bloat_share: Number(bloatShare.toFixed(4)),
      session_cap_weighted_tokens: Math.round(sessionCapWeightedTokens),
    },
    expression:
      "tool_result_bytes / bytes_per_token compared with session_cap_weighted_tokens; heuristic directional exposure only (no avoidable-token or USD estimate)",
  };
}

/** True only for SQLite "no such table/column" errors from an un-migrated DB. */
function isMissingSchemaError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === "SQLITE_ERROR" &&
    /no such (table|column)/i.test(error.message)
  );
}

/** Keep event-provided tool identity structural and bounded. */
function boundedToolNameClass(toolName: string): string | null {
  const trimmed = toolName.trim();
  return trimmed === "" ? null : trimmed.slice(0, 64);
}

function d6Attribution(
  db: Db,
  sessionId: string,
  fromIso: string,
  toIso: string,
  bytesPerToken: number,
): D6Attribution {
  const empty: D6Attribution = {
    attributed_tool: null,
    attributed_result_bytes: null,
    carry_turns: null,
    carry_exposure_tokens_directional: null,
  };

  try {
    const events = db
      .prepare(
        `SELECT e.event_id, e.tool_name, e.result_bytes,
                m.owner_message_id, m.block_index
           FROM tool_events e
           LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
           LEFT JOIN turns owner
             ON owner.message_id = m.owner_message_id
            AND owner.session_id = e.session_id
            AND owner.ts >= ? AND owner.ts < ?
            AND owner.provisional = 0
          WHERE e.session_id = ?
            AND e.ts >= ? AND e.ts < ?
            AND e.result_bytes IS NOT NULL
            AND e.result_bytes > 0
            AND m.owner_message_id IS NOT NULL
            AND owner.message_id IS NOT NULL
          ORDER BY e.ts ASC, m.block_index ASC, e.event_id ASC`,
      )
      .all(fromIso, toIso, sessionId, fromIso, toIso) as ToolEventRow[];
    if (events.length === 0) return empty;

    const laterTurns = db
      .prepare(
        `SELECT message_id, ts
           FROM turns
          WHERE session_id = ?
            AND ts >= ? AND ts < ?
            AND provisional = 0
          ORDER BY ts ASC, message_id ASC`,
      )
      .all(sessionId, fromIso, toIso) as TurnOrderRow[];
    const turnIndexByMessage = new Map(laterTurns.map((turn, index) => [turn.message_id, index]));

    const byTool = new Map<
      string,
      { bytes: number; eventCount: number; firstOwnerIndex: number }
    >();
    for (const event of events) {
      if (event.result_bytes === null || event.owner_message_id === null) continue;
      const ownerIndex = turnIndexByMessage.get(event.owner_message_id);
      if (ownerIndex === undefined) continue;
      const tool = boundedToolNameClass(event.tool_name);
      if (tool === null) continue;
      const existing = byTool.get(tool);
      if (existing === undefined) {
        byTool.set(tool, {
          bytes: event.result_bytes,
          eventCount: 1,
          firstOwnerIndex: ownerIndex,
        });
      } else {
        existing.bytes += event.result_bytes;
        existing.eventCount += 1;
        if (ownerIndex < existing.firstOwnerIndex) existing.firstOwnerIndex = ownerIndex;
      }
    }

    const recurring = [...byTool.entries()]
      .filter(([, value]) => value.eventCount >= 2)
      .sort(([toolA, valueA], [toolB, valueB]) => {
        return valueB.bytes - valueA.bytes || (toolA < toolB ? -1 : toolA > toolB ? 1 : 0);
      });
    const winner = recurring[0];
    if (winner === undefined) return empty;

    const [attributedTool, value] = winner;
    // Directional upper bound: assumes the result stays in context for every later
    // turn. Real carry is shorter when context is trimmed, so this over-estimates
    // (~20% observed); it is exposure, never an avoidable-token or savings claim.
    const carryTurns = Math.max(0, laterTurns.length - value.firstOwnerIndex - 1);
    return {
      attributed_tool: attributedTool,
      attributed_result_bytes: value.bytes,
      carry_turns: carryTurns,
      carry_exposure_tokens_directional: Number(
        ((value.bytes * carryTurns) / bytesPerToken).toFixed(4),
      ),
    };
  } catch (error) {
    // Older or partially migrated databases lack event metadata; keep the
    // already-qualified session-level recommendation instead of failing D6.
    // Only swallow the missing-schema case — a genuine query defect must surface.
    if (isMissingSchemaError(error)) return empty;
    throw error;
  }
}

export const d6Detector: Detector = {
  id: "D6",
  name: "TOOL_RESULT_BLOAT",

  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    // Resolve bytes-per-token: calibrated value from user_config, fallback to 4.
    const bptResolution: BytesPerTokenResolution = resolveBytesPerToken(db);
    const bytesPerToken = bptResolution.ratio;

    const capRows = capWeightedTokens(db, {
      fromIso: ctx.fromIso,
      toIso: ctx.toIso,
      groupBy: "session_id",
    });
    const capBySession = new Map(capRows.map((r) => [r.group ?? "", r.cap_weighted_tokens]));

    const sessions = db
      .prepare(
        `SELECT t.session_id, t.workspace_id,
                COALESCE(SUM(t.tool_result_bytes), 0) AS tool_result_bytes,
                COUNT(*) AS turns
           FROM turns t
          WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0
          GROUP BY t.session_id
         HAVING SUM(t.tool_result_bytes) IS NOT NULL`,
      )
      .all(ctx.fromIso, ctx.toIso) as SessionRow[];

    // Identify qualifying sessions (bloat share + absolute floor).
    // Convert bytes → tokens before computing the share so the ratio is unitless.
    const qualifying: Array<{ row: SessionRow; capTotal: number; bloatShare: number }> = [];
    for (const s of sessions) {
      const capTotal = capBySession.get(s.session_id) ?? 0;
      if (capTotal <= 0) continue;
      const bloatTokens = s.tool_result_bytes / bytesPerToken;
      const bloatShare = bloatTokens / capTotal;
      if (bloatShare >= D6_BLOAT_SHARE && s.tool_result_bytes >= D6_ABS_FLOOR_BYTES) {
        qualifying.push({ row: s, capTotal, bloatShare });
      }
    }

    // Recurrence gate: only surface when the pattern repeats across ≥ N sessions.
    if (qualifying.length < D6_MIN_SESSIONS) {
      return {
        fired: [],
        status: "INACTIVE",
        note: `${qualifying.length} bloated session(s) (< ${D6_MIN_SESSIONS} threshold)`,
      };
    }

    const fired: Fired[] = [];
    for (const { row, capTotal, bloatShare } of qualifying) {
      const attribution = d6Attribution(db, row.session_id, ctx.fromIso, ctx.toIso, bytesPerToken);

      // Compute modeled savings only when calibration is present AND attribution
      // provided a carry estimate. Without calibration the heuristic ratio is
      // unvalidated, so we make no $ claim (honest default: stays null).
      let modeledSavingsU: number | null = null;
      let savingsFormula: Fired["modeled_formula"] | null = null;
      let calibrationCaveat: Record<string, unknown> | null = null;

      if (
        bptResolution.calibrated &&
        attribution.carry_exposure_tokens_directional !== null &&
        attribution.carry_exposure_tokens_directional > 0
      ) {
        const blendedReadPrice = blendedCacheReadPriceForSession(
          db,
          row.session_id,
          ctx.fromIso,
          ctx.toIso,
        );
        const { savingsU, formula } = d6Savings(
          attribution.carry_exposure_tokens_directional,
          D6_AVOIDANCE_FRACTION,
          blendedReadPrice,
        );
        if (savingsU > 0) {
          modeledSavingsU = savingsU;
          savingsFormula = formula;
          calibrationCaveat = {
            tokenizer: "anthropic count_tokens",
            model: bptResolution.model,
            measured_at: bptResolution.measuredAt,
            note: "conservative — proxy corpora undercount Claude tokens, so real savings are likely ≥ shown",
          };
        }
      }

      // When calibrated with savings, use the savings formula; otherwise directional.
      const formula =
        savingsFormula !== null
          ? savingsFormula
          : d6DirectionalFormula(row.tool_result_bytes, bloatShare, capTotal, bytesPerToken);

      const bytesPerTokenNote = bptResolution.calibrated
        ? `calibrated via count_tokens (${bptResolution.provenance ?? ""})`
        : "heuristic estimate; actual tokenization is not observed";

      fired.push({
        scopeKey: `D6|${row.session_id}`,
        category: "TOOLING",
        scope_workspace_id: row.workspace_id,
        lever:
          "Use scoped reads (line ranges) and head/filters over full dumps; truncate or summarize verbose tool output; move exploration to subagents to keep bloat off the premium main thread.",
        target_metric: "tool_result_byte_share",
        modeled_savings_u_per_wk: modeledSavingsU,
        modeled_formula: formula,
        evidence: {
          title: `Trim tool output: ${Math.round(bloatShare * 100)}% bloat share in session`,
          session_id: row.session_id,
          workspace_id: row.workspace_id,
          tool_result_bytes: row.tool_result_bytes,
          session_cap_weighted_tokens: capTotal,
          bloat_share: Number(bloatShare.toFixed(4)),
          turn_count: row.turns,
          bloat_share_threshold: D6_BLOAT_SHARE,
          abs_floor_bytes_threshold: D6_ABS_FLOOR_BYTES,
          min_sessions_threshold: D6_MIN_SESSIONS,
          bytes_per_token: bytesPerToken,
          bytes_per_token_note: bytesPerTokenNote,
          thresholds_unvalidated: true,
          attributed_tool: attribution.attributed_tool,
          attributed_result_bytes: attribution.attributed_result_bytes,
          carry_turns: attribution.carry_turns,
          carry_exposure_tokens_directional: attribution.carry_exposure_tokens_directional,
          ...(calibrationCaveat !== null ? { calibration: calibrationCaveat } : {}),
          steps: [
            "Open the session and find the turns carrying large tool-result output",
            "Replace full-file dumps with scoped reads (line ranges) and head/grep filters",
            "Truncate or summarize verbose command output before it enters context",
            "Move broad exploration to a subagent so the bloat stays off the main thread",
          ],
        },
      });
    }

    if (fired.length === 0) {
      return { fired: [], status: "INACTIVE", note: "no qualifying bloated session" };
    }
    return {
      fired,
      status: "ACTIVE",
      note: `${fired.length} session(s) with tool-result bloat`,
    };
  },
};
