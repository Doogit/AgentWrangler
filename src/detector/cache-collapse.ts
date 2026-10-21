/**
 * src/detector/cache-collapse.ts — the one cache-collapse predicate for B1, B2, B3 and B4.
 *
 * A "collapse" is a turn that re-created most of the previous turn's context instead of
 * reading it from cache. It is judged on creation versus the previous context, not on a
 * ratio of cache reads: the ~30k system prefix keeps reading after an expiry, so a
 * reads-fell-10x rule only fires when the context is over ~300k. A turn whose context
 * shrank (compaction, /clear) is not a collapse. Whether the break was inside the cache
 * TTL (B1) or after it (B2/D8) is decided by the caller from cache-ttl.ts.
 *
 * Pricing is the turn's own: its write tiers minus the cache-read price, so the card
 * agrees with the claim ledger (which prices write minus read on the same turn).
 */

import type { Db } from "../db/open.js";
import { LIST_PRICES, modelTier } from "../ingest/pricing.js";
import { pctOfSpend, spendByWorkspace } from "../query/spend.js";
import type { DetectorContext } from "./types.js";

/** A collapse turn re-creates at least this share of the previous turn's context. */
export const COLLAPSE_MIN_CREATION_SHARE = 0.5;
/** ...and its cache reads fall below this share of the previous turn's. */
export const COLLAPSE_READ_FALL_SHARE = 0.5;
/** ...and its own context stays at least this share of the previous one (else a shrink). */
export const COLLAPSE_SHRINK_GUARD = 0.9;
/** B3: the resumed session's first turn re-creates 0.8-1.25x of the prior session's context. */
export const RESUME_CONTEXT_MATCH: readonly [number, number] = [0.8, 1.25];
/** Event floor: an event under this % of the workspace's 7-day spend is not worth a finding. */
export const EVENT_FLOOR_PCT = 0.1;

export interface CollapseTurn {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
}

export function turnCreation(
  row: Pick<CollapseTurn, "cache_write_5m" | "cache_write_1h" | "cache_write_other">,
): number {
  return row.cache_write_5m + row.cache_write_1h + row.cache_write_other;
}

export function turnContext(row: CollapseTurn): number {
  return row.input_tokens + row.cache_read_tokens + turnCreation(row);
}

function usable(row: CollapseTurn): boolean {
  return [
    row.input_tokens,
    row.cache_read_tokens,
    row.cache_write_5m,
    row.cache_write_1h,
    row.cache_write_other,
  ].every((n) => Number.isSafeInteger(n) && n >= 0);
}

/** B1, B2, B4: `current` re-created the previous context instead of reading it. */
export function isCacheCollapse(previous: CollapseTurn, current: CollapseTurn): boolean {
  if (!usable(previous) || !usable(current)) return false;
  const prevContext = turnContext(previous);
  return (
    prevContext > 0 &&
    previous.cache_read_tokens > 0 &&
    turnCreation(current) >= COLLAPSE_MIN_CREATION_SHARE * prevContext &&
    current.cache_read_tokens < COLLAPSE_READ_FALL_SHARE * previous.cache_read_tokens &&
    turnContext(current) >= COLLAPSE_SHRINK_GUARD * prevContext
  );
}

/** B4's "rapid" annotation on a B1 collapse: within 5 minutes and at least double the prior write. */
export const RAPID_MAX_GAP_MS = 5 * 60 * 1000;
export const RAPID_CREATION_THRESHOLD = 20_000;
export const RAPID_CREATION_RATIO = 2;

export function isRapidCollapse(
  previous: CollapseTurn,
  current: CollapseTurn,
  gapMs: number,
): boolean {
  const created = turnCreation(current);
  return (
    Number.isSafeInteger(gapMs) &&
    gapMs >= 0 &&
    gapMs <= RAPID_MAX_GAP_MS &&
    created > RAPID_CREATION_THRESHOLD &&
    created > RAPID_CREATION_RATIO * turnCreation(previous)
  );
}

/** B3: the first turn of a new session wrote about the previous session's whole context again. */
export function isResumeRewrite(previous: CollapseTurn, current: CollapseTurn): boolean {
  if (!usable(previous) || !usable(current)) return false;
  const prevContext = turnContext(previous);
  if (prevContext <= 0) return false;
  const share = turnCreation(current) / prevContext;
  return (
    share >= RESUME_CONTEXT_MATCH[0] &&
    share <= RESUME_CONTEXT_MATCH[1] &&
    current.cache_read_tokens <= COLLAPSE_READ_FALL_SHARE * previous.cache_read_tokens
  );
}

/**
 * Resolve [cacheRead, cw5m, cw1h] prices ($/MTok) for a turn, snapshot first, list-price
 * fallback. Shared by D8/B1/B3's claim producers (P3.L L4).
 */
export function cachePrices(
  unitPricesJson: string | null,
  model: string,
): [number, number, number] {
  if (unitPricesJson) {
    try {
      const arr = JSON.parse(unitPricesJson) as number[];
      if (typeof arr[2] === "number" && typeof arr[3] === "number" && typeof arr[4] === "number")
        return [arr[2], arr[3], arr[4]];
    } catch {
      // fall through to list price
    }
  }
  const tier = modelTier(model);
  const lp = tier ? LIST_PRICES[tier] : undefined;
  return lp ? [lp[2], lp[3], lp[4]] : [0, 0, 0];
}

/**
 * The turn's own write price ($/MTok) over `row`'s write tiers (cw_other at the 5m rate),
 * and the cache-read price it would have paid instead. Both 0 when it wrote nothing.
 */
export function ownWriteReadPrices(
  row: Pick<CollapseTurn, "cache_write_5m" | "cache_write_1h" | "cache_write_other">,
  prices: readonly [number, number, number],
): { write: number; read: number } {
  const total = turnCreation(row);
  if (total <= 0) return { write: 0, read: 0 };
  const [read, w5m, w1h] = prices;
  return {
    write: ((row.cache_write_5m + row.cache_write_other) * w5m + row.cache_write_1h * w1h) / total,
    read,
  };
}

/** Lazily resolved, per-workspace 7-day spend (µ$) for the event floor. */
export function workspaceSpendLookup(
  db: Db,
  ctx: DetectorContext,
): (workspaceId: string) => number {
  let spends: Map<string, number> | undefined;
  return (workspaceId) => {
    spends ??= new Map(
      spendByWorkspace(db, ctx.fromIso, ctx.toIso).map((row) => [
        row.workspace_id,
        row.cost_equiv_u,
      ]),
    );
    return spends.get(workspaceId) ?? 0;
  };
}

/** Whether an event worth `eventU` µ$ clears the floor; unknown (zero) spend cannot gate. */
export function clearsEventFloor(eventU: number, workspaceSpendU: number): boolean {
  const pct = pctOfSpend(eventU, workspaceSpendU);
  return pct === null || pct >= EVENT_FLOOR_PCT;
}

/** The fields of one B1/B4 EVENTS line, in order, `|`-separated. */
export interface B4Event {
  session_id: string;
  ts: string;
  written: number;
  read: number;
  previous_read: number;
  /** The session's first main-thread cache read (its system prompt and base tools), or 0. */
  first_read: number;
  gap_ms: number;
  rewrite_cost_u: number;
  after_tool_search: boolean;
  first_tool: string;
}

export function b4EventLine(e: B4Event): string {
  return [
    e.session_id,
    e.ts,
    e.written,
    e.read,
    e.previous_read,
    e.first_read,
    e.gap_ms,
    e.rewrite_cost_u,
    e.after_tool_search ? 1 : 0,
    e.first_tool.replace(/[|\n]/g, "_"),
  ].join("|");
}

export function parseB4Events(text: string): B4Event[] {
  return text
    .split("\n")
    .map((line) => line.split("|"))
    .filter((f) => f.length === 10)
    .map((f) => ({
      session_id: f[0] as string,
      ts: f[1] as string,
      written: Number(f[2]),
      read: Number(f[3]),
      previous_read: Number(f[4]),
      first_read: Number(f[5]),
      gap_ms: Number(f[6]),
      rewrite_cost_u: Number(f[7]),
      after_tool_search: f[8] === "1",
      first_tool: f[9] as string,
    }));
}
