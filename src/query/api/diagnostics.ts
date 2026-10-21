import type { Db } from "../../db/open.js";
import { findingIds } from "../../detector/privacy-contract.js";
/** Privacy-safe, cross-workspace attribution projection for the Diagnostics tab. */
import { getQueryDb } from "../db-context.js";
import { type ApiResponse, buildResponse } from "../envelope.js";
import { trustedRecommendationContract } from "../recommendation-contract.js";

export const DIAGNOSTIC_CATEGORIES = [
  "errors",
  "denials",
  "loops",
  "destructive_ops",
  "token_waste",
] as const;
export type DiagnosticCategory = (typeof DIAGNOSTIC_CATEGORIES)[number];
export interface DiagnosticAnchor {
  session_id: string;
  message_id?: string;
  turn_index?: number;
  timestamp: string;
  label: string;
  ceu: {
    value: number;
    band: "LOW" | "MEDIUM" | "HIGH";
    provenance: "MEASURED" | "ESTIMATED" | "FLOOR";
  } | null;
}
export type SessionDiagnosticAnchor = DiagnosticAnchor & { category: DiagnosticCategory };
export interface DiagnosticCategoryGroup {
  category: DiagnosticCategory;
  anchors: DiagnosticAnchor[];
  sessions_affected: number;
  occurrences: number;
  /** Sum of distinct affected turns' cost_equiv_u, in micro-USD. */
  affected_turn_cost_u: number;
  breakdown: Array<{ label: string; count: number }>;
  sessions: DiagnosticSessionRow[];
  sessions_total: number;
  rec_ids: string[];
}
export interface DiagnosticSessionRow {
  session_id: string;
  title: string | null;
  occurrences: number;
  affected_turn_cost_u: number;
  turn_min: number | null;
  turn_max: number | null;
  anchors: DiagnosticSessionAnchor[];
}
export interface DiagnosticSessionAnchor {
  timestamp: string;
  message_id?: string;
  turn_index?: number;
  tool: string | null;
  label: string;
  context_tokens: number | null;
  cache_write_tokens: number | null;
  result_bytes: number | null;
  cost_u: number | null;
  band: "LOW" | "MEDIUM" | "HIGH" | null;
}
export interface DiagnosticsView {
  window_days: number;
  partial: boolean;
  categories: DiagnosticCategoryGroup[];
  session_count: number;
  workspace_count: number;
}

const CATEGORY_BY_RULE: Record<string, DiagnosticCategory> = {
  C1_TOOL_ERROR_RATE: "errors",
  C4_FAILED_EDIT_RECOVERY_LOOP: "errors",
  C7_BASH_FAILURE_CLUSTER: "errors",
  D2: "errors",
  G11_HIGH_SPEND_OBSERVED_FAILURE: "errors",
  C9_DENIAL_FRICTION: "denials",
  C5_SAME_ERROR_LOOP: "loops",
  C6_EDIT_FLIP_FLOP: "loops",
  H1_DESTRUCTIVE_OPERATION_REPORT: "destructive_ops",
};
export function diagnosticCategoryForRule(ruleId: string): DiagnosticCategory {
  return CATEGORY_BY_RULE[ruleId] ?? "token_waste";
}

/**
 * All-time Diagnostics categories per session (same anchors as `getSessionDiagnostics`: no
 * window, no caps). One projection over every session; categories in DIAGNOSTIC_CATEGORIES order.
 */
export function sessionDiagnosticCategories(db: Db): Map<string, DiagnosticCategory[]> {
  const routeSessionIds = new Map<string, string>();
  for (const { session_id } of db.prepare("SELECT session_id FROM sessions").all() as Array<{
    session_id: string;
  }>) {
    routeSessionIds.set(findingIds.session(session_id), session_id);
  }
  const rows = db
    .prepare(
      "SELECT rec_id, scope_workspace_id, evidence_json, detector_id, category, lever, target_metric, contract_version, template_id, contract_status, rule_id FROM recommendations WHERE rec_id NOT LIKE 'riq-%'",
    )
    .all() as DiagnosticRecommendationRow[];
  const hits = new Map<string, Set<DiagnosticCategory>>();
  projectDiagnosticsRows(rows, {
    routeSessionIds,
    allTime: true,
    collectAnchor: (anchor) => {
      const set = hits.get(anchor.session_id) ?? new Set<DiagnosticCategory>();
      set.add(anchor.category);
      hits.set(anchor.session_id, set);
    },
  });
  return new Map(
    [...hits].map(([id, categories]) => [
      id,
      DIAGNOSTIC_CATEGORIES.filter((category) => categories.has(category)),
    ]),
  );
}
export interface DiagnosticRecommendationRow {
  rec_id: string;
  scope_workspace_id: string | null;
  evidence_json: string;
  detector_id: string | null;
  category: string;
  lever: string;
  target_metric: string;
  contract_version: number | null;
  template_id: string | null;
  contract_status: string;
  rule_id: string | null;
}

export interface DiagnosticProjectionContext {
  partial?: boolean;
  routeSessionIds?: ReadonlyMap<string, string>;
  routeMessageIds?: ReadonlyMap<string, string>;
  workspaceIdsBySession?: ReadonlyMap<string, string>;
  turnsByMessage?: ReadonlyMap<string, { message_id: string; turn_index: number }>;
  turnsByEvent?: ReadonlyMap<string, { message_id: string; turn_index: number }>;
  turnsByIngestEvent?: ReadonlyMap<string, { message_id: string; turn_index: number }>;
  turnsByEventTime?: ReadonlyMap<string, { message_id: string; turn_index: number } | null>;
  sessionTitles?: ReadonlyMap<string, string | null>;
  turnDetails?: ReadonlyMap<
    string,
    {
      context_tokens: number;
      cache_write_tokens: number;
      result_bytes: number | null;
      cost_u: number | null;
    }
  >;
  eventDetails?: ReadonlyMap<string, { tool: string; result_bytes: number | null }>;
  windowDays?: 7 | 14 | 30;
  asOf?: Date;
  /** Internal session projection: retain every matching anchor before aggregate caps. */
  collectAnchor?: (anchor: SessionDiagnosticAnchor) => void;
  allTime?: boolean;
  filterSessionId?: string;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const OWNER_ANCHOR_DETECTORS = new Set(["A1", "C1", "C4", "C5", "C7", "D2", "G11"]);
const eventTimeKey = (sessionId: string, timestamp: string): string =>
  JSON.stringify([sessionId, timestamp]);

/** Project validated V2 envelopes only; legacy or malformed records fail closed. */
/** Pure projection seam: keeps ordering, truncation, and privacy contract testable without UI state. */
export function projectDiagnosticsRows(
  rows: DiagnosticRecommendationRow[],
  context: DiagnosticProjectionContext = {},
): DiagnosticsView {
  const {
    partial = false,
    routeSessionIds = new Map<string, string>(),
    routeMessageIds = new Map<string, string>(),
    workspaceIdsBySession = new Map<string, string>(),
    turnsByMessage = new Map<string, { message_id: string; turn_index: number }>(),
    turnsByEvent = new Map<string, { message_id: string; turn_index: number }>(),
    turnsByIngestEvent = new Map<string, { message_id: string; turn_index: number }>(),
    turnsByEventTime = new Map<string, { message_id: string; turn_index: number } | null>(),
    sessionTitles = new Map<string, string | null>(),
    turnDetails = new Map<
      string,
      {
        context_tokens: number;
        cache_write_tokens: number;
        result_bytes: number | null;
        cost_u: number | null;
      }
    >(),
    eventDetails = new Map<string, { tool: string; result_bytes: number | null }>(),
    windowDays = 7,
    asOf = new Date(),
    collectAnchor,
    allTime = false,
    filterSessionId,
  } = context;
  const asOfMs = asOf.getTime();
  if (Number.isNaN(asOfMs)) throw new TypeError("diagnostic projection asOf must be a valid date");
  const cutoffMs = asOfMs - windowDays * DAY_MS;
  const byCategory = new Map<
    DiagnosticCategory,
    Array<{ anchor: DiagnosticAnchor; detail: DiagnosticSessionAnchor; rec_id: string }>
  >(DIAGNOSTIC_CATEGORIES.map((category) => [category, []]));
  const sessions = new Set<string>();
  const workspaces = new Set<string>();
  for (const row of rows) {
    const contract = trustedRecommendationContract(row);
    if (contract?.version !== 2) continue;
    const category = diagnosticCategoryForRule(contract.payload.rule_id);
    for (const anchor of contract.payload.anchors) {
      if (filterSessionId !== undefined && anchor.session_id !== filterSessionId) continue;
      const anchorMs = new Date(anchor.timestamp).getTime();
      if (!allTime && (anchorMs < cutoffMs || anchorMs > asOfMs)) continue;
      const needsOwner =
        OWNER_ANCHOR_DETECTORS.has(row.detector_id ?? "") || contract.payload.rule_id === "D2";
      const owner =
        (row.detector_id === "C9" || row.detector_id === "H1") && anchor.event_id !== undefined
          ? turnsByIngestEvent.get(anchor.event_id)
          : needsOwner
            ? anchor.event_id !== undefined
              ? turnsByEvent.get(anchor.event_id)
              : anchor.message_id !== undefined
                ? turnsByMessage.get(anchor.message_id)
                : turnsByEventTime.get(eventTimeKey(anchor.session_id, anchor.timestamp))
            : // Any other detector whose anchor names a tool event (e.g. C2) or a turn (e.g. B2/B4)
              // resolves the same way.
              anchor.event_id !== undefined
              ? turnsByEvent.get(anchor.event_id)
              : anchor.message_id !== undefined
                ? turnsByMessage.get(anchor.message_id)
                : undefined;
      const messageId =
        anchor.message_id === undefined
          ? owner?.message_id
          : (routeMessageIds.get(anchor.message_id) ?? anchor.message_id);
      const turnIndex = anchor.turn_index ?? owner?.turn_index;
      const routeSessionId = routeSessionIds.get(anchor.session_id) ?? anchor.session_id;
      sessions.add(routeSessionId);
      const workspaceId = row.scope_workspace_id ?? workspaceIdsBySession.get(anchor.session_id);
      if (workspaceId !== undefined) workspaces.add(workspaceId);
      const projected: DiagnosticAnchor = {
        session_id: routeSessionId,
        ...(messageId === undefined ? {} : { message_id: messageId }),
        ...(turnIndex === undefined ? {} : { turn_index: turnIndex }),
        timestamp: anchor.timestamp,
        label: contract.payload.label,
        ceu: contract.payload.ceu ?? null,
      };
      collectAnchor?.({ ...projected, category });
      const turn =
        messageId === undefined
          ? undefined
          : turnDetails.get(JSON.stringify([routeSessionId, messageId]));
      const event = anchor.event_id === undefined ? undefined : eventDetails.get(anchor.event_id);
      byCategory.get(category)?.push({
        anchor: projected,
        detail: {
          timestamp: anchor.timestamp,
          ...(messageId === undefined ? {} : { message_id: messageId }),
          ...(turnIndex === undefined ? {} : { turn_index: turnIndex }),
          tool: event?.tool ?? null,
          label: contract.payload.label,
          context_tokens: turn?.context_tokens ?? null,
          cache_write_tokens: turn?.cache_write_tokens ?? null,
          result_bytes: event?.result_bytes ?? turn?.result_bytes ?? null,
          cost_u: turn?.cost_u ?? null,
          band: contract.payload.ceu?.band ?? null,
        },
        rec_id: row.rec_id,
      });
    }
  }
  const categories = DIAGNOSTIC_CATEGORIES.map((category): DiagnosticCategoryGroup => {
    const records = byCategory.get(category) ?? [];
    const grouped = new Map<string, typeof records>();
    const labels = new Map<string, number>();
    const recIds = new Set<string>();
    for (const record of records) {
      const sessionId = record.anchor.session_id;
      const sessionRecords = grouped.get(sessionId) ?? [];
      sessionRecords.push(record);
      grouped.set(sessionId, sessionRecords);
      labels.set(record.anchor.label, (labels.get(record.anchor.label) ?? 0) + 1);
      recIds.add(record.rec_id);
    }
    const allSessions = [...grouped].map(([session_id, sessionRecords]): DiagnosticSessionRow => {
      const distinctTurns = new Map<string, number>();
      const turnIndexes: number[] = [];
      for (const { detail } of sessionRecords) {
        if (detail.message_id !== undefined && !distinctTurns.has(detail.message_id)) {
          distinctTurns.set(detail.message_id, detail.cost_u ?? 0);
        }
        if (detail.turn_index !== undefined) turnIndexes.push(detail.turn_index);
      }
      return {
        session_id,
        title: sessionTitles.get(session_id) ?? null,
        occurrences: sessionRecords.length,
        affected_turn_cost_u: [...distinctTurns.values()].reduce((sum, cost) => sum + cost, 0),
        turn_min: turnIndexes.length ? Math.min(...turnIndexes) : null,
        turn_max: turnIndexes.length ? Math.max(...turnIndexes) : null,
        anchors: sessionRecords.map(({ detail }) => detail),
      };
    });
    allSessions.sort(
      (a, b) =>
        b.affected_turn_cost_u - a.affected_turn_cost_u ||
        b.occurrences - a.occurrences ||
        a.session_id.localeCompare(b.session_id),
    );
    return {
      category,
      anchors: records
        .map(({ anchor }) => anchor)
        .sort(
          (a, b) =>
            (b.ceu?.value ?? -1) - (a.ceu?.value ?? -1) ||
            b.timestamp.localeCompare(a.timestamp) ||
            a.session_id.localeCompare(b.session_id),
        )
        .slice(0, 10),
      sessions_affected: grouped.size,
      occurrences: records.length,
      affected_turn_cost_u: allSessions.reduce(
        (sum, session) => sum + session.affected_turn_cost_u,
        0,
      ),
      breakdown: [...labels]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      sessions: allSessions.slice(0, 10),
      sessions_total: grouped.size,
      rec_ids: [...recIds].sort().slice(0, 5),
    };
  });
  return {
    window_days: windowDays,
    partial,
    categories,
    session_count: sessions.size,
    workspace_count: workspaces.size,
  };
}

/** Every validated V2 anchor for one session, without the dashboard window or caps. */
export function getSessionDiagnostics(sessionId: string): ApiResponse<SessionDiagnosticAnchor[]> {
  const db = getQueryDb();
  const session = db
    .prepare("SELECT session_id FROM sessions WHERE session_id = ?")
    .get(sessionId) as { session_id: string } | undefined;
  const anchors: SessionDiagnosticAnchor[] = [];
  if (session !== undefined) {
    const structuralSessionId = findingIds.session(sessionId);
    const routeSessionIds = new Map([[structuralSessionId, sessionId]]);
    const routeMessageIds = new Map<string, string>();
    const turnsByMessage = new Map<string, { message_id: string; turn_index: number }>();
    const turnsByEvent = new Map<string, { message_id: string; turn_index: number }>();
    const turnsByIngestEvent = new Map<string, { message_id: string; turn_index: number }>();
    const turnsByEventTime = new Map<string, { message_id: string; turn_index: number } | null>();
    const turns = db
      .prepare("SELECT message_id FROM turns WHERE session_id = ? ORDER BY ts, message_id")
      .all(sessionId) as Array<{ message_id: string }>;
    turns.forEach((turn, turn_index) => {
      const key = findingIds.message(turn.message_id);
      routeMessageIds.set(key, turn.message_id);
      turnsByMessage.set(key, { message_id: turn.message_id, turn_index });
    });
    const events = db
      .prepare(`SELECT e.event_id, e.ts, m.owner_message_id
        FROM tool_events e
        JOIN tool_event_metadata m ON m.event_id = e.event_id
        JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
        WHERE e.session_id = ?`)
      .all(sessionId) as Array<{ event_id: string; ts: string; owner_message_id: string }>;
    for (const event of events) {
      const owner = turnsByMessage.get(findingIds.message(event.owner_message_id));
      if (owner === undefined) continue;
      turnsByEvent.set(findingIds.event(event.event_id), owner);
      const key = eventTimeKey(structuralSessionId, event.ts);
      if (turnsByEventTime.has(key)) turnsByEventTime.set(key, null);
      else turnsByEventTime.set(key, owner);
    }
    const ingestEvents = db
      .prepare(`SELECT e.event_id,
        (SELECT t.message_id FROM turns t
         WHERE t.session_id = e.session_id AND t.ts <= e.event_ts
         ORDER BY t.ts DESC, t.message_id DESC LIMIT 1) AS owner_message_id
        FROM ingest_metric_events e
        WHERE e.session_id = ? AND e.event_ts IS NOT NULL AND e.is_sidechain = 0
          AND (e.destructive_op IS NOT NULL
            OR e.classifier_label IN ('hook-block', 'deny-rule', 'user-rejected'))`)
      .all(sessionId) as Array<{ event_id: string; owner_message_id: string | null }>;
    for (const event of ingestEvents) {
      if (event.owner_message_id === null) continue;
      const owner = turnsByMessage.get(findingIds.message(event.owner_message_id));
      if (owner !== undefined) turnsByIngestEvent.set(findingIds.event(event.event_id), owner);
    }
    const rows = db
      .prepare(
        "SELECT rec_id, scope_workspace_id, evidence_json, detector_id, category, lever, target_metric, contract_version, template_id, contract_status, rule_id FROM recommendations WHERE rec_id NOT LIKE 'riq-%'",
      )
      .all() as DiagnosticRecommendationRow[];
    projectDiagnosticsRows(rows, {
      routeSessionIds,
      routeMessageIds,
      turnsByMessage,
      turnsByEvent,
      turnsByIngestEvent,
      turnsByEventTime,
      allTime: true,
      filterSessionId: structuralSessionId,
      collectAnchor: (anchor) => anchors.push(anchor),
    });
    anchors.sort(
      (a, b) =>
        (a.turn_index ?? Number.POSITIVE_INFINITY) - (b.turn_index ?? Number.POSITIVE_INFINITY) ||
        a.timestamp.localeCompare(b.timestamp),
    );
  }
  return buildResponse(anchors, {
    claim_kind: "OBS_PROXY",
    n: anchors.length,
    drilldown_ids: { session_id: sessionId },
  });
}
