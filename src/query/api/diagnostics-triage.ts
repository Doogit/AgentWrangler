/**
 * src/query/api/diagnostics-triage.ts — the Diagnostics triage view (P4 U3b; plan KTD-4/5/7/8/11 and
 * the `DiagnosticsTriageView` contract).
 *
 * Reliability figures come from the U3a census and are only shaped here: titles, the session-list
 * sort, plain-English labels, one count unit per row, the most frequent commands and the wait cost.
 * Avoidable causes are counted from findings, whatever the rec's state: V2 anchors in the window, and
 * V1 session lists whose fired week (`detector_week_results`) overlaps it. Their dollars come from an
 * `AvoidableProvider`, which returns "not estimated" until P3.L. Hand-offs are joined at GET time
 * (U4), so every `handoff` is null here.
 *
 * Pure over (db, window, asOf). The window is [asOf − w days, asOf), end exclusive.
 */

import type { Db } from "../../db/open.js";
import { SPEND_LANE_DETECTOR_IDS } from "../../detector/claim-ledger.js";
import { findingIds } from "../../detector/privacy-contract.js";
import { C9_DENIAL_WHERE } from "../../detector/turn-claim.js";
import type { AvoidableCauseFigure, AvoidableProvider } from "./diagnostics-avoidable.js";
import { CAUSES, type Cause, EXCLUDED_KEYS, causeForKey } from "./diagnostics-causes.js";
import {
  type CensusRow,
  type CensusWindow,
  type Trend,
  type WindowDays,
  buildReliabilityCensus,
  trendOf,
} from "./diagnostics-census.js";
import { ledgerDailyProvider, ledgerReliabilityU } from "./ledger-daily-provider.js";
import { type EvidenceAnchor, anchoredToolCalls, commandText, shellFamily } from "./tool-calls.js";

// ── Contract ──────────────────────────────────────────────────────────────────

export interface DiagnosticsTriageView {
  window_days: WindowDays;
  as_of: string;
  built_at: string;
  partial: boolean;
  /** F9: the recs snapshot isn't built yet, so hand-offs are unknown (not "no fix"). */
  handoffs_pending?: boolean;
  tiles: {
    spend_u: number;
    session_count: number;
    avoidable_u: number | null;
    avoidable_share: number | null;
    /** ISO of the UTC midnight the Avoidable $ runs through (whole days); null when not estimated. */
    avoidable_through?: string | null;
    friction_sessions: number;
    friction_share: number | null;
    fix_ready: { n: number; m: number };
  };
  avoidable: {
    banner: { not_estimated_count: number } | null;
    causes: AvoidableRow[];
    /** RC-B U3: the section's causes with no row in this window. Optional for older payloads. */
    silent?: SilentCause[];
  };
  reliability: { causes: ReliabilityRow[]; risk: RiskRow | null; silent?: SilentCause[] };
}

/** A watched cause that found nothing in the window (RC-B U3 coverage line). */
export interface SilentCause {
  cause_id: string;
  name: string;
}

export interface CauseRowBase {
  cause_id: string;
  name: string;
  explanation: string;
  rank: number;
  featured: boolean;
  trend: Trend;
  trend_basis: "spend_share" | "session_rate";
  /** Joined at GET time (KTD-7, U4); always null in the build. */
  handoff: { rec_id: string; label: string } | null;
  /** RC-B, joined at GET time: no hand-off, but a PROPOSED rec for this cause sits in recs history. */
  fix_quiet?: boolean;
  /** RC-B: with `fix_quiet`, the largest such history card, so "No fix this week" can link to it. */
  quiet_rec_id?: string;
  /** RC-B, joined at GET time: the hand-off is a recs `below_floor` card (no active card for this cause). */
  fix_small?: boolean;
  /** `code` is shown only in a tooltip (R11). Patterns with no occurrences are left out. */
  patterns: Array<{ label: string; code: string; count: number }>;
  sessions_affected: number;
  sessions_affected_is_lower_bound: boolean;
  /** Every affected session: most occurrences first, then the most recent (KTD-9). */
  sessions: Array<{
    session_id: string;
    title: string | null;
    occurrences: number;
    /** Ledger µ$ for the session; set on Avoidable rows with a ledger figure. */
    avoidable_u?: number;
  }>;
  occurrences: number;
  count_unit: string;
}

export interface AvoidableRow extends CauseRowBase {
  share: number | null;
  avoidable_u: number | null;
  /**
   * F9: µ$/wk from the cause's own findings when none of its detectors has a ledger producer (E1).
   * It overlaps other causes, so it stays out of the Avoidable tile and the ranking.
   */
  standalone_u?: number | null;
  coverage: "ALL" | "PARTIAL" | null;
  folded: boolean;
  when: {
    buckets: number[];
    weight: "occurrences" | "spend";
    heaviest: "early" | "middle" | "late";
  } | null;
  example: {
    session_id: string;
    title: string | null;
    message_id?: string;
    turn_index?: number;
    text: string | null;
    figure_line: string;
  } | null;
}

export interface ReliabilityRow extends CauseRowBase {
  /** % of sessions; null when the window has no spend or no sessions. */
  share: number | null;
  breakdown: Array<{ label: string; count: number }>;
  /**
   * RC-A: the cause's tool events by tool name. Optional for older payloads. Some claimed turns have
   * no tool event (re-plan turns), so this need not sum to `occurrences`.
   */
  by_tool?: Array<{ label: string; count: number }>;
  top_commands: Array<{ text: string; count: number }>;
  cost: { wait_ms: number | null; replan_u: number | null };
}

/** The risk row: outside the ranking (`rank` 0, shown as "!"), never featured, no cost. */
export interface RiskRow extends Omit<ReliabilityRow, "cost"> {
  risk: true;
}

// ── Wire (U4 route, U5 page) ──────────────────────────────────────────────────

/** Progress of a running build (R27). `step` counts finished stages out of `steps`. */
export interface DiagnosticsBuildProgress {
  /** Plain-English label of the running stage, e.g. "Counting failed and blocked commands". */
  stage: string;
  step: number;
  steps: number;
  started_at: string;
  /** The window's last logged build duration; null on the first build. */
  expected_ms: number | null;
}

/** A cold window: returned at once while the first build runs; the UI polls. */
export interface DiagnosticsBuilding {
  status: "building";
  window_days: WindowDays;
  progress: DiagnosticsBuildProgress;
}

/** A served snapshot, with hand-offs and `fix_ready` joined at GET time (KTD-7). */
export interface DiagnosticsReady extends DiagnosticsTriageView {
  status?: "ready";
  /** When the served snapshot was built. */
  snapshot_at?: string;
  /** True while a rebuild runs behind this (stale) snapshot. */
  refreshing?: boolean;
}

/** `data` of `GET /api/diagnostics?window=7|14|30`. */
export type DiagnosticsPayload = DiagnosticsReady | DiagnosticsBuilding;

export interface TriageOptions {
  provider?: AvoidableProvider;
  /** An unknown finding key is logged here and skipped. */
  warn?: (message: string) => void;
  /** Each build stage's duration (R27 timing; U4 reports progress from it). */
  onStage?: (stage: string, ms: number) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** V2 evidence keeps at most 5 anchors per finding, V1 at most 20 session ids. */
const ANCHOR_CAP = 5;
const V1_SESSION_CAP = 20;
/** An answer later than this means you were away, not held up (KTD-8). */
const WAIT_CAP_MS = 30 * 60_000;
/** Most events read back from transcripts per cause per build (KTD-8). */
const MAX_EVENTS = 300;
const TOP_COMMANDS = 3;
const FOLD_SHARE = 0.005;
const BANNER_SHARE = 0.01;
const BUCKETS = 6;

const BREAKDOWN_LABELS: Readonly<Record<string, string>> = {
  "hook-block": "hook",
  "deny-rule": "deny rule",
  "user-rejected": "rejected by you",
  "rm-rf": "rm -rf",
  "git-reset-hard": "git reset --hard",
  "git-clean": "git clean",
  "sql-drop": "DROP TABLE",
  truncate: "TRUNCATE",
};

const EXCLUDED = new Set(EXCLUDED_KEYS.map((k) => `${k.detector_id}\0${k.id}`));

const n = (value: number): string => Math.round(value).toLocaleString("en-US");

/** One plain line from a V1 finding's stored facts (KTD-8), or null for an unknown template. */
const FACT_LINES: Readonly<Record<string, (f: Record<string, number>) => string>> = {
  D1_CONTEXT_ALWAYS_LOADED: (f) =>
    `Always-loaded context adds ${n(f.delta_context_tokens ?? 0)} tokens to every turn`,
  D2_LONG_FULL_CONTEXT: (f) =>
    `${n(f.qualifying_session_count ?? 0)} long sessions averaged ${n(f.raw_context_average_tokens_per_turn ?? 0)} context tokens a turn`,
  D4_MODEL_MISMATCH: (f) =>
    `${n(f.mismatch_turns_per_week ?? 0)} of ${n(f.total_opus_turns_per_week ?? 0)} Opus turns a week were lookup work`,
  D6_TOOL_RESULT_BLOAT: (f) =>
    `Tool output was ${n((f.bloat_share ?? 0) * 100)}% of context across ${n(f.session_count ?? 0)} sessions`,
  D7_CROSS_SESSION_REREAD: (f) =>
    `${n(f.redundant_path_count ?? 0)} files were re-read ${n(f.total_redundant_read_count ?? 0)} times across sessions`,
  D8_CACHE_WRITE_CHURN: (f) =>
    `The cache was rebuilt ${n(f.churn_event_count ?? 0)} times across ${n(f.session_count ?? 0)} sessions`,
  D9_BACKGROUND_SESSION: (f) => `${n(f.fork_count ?? 0)} subagents were forked with full context`,
  D10_CATALOG_FOOTPRINT: (f) =>
    `${n(f.always_load_count ?? 0)} of ${n(f.catalog_item_count ?? 0)} catalog entries always load (${n(f.catalog_tokens ?? 0)} tokens)`,
  D12_SUBAGENT_OVERSPAWN: (f) =>
    `Subagents returned ${n((f.sidechain_result_bytes ?? 0) / 1024)} KB across ${n(f.sidechain_turn_count ?? 0)} turns`,
};

// ── Avoidable findings ────────────────────────────────────────────────────────

interface FindingRow {
  rec_id: string;
  detector_id: string;
  rule_id: string | null;
  template_id: string | null;
  contract_status: string;
  scope_workspace_id: string | null;
  evidence_json: string;
  modeled_savings_u_per_wk: number | null;
}

interface AnchorHit {
  /** Raw session id, or the hashed one when no session row matches. */
  session_id: string;
  timestamp: string;
  event_id?: string;
  message_id?: string;
}

interface V1Hit {
  template_id: string;
  session_ids: string[];
  facts: Record<string, unknown>;
  savings_u: number | null;
}

interface SpendTally {
  /** Pattern code → affected sessions (raw ids) in registry key order. */
  patterns: Map<string, Set<string>>;
  lowerBound: boolean;
  anchors: AnchorHit[];
  v1: V1Hit[];
  /** Raw tool event ids of D7's most-read files (turn positions only). */
  readEventIds: string[];
  /** Σ modeled µ$/wk of the findings counted in the window; null when none has one. */
  modeledU: number | null;
}

/** The detector id, except where it is ambiguous: D2 would read as D14's rule "D2", D7 has two keys. */
const spendCode = (detectorId: string, id: string): string =>
  detectorId === "D2" || detectorId === "D7" ? id : detectorId;

function spendFindings(
  rows: FindingRow[],
  weeks: Array<{ detector_id: string; ws: string | null; week_start: string }>,
  window: CensusWindow,
  unhash: (hashed: string) => string,
  warn: ((message: string) => void) | null,
): Map<string, SpendTally> {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const inWindow = (ts: unknown): ts is string =>
    typeof ts === "string" && Date.parse(ts) >= from && Date.parse(ts) < to;
  const tallies = new Map<string, SpendTally>();
  for (const row of rows) {
    const id = row.rule_id ?? row.template_id ?? "";
    if (EXCLUDED.has(`${row.detector_id}\0${id}`)) continue;
    let cause: Cause;
    try {
      cause = causeForKey(row.detector_id, id);
    } catch {
      warn?.(
        `diagnostics-triage: skipped finding ${row.rec_id} with unknown key (${row.detector_id}, ${id})`,
      );
      continue;
    }
    if (cause.section !== "spend") continue;
    let evidence: Record<string, unknown>;
    try {
      evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    let tally = tallies.get(cause.cause_id);
    if (tally === undefined) {
      tally = {
        patterns: new Map(),
        lowerBound: false,
        anchors: [],
        v1: [],
        readEventIds: [],
        modeledU: null,
      };
      for (const key of cause.keys)
        tally.patterns.set(spendCode(key.detector_id, key.id), new Set());
      tallies.set(cause.cause_id, tally);
    }
    const sessions = tally.patterns.get(spendCode(row.detector_id, id)) as Set<string>;
    if (Array.isArray(evidence.anchors)) {
      const anchors = evidence.anchors as Array<Record<string, unknown>>;
      let hits = 0;
      for (const anchor of anchors) {
        if (!inWindow(anchor.timestamp) || typeof anchor.session_id !== "string") continue;
        hits += 1;
        const session_id = unhash(anchor.session_id);
        sessions.add(session_id);
        tally.anchors.push({
          session_id,
          timestamp: anchor.timestamp,
          ...(typeof anchor.event_id === "string" ? { event_id: anchor.event_id } : {}),
          ...(typeof anchor.message_id === "string" ? { message_id: anchor.message_id } : {}),
        });
      }
      if (hits > 0 && anchors.length >= ANCHOR_CAP) tally.lowerBound = true;
      if (hits > 0) addModeled(tally, row.modeled_savings_u_per_wk);
    } else if (row.contract_status === "V1_VALIDATED") {
      const overlaps = weeks.some(
        (week) =>
          week.detector_id === row.detector_id &&
          week.ws === row.scope_workspace_id &&
          Date.parse(week.week_start) < to &&
          Date.parse(week.week_start) + 7 * DAY_MS > from,
      );
      if (!overlaps) continue;
      const facts = (evidence.facts ?? {}) as Record<string, unknown>;
      const ids = Array.isArray(facts.session_ids)
        ? facts.session_ids.filter((s): s is string => typeof s === "string")
        : [];
      for (const s of ids) sessions.add(s);
      if (ids.length >= V1_SESSION_CAP) tally.lowerBound = true;
      addModeled(tally, row.modeled_savings_u_per_wk);
      tally.v1.push({
        template_id: id,
        session_ids: ids,
        facts,
        savings_u: row.modeled_savings_u_per_wk,
      });
      if (Array.isArray(facts.top_read_event_ids))
        for (const e of facts.top_read_event_ids)
          if (typeof e === "string") tally.readEventIds.push(e);
    }
  }
  return tallies;
}

function addModeled(tally: SpendTally, modeledU: number | null): void {
  if (modeledU !== null && modeledU > 0) tally.modeledU = (tally.modeledU ?? 0) + modeledU;
}

/** Σ each pattern's distinct sessions (the unit is sessions), and the union of sessions. */
function spendFigures(tally: SpendTally | undefined) {
  const perSession = new Map<string, number>();
  let occurrences = 0;
  for (const sessions of tally?.patterns.values() ?? []) {
    occurrences += sessions.size;
    for (const s of sessions) perSession.set(s, (perSession.get(s) ?? 0) + 1);
  }
  return { occurrences, perSession };
}

// ── Turn positions ────────────────────────────────────────────────────────────

interface TurnRef {
  session_id: string;
  message_id: string;
  index: number;
  count: number;
  cost_u: number;
  context_tokens: number;
}

interface EventRef {
  event_id: string;
  ts: string;
  tool: string;
  result_bytes: number | null;
  turn: TurnRef;
}

/** Turns and owned tool events of the given sessions, keyed by hashed and raw ids. */
function loadPositions(db: Db, sessionIds: string[], rawEventIds: string[]) {
  const turnsByHash = new Map<string, TurnRef>();
  const turnsByRaw = new Map<string, TurnRef>();
  const eventsByHash = new Map<string, EventRef>();
  const eventsByRaw = new Map<string, EventRef>();
  const extraSessions = db
    .prepare(
      "SELECT DISTINCT session_id FROM tool_events WHERE event_id IN (SELECT value FROM json_each(?))",
    )
    .all(JSON.stringify(rawEventIds)) as Array<{ session_id: string }>;
  const sessions = JSON.stringify([
    ...new Set([...sessionIds, ...extraSessions.map((r) => r.session_id)]),
  ]);
  const turns = db
    .prepare(
      `SELECT session_id, message_id, COALESCE(cost_equiv_u, 0) AS cost_u, context_tokens
         FROM turns WHERE session_id IN (SELECT value FROM json_each(?))
        ORDER BY session_id, ts, message_id`,
    )
    .all(sessions) as Array<Omit<TurnRef, "index" | "count">>;
  const counts = new Map<string, number>();
  for (const t of turns) counts.set(t.session_id, (counts.get(t.session_id) ?? 0) + 1);
  const next = new Map<string, number>();
  for (const t of turns) {
    const index = next.get(t.session_id) ?? 0;
    next.set(t.session_id, index + 1);
    const ref = { ...t, index, count: counts.get(t.session_id) ?? 1 };
    turnsByRaw.set(`${t.session_id}\0${t.message_id}`, ref);
    turnsByHash.set(findingIds.message(t.message_id), ref);
  }
  const events = db
    .prepare(
      `SELECT e.event_id, e.session_id, e.ts, e.tool_name AS tool, e.result_bytes,
              m.owner_message_id
         FROM tool_events e JOIN tool_event_metadata m ON m.event_id = e.event_id
        WHERE e.session_id IN (SELECT value FROM json_each(?))`,
    )
    .all(sessions) as Array<{
    event_id: string;
    session_id: string;
    ts: string;
    tool: string;
    result_bytes: number | null;
    owner_message_id: string;
  }>;
  for (const e of events) {
    const turn = turnsByRaw.get(`${e.session_id}\0${e.owner_message_id}`);
    if (turn === undefined) continue;
    const ref = {
      event_id: e.event_id,
      ts: e.ts,
      tool: e.tool,
      result_bytes: e.result_bytes,
      turn,
    };
    eventsByRaw.set(e.event_id, ref);
    eventsByHash.set(findingIds.event(e.event_id), ref);
  }
  return { turnsByHash, eventsByHash, eventsByRaw };
}

const bucketOf = (turn: TurnRef): number =>
  Math.min(BUCKETS - 1, Math.floor((turn.index * BUCKETS) / turn.count));

function whenFromBuckets(
  buckets: number[],
  weight: "occurrences" | "spend",
): NonNullable<AvoidableRow["when"]> {
  const thirds = [0, 2, 4].map((i) => (buckets[i] ?? 0) + (buckets[i + 1] ?? 0));
  const heaviest = (["early", "middle", "late"] as const)[thirds.indexOf(Math.max(...thirds))];
  return { buckets, weight, heaviest: heaviest ?? "early" };
}

function whenOf(turns: TurnRef[]): AvoidableRow["when"] {
  if (turns.length === 0) return null;
  const buckets = new Array<number>(BUCKETS).fill(0);
  for (const turn of turns) buckets[bucketOf(turn)] = (buckets[bucketOf(turn)] ?? 0) + 1;
  return whenFromBuckets(buckets, "occurrences");
}

// ── Commands ──────────────────────────────────────────────────────────────────

/** A cause's tool events by tool name, largest first. Ingest event ids (blocks, H1) match none. */
function toolBreakdown(db: Db, eventIds: string[]): Array<{ label: string; count: number }> {
  if (eventIds.length === 0) return [];
  return db
    .prepare(
      `SELECT tool_name AS label, COUNT(*) AS count FROM tool_events
        WHERE event_id IN (SELECT value FROM json_each(?))
        GROUP BY tool_name ORDER BY count DESC, tool_name`,
    )
    .all(JSON.stringify(eventIds)) as Array<{ label: string; count: number }>;
}

/**
 * The most frequent commands behind a cause's events. Shell failures group their stored command by
 * family; events with no stored command (blocks, interrupts, destructive commands) are read back
 * from transcripts, newest first, at most `MAX_EVENTS`.
 */
function topCommands(db: Db, eventIds: string[]): ReliabilityRow["top_commands"] {
  if (eventIds.length === 0) return [];
  const ids = JSON.stringify(eventIds);
  const groups = new Map<string, { count: number; texts: Set<string> }>();
  const add = (key: string, text: string, count: number): void => {
    const group = groups.get(key) ?? { count: 0, texts: new Set<string>() };
    group.count += count;
    group.texts.add(text);
    groups.set(key, group);
  };
  const stored = db
    .prepare(
      `SELECT event_id, json_extract(content_json, '$.command') AS command FROM tool_event_content
        WHERE event_id IN (SELECT value FROM json_each(?))`,
    )
    .all(ids) as Array<{ event_id: string; command: unknown }>;
  const done = new Set<string>();
  for (const row of stored) {
    if (typeof row.command !== "string" || row.command.trim() === "") continue;
    done.add(row.event_id);
    add(shellFamily(row.command), commandText(row.command), 1);
  }
  const rest = JSON.stringify(eventIds.filter((id) => !done.has(id)));
  const anchors: EvidenceAnchor[] = (
    db
      .prepare(
        `SELECT event_id, session_id, ts FROM tool_events
          WHERE event_id IN (SELECT value FROM json_each(?))
         UNION ALL
         SELECT event_id, session_id, event_ts FROM ingest_metric_events
          WHERE event_id IN (SELECT value FROM json_each(?))
         ORDER BY ts DESC LIMIT ${MAX_EVENTS}`,
      )
      .all(rest, rest) as Array<{ event_id: string; session_id: string; ts: string }>
  ).map((row) => ({
    event_id: findingIds.event(row.event_id),
    session_id: findingIds.session(row.session_id),
    timestamp: row.ts,
  }));
  for (const call of anchoredToolCalls(db, anchors))
    add(call.kind === "command" ? shellFamily(call.target) : call.target, call.target, call.calls);
  return [...groups]
    .map(([key, g]) => ({
      text: g.texts.size === 1 ? ([...g.texts][0] ?? key) : key,
      count: g.count,
    }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, TOP_COMMANDS);
}

/** KTD-8: Σ over user rejections of the time since the latest `HUMAN_DENY`, each capped at 30 min. */
function waitMs(db: Db, window: CensusWindow): number {
  const rows = db
    .prepare(
      `SELECT e.event_ts,
              (SELECT MAX(h.ts) FROM tool_events h
                WHERE h.session_id = e.session_id AND h.interrupt_kind = 'HUMAN_DENY'
                  AND h.ts <= e.event_ts) AS deny_ts
         FROM ingest_metric_events e
        WHERE e.event_ts >= ? AND e.event_ts < ? AND ${C9_DENIAL_WHERE}
          AND e.classifier_label = 'user-rejected'`,
    )
    .all(window.from, window.to) as Array<{ event_ts: string; deny_ts: string | null }>;
  return rows.reduce(
    (sum, r) =>
      r.deny_ts === null
        ? sum
        : sum + Math.min(Date.parse(r.event_ts) - Date.parse(r.deny_ts), WAIT_CAP_MS),
    0,
  );
}

// ── Build ─────────────────────────────────────────────────────────────────────

function countUnit(cause: Cause): string {
  const units = new Set(cause.keys.map((k) => k.count_unit));
  return units.size === 1 ? (cause.keys[0]?.count_unit ?? "occurrences") : "occurrences";
}

/** A census pattern code ("C9", "D2", "D7_RETRY_LOOP+C5") → its registry label. */
function censusLabel(cause: Cause, code: string): string {
  const parts = code.split("+");
  const key = cause.keys.find((k) => parts.includes(k.detector_id) || parts.includes(k.id));
  return key?.pattern_label ?? code;
}

export function buildDiagnosticsTriage(
  db: Db,
  windowDays: WindowDays,
  asOf: Date,
  options: TriageOptions = {},
): DiagnosticsTriageView {
  const { provider = ledgerDailyProvider(db), warn = console.warn, onStage } = options;
  let mark = performance.now();
  const stage = (name: string): void => {
    const now = performance.now();
    onStage?.(name, now - mark);
    mark = now;
  };

  const census = buildReliabilityCensus(db, windowDays, asOf);
  stage("census");

  const sessionRows = db
    .prepare("SELECT session_id, title, last_turn_at FROM sessions")
    .all() as Array<{ session_id: string; title: string | null; last_turn_at: string | null }>;
  const sessionInfo = new Map(sessionRows.map((s) => [s.session_id, s]));
  const raw = new Map<string, string>(
    sessionRows.map((s) => [findingIds.session(s.session_id), s.session_id]),
  );
  const unhash = (hashed: string): string => raw.get(hashed) ?? hashed;
  const titleOf = (id: string): string | null => sessionInfo.get(id)?.title ?? null;
  const sessionList = (perSession: Map<string, number>) =>
    [...perSession]
      .map(([session_id, occurrences]) => ({ session_id, title: titleOf(session_id), occurrences }))
      .sort(
        (a, b) =>
          b.occurrences - a.occurrences ||
          (sessionInfo.get(b.session_id)?.last_turn_at ?? "").localeCompare(
            sessionInfo.get(a.session_id)?.last_turn_at ?? "",
          ) ||
          a.session_id.localeCompare(b.session_id),
      );

  const findings = db
    .prepare(
      `SELECT rec_id, detector_id, rule_id, template_id, contract_status, scope_workspace_id,
              evidence_json, modeled_savings_u_per_wk
         FROM recommendations WHERE provenance = 'RULE'`,
    )
    .all() as FindingRow[];
  const weeks = db
    .prepare(
      "SELECT detector_id, scope_workspace_id AS ws, week_start FROM detector_week_results WHERE fired = 1",
    )
    .all() as Array<{ detector_id: string; ws: string | null; week_start: string }>;
  const current = spendFindings(findings, weeks, census.window, unhash, warn);
  const previous = spendFindings(findings, weeks, census.previous_window, unhash, null);
  const prevTotals = db
    .prepare(
      `SELECT COALESCE(SUM(cost_equiv_u), 0) AS spend, COUNT(DISTINCT session_id) AS sessions
         FROM turns WHERE ts >= ? AND ts < ?`,
    )
    .get(census.previous_window.from, census.previous_window.to) as {
    spend: number;
    sessions: number;
  };
  const first = (db.prepare("SELECT MIN(ts) AS ts FROM turns").get() as { ts: string | null }).ts;
  const hasHistory = first !== null && Date.parse(census.previous_window.from) >= Date.parse(first);
  stage("findings");

  // OD-U8-1: the ledger $ covers whole UTC days [E-w, E); every $ ratio divides by spend over those days.
  const midnight = Math.floor(asOf.getTime() / DAY_MS) * DAY_MS;
  const spendBetween = db.prepare(
    "SELECT COALESCE(SUM(cost_equiv_u), 0) AS spend FROM turns WHERE ts >= ? AND ts < ?",
  );
  const ledgerFrom = midnight - windowDays * DAY_MS;
  const ledgerPrevFrom = midnight - 2 * windowDays * DAY_MS;
  const iso = (ms: number): string => new Date(ms).toISOString();
  const ledgerSpend = (spendBetween.get(iso(ledgerFrom), iso(midnight)) as { spend: number }).spend;
  const prevLedgerSpend = (
    spendBetween.get(iso(ledgerPrevFrom), iso(ledgerFrom)) as { spend: number }
  ).spend;
  const hasLedgerHistory = first !== null && ledgerPrevFrom >= Date.parse(first);

  const { spend_u: spend, session_count: sessionCount } = census.tiles;
  const shares = spend !== 0 && sessionCount !== 0;
  const ledgerShares = shares && ledgerSpend !== 0;
  const positions = loadPositions(
    db,
    [...new Set([...current.values()].flatMap((t) => t.anchors.map((a) => a.session_id)))],
    [...current.values()].flatMap((t) => t.readEventIds),
  );
  const spendBySession = db.prepare(
    `SELECT session_id, SUM(cost_equiv_u) AS spend FROM turns
      WHERE session_id IN (SELECT value FROM json_each(?)) AND ts >= ? AND ts < ?
      GROUP BY session_id ORDER BY spend DESC, session_id LIMIT 1`,
  );
  const figures = provider(windowDays, asOf);

  const avoidableRows: AvoidableRow[] = [];
  for (const cause of CAUSES) {
    if (cause.section !== "spend") continue;
    const tally = current.get(cause.cause_id);
    const now = spendFigures(tally);
    const before = spendFigures(previous.get(cause.cause_id));
    const figure: AvoidableCauseFigure | undefined = figures.causes.get(cause.cause_id);
    const estimated = figure?.basis != null && figure.avoidable_u !== null;
    const avoidableU = estimated ? (figure?.avoidable_u ?? null) : null;
    if (now.occurrences === 0 && (avoidableU ?? 0) <= 0) continue;

    // Resolved anchors (and D7's most-read calls) give turn positions and the example.
    const resolved: Array<{ turn: TurnRef; event?: EventRef; anchor?: AnchorHit }> = [];
    for (const anchor of tally?.anchors ?? []) {
      const event =
        anchor.event_id === undefined ? undefined : positions.eventsByHash.get(anchor.event_id);
      const turn =
        event?.turn ??
        (anchor.message_id === undefined
          ? undefined
          : positions.turnsByHash.get(anchor.message_id));
      if (turn !== undefined) resolved.push({ turn, anchor, ...(event ? { event } : {}) });
    }
    // The finding's week may start before the window; only reads inside it count.
    for (const id of tally?.readEventIds ?? []) {
      const event = positions.eventsByRaw.get(id);
      if (event !== undefined && event.ts >= census.window.from && event.ts < census.window.to)
        resolved.push({ turn: event.turn });
    }

    const textOf = (turn: TurnRef, event?: EventRef, anchor?: AnchorHit): string | null => {
      let text: string | null = null;
      if (anchor?.event_id !== undefined) {
        const call = anchoredToolCalls(db, [
          {
            event_id: anchor.event_id,
            session_id: findingIds.session(turn.session_id),
            timestamp: anchor.timestamp,
          },
        ])[0];
        text = call?.target ?? null;
        if (text === null && event !== undefined) {
          const stored = db
            .prepare(
              "SELECT json_extract(content_json, '$.command') AS command FROM tool_event_content WHERE event_id = ?",
            )
            .get(event.event_id) as { command: unknown } | undefined;
          if (typeof stored?.command === "string") text = commandText(stored.command);
        }
      }
      return text;
    };

    let example: AvoidableRow["example"] = null;
    const candidates = resolved.filter((r) => r.anchor !== undefined);
    const claim = estimated ? figure?.top_claim : undefined;
    if (claim !== undefined) {
      // The ledger's largest avoidable turn is the example (spec U8 item 5).
      const match = candidates.find(
        (r) => r.turn.session_id === claim.session_id && r.turn.message_id === claim.message_id,
      );
      const turnRow = db
        .prepare("SELECT ts FROM turns WHERE session_id = ? AND message_id = ?")
        .get(claim.session_id, claim.message_id) as { ts: string } | undefined;
      const turnIndex =
        turnRow === undefined
          ? undefined
          : (
              db
                .prepare(
                  `SELECT COUNT(*) AS n FROM turns
                    WHERE session_id = ? AND (ts < ? OR (ts = ? AND message_id < ?))`,
                )
                .get(claim.session_id, turnRow.ts, turnRow.ts, claim.message_id) as { n: number }
            ).n;
      example = {
        session_id: claim.session_id,
        title: titleOf(claim.session_id),
        message_id: claim.message_id,
        ...(turnIndex === undefined ? {} : { turn_index: turnIndex }),
        text: match === undefined ? null : textOf(match.turn, match.event, match.anchor),
        figure_line:
          claim.value_u < 5_000
            ? "under $0.01 avoidable in this turn"
            : `$${(claim.value_u / 1e6).toFixed(2)} avoidable in this turn`,
      };
    } else if (candidates.length > 0) {
      const best = candidates.reduce((a, b) =>
        b.turn.cost_u > a.turn.cost_u ||
        (b.turn.cost_u === a.turn.cost_u &&
          (b.anchor?.timestamp ?? "") > (a.anchor?.timestamp ?? ""))
          ? b
          : a,
      );
      const { turn, event, anchor } = best;
      const text = textOf(turn, event, anchor);
      example = {
        session_id: turn.session_id,
        title: titleOf(turn.session_id),
        message_id: turn.message_id,
        turn_index: turn.index,
        text,
        figure_line:
          event?.result_bytes != null
            ? `${event.tool} returned ${n(event.result_bytes / 1024)} KB`
            : `${n(turn.context_tokens)} context tokens in this turn`,
      };
    } else if (tally !== undefined && tally.v1.length > 0) {
      const finding = tally.v1.reduce((a, b) =>
        (b.savings_u ?? Number.NEGATIVE_INFINITY) > (a.savings_u ?? Number.NEGATIVE_INFINITY)
          ? b
          : a,
      );
      const top = spendBySession.get(
        JSON.stringify(finding.session_ids),
        census.window.from,
        census.window.to,
      ) as { session_id: string } | undefined;
      const session = top?.session_id ?? finding.session_ids[0];
      const line = FACT_LINES[finding.template_id]?.(finding.facts as Record<string, number>);
      if (session !== undefined)
        example = {
          session_id: session,
          title: titleOf(session),
          text: null,
          figure_line: line ?? cause.name,
        };
    }

    const bySpend = estimated && figure?.prev_avoidable_u != null;
    const trend = bySpend
      ? trendOf(
          {
            occurrences: now.occurrences,
            rate: ledgerSpend === 0 ? null : (avoidableU ?? 0) / ledgerSpend,
          },
          {
            occurrences: before.occurrences,
            rate: prevLedgerSpend === 0 ? null : (figure?.prev_avoidable_u ?? 0) / prevLedgerSpend,
          },
          hasLedgerHistory,
        )
      : trendOf(
          {
            occurrences: now.occurrences,
            rate: sessionCount === 0 ? null : now.perSession.size / sessionCount,
          },
          {
            occurrences: before.occurrences,
            rate: prevTotals.sessions === 0 ? null : before.perSession.size / prevTotals.sessions,
          },
          hasHistory,
        );
    const share = avoidableU !== null && ledgerShares ? avoidableU / ledgerSpend : null;
    // OD-U8-2: a cause with a ledger figure lists its sessions from the ledger, by avoidable $.
    const ledgerSessions = estimated ? figure?.sessions : undefined;
    const positionU = estimated ? figure?.position_u : undefined;
    const spendBuckets =
      positionU !== undefined && positionU.reduce((t, v) => t + v, 0) > 0 ? positionU : undefined;
    avoidableRows.push({
      cause_id: cause.cause_id,
      name: cause.name,
      explanation: cause.explanation,
      rank: 0,
      featured: false,
      trend,
      trend_basis: bySpend ? "spend_share" : "session_rate",
      handoff: null,
      patterns: cause.keys.flatMap((key) => {
        const code = spendCode(key.detector_id, key.id);
        const count = tally?.patterns.get(code)?.size ?? 0;
        return count === 0 ? [] : [{ label: key.pattern_label, code, count }];
      }),
      sessions_affected: ledgerSessions ? ledgerSessions.length : now.perSession.size,
      sessions_affected_is_lower_bound: ledgerSessions ? false : (tally?.lowerBound ?? false),
      sessions: ledgerSessions
        ? ledgerSessions.map((s) => ({
            session_id: s.session_id,
            title: titleOf(s.session_id),
            occurrences: now.perSession.get(s.session_id) ?? 0,
            avoidable_u: s.value_u,
          }))
        : sessionList(now.perSession),
      occurrences: now.occurrences,
      count_unit: countUnit(cause),
      share,
      avoidable_u: avoidableU,
      standalone_u: cause.keys.some((k) => SPEND_LANE_DETECTOR_IDS.has(k.detector_id))
        ? null
        : (tally?.modeledU ?? null),
      coverage: estimated ? (figure?.coverage ?? null) : null,
      folded: false,
      when: spendBuckets
        ? whenFromBuckets([...spendBuckets], "spend")
        : whenOf(resolved.map((r) => r.turn)),
      example,
    });
  }
  // KTD-11: causes with a figure by share, then $, then name; then the rest by occurrences, name.
  avoidableRows.sort((a, b) => {
    if ((a.avoidable_u === null) !== (b.avoidable_u === null))
      return a.avoidable_u === null ? 1 : -1;
    if (a.avoidable_u !== null && b.avoidable_u !== null)
      return (
        (b.share ?? -1) - (a.share ?? -1) ||
        b.avoidable_u - a.avoidable_u ||
        a.name.localeCompare(b.name)
      );
    return b.occurrences - a.occurrences || a.name.localeCompare(b.name);
  });
  // The featured row starts expanded, so it never folds.
  avoidableRows.forEach((row, i) => {
    row.rank = i + 1;
    row.featured = i === 0;
    row.folded = i > 0 && row.share !== null && row.share < FOLD_SHARE;
  });
  const estimatedRows = avoidableRows.filter((r) => r.avoidable_u !== null);
  const banner =
    estimatedRows.length > 0 && estimatedRows.every((r) => (r.share ?? 0) < BANNER_SHARE)
      ? { not_estimated_count: avoidableRows.length - estimatedRows.length }
      : null;
  stage("avoidable");

  const shape = (row: CensusRow) => {
    const cause = CAUSES.find((c) => c.cause_id === row.cause_id) as Cause;
    return {
      cause_id: row.cause_id,
      name: cause.name,
      explanation: cause.explanation,
      rank: 0,
      featured: false,
      trend: row.trend,
      trend_basis: "session_rate" as const,
      handoff: null,
      patterns: row.patterns
        .filter((p) => p.count > 0)
        .map((p) => ({ label: censusLabel(cause, p.code), code: p.code, count: p.count })),
      sessions_affected: row.sessions_affected,
      sessions_affected_is_lower_bound: row.sessions_affected_is_lower_bound,
      sessions: sessionList(new Map(row.sessions.map((s) => [s.session_id, s.occurrences]))),
      occurrences: row.occurrences,
      count_unit: countUnit(cause),
      share: row.share,
      breakdown: row.breakdown.map((b) => ({
        label: BREAKDOWN_LABELS[b.label] ?? b.label,
        count: b.count,
      })),
      by_tool: toolBreakdown(db, row.event_ids),
      top_commands: topCommands(db, row.event_ids),
    };
  };
  const wait = waitMs(db, census.window);
  const reliabilityRows: ReliabilityRow[] = census.causes
    .filter((row) => row.occurrences > 0)
    .map((row) => ({
      ...shape(row),
      cost: {
        wait_ms: row.cause_id === "BLOCKED_BY_PERMISSIONS" ? wait : null,
        replan_u: ledgerReliabilityU(db, windowDays, asOf, [
          ...new Set(
            (CAUSES.find((c) => c.cause_id === row.cause_id)?.keys ?? []).map((k) => k.detector_id),
          ),
        ]),
      },
    }))
    .sort(
      (a, b) =>
        (b.share ?? -1) - (a.share ?? -1) ||
        b.occurrences - a.occurrences ||
        a.name.localeCompare(b.name),
    );
  reliabilityRows.forEach((row, i) => {
    row.rank = i + 1;
    row.featured = i === 0;
  });
  const risk: RiskRow | null =
    census.risk.occurrences > 0 ? { ...shape(census.risk), risk: true } : null;
  stage("reliability");

  const silentOf = (
    sections: readonly Cause["section"][],
    shown: readonly { cause_id: string }[],
  ) => {
    const ids = new Set(shown.map((row) => row.cause_id));
    return CAUSES.filter((c) => sections.includes(c.section) && !ids.has(c.cause_id)).map((c) => ({
      cause_id: c.cause_id,
      name: c.name,
    }));
  };

  return {
    window_days: windowDays,
    as_of: asOf.toISOString(),
    built_at: new Date().toISOString(),
    partial: false,
    tiles: {
      spend_u: spend,
      session_count: sessionCount,
      avoidable_u: figures.tile_u,
      avoidable_share:
        figures.tile_u !== null && ledgerShares ? figures.tile_u / ledgerSpend : null,
      avoidable_through: figures.tile_u !== null ? (figures.through ?? null) : null,
      friction_sessions: census.tiles.friction_sessions,
      friction_share: census.tiles.friction_share,
      fix_ready: { n: 0, m: avoidableRows.length + reliabilityRows.length },
    },
    avoidable: { banner, causes: avoidableRows, silent: silentOf(["spend"], avoidableRows) },
    reliability: {
      causes: reliabilityRows,
      risk,
      silent: silentOf(["reliability", "risk"], [...reliabilityRows, ...(risk ? [risk] : [])]),
    },
  };
}
