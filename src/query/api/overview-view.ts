/**
 * src/query/api/overview-view.ts — P1-U2 `GET /api/overview-view`: the Overview page in one
 * response, one status per section (perf plan P1-U2).
 *
 * Composes the legacy routes' functions only (no new SQL). Each section's `data` is the legacy
 * route's payload (the envelope's `.data`; `/api/status`'s raw body), the shape P1-U1's schemas
 * validate. Two sections are composed: `weekly_sessions` and `top_recs`.
 *
 * Memo (deviation from the plan's whole-response memo): only the DB-backed sections are reused
 * by (window filter, data_version, minute bucket). `live` reads the clock, `status` and
 * `top_recs` read in-memory daemon state and `hook_config` reads the home dir, so they are
 * recomputed on every request; the route is `nomemo` in route-budgets.ts for the same reason.
 */

import { getDataVersion } from "../../daemon/data-version.js";
import type { RecsSnapshotService } from "../../daemon/recs-snapshot.js";
import type { OverviewSectionName } from "../../shared/schemas/overview-view.js";
import type { SnapshotFreshness } from "../envelope.js";
import { getHookConfig } from "./hook-config.js";
import { getHotSessions } from "./hot-sessions.js";
import { getLinkageRate } from "./outcomes.js";
import {
  type WindowFilter,
  getGlobalOverview,
  listLiveSessions,
  listWorkspaces,
} from "./overview.js";
import { getFlavorDecomposition } from "./spend-flavor.js";
import { getCacheWriteTrend, getTrends } from "./trends.js";

export interface OverviewSection {
  status: "ok" | "pending" | "error";
  data?: unknown;
  ms: number;
  /** A-17 (perf plan P3-U4): on sections served from a snapshot (`top_recs`). */
  freshness?: SnapshotFreshness;
  /** OV-13: on a `pending` section whose build is running (`top_recs`). */
  progress?: SectionProgress;
}

export interface SectionProgress {
  started_at: string;
  /** The last build's duration; null before the first one. */
  expected_ms: number | null;
}

/**
 * A section function returns its data, a `SnapshotSection`, `SECTION_PENDING`, a
 * `PendingSection`, or throws (→ `error`).
 */
export type SectionFn = () => unknown;
export const SECTION_PENDING = Symbol("overview-view pending section");

/** Section data served from a snapshot, with its freshness kept beside `data`. */
export class SnapshotSection {
  constructor(
    readonly data: unknown,
    readonly freshness: SnapshotFreshness,
  ) {}
}

/** A pending section whose build is running, with when it started and how long it usually takes. */
export class PendingSection {
  constructor(readonly progress: SectionProgress) {}
}

/** Sections served from the memo; every other section is recomputed per request. */
const MEMO_SECTIONS: ReadonlySet<OverviewSectionName> = new Set([
  "kpis",
  "workspaces",
  "trends",
  "trends_prior",
  "flavor",
  "cache_write",
  "weekly_sessions",
  "linkage",
]);

/**
 * A `top_recs` build pending this long is taken as hung and reported as `error` (DESIGN_GUIDE §9).
 * OV-13: a hang ceiling, not a "slow" limit — a cold build on a large DB can take minutes.
 */
const TOP_RECS_PENDING_LIMIT_MS = 10 * 60_000;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function runSection(fn: SectionFn): Promise<OverviewSection> {
  const started = performance.now();
  try {
    const data = await fn();
    const ms = Math.round((performance.now() - started) * 100) / 100;
    if (data === SECTION_PENDING) return { status: "pending", ms };
    if (data instanceof PendingSection) return { status: "pending", ms, progress: data.progress };
    if (data instanceof SnapshotSection) {
      return { status: "ok", data: data.data, ms, freshness: data.freshness };
    }
    return { status: "ok", data, ms };
  } catch {
    return { status: "error", ms: Math.round((performance.now() - started) * 100) / 100 };
  }
}

/**
 * Run the sections in order, yielding to the loop between them. `memo` holds sections for the
 * current (data_version, minute bucket), keyed `memoPrefix + name`; the caller hands in a fresh
 * map whenever either moves. A section that ran before an ingest commit is recomputed once; a
 * second commit during that recompute marks the response `consistent: false`.
 */
export async function composeSections(
  fns: Partial<Record<OverviewSectionName, SectionFn>>,
  options: { memo?: Map<string, OverviewSection>; memoPrefix?: string } = {},
): Promise<{
  data_version: number;
  consistent: boolean;
  sections: Partial<Record<OverviewSectionName, OverviewSection>>;
}> {
  const { memo, memoPrefix = "" } = options;
  const names = Object.keys(fns) as OverviewSectionName[];
  const sections: Partial<Record<OverviewSectionName, OverviewSection>> = {};
  const ranAt = new Map<OverviewSectionName, number>();
  const startVersion = getDataVersion();

  for (const name of names) {
    const hit = MEMO_SECTIONS.has(name) ? memo?.get(memoPrefix + name) : undefined;
    if (hit) {
      sections[name] = hit;
      ranAt.set(name, startVersion);
      continue;
    }
    ranAt.set(name, getDataVersion());
    sections[name] = await runSection(fns[name] as SectionFn);
    await yieldToLoop();
  }

  const endVersion = getDataVersion();
  for (const name of names) {
    if (ranAt.get(name) === endVersion) continue;
    sections[name] = await runSection(fns[name] as SectionFn);
    await yieldToLoop();
  }
  const consistent = getDataVersion() === endVersion;

  if (memo && endVersion === startVersion) {
    for (const name of names) {
      const section = sections[name];
      if (MEMO_SECTIONS.has(name) && section?.status === "ok") memo.set(memoPrefix + name, section);
    }
  }
  return { data_version: getDataVersion(), consistent, sections };
}

/**
 * `top_recs` from the last recs snapshot. Never builds on the request path: a cold, failed or
 * stale snapshot kicks a background `get()` after this response. A running build is pending with
 * its progress; past the 10 min hang ceiling, or a failed build, is `error` (the client's retry
 * refetches; the kick has already started a rebuild).
 */
export function topRecsSection(
  recs: Pick<RecsSnapshotService, "peek" | "get">,
  scope?: string,
): unknown {
  const peeked = recs.peek(scope);
  if (peeked.state !== "building" && (peeked.state !== "ready" || peeked.stale)) {
    setImmediate(() => void recs.get(scope).catch(() => {}));
  }
  if (peeked.state === "ready") {
    const view = peeked.result.data;
    const data = {
      active: view?.active ?? [],
      adopted: view?.adopted ?? [],
      ...(view?.active_groups === undefined ? {} : { active_groups: view.active_groups }),
    };
    return new SnapshotSection(data, peeked.freshness);
  }
  if (peeked.state === "building" && Date.now() - peeked.sinceMs <= TOP_RECS_PENDING_LIMIT_MS) {
    return new PendingSection({
      started_at: new Date(peeked.sinceMs).toISOString(),
      expected_ms: peeked.expectedMs ?? null,
    });
  }
  if (peeked.state === "cold") return SECTION_PENDING;
  throw new Error("recommendations snapshot unavailable");
}

/** The Overview's sections, in page order, built from the same calls the legacy routes make. */
export function overviewSectionFns(ctx: {
  filter: WindowFilter;
  /** The request's resolved window; the prior window is the same span ending at its start. */
  window: { from: string; to: string };
  /** The resolved 7-day window (the weekly sessions card is always 7 days). */
  week: { from: string; to: string };
  status: () => unknown;
  recs: Pick<RecsSnapshotService, "peek" | "get">;
}): Record<OverviewSectionName, SectionFn> {
  const { filter, window } = ctx;
  const span = Date.parse(window.to) - Date.parse(window.from);
  const prior = { from: new Date(Date.parse(window.from) - span).toISOString(), to: window.from };
  return {
    kpis: () => getGlobalOverview(filter).data,
    workspaces: () => listWorkspaces(filter).data,
    trends: () => getTrends(filter, "day").data,
    trends_prior: () => getTrends(prior, "day").data,
    flavor: () => getFlavorDecomposition(filter).data,
    cache_write: () => getCacheWriteTrend(filter, "day").data,
    weekly_sessions: () => {
      const week = getGlobalOverview({ preset: "7d" }).data;
      if (week === null) throw new Error("seven-day overview is empty");
      return { rows: getHotSessions(ctx.week, 20).slice(0, 5), cost_equiv_u: week.cost_equiv_u };
    },
    live: () => listLiveSessions().data,
    status: ctx.status,
    top_recs: () => topRecsSection(ctx.recs),
    linkage: () => getLinkageRate().data,
    hook_config: () => getHookConfig().data,
  };
}
