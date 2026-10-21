/**
 * src/detector/cache-ttl.ts — per-thread cache TTL shared by B1 and D8.
 *
 * A thread is (session_id, is_sidechain, agent_id): main and subagent turns, and turns
 * of different subagents, interleave in one session, so a gap is only meaningful to the
 * previous turn of the same thread. A sidechain turn with no agent_id (S1d could not
 * attribute it) has no reliable predecessor, so it never gets one.
 * TTL is observed from the write tier the thread has used (RQ4 2026-09-25: main
 * writes 100% 1h, subagent writes 100% 5m), not from the current turn's tier.
 * B1 (gap ≤ TTL) and D8 (gap > TTL) use this one definition so no turn is both.
 */

import { D8_TTL_1H_GAP_MIN, D8_TTL_5M_GAP_MIN } from "./savings.js";

export type WriteTier = "5m" | "1h";

export interface CacheThreadRow {
  session_id: string;
  is_sidechain: number;
  agent_id: string | null;
  ts: string;
  cache_write_5m: number;
  cache_write_1h: number;
}

/** The write tier a turn used, or null when it wrote nothing to a known tier. */
export function writeTier(
  row: Pick<CacheThreadRow, "cache_write_5m" | "cache_write_1h">,
): WriteTier | null {
  if (row.cache_write_1h > 0 && row.cache_write_1h >= row.cache_write_5m) return "1h";
  if (row.cache_write_5m > 0) return "5m";
  return null;
}

/** TTL in minutes: the thread's prior tier, else this turn's tier, else the thread default. */
export function threadTtlMin(
  priorTier: WriteTier | null,
  currentTier: WriteTier | null,
  isSidechain: boolean,
): number {
  const tier = priorTier ?? currentTier;
  if (tier === "1h") return D8_TTL_1H_GAP_MIN;
  if (tier === "5m") return D8_TTL_5M_GAP_MIN;
  return isSidechain ? D8_TTL_5M_GAP_MIN : D8_TTL_1H_GAP_MIN;
}

export interface ThreadStep<T extends CacheThreadRow> {
  row: T;
  /** Previous turn in the same thread, if any. */
  previous: T | undefined;
  gapMin: number;
  ttlMin: number;
}

/**
 * Walk rows ordered by session_id, is_sidechain, agent_id, ts, message_id and yield
 * each turn with its same-thread predecessor, gap and TTL.
 */
export function* cacheThreadSteps<T extends CacheThreadRow>(
  rows: readonly T[],
): Generator<ThreadStep<T>> {
  let previous: T | undefined;
  let priorTier: WriteTier | null = null;
  for (const row of rows) {
    const unattributed = row.is_sidechain !== 0 && row.agent_id === null;
    const sameThread =
      !unattributed &&
      previous !== undefined &&
      previous.session_id === row.session_id &&
      previous.is_sidechain === row.is_sidechain &&
      previous.agent_id === row.agent_id;
    if (!sameThread) priorTier = null;
    const prev = sameThread ? previous : undefined;
    const gapMin = prev ? (Date.parse(row.ts) - Date.parse(prev.ts)) / 60_000 : 0;
    const current = writeTier(row);
    yield {
      row,
      previous: prev,
      gapMin,
      ttlMin: threadTtlMin(priorTier, current, row.is_sidechain !== 0),
    };
    priorTier = current ?? priorTier;
    previous = row;
  }
}
