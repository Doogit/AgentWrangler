/** Per-session, privacy-safe detector attribution. */

import type { Db } from "../../db/open.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";

export interface SessionDriver {
  detector_id: "D2" | "D6" | "D7" | "D8";
  label: string;
  measured: Record<string, number | string | boolean>;
  share: number | null;
  rec_id: string;
  routing: "rec_card" | "hook";
  approx_usd?: number;
}

export interface SessionDrivers {
  session_id: string;
  workspace_id: string;
  percentile: number;
  drivers: SessionDriver[];
}

type DetectorId = SessionDriver["detector_id"];

interface SessionRow {
  workspace_id: string;
  cost_equiv_u: number;
  last_turn_at: string | null;
}

interface RecommendationRow {
  rec_id: string;
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
    routing: "hook",
  },
  D8: {
    label: "CACHE_WRITE_CHURN",
    fields: ["churn_event_count", "total_churn_creation_tokens", "creation_share", "regime"],
    shareField: "creation_share",
    routing: "hook",
  },
};

function parseEvidence(evidenceJson: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(evidenceJson);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
    .prepare(
      `SELECT rec_id, detector_id, modeled_savings_u_per_wk, evidence_json
         FROM recommendations
        WHERE state = 'PROPOSED'
          AND detector_id IN ('D2', 'D6', 'D7', 'D8')
          AND (scope_workspace_id = ? OR scope_workspace_id IS NULL)`,
    )
    .all(session.workspace_id) as RecommendationRow[];

  const drivers: SessionDriver[] = [];
  for (const recommendation of recommendations) {
    const evidence = parseEvidence(recommendation.evidence_json);
    if (evidence === null || !isSessionAttribution(evidence, sessionId)) continue;

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

  return buildResponse(
    {
      session_id: sessionId,
      workspace_id: session.workspace_id,
      percentile: percentile(db, session),
      drivers,
    },
    {
      claim_kind: "OBS_PROXY",
      n: drivers.length,
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
