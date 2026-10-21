/**
 * Disk and SQL scans that used to run inline in GET handlers (judge-setup, judge-setup/consent,
 * idle-sessions, session story, and the heavy direct reads in `QUERIES`). One definition, two callers: the scan worker (off the event loop) and the inline
 * fallback (in-memory DBs, or the worker failing). Each call re-reads disk and DB, so a result is
 * exactly as fresh as the old inline scan.
 */

import type { Db } from "../db/open.js";
import { type SetupGrade, gradeSetup } from "../detector/setup-grade.js";
import { type JudgeInputs, type JudgePrep, gatherJudgeInputs } from "../judge/judge-service.js";
import { type AgentsLivenessResult, getAgentsLiveness } from "../query/api/agents-liveness.js";
import { getContextComposition } from "../query/api/context-composition.js";
import { getCostPerSuccess } from "../query/api/cost-per-success.js";
import { getSessionDiagnostics } from "../query/api/diagnostics.js";
import { getClosureProxy } from "../query/api/effectiveness.js";
import { getEsfObservations, getSessionEsfObservations } from "../query/api/esf-observations.js";
import { getHeadroomTrend } from "../query/api/headroom-trend.js";
import {
  getHotSessionModels,
  getHotSessions,
  getHotSessionsPage,
} from "../query/api/hot-sessions.js";
import { type IdleSession, getIdleSessions } from "../query/api/idle-sessions.js";
import { type JudgeWhereRow, judgeWhere } from "../query/api/judge-setup.js";
import { listWorkspaceOutcomes } from "../query/api/outcomes.js";
import { overviewSectionFns } from "../query/api/overview-view.js";
import {
  type WindowFilter,
  getGlobalOverview,
  getTurnTimeline,
  getTurnTimelineThrough,
  listSessions,
  listWorkspaces,
} from "../query/api/overview.js";
import { getSelfChurn } from "../query/api/self-churn.js";
import { getWeeklySelfPercentile } from "../query/api/self-percentiles.js";
import { getSessionDrivers } from "../query/api/session-drivers.js";
import { type SessionStory, getSessionStory } from "../query/api/session-story.js";
import { getTrends } from "../query/api/trends.js";
import type { ApiResponse } from "../query/envelope.js";
import { type EnvScanOptions, type EnvScanResult, scanEnvironment } from "../scanner/env-scan.js";

/** A query that reads the query DB (db-context), as a registry entry taking the unused `db` first. */
const viaQueryDb =
  <A extends unknown[], R>(fn: (...args: A) => R) =>
  (_db: Db, ...args: A): R =>
    fn(...args);

/** Overview sections that only read the DB and clock (no daemon in-memory state). */
export const OFFLOADED_OVERVIEW_SECTIONS = [
  "kpis",
  "workspaces",
  "trends",
  "trends_prior",
  "flavor",
  "cache_write",
  "weekly_sessions",
  "live",
  "linkage",
] as const;
type OffloadedOverviewSection = (typeof OFFLOADED_OVERVIEW_SECTIONS)[number];

const noDaemonState = (): never => {
  throw new Error("this overview section reads daemon state and runs on the main thread");
};

/**
 * Pure reads behind direct GET routes (PERF P3-F3), by name. Each takes the DB first and returns
 * the route's JSON body; args and results cross the worker boundary, so both are plain data.
 */
export const QUERIES = {
  getEsfObservations,
  getSessionEsfObservations,
  getCostPerSuccess,
  getSelfChurn,
  getClosureProxy,
  getWeeklySelfPercentile,
  getSessionDrivers,
  getGlobalOverview: viaQueryDb(getGlobalOverview),
  listWorkspaces: viaQueryDb(listWorkspaces),
  listSessions: viaQueryDb(listSessions),
  getTurnTimeline: viaQueryDb(getTurnTimeline),
  getTurnTimelineThrough: viaQueryDb(getTurnTimelineThrough),
  getHotSessions: viaQueryDb(getHotSessions),
  getHotSessionsPage: viaQueryDb(getHotSessionsPage),
  getTrends: viaQueryDb(getTrends),
  getHeadroomTrend: viaQueryDb(getHeadroomTrend),
  listWorkspaceOutcomes: viaQueryDb(listWorkspaceOutcomes),
  getSessionDiagnostics: viaQueryDb(getSessionDiagnostics),
  getHotSessionModels: viaQueryDb(getHotSessionModels),
  getContextComposition: viaQueryDb(getContextComposition),
  /** One /api/overview-view section, built by the same section function the route uses. */
  overviewSection: (
    _db: Db,
    name: OffloadedOverviewSection,
    filter: WindowFilter,
    window: { from: string; to: string },
    week: { from: string; to: string },
  ): unknown =>
    overviewSectionFns({
      filter,
      window,
      week,
      status: noDaemonState,
      recs: { peek: noDaemonState, get: noDaemonState },
    })[name](),
};

export type QueryName = keyof typeof QUERIES;
export type QueryArgs<N extends QueryName> = (typeof QUERIES)[N] extends (
  db: Db,
  ...args: infer A
) => unknown
  ? A
  : never;

export type ScanTask =
  | { kind: "idle-sessions" }
  /** Env scan plus the setup grade as of `nowIso` and its "where" rows (SQL over turns and tool_events, too heavy for the loop). */
  | { kind: "env-scan"; scan: EnvScanOptions; nowIso: string }
  /** `prep` also grades and builds the consent payload (scrub, secret scan, hashing) on the worker. */
  | { kind: "judge-inputs"; scan: EnvScanOptions; prep?: JudgePrep }
  /** `claude agents --json` spawn (sync CreateProcess cost) plus its usage lookup, off the event loop. */
  | { kind: "agents-liveness" }
  /** Transcript read + parse (MBs per session); its chunked reads queued behind backfill work on the loop. */
  | { kind: "session-story"; sessionId: string }
  /** A `QUERIES` read; the result is its JSON text, so the route sends it without re-serializing. */
  | { kind: "query"; name: QueryName; args: unknown[] };

export interface ScanTaskResults {
  "idle-sessions": ApiResponse<IdleSession[]>;
  "env-scan": { scan: EnvScanResult; grade: SetupGrade; where: Record<string, JudgeWhereRow[]> };
  "judge-inputs": JudgeInputs;
  "agents-liveness": ApiResponse<AgentsLivenessResult>;
  "session-story": SessionStory | null;
  query: string;
}

/** `getIdleSessions` and `getAgentsLiveness` read the query DB, so the caller must have set it to `db`. */
export function runScanTask<K extends ScanTask["kind"]>(
  db: Db,
  task: Extract<ScanTask, { kind: K }>,
): ScanTaskResults[K] | Promise<ScanTaskResults[K]>;
export function runScanTask(
  db: Db,
  task: ScanTask,
): ScanTaskResults[ScanTask["kind"]] | Promise<ScanTaskResults[ScanTask["kind"]]> {
  switch (task.kind) {
    case "agents-liveness":
      return getAgentsLiveness();
    case "idle-sessions":
      return getIdleSessions();
    case "env-scan": {
      const scan = scanEnvironment(db, task.scan);
      const grade = gradeSetup({ db, scan, now: task.nowIso });
      return { scan, grade, where: judgeWhere(db, grade) };
    }
    case "judge-inputs":
      return gatherJudgeInputs(db, task.scan, task.prep);
    case "session-story":
      return getSessionStory(db, task.sessionId);
    case "query": {
      const run = QUERIES[task.name] as (db: Db, ...args: unknown[]) => unknown;
      return JSON.stringify(run(db, ...task.args));
    }
  }
}
