/**
 * src/query/api/diagnostics-census.ts — the Reliability census behind the Diagnostics triage page
 * (P4 U3a; plan KTD-2 and KTD-3).
 *
 * Figures come from the detectors' own predicates, not from capped rec evidence: C9 blocks from
 * `C9_DENIAL_WHERE`, H1 from the predicate `destructiveToolCalls` uses, the failure families and the
 * C5/D7 loop pool from `wastedTurnCensus`. C6 and G11 have no shared predicate, so they count their
 * in-window V2 anchors, whatever the rec's state; a capped anchor list makes the session count a
 * lower bound. A legacy V1 C6/G11 rec (no `anchors`) counts nothing; the current emitters always
 * write anchors.
 *
 * Pure over (db, window, asOf). The window is [asOf − w days, asOf), end exclusive.
 */

import type { Db } from "../../db/open.js";
import { destructiveRuns } from "../../detector/detectors/h1_destructive_operations.js";
import { findingIds } from "../../detector/privacy-contract.js";
import {
  C9_DENIAL_WHERE,
  type TurnKey,
  type WastedTurnFamily,
  wastedTurnCensus,
} from "../../detector/turn-claim.js";
import { CAUSES } from "./diagnostics-causes.js";

export type WindowDays = 7 | 14 | 30;
export type Trend = "rising" | "steady" | "falling";

const DAY_MS = 86_400_000;
/** Below 5 occurrences in either window, one event moves the rate by ≥20%, so the trend is steady. */
const TREND_FLOOR = 5;
const RISING_RATIO = 1.25;
const FALLING_RATIO = 0.8;
/** V2 evidence keeps at most this many anchors per finding. */
const ANCHOR_CAP = 5;

type Source =
  | { kind: "family"; family: WastedTurnFamily }
  | { kind: "loop" }
  | { kind: "denials" }
  | { kind: "destructive" }
  | { kind: "anchors"; detectorId: string };

/**
 * Each Reliability and risk cause's patterns. A pattern's code is its rule id, so D14's is "D2".
 * The loop pool does not tell C5 from D7_RETRY_LOOP, so the two are one pattern.
 */
const PATTERNS: Readonly<Record<string, ReadonlyArray<{ code: string; source: Source }>>> = {
  BLOCKED_BY_PERMISSIONS: [{ code: "C9", source: { kind: "denials" } }],
  INTERRUPTED_OR_CANCELLED: [{ code: "D2", source: { kind: "family", family: "D14" } }],
  SHELL_FAILS_IN_BURSTS: [{ code: "C7", source: { kind: "family", family: "C7" } }],
  TOOLS_FAIL_MORE_THAN_USUAL: [
    { code: "C1", source: { kind: "family", family: "C1" } },
    { code: "D11", source: { kind: "family", family: "D11" } },
    { code: "G11", source: { kind: "anchors", detectorId: "G11" } },
  ],
  AGENT_REPEATS_SAME_ERROR: [{ code: "D7_RETRY_LOOP+C5", source: { kind: "loop" } }],
  EDITS_FAIL_OR_UNDONE: [
    { code: "C3", source: { kind: "family", family: "C3" } },
    { code: "C4", source: { kind: "family", family: "C4" } },
    { code: "C6", source: { kind: "anchors", detectorId: "C6" } },
  ],
  SEARCHES_FOR_MISSING_CONTENT: [{ code: "C2", source: { kind: "family", family: "C2" } }],
  DESTRUCTIVE_COMMANDS_RAN: [{ code: "H1", source: { kind: "destructive" } }],
};

export interface CensusWindow {
  from: string;
  to: string;
}

export interface CensusRow {
  cause_id: string;
  patterns: Array<{ code: string; count: number }>;
  /** Σ pattern counts, each in its registry unit. */
  occurrences: number;
  sessions_affected: number;
  sessions_affected_is_lower_bound: boolean;
  /** Sessions affected ÷ window sessions; null when the window has no spend or no sessions. */
  share: number | null;
  /** Every affected session, most occurrences first. Anchor sessions with no row stay hashed. */
  sessions: Array<{ session_id: string; occurrences: number }>;
  /** Blocks by classifier label, destructive commands by operation; empty for other causes. */
  breakdown: Array<{ label: string; count: number }>;
  /** Events behind the figure: tool event ids, or ingest event ids for blocks and H1. */
  event_ids: string[];
  trend: Trend;
  previous: { occurrences: number; sessions_affected: number; rate: number | null };
}

export interface ReliabilityCensus {
  window_days: WindowDays;
  as_of: string;
  window: CensusWindow;
  previous_window: CensusWindow;
  tiles: {
    spend_u: number;
    session_count: number;
    /** Sessions affected by any Reliability cause; the risk row is left out. */
    friction_sessions: number;
    friction_share: number | null;
  };
  causes: CensusRow[];
  risk: CensusRow;
}

interface Tally {
  occurrences: number;
  sessions: Map<string, number>;
  lowerBound: boolean;
  eventIds: string[];
  breakdown: Map<string, number>;
}

interface WindowFigures {
  spend: number;
  sessionCount: number;
  tallies: Map<string, Tally>;
}

const newTally = (): Tally => ({
  occurrences: 0,
  sessions: new Map(),
  lowerBound: false,
  eventIds: [],
  breakdown: new Map(),
});

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

const sessionOf = (turn: TurnKey): string => turn.slice(0, turn.indexOf("|"));

function inWindow(ts: unknown, window: CensusWindow): ts is string {
  if (typeof ts !== "string") return false;
  const ms = Date.parse(ts);
  return ms >= Date.parse(window.from) && ms < Date.parse(window.to);
}

function measureWindow(db: Db, window: CensusWindow, now: Date): WindowFigures {
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(cost_equiv_u), 0) AS spend, COUNT(DISTINCT session_id) AS sessions
         FROM turns WHERE ts >= ? AND ts < ?`,
    )
    .get(window.from, window.to) as { spend: number; sessions: number };
  const census = wastedTurnCensus(db, { now, fromIso: window.from, toIso: window.to });

  const denials = db
    .prepare(
      `SELECT e.event_id, e.session_id, e.classifier_label AS label
         FROM ingest_metric_events e
        WHERE e.event_ts >= ? AND e.event_ts < ? AND ${C9_DENIAL_WHERE}`,
    )
    .all(window.from, window.to) as Array<{ event_id: string; session_id: string; label: string }>;
  const destructive = destructiveRuns(db, window.from, window.to).map((run) => ({
    event_id: run.event_id,
    session_id: run.session_id,
    label: run.destructive_op,
  }));

  const anchorSources = new Set<string>();
  for (const patterns of Object.values(PATTERNS))
    for (const { source } of patterns)
      if (source.kind === "anchors") anchorSources.add(source.detectorId);
  const findings = db
    .prepare(
      `SELECT detector_id, evidence_json FROM recommendations
        WHERE provenance = 'RULE' AND detector_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify([...anchorSources])) as Array<{
    detector_id: string;
    evidence_json: string;
  }>;
  let rawSessions: Map<string, string> | null = null;
  const unhash = (hashed: string): string => {
    if (rawSessions === null) {
      rawSessions = new Map();
      for (const { session_id } of db.prepare("SELECT session_id FROM sessions").all() as Array<{
        session_id: string;
      }>)
        rawSessions.set(findingIds.session(session_id), session_id);
    }
    return rawSessions.get(hashed) ?? hashed;
  };

  const tallies = new Map<string, Tally>();
  for (const patterns of Object.values(PATTERNS)) {
    for (const { code, source } of patterns) {
      const tally = newTally();
      tallies.set(code, tally);
      const add = (sessionId: string, eventId?: string): void => {
        tally.occurrences += 1;
        bump(tally.sessions, sessionId);
        if (eventId !== undefined) tally.eventIds.push(eventId);
      };
      switch (source.kind) {
        case "family": {
          for (const turn of census.claims.get(source.family) ?? []) add(sessionOf(turn));
          tally.eventIds.push(...(census.claimEventIds.get(source.family) ?? []));
          break;
        }
        case "loop":
          for (const [eventId, turn] of census.loopExcessEvents) add(sessionOf(turn), eventId);
          break;
        case "denials":
        case "destructive":
          for (const row of source.kind === "denials" ? denials : destructive) {
            add(row.session_id, row.event_id);
            bump(tally.breakdown, row.label);
          }
          break;
        case "anchors":
          for (const finding of findings) {
            if (finding.detector_id !== source.detectorId) continue;
            let anchors: unknown;
            try {
              anchors = (JSON.parse(finding.evidence_json) as { anchors?: unknown }).anchors;
            } catch {
              continue;
            }
            if (!Array.isArray(anchors)) continue;
            let hits = 0;
            for (const anchor of anchors as Array<{ session_id?: unknown; timestamp?: unknown }>) {
              if (!inWindow(anchor.timestamp, window) || typeof anchor.session_id !== "string")
                continue;
              hits += 1;
              add(unhash(anchor.session_id));
            }
            if (hits > 0 && anchors.length >= ANCHOR_CAP) tally.lowerBound = true;
          }
          break;
      }
    }
  }
  return { spend: totals.spend, sessionCount: totals.sessions, tallies };
}

/** A cause's figures in one window: Σ pattern counts, and the union of its sessions. */
function combine(figures: WindowFigures, causeId: string) {
  const sessions = new Map<string, number>();
  const breakdown = new Map<string, number>();
  const eventIds: string[] = [];
  let occurrences = 0;
  let lowerBound = false;
  const patterns = (PATTERNS[causeId] ?? []).map(({ code }) => {
    const tally = figures.tallies.get(code) ?? newTally();
    occurrences += tally.occurrences;
    lowerBound ||= tally.lowerBound;
    for (const [session, n] of tally.sessions) bump(sessions, session, n);
    for (const [label, n] of tally.breakdown) bump(breakdown, label, n);
    eventIds.push(...tally.eventIds);
    return { code, count: tally.occurrences };
  });
  return { patterns, occurrences, sessions, breakdown, eventIds, lowerBound };
}

/** KTD-3: compare session rates; steady below the floor or without a full previous window. */
export function trendOf(
  current: { occurrences: number; rate: number | null },
  previous: { occurrences: number; rate: number | null },
  hasHistory: boolean,
): Trend {
  if (!hasHistory || current.occurrences < TREND_FLOOR || previous.occurrences < TREND_FLOOR)
    return "steady";
  if (current.rate === null || previous.rate === null || previous.rate === 0) return "steady";
  const ratio = current.rate / previous.rate;
  if (ratio >= RISING_RATIO) return "rising";
  if (ratio <= FALLING_RATIO) return "falling";
  return "steady";
}

export function buildReliabilityCensus(
  db: Db,
  windowDays: WindowDays,
  asOf: Date,
): ReliabilityCensus {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const end = asOf.getTime();
  const window = { from: iso(end - windowDays * DAY_MS), to: iso(end) };
  const previousWindow = { from: iso(end - 2 * windowDays * DAY_MS), to: window.from };
  const current = measureWindow(db, window, asOf);
  const previous = measureWindow(db, previousWindow, new Date(window.from));
  const first = (db.prepare("SELECT MIN(ts) AS ts FROM turns").get() as { ts: string | null }).ts;
  const hasHistory = first !== null && Date.parse(previousWindow.from) >= Date.parse(first);
  const shares = current.spend !== 0 && current.sessionCount !== 0;
  const rate = (n: number, of: number): number | null => (of === 0 ? null : n / of);

  const row = (causeId: string): CensusRow => {
    const now = combine(current, causeId);
    const before = combine(previous, causeId);
    const currentRate = rate(now.sessions.size, current.sessionCount);
    const previousRate = rate(before.sessions.size, previous.sessionCount);
    return {
      cause_id: causeId,
      patterns: now.patterns,
      occurrences: now.occurrences,
      sessions_affected: now.sessions.size,
      sessions_affected_is_lower_bound: now.lowerBound,
      share: shares ? now.sessions.size / current.sessionCount : null,
      sessions: [...now.sessions]
        .map(([session_id, occurrences]) => ({ session_id, occurrences }))
        .sort((a, b) => b.occurrences - a.occurrences || a.session_id.localeCompare(b.session_id)),
      breakdown: [...now.breakdown]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      event_ids: now.eventIds,
      trend: trendOf(
        { occurrences: now.occurrences, rate: currentRate },
        { occurrences: before.occurrences, rate: previousRate },
        hasHistory,
      ),
      previous: {
        occurrences: before.occurrences,
        sessions_affected: before.sessions.size,
        rate: previousRate,
      },
    };
  };

  const causes: CensusRow[] = [];
  let risk: CensusRow | null = null;
  for (const cause of CAUSES) {
    if (cause.section === "spend") continue;
    if (PATTERNS[cause.cause_id] === undefined)
      throw new Error(`diagnostics-census: no census patterns for ${cause.cause_id}`);
    if (cause.section === "risk") risk = row(cause.cause_id);
    else causes.push(row(cause.cause_id));
  }
  if (risk === null) throw new Error("diagnostics-census: the registry has no risk cause");

  const friction = new Set<string>();
  for (const cause of causes) for (const { session_id } of cause.sessions) friction.add(session_id);
  return {
    window_days: windowDays,
    as_of: asOf.toISOString(),
    window,
    previous_window: previousWindow,
    tiles: {
      spend_u: current.spend,
      session_count: current.sessionCount,
      friction_sessions: friction.size,
      friction_share: shares ? friction.size / current.sessionCount : null,
    },
    causes,
    risk,
  };
}
