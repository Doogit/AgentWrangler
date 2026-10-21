/**
 * B3 RESUME_CACHE_MISS. A new session's first turn, started within the previous session's
 * cache TTL, that re-created about that session's whole context (0.8-1.25x). The context
 * match is the signature of a resume; no work-item link is required. Priced at the turn's
 * own write tier minus the read price.
 */

import type { Db } from "../../db/open.js";
import {
  cachePrices,
  clearsEventFloor,
  isResumeRewrite,
  ownWriteReadPrices,
  turnCreation,
  workspaceSpendLookup,
} from "../cache-collapse.js";
import { threadTtlMin, writeTier } from "../cache-ttl.js";
import type { ClaimProducer } from "../claim-ledger.js";
import { DETECTOR_CONTRACTS } from "../contracts.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { recId } from "../rec-id.js";
import { B3_AVOIDANCE_FRACTION, b3Estimate, b3Savings } from "../savings.js";
import { turnKey } from "../turn-claim.js";
import type { DetectorContext, DetectorV2, FiredV2 } from "../types.js";

export { cachePrices };

export const B3_CACHE_CREATION_THRESHOLD = 20_000;

interface TurnRow {
  readonly message_id: string;
  readonly session_id: string;
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

/** B3's ASSUMED avoidance-fraction [min, max], read from the quantity contract (F1). */
const B3_FRACTION_CONSTANT = DETECTOR_CONTRACTS.B3?.constants.find(
  (constant) => constant.name === "B3_AVOIDANCE_FRACTION",
);
export const B3_FRACTION_RANGE: readonly [number, number] =
  B3_FRACTION_CONSTANT && B3_FRACTION_CONSTANT.status === "ASSUMED"
    ? [B3_FRACTION_CONSTANT.min, B3_FRACTION_CONSTANT.max]
    : [0.33, 0.7]; // fallback literal mirrors contracts.ts DETECTOR_CONTRACTS.B3

/** The fields of a session's first main-thread turn that its context size comes from. */
export type BasePrefixTurn = Pick<
  TurnRow,
  | "workspace_id"
  | "ts"
  | "input_tokens"
  | "cache_read_tokens"
  | "cache_write_5m"
  | "cache_write_1h"
  | "cache_write_other"
>;

function creation(row: BasePrefixTurn): number {
  return row.cache_write_5m + row.cache_write_1h + row.cache_write_other;
}

/**
 * Unavoidable base prefix per workspace: the median context of each session's first
 * main-thread turn in the window (system prompt, tools, CLAUDE.md — what any fresh
 * session loads). Same measure as RQ4's fresh-start ceiling, scoped per workspace.
 * D2 and D8 subtract it as what a fresh start writes anyway (P3.1-T9).
 */
export function basePrefixByWorkspace(
  firstTurns: Iterable<BasePrefixTurn>,
  fromIso: string,
): Map<string, number> {
  const contexts = new Map<string, number[]>();
  for (const row of firstTurns) {
    if (row.ts < fromIso) continue;
    const list = contexts.get(row.workspace_id) ?? [];
    list.push(row.input_tokens + row.cache_read_tokens + creation(row));
    contexts.set(row.workspace_id, list);
  }
  const medians = new Map<string, number>();
  for (const [workspaceId, list] of contexts) {
    list.sort((a, b) => a - b);
    const mid = Math.floor(list.length / 2);
    medians.set(
      workspaceId,
      list.length % 2
        ? (list[mid] ?? 0)
        : Math.round(((list[mid - 1] ?? 0) + (list[mid] ?? 0)) / 2),
    );
  }
  return medians;
}

/** Each session's first reconciled main-thread turn, for sessions that started in the window. */
export function firstMainTurns(db: Db, fromIso: string, toIso: string): BasePrefixTurn[] {
  return db
    .prepare(
      `WITH firsts AS (
         SELECT session_id, MIN(ts) AS ts FROM turns
          WHERE is_sidechain = 0 AND provisional = 0 AND ts < ?
          GROUP BY session_id)
       SELECT t.workspace_id, t.ts, t.input_tokens, t.cache_read_tokens,
              t.cache_write_5m, t.cache_write_1h, t.cache_write_other
         FROM firsts f
         JOIN turns t ON t.session_id = f.session_id AND t.ts = f.ts
                     AND t.is_sidechain = 0 AND t.provisional = 0
        WHERE f.ts >= ?
        GROUP BY t.session_id`,
    )
    .all(toIso, fromIso) as BasePrefixTurn[];
}

export const b3FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "B3",
  rule_id: "B3_RESUME_CACHE_MISS",
  labels: ["UNIQUE_LINKED_RESUME_MISS"],
  metrics: {
    GAP_DURATION_MS: { kind: "DURATION_MS" },
    MAX_RESUME_GAP_DURATION_MS: { kind: "DURATION_MS" },
    CURRENT_CACHE_CREATION_TOKENS: { kind: "TOKENS" },
    BASE_PREFIX_TOKENS: { kind: "TOKENS" },
    CREATION_THRESHOLD_TOKENS: { kind: "TOKENS" },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "REVIEW",
      provenance: { source: "RULE", version: "b3-v2" },
    },
    routing: { tier: "INVESTIGATE" },
  },
  presentation: {
    category: "CACHE",
    lever: "Preserve the same work context when immediately resuming in a new session.",
    target_metric: "cache_creation_tokens",
    title: "Resume cache miss",
  },
} as const);

/** One qualifying B3 resume event: a new session's first turn that re-created the previous context. */
export interface B3Event {
  workspaceId: string;
  previous: TurnRow;
  current: TurnRow;
  gapMs: number;
  /** The previous session's cache TTL, ms. */
  ttlMs: number;
  currentCreation: number;
  basePrefixTokens: number;
  /** max(0, currentCreation - basePrefixTokens); >0 required to claim (B3's finding gate). */
  avoidableCreationTokens: number;
  modeledSavingsU: number | null;
  /** The turn's own write price minus its read price, $/MTok. */
  writePriceUsdPerMtok: number;
}

export interface B3Analysis {
  events: B3Event[];
}

/**
 * B3's uniquely-linked-resume detection, split out of evaluate() (P3.L L4) so
 * b3ClaimProducer shares the exact same quantities evaluate() prices. Must produce
 * byte-identical evaluate() output.
 */
export function b3Analysis(db: Db, ctx: DetectorContext): B3Analysis {
  const rows = db
    .prepare(
      `SELECT t.message_id, t.session_id, t.workspace_id, t.ts, t.input_tokens, t.cache_read_tokens,
              t.cache_write_5m, t.cache_write_1h, t.cache_write_other, t.model, ps.unit_prices_json
         FROM turns t
         LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
        WHERE t.ts < ? AND t.is_sidechain = 0 AND t.provisional = 0
        ORDER BY t.workspace_id ASC, t.ts ASC, t.session_id ASC, t.message_id ASC`,
    )
    .all(ctx.toIso) as TurnRow[];
  const firstEligibleBySession = new Map<string, TurnRow>();
  const lastEligibleBySession = new Map<string, TurnRow>();
  for (const row of rows) {
    if (!firstEligibleBySession.has(row.session_id)) {
      firstEligibleBySession.set(row.session_id, row);
    }
    lastEligibleBySession.set(row.session_id, row);
  }
  const basePrefix = basePrefixByWorkspace(firstEligibleBySession.values(), ctx.fromIso);
  const spendOf = workspaceSpendLookup(db, ctx);
  const events: B3Event[] = [];
  let previous: TurnRow | undefined;
  for (const current of rows) {
    if (
      previous?.workspace_id === current.workspace_id &&
      previous.session_id !== current.session_id &&
      // A resume boundary must join the last eligible prior turn to the first
      // eligible current turn; timestamp adjacency alone is not sufficient.
      lastEligibleBySession.get(previous.session_id) === previous &&
      firstEligibleBySession.get(current.session_id) === current &&
      current.ts >= ctx.fromIso &&
      isResumeRewrite(previous, current)
    ) {
      const gapMs = Date.parse(current.ts) - Date.parse(previous.ts);
      // The previous session's cache lifetime: its own write tier (the main thread is 1h).
      const ttlMs = threadTtlMin(writeTier(previous), writeTier(current), false) * 60_000;
      const currentCreation = turnCreation(current);
      if (
        Number.isSafeInteger(gapMs) &&
        gapMs >= 0 &&
        gapMs <= ttlMs &&
        currentCreation > B3_CACHE_CREATION_THRESHOLD
      ) {
        // A fresh session would load the base prefix anyway; only the rest is avoidable.
        const basePrefixTokens = basePrefix.get(current.workspace_id) ?? 0;
        const avoidableCreationTokens = Math.max(0, currentCreation - basePrefixTokens);
        // Two back-to-back fresh sessions both write the base prefix; that is no resume.
        if (avoidableCreationTokens <= 0) {
          previous = current;
          continue;
        }
        // The turn's own write tier minus the read it would have paid instead.
        const own = ownWriteReadPrices(
          current,
          cachePrices(current.unit_prices_json, current.model),
        );
        const netPrice = Math.max(0, own.write - own.read);
        if (!clearsEventFloor(avoidableCreationTokens * netPrice, spendOf(current.workspace_id))) {
          previous = current;
          continue;
        }
        const modeledSavingsU =
          avoidableCreationTokens > 0 && netPrice > 0
            ? b3Savings(avoidableCreationTokens, B3_AVOIDANCE_FRACTION, netPrice).savingsU
            : null;
        events.push({
          workspaceId: current.workspace_id,
          previous: { ...previous },
          current: { ...current },
          gapMs,
          ttlMs,
          currentCreation,
          basePrefixTokens,
          avoidableCreationTokens,
          modeledSavingsU,
          writePriceUsdPerMtok: netPrice,
        });
      }
    }
    previous = current;
  }
  return { events };
}

export const b3Detector: DetectorV2 = {
  contractVersion: 2,
  version: "B3@u7-1",
  scope: "session",
  inputs: { tables: ["turns", "sessions", "workspaces", "user_config", "pricing_snapshots"] },
  descriptor: b3FindingDescriptor,
  id: "B3",
  name: "RESUME_CACHE_MISS_V2",
  evaluate(db: Db, ctx) {
    const { events } = b3Analysis(db, ctx);
    const fired: FiredV2[] = events.map((e) => {
      const {
        previous,
        current,
        gapMs,
        currentCreation,
        basePrefixTokens,
        avoidableCreationTokens,
      } = e;
      return {
        scopeKey: `B3|${current.workspace_id}|${previous.session_id}|${current.session_id}|${current.message_id}`,
        scope_workspace_id: current.workspace_id,
        modeled_savings_u_per_wk: e.modeledSavingsU,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: b3FindingDescriptor.rule_id,
            label: "UNIQUE_LINKED_RESUME_MISS",
            assessment: b3FindingDescriptor.defaults.assessment,
            routing: b3FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            anchors: [
              {
                session_id: findingIds.session(previous.session_id),
                timestamp: previous.ts,
                message_id: findingIds.message(previous.message_id),
              },
              {
                session_id: findingIds.session(current.session_id),
                timestamp: current.ts,
                message_id: findingIds.message(current.message_id),
              },
            ],
            session_ids: [...new Set([previous.session_id, current.session_id])]
              .sort()
              .slice(0, 20),
            estimate: b3Estimate({
              avoidableCreationTokens,
              reductionFraction: B3_AVOIDANCE_FRACTION,
              writePriceUsdPerMtok: e.writePriceUsdPerMtok,
            }),
            impact: { kind: "TOKEN_WASTE", severity: "HIGH", direction: "REDUCE" },
            verdict: { value: "CONFIRMED", method: "RULE" },
            metrics: {
              GAP_DURATION_MS: { kind: "DURATION_MS", value: gapMs },
              MAX_RESUME_GAP_DURATION_MS: { kind: "DURATION_MS", value: e.ttlMs },
              CURRENT_CACHE_CREATION_TOKENS: { kind: "TOKENS", value: currentCreation },
              BASE_PREFIX_TOKENS: { kind: "TOKENS", value: basePrefixTokens },
              CREATION_THRESHOLD_TOKENS: { kind: "TOKENS", value: B3_CACHE_CREATION_THRESHOLD },
            },
          },
          b3FindingDescriptor,
        ),
      };
    });
    return fired.length === 0
      ? { fired, status: "INACTIVE", note: "no uniquely linked resume cache miss" }
      : { fired, status: "ACTIVE", note: `${fired.length} uniquely linked resume cache miss(es)` };
  },
};

/**
 * B3 ledger claims: for each qualifying resume event with avoidable creation tokens,
 * split them to the cw5m/cw1h cells exactly as D8 (the cw_other share has no ledger cell).
 * recId uses the same per-event scopeKey evaluate() emits (not a shared per-workspace one —
 * B3 fires one rec per event).
 */
export const b3ClaimProducer: ClaimProducer = {
  detectorId: "B3",
  *produce(db, ctx) {
    const { events } = b3Analysis(db, ctx);
    for (const e of events) {
      if (e.avoidableCreationTokens <= 0 || e.currentCreation <= 0) continue;
      const { current, previous } = e;
      const raw5 = Math.round(
        (e.avoidableCreationTokens * current.cache_write_5m) / e.currentCreation,
      );
      const raw1h = Math.round(
        (e.avoidableCreationTokens * current.cache_write_1h) / e.currentCreation,
      );
      const scopeKey = `B3|${current.workspace_id}|${previous.session_id}|${current.session_id}|${current.message_id}`;
      const claimRecId = recId("B3", current.workspace_id, scopeKey);
      const tk = turnKey(current.session_id, current.message_id);
      const readPriceU = cachePrices(current.unit_prices_json, current.model)[0];
      if (raw5 > 0) {
        yield {
          detectorId: "B3",
          workspaceId: current.workspace_id,
          sessionId: current.session_id,
          turnKey: tk,
          component: "cw5m" as const,
          slice: `cache:${current.message_id}`,
          tokens: raw5,
          fraction: B3_AVOIDANCE_FRACTION,
          fractionRange: B3_FRACTION_RANGE,
          assumed: true,
          counterfactualPriceU: readPriceU,
          recId: claimRecId,
        };
      }
      if (raw1h > 0) {
        yield {
          detectorId: "B3",
          workspaceId: current.workspace_id,
          sessionId: current.session_id,
          turnKey: tk,
          component: "cw1h" as const,
          slice: `cache:${current.message_id}`,
          tokens: raw1h,
          fraction: B3_AVOIDANCE_FRACTION,
          fractionRange: B3_FRACTION_RANGE,
          assumed: true,
          counterfactualPriceU: readPriceU,
          recId: claimRecId,
        };
      }
    }
  },
};
