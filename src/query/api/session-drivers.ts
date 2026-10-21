/** Per-session, privacy-safe detector attribution. */

import type { Db } from "../../db/open.js";
import { type CacheThreadRow, cacheThreadSteps } from "../../detector/cache-ttl.js";
import { analyzeD7LoopEvents } from "../../detector/d7-loop-analysis.js";
import {
  isA1Result,
  isD7NonLoopCall,
  normalizedClusterText,
} from "../../detector/detectors/d7_loop_retry_waste.js";
import { findingIds } from "../../detector/privacy-contract.js";
import {
  D2_AVG_CONTEXT_THRESHOLD,
  D8_CREATION_SPIKE_TOKENS,
  D8_LOW_READ_RATIO,
} from "../../detector/savings.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";
import {
  type PersistedRecommendationContractRow,
  trustedRecommendationContract,
} from "../recommendation-contract.js";

export interface SessionDriver {
  detector_id: "D2" | "D6" | "D7" | "D8";
  label: string;
  measured: Record<string, number | string | boolean>;
  share: number | null;
  rec_id: string;
  routing: "rec_card" | "hook";
  approx_usd?: number;
  session_cost_u?: number;
}

export interface SessionDrivers {
  session_id: string;
  workspace_id: string;
  percentile: number;
  drivers: SessionDriver[];
  tool_error_breakdown?: {
    tool_name: string;
    tool_error_class: string;
    bash_command_family: string | null;
    count: number;
  }[];
}

type DetectorId = SessionDriver["detector_id"];

interface SessionRow {
  workspace_id: string;
  cost_equiv_u: number;
  last_turn_at: string | null;
}

interface RecommendationRow extends PersistedRecommendationContractRow {
  rec_id: string;
  scope_workspace_id: string | null;
  detector_id: DetectorId;
  modeled_savings_u_per_wk: number | null;
  evidence_json: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DETECTOR_ORDER: Record<DetectorId, number> = { D6: 0, D8: 1, D7: 2, D2: 3 };

const DRIVER_CONFIG: Record<
  DetectorId,
  {
    label: string;
    fields: readonly string[];
    shareField?: string;
    routing: SessionDriver["routing"];
  }
> = {
  D2: {
    label: "SESSION_LONG_FULL_CONTEXT",
    fields: [],
    routing: "hook",
  },
  D6: {
    label: "TOOL_RESULT_BLOAT",
    fields: ["tool_result_bytes", "bloat_share", "attributed_tool", "turn_count"],
    shareField: "bloat_share",
    routing: "rec_card",
  },
  D7: {
    label: "LOOP_RETRY_WASTE",
    fields: [
      "loop_flagged_turn_count",
      "repeat_excess_event_count",
      "total_turn_count",
      "loop_flagged_turn_share",
    ],
    shareField: "loop_flagged_turn_share",
    routing: "rec_card",
  },
  D8: {
    label: "CACHE_WRITE_CHURN",
    fields: ["churn_event_count", "total_churn_creation_tokens", "creation_share", "regime"],
    shareField: "creation_share",
    routing: "hook",
  },
};

interface CostTurn {
  message_id: string;
  context_tokens: number;
  cost_equiv_u: number | null;
}

interface D8CostTurn extends CacheThreadRow {
  cache_read_tokens: number;
  cache_write_other: number;
  cost_equiv_u: number | null;
}

function sessionDriverCosts(
  db: Db,
  sessionId: string,
  requested: ReadonlySet<DetectorId> = new Set<DetectorId>(["D2", "D7", "D8"]),
): Partial<Record<DetectorId, number>> {
  const turns = db
    .prepare(
      `SELECT message_id, context_tokens, cost_equiv_u
         FROM turns WHERE session_id = ? AND provisional = 0
        ORDER BY ts, message_id`,
    )
    .all(sessionId) as CostTurn[];
  const costs: Partial<Record<DetectorId, number>> = { D2: 0, D8: 0, D7: 0 };
  for (const turn of turns) {
    if (requested.has("D2") && turn.context_tokens > D2_AVG_CONTEXT_THRESHOLD) {
      costs.D2 = (costs.D2 ?? 0) + (turn.cost_equiv_u ?? 0);
    }
  }

  if (requested.has("D8")) {
    // Same per-thread walk and condition as the D8 detector, so drivers flags its turns.
    const threadTurns = db
      .prepare(
        `SELECT session_id, is_sidechain, agent_id, ts, cache_read_tokens,
                cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u
           FROM turns WHERE session_id = ? AND provisional = 0
          ORDER BY session_id, is_sidechain, agent_id, ts, message_id`,
      )
      .all(sessionId) as D8CostTurn[];
    for (const { row, previous, gapMin, ttlMin } of cacheThreadSteps(threadTurns)) {
      if (previous === undefined || row.is_sidechain !== 0) continue;
      const creation = row.cache_write_5m + row.cache_write_1h + row.cache_write_other;
      if (creation < D8_CREATION_SPIKE_TOKENS) continue;
      if (gapMin > ttlMin && row.cache_read_tokens < D8_LOW_READ_RATIO * creation) {
        costs.D8 = (costs.D8 ?? 0) + (row.cost_equiv_u ?? 0);
      }
    }
  }

  if (requested.has("D7")) {
    const owners = sessionLoopFlaggedMessageIds(db, sessionId);
    costs.D7 = turns.reduce(
      (sum, turn) => sum + (owners.has(turn.message_id) ? (turn.cost_equiv_u ?? 0) : 0),
      0,
    );
  }
  return costs;
}

/** Owner turns flagged by the same D7 event analysis used for driver costs. */
export function sessionLoopFlaggedMessageIds(db: Db, sessionId: string): Set<string> {
  const events = db
    .prepare(
      `SELECT e.event_id, e.ts, e.tool_name, e.input_hash, e.exit_class, e.result_bytes,
              m.file_path_hash, m.owner_message_id, t.agent_id AS context,
              COALESCE(json_extract(c.content_json, '$.command'),
                       json_extract(c.content_json, '$.error')) AS content_text,
              json_extract(c.content_json, '$.error') AS error_text
         FROM tool_events e
         JOIN tool_event_metadata m ON m.event_id = e.event_id
         JOIN turns t ON t.message_id = m.owner_message_id
                     AND t.session_id = e.session_id AND t.provisional = 0
         LEFT JOIN tool_event_content c ON c.event_id = e.event_id
        WHERE e.session_id = ?
        ORDER BY e.ts, m.block_index, e.event_id`,
    )
    .all(sessionId) as Array<{
    event_id: string;
    ts: string;
    tool_name: string;
    input_hash: string | null;
    exit_class: string | null;
    result_bytes: number | null;
    file_path_hash: string | null;
    owner_message_id: string;
    context: string | null;
    content_text: string | null;
    error_text: string | null;
  }>;
  const flagged = analyzeD7LoopEvents(
    events.map((event) => ({
      event_id: event.event_id,
      ts: event.ts,
      tool_name: event.tool_name,
      input_hash: normalizedClusterText(event.content_text) ?? event.input_hash,
      exit_class: event.exit_class,
      file_path_hash: event.file_path_hash,
      result_bytes: event.result_bytes,
      eligible:
        !isA1Result(event.result_bytes) &&
        !isD7NonLoopCall(event.tool_name, event.exit_class, event.error_text),
      context: event.context,
    })),
  ).flaggedEventIds;
  return new Set(
    events.filter((event) => flagged.has(event.event_id)).map((event) => event.owner_message_id),
  );
}

function isSessionAttribution(evidence: Record<string, unknown>, sessionId: string): boolean {
  return (
    evidence.session_id === sessionId ||
    (Array.isArray(evidence.session_ids) && evidence.session_ids.includes(sessionId))
  );
}

function whitelistedMeasured(
  detectorId: DetectorId,
  evidence: Record<string, unknown>,
): Record<string, number | string | boolean> {
  if (detectorId === "D2") return { in_long_context_group: true };

  const measured: Record<string, number | string | boolean> = {};
  for (const field of DRIVER_CONFIG[detectorId].fields) {
    const value = evidence[field];
    if (
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      measured[field] = value;
    }
  }
  return measured;
}

function boundedShare(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null;
}

function percentile(db: Db, session: SessionRow): number {
  if (session.last_turn_at === null) return 0;
  const referenceMs = Date.parse(session.last_turn_at);
  if (!Number.isFinite(referenceMs)) return 0;

  const windowStart = new Date(referenceMs - 30 * DAY_MS).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS population_count,
              COALESCE(SUM(CASE WHEN cost_equiv_u <= ? THEN 1 ELSE 0 END), 0) AS at_or_below_count
         FROM sessions
        WHERE last_turn_at >= ? AND last_turn_at <= ?`,
    )
    .get(session.cost_equiv_u, windowStart, session.last_turn_at) as {
    population_count: number;
    at_or_below_count: number;
  };

  if (row.population_count === 0) return 0;
  return Math.round((1000 * row.at_or_below_count) / row.population_count) / 10;
}

const DRIVER_RECOMMENDATIONS_SQL = `SELECT rec_id, detector_id, category, lever, target_metric,
              modeled_savings_u_per_wk, evidence_json,
              contract_version, template_id, contract_status, rule_id, scope_workspace_id
         FROM recommendations
        WHERE state = 'PROPOSED'
          AND detector_id IN ('D2', 'D6', 'D7', 'D8')`;

/** Trusted evidence + the session-attribution test shared by the detail and list surfaces. */
function driverAttribution(
  recommendation: RecommendationRow,
): { evidence: Record<string, unknown>; attributes: (sessionId: string) => boolean } | null {
  const contract = trustedRecommendationContract(recommendation);
  if (contract === null) return null;
  if (contract.version === 1) {
    const evidence = contract.payload.facts as Record<string, unknown>;
    return { evidence, attributes: (sessionId) => isSessionAttribution(evidence, sessionId) };
  }
  const evidence = Object.fromEntries(
    Object.entries(contract.payload.metrics ?? {}).map(([id, metric]) => [
      id.toLowerCase(),
      metric.value,
    ]),
  );
  const anchored = new Set(contract.payload.anchors.map((anchor) => anchor.session_id));
  return { evidence, attributes: (sessionId) => anchored.has(findingIds.session(sessionId)) };
}

/**
 * Return session-attributed detector drivers without exposing transcript content.
 */
export function getSessionDrivers(db: Db, sessionId: string): ApiResponse<SessionDrivers | null> {
  const session = db
    .prepare(
      `SELECT workspace_id, cost_equiv_u, last_turn_at
         FROM sessions
        WHERE session_id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;

  if (session === undefined) {
    return buildResponse(null, {
      claim_kind: "N_A",
      n: 0,
      drilldown_ids: { session_id: sessionId },
    });
  }

  const recommendations = db
    .prepare(`${DRIVER_RECOMMENDATIONS_SQL}
          AND (scope_workspace_id = ? OR scope_workspace_id IS NULL)`)
    .all(session.workspace_id) as RecommendationRow[];

  const drivers: SessionDriver[] = [];
  for (const recommendation of recommendations) {
    const attribution = driverAttribution(recommendation);
    if (attribution === null || !attribution.attributes(sessionId)) continue;
    const { evidence } = attribution;

    const config = DRIVER_CONFIG[recommendation.detector_id];
    const share = boundedShare(
      config.shareField === undefined ? undefined : evidence[config.shareField],
    );
    drivers.push({
      detector_id: recommendation.detector_id,
      label: config.label,
      measured: whitelistedMeasured(recommendation.detector_id, evidence),
      share,
      rec_id: recommendation.rec_id,
      routing: config.routing,
      ...(recommendation.modeled_savings_u_per_wk === null
        ? {}
        : { approx_usd: recommendation.modeled_savings_u_per_wk / 1_000_000 }),
    });
  }

  drivers.sort((a, b) => {
    const savingsDiff = (b.approx_usd ?? 0) - (a.approx_usd ?? 0);
    if (savingsDiff !== 0) return savingsDiff;
    const shareDiff = (b.share ?? 0) - (a.share ?? 0);
    if (shareDiff !== 0) return shareDiff;
    return DETECTOR_ORDER[a.detector_id] - DETECTOR_ORDER[b.detector_id];
  });
  const seenDetectors = new Set<DetectorId>();
  const uniqueDrivers = drivers.filter((driver) => {
    if (seenDetectors.has(driver.detector_id)) return false;
    seenDetectors.add(driver.detector_id);
    return true;
  });
  if (uniqueDrivers.some((driver) => driver.detector_id !== "D6")) {
    const costs = sessionDriverCosts(db, sessionId);
    for (const driver of uniqueDrivers) {
      const cost = costs[driver.detector_id];
      if (cost !== undefined) driver.session_cost_u = cost;
    }
  }

  const toolErrorBreakdown = db
    .prepare(
      `SELECT tool_name, tool_error_class, bash_command_family, COUNT(*) AS count
         FROM tool_events
        WHERE session_id = ? AND tool_error_class IS NOT NULL
        GROUP BY tool_name, tool_error_class, bash_command_family
        ORDER BY count DESC, tool_name, tool_error_class, bash_command_family`,
    )
    .all(sessionId) as NonNullable<SessionDrivers["tool_error_breakdown"]>;

  return buildResponse(
    {
      session_id: sessionId,
      workspace_id: session.workspace_id,
      percentile: percentile(db, session),
      drivers: uniqueDrivers,
      tool_error_breakdown: toolErrorBreakdown,
    },
    {
      claim_kind: "OBS_PROXY",
      n: uniqueDrivers.length,
      drilldown_ids: { session_id: sessionId, workspace_id: session.workspace_id },
      qualification: {
        provisional_excluded: false,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "Per-driver figures are observed proxies; never summed.",
      },
    },
  );
}

export interface SessionTopDriver {
  detector_id: "D2" | "D7" | "D8";
  label: string;
  session_cost_u: number;
}

/**
 * The attributed driver with the largest one-time cost in each session (> 0), else null.
 * Same attribution and costs as `getSessionDrivers`; recommendations are parsed once and
 * `sessionDriverCosts` runs only for sessions with an attributed D2/D7/D8 driver.
 */
export function sessionTopDrivers(
  db: Db,
  sessions: ReadonlyArray<{ session_id: string; workspace_id: string }>,
): Map<string, SessionTopDriver | null> {
  const result = new Map<string, SessionTopDriver | null>(
    sessions.map((session) => [session.session_id, null]),
  );
  if (sessions.length === 0) return result;
  const parsed = (db.prepare(DRIVER_RECOMMENDATIONS_SQL).all() as RecommendationRow[]).flatMap(
    (recommendation) => {
      if (recommendation.detector_id === "D6") return [];
      const attribution = driverAttribution(recommendation);
      return attribution === null ? [] : [{ recommendation, attribution }];
    },
  );
  if (parsed.length === 0) return result;
  for (const session of sessions) {
    const detectors = new Set<DetectorId>();
    for (const { recommendation, attribution } of parsed) {
      const scope = recommendation.scope_workspace_id;
      if (scope !== null && scope !== session.workspace_id) continue;
      if (attribution.attributes(session.session_id)) detectors.add(recommendation.detector_id);
    }
    if (detectors.size === 0) continue;
    const costs = sessionDriverCosts(db, session.session_id, detectors);
    let top: SessionTopDriver | null = null;
    for (const detectorId of [...detectors].sort((a, b) => DETECTOR_ORDER[a] - DETECTOR_ORDER[b])) {
      const cost = costs[detectorId] ?? 0;
      if (cost > 0 && (top === null || cost > top.session_cost_u)) {
        top = {
          detector_id: detectorId as SessionTopDriver["detector_id"],
          label: DRIVER_CONFIG[detectorId].label,
          session_cost_u: cost,
        };
      }
    }
    result.set(session.session_id, top);
  }
  return result;
}
