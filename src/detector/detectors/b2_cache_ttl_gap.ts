/**
 * B2 TTL_GAP_MISS. A main-thread turn that re-created the previous context after a break
 * longer than that thread's cache TTL (cache-ttl.ts: 1h for the main thread's 1h writes).
 * Same collapse predicate as B1; B1 takes gap <= TTL, B2 takes gap > TTL. Priced on the
 * resume turn's actual creation minus the base prefix a fresh start writes anyway, at the
 * turn's own write tier minus the read price.
 */

import type { Db } from "../../db/open.js";
import {
  cachePrices,
  clearsEventFloor,
  isCacheCollapse,
  ownWriteReadPrices,
  turnCreation,
  workspaceSpendLookup,
} from "../cache-collapse.js";
import { cacheThreadSteps } from "../cache-ttl.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { b2Estimate } from "../savings.js";
import type { DetectorV2, FiredV2 } from "../types.js";
import { basePrefixByWorkspace, firstMainTurns } from "./b3_resume_cache_miss.js";

/** The main thread's 1h cache lifetime; the finding reports the thread's own TTL beside it. */
export const B2_CONSERVATIVE_TTL_GAP_MS = 60 * 60 * 1000;
const B2_LABEL = "UNKNOWN_CONSERVATIVE_1H";

interface TurnRow {
  readonly message_id: string;
  readonly session_id: string;
  readonly is_sidechain: number;
  readonly agent_id: string | null;
  readonly workspace_id: string;
  readonly ts: string;
  readonly input_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_5m: number;
  readonly cache_write_1h: number;
  readonly cache_write_other: number;
  readonly model: string;
  readonly unit_prices_json: string | null;
}

interface B2Pair {
  prevRow: TurnRow;
  currRow: TurnRow;
  gapMs: number;
  ttlMs: number;
  avoidableTokens: number;
  writePrice: number;
  readPrice: number;
}

/**
 * B2's pair rule: a main-thread turn that re-created the previous context after a break
 * longer than the thread's TTL (`ttlMin`). Returns the gap, or null. Shared with the B2
 * effect observer.
 */
export function b2ResumeGapMs(
  previous: Parameters<typeof isCacheCollapse>[0] & { ts: string },
  current: Parameters<typeof isCacheCollapse>[1] & { ts: string },
  ttlMin: number,
): number | null {
  if (!isCacheCollapse(previous, current)) return null;
  const gapMs = Date.parse(current.ts) - Date.parse(previous.ts);
  return Number.isSafeInteger(gapMs) && gapMs > ttlMin * 60_000 ? gapMs : null;
}

export const b2FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "B2",
  rule_id: "B2_TTL_GAP_MISS",
  labels: [B2_LABEL],
  metrics: {
    GAP_DURATION_MS: { kind: "DURATION_MS" },
    CONSERVATIVE_TTL_DURATION_MS: { kind: "DURATION_MS" },
    PREVIOUS_CACHE_READ_TOKENS: { kind: "TOKENS" },
    CURRENT_CACHE_READ_TOKENS: { kind: "TOKENS" },
    CURRENT_CACHE_CREATION_TOKENS: { kind: "TOKENS" },
    RESUME_COUNT: { kind: "COUNT" },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "REVIEW",
      provenance: { source: "RULE", version: "b2-v1" },
    },
    routing: { tier: "INVESTIGATE" },
  },
  presentation: {
    category: "CACHE",
    lever:
      "Resume within the cache TTL, or start fresh after a break over one hour instead of resuming cold.",
    target_metric: "cache_read_tokens",
    title: "Conservative one-hour cache TTL gap",
  },
} as const);

export const b2Detector: DetectorV2 = {
  contractVersion: 2,
  version: "B2@u7-1",
  scope: "session",
  inputs: { tables: ["turns", "sessions", "workspaces", "user_config", "pricing_snapshots"] },
  descriptor: b2FindingDescriptor,
  id: "B2",
  name: "TTL_GAP_MISS_V2",

  evaluate(db: Db, ctx) {
    const rows = db
      .prepare(
        `SELECT t.message_id, t.session_id, t.is_sidechain, t.agent_id, t.workspace_id, t.ts,
                t.input_tokens, t.cache_read_tokens, t.cache_write_5m, t.cache_write_1h,
                t.cache_write_other, t.model, ps.unit_prices_json
           FROM turns t
           LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
          WHERE t.ts < ? AND t.is_sidechain = 0 AND t.provisional = 0
          ORDER BY t.session_id ASC, t.is_sidechain ASC, t.agent_id ASC, t.ts ASC, t.message_id ASC`,
      )
      .all(ctx.toIso) as TurnRow[];

    const basePrefix = basePrefixByWorkspace(
      firstMainTurns(db, ctx.fromIso, ctx.toIso),
      ctx.fromIso,
    );
    const spendOf = workspaceSpendLookup(db, ctx);

    // Collect qualifying pairs per workspace for rollup.
    const byWorkspace = new Map<string, B2Pair[]>();
    for (const { row: current, previous, gapMin, ttlMin } of cacheThreadSteps(rows)) {
      if (previous === undefined || current.ts < ctx.fromIso) continue;
      const gapMs = b2ResumeGapMs(previous, current, ttlMin);
      if (gapMs === null || gapMin <= ttlMin) continue;
      // What a fresh start writes anyway is not avoidable.
      const avoidableTokens = Math.max(
        0,
        turnCreation(current) - (basePrefix.get(current.workspace_id) ?? 0),
      );
      const own = ownWriteReadPrices(current, cachePrices(current.unit_prices_json, current.model));
      const net = Math.max(0, own.write - own.read);
      if (avoidableTokens <= 0) continue;
      if (!clearsEventFloor(avoidableTokens * net, spendOf(current.workspace_id))) continue;
      let bucket = byWorkspace.get(current.workspace_id);
      if (!bucket) {
        bucket = [];
        byWorkspace.set(current.workspace_id, bucket);
      }
      bucket.push({
        prevRow: { ...previous },
        currRow: { ...current },
        gapMs,
        ttlMs: ttlMin * 60_000,
        avoidableTokens,
        writePrice: own.write,
        readPrice: own.read,
      });
    }

    // Emit ONE Fired per workspace (flood rollup — spec B5 §2).
    const fired: FiredV2[] = [];
    for (const [workspaceId, pairs] of byWorkspace) {
      // All session ids contributing to this workspace's finding.
      const sessionIdSet = new Set<string>();
      for (const pair of pairs) {
        sessionIdSet.add(pair.prevRow.session_id);
        sessionIdSet.add(pair.currRow.session_id);
      }
      const sessionIds = [...sessionIdSet].sort();

      // Aggregate token and gap metrics across all pairs; prices are token-weighted so
      // tokens x (write - read) is the exact sum of each resume turn's own figure.
      let sumPriorReads = 0;
      let sumCurrentReads = 0;
      let sumCreation = 0;
      let maxGapMs = 0;
      let ttlOfMaxGapMs = 0;
      let sumAvoidable = 0;
      let weightedWrite = 0;
      let weightedRead = 0;
      for (const pair of pairs) {
        sumPriorReads += pair.prevRow.cache_read_tokens;
        sumCurrentReads += pair.currRow.cache_read_tokens;
        sumCreation += turnCreation(pair.currRow);
        if (pair.gapMs > maxGapMs) {
          maxGapMs = pair.gapMs;
          ttlOfMaxGapMs = pair.ttlMs;
        }
        sumAvoidable += pair.avoidableTokens;
        weightedWrite += pair.avoidableTokens * pair.writePrice;
        weightedRead += pair.avoidableTokens * pair.readPrice;
      }

      // Anchors from the first (oldest) qualifying pair (bucket is non-empty by construction).
      // biome-ignore lint/style/noNonNullAssertion: bucket is non-empty — only populated when a pair qualifies
      const firstPair = pairs[0]!;

      fired.push({
        scopeKey: `B2|${workspaceId}`,
        scope_workspace_id: workspaceId,
        // MED-1 (operator 2026-09-22): B2's qualifying pairs are the idle-expiry subset D8
        // prices, so D8 owns the $ and B2 is a null-savings label. Emitting a $/wk here
        // double-counted the same avoidable tokens in the efficiency-headroom SUM.
        modeled_savings_u_per_wk: null,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: b2FindingDescriptor.rule_id,
            label: B2_LABEL,
            assessment: b2FindingDescriptor.defaults.assessment,
            routing: b2FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            anchors: [
              {
                session_id: findingIds.session(firstPair.prevRow.session_id),
                timestamp: firstPair.prevRow.ts,
                message_id: findingIds.message(firstPair.prevRow.message_id),
              },
              {
                session_id: findingIds.session(firstPair.currRow.session_id),
                timestamp: firstPair.currRow.ts,
                message_id: findingIds.message(firstPair.currRow.message_id),
              },
            ],
            session_ids: sessionIds,
            // Basis O (rank-only): the resume turns' creation above the base prefix, priced at
            // each turn's own write tier minus its read price.
            estimate: b2Estimate({
              previousCacheReadTokens: sumAvoidable,
              writePriceUsdPerMtok: sumAvoidable > 0 ? weightedWrite / sumAvoidable : 0,
              cacheReadPriceUsdPerMtok: sumAvoidable > 0 ? weightedRead / sumAvoidable : 0,
            }),
            impact: { kind: "TOKEN_WASTE", severity: "MEDIUM", direction: "REDUCE" },
            verdict: { value: "CONFIRMED", method: "RULE" },
            metrics: {
              GAP_DURATION_MS: { kind: "DURATION_MS", value: maxGapMs },
              CONSERVATIVE_TTL_DURATION_MS: {
                kind: "DURATION_MS",
                value: ttlOfMaxGapMs,
              },
              PREVIOUS_CACHE_READ_TOKENS: { kind: "TOKENS", value: sumPriorReads },
              CURRENT_CACHE_READ_TOKENS: { kind: "TOKENS", value: sumCurrentReads },
              CURRENT_CACHE_CREATION_TOKENS: { kind: "TOKENS", value: sumCreation },
              // F29: the qualifying pairs (resumes) the sums above run over.
              RESUME_COUNT: { kind: "COUNT", value: pairs.length },
            },
          },
          b2FindingDescriptor,
        ),
      });
    }

    return fired.length === 0
      ? { fired, status: "INACTIVE", note: "no cache collapse after the thread's TTL" }
      : {
          fired,
          status: "ACTIVE",
          note: `${fired.length} workspace(s) with a cache collapse after the TTL`,
        };
  },
};
