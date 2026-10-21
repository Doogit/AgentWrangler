/**
 * B1 CACHE_READ_COLLAPSE — main-thread collapse INSIDE the cache TTL (gap ≤ thread
 * TTL): the prefix changed while the cache was still warm (CLAUDE.md/memory edit,
 * tool or MCP list change). Idle-expiry collapses (gap > TTL) belong to
 * B2/D8. Priced on the tokens re-created on the collapse turn, at that turn's own write
 * tier minus the read price. Absorbs B4: B1 counts its rapid collapses as an annotation.
 * The collapse test is the shared one in cache-collapse.ts.
 */

import type { Db } from "../../db/open.js";
import {
  b4EventLine,
  cachePrices,
  clearsEventFloor,
  isCacheCollapse,
  isRapidCollapse,
  ownWriteReadPrices,
  turnCreation,
  workspaceSpendLookup,
} from "../cache-collapse.js";
import { cacheThreadSteps } from "../cache-ttl.js";
import type { ClaimProducer } from "../claim-ledger.js";
import { DETECTOR_CONTRACTS } from "../contracts.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { recId } from "../rec-id.js";
import { B1_AVOIDANCE_FRACTION, b1Estimate, b1Savings } from "../savings.js";
import { turnKey } from "../turn-claim.js";
import type { DetectorContext, DetectorV2, FiredV2 } from "../types.js";

interface TurnRow {
  message_id: string;
  session_id: string;
  is_sidechain: number;
  agent_id: string | null;
  workspace_id: string;
  ts: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
  model: string;
  unit_prices_json: string | null;
}

export interface B1Pair {
  prevRow: TurnRow;
  currRow: TurnRow;
  avoidableCreationTokens: number;
  savingsU: number | null;
  /** B4's annotation: within 5 minutes of the previous turn and at least double its write. */
  rapid: boolean;
  /** [cacheRead, cw5m, cw1h] µ$/token for the CURRENT turn (cachePrices()). */
  cachePricesU: readonly [number, number, number];
  /** U9: the previous turn called ToolSearch (a tool_event between the two turns). */
  afterToolSearch: boolean;
  /** U9: the first tool the collapse turn called, or null. */
  firstTool: string | null;
  /** U9 r2: the session had called no MCP tool before this turn (so an MCP server's tools were not yet in use). */
  beforeFirstMcpCall: boolean;
  /** U9: µ$ paid over reading the same tokens: written × (own write − own read price). */
  rewriteCostU: number;
}

/** B1's ASSUMED avoidance-fraction [min, max], read from the quantity contract (F1). */
const B1_FRACTION_CONSTANT = DETECTOR_CONTRACTS.B1?.constants.find(
  (constant) => constant.name === "B1_AVOIDANCE_FRACTION",
);
export const B1_FRACTION_RANGE: readonly [number, number] =
  B1_FRACTION_CONSTANT && B1_FRACTION_CONSTANT.status === "ASSUMED"
    ? [B1_FRACTION_CONSTANT.min, B1_FRACTION_CONSTANT.max]
    : [0.33, 0.7]; // fallback literal mirrors contracts.ts DETECTOR_CONTRACTS.B1

const B1_EVENTS_MAX_CHARS = 4_000;

/** scopeKey for one B1 workspace rec — shared by evaluate() and b1ClaimProducer. */
function b1ScopeKey(workspaceId: string): string {
  return `B1|${workspaceId}`;
}

export const b1FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "B1",
  rule_id: "B1_CACHE_READ_COLLAPSE",
  labels: ["CACHE_READ_UNDER_10_PERCENT_OF_PREVIOUS"],
  metrics: {
    PREVIOUS_CACHE_READ_TOKENS: { kind: "TOKENS" },
    CURRENT_CACHE_READ_TOKENS: { kind: "TOKENS" },
    CURRENT_TO_PREVIOUS_RATIO: { kind: "RATIO" },
    CURRENT_CACHE_CREATION_TOKENS: { kind: "TOKENS" },
    COLLAPSE_EVENT_COUNT: { kind: "COUNT" },
    RAPID_COLLAPSE_COUNT: { kind: "COUNT" },
    // U9: collapses on the turn right after a ToolSearch call, and µ$ paid over a cache read.
    TOOLSEARCH_COLLAPSE_COUNT: { kind: "COUNT", optional: true },
    REWRITE_COST_U: { kind: "NUMBER", min: 0, optional: true },
    // U9 r2: ToolSearch collapses that came before the session's first MCP tool call, and the
    // session's total ToolSearch calls (the base rate: most ToolSearch calls do not break the cache).
    FIRST_MCP_LOAD_COUNT: { kind: "COUNT", optional: true },
    SESSION_TOOLSEARCH_CALLS: { kind: "COUNT", optional: true },
    /** U9 r4: one line per collapse, most µ$ paid over a cache read first (see b4EventLine). */
    EVENTS: { kind: "TEXT", max: B1_EVENTS_MAX_CHARS, optional: true },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "REVIEW",
      provenance: { source: "RULE", version: "b1-v1" },
    },
    routing: { tier: "INVESTIGATE" },
  },
  presentation: {
    category: "CACHE",
    lever:
      "Load on-demand tools once, at the start of a task, so the cached prompt is not rebuilt mid-session.",
    target_metric: "cache_read_tokens",
    title: "Cache-read collapse",
  },
} as const);

/**
 * U9 r2: the measured ToolSearch pattern for a set of breaks. `firstMcpLoad` counts breaks that
 * came right after a ToolSearch call and before the session's first MCP tool call;
 * `sessionToolSearchCalls` is every ToolSearch call in those sessions, so a reader can see that
 * most ToolSearch calls were NOT followed by a break (a pattern, not a proven cause).
 */
export function toolSearchPattern(
  db: Db,
  pairs: readonly B1Pair[],
  toIso: string,
): { firstMcpLoad: number; sessionToolSearchCalls: number } {
  const calls = db.prepare(
    "SELECT COUNT(*) AS n FROM tool_events WHERE session_id = ? AND tool_name = 'ToolSearch' AND ts < ?",
  );
  const sessions = new Set(pairs.map((pair) => pair.currRow.session_id));
  let sessionToolSearchCalls = 0;
  for (const sessionId of sessions) {
    sessionToolSearchCalls += (calls.get(sessionId, toIso) as { n: number }).n;
  }
  return {
    firstMcpLoad: pairs.filter((pair) => pair.afterToolSearch && pair.beforeFirstMcpCall).length,
    sessionToolSearchCalls,
  };
}

export interface B1Analysis {
  byWorkspace: Map<string, B1Pair[]>;
}

/**
 * B1's cache-read-collapse pair detection, split out of evaluate() (P3.L L4) so
 * b1ClaimProducer shares the exact same pairs evaluate() prices. Must produce
 * byte-identical evaluate() output.
 */
export function b1Analysis(db: Db, ctx: DetectorContext): B1Analysis {
  // The pre-window row is intentionally present: it is evidence only, while
  // every emitted finding is anchored to its current in-window turn.
  const rows = db
    .prepare(
      `SELECT t.message_id, t.session_id, t.is_sidechain, t.agent_id, t.workspace_id, t.ts,
              t.input_tokens, t.cache_read_tokens, t.cache_write_5m, t.cache_write_1h, t.cache_write_other,
              t.model, ps.unit_prices_json
         FROM turns t
         LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
        WHERE t.ts < ? AND t.is_sidechain = 0 AND t.provisional = 0
        ORDER BY t.session_id ASC, t.is_sidechain ASC, t.agent_id ASC, t.ts ASC, t.message_id ASC`,
    )
    .all(ctx.toIso) as TurnRow[];

  const spendOf = workspaceSpendLookup(db, ctx);
  // U9 diagnosis: nearly every in-TTL break came on the turn right after a ToolSearch call.
  const toolSearchBetween = db.prepare(
    `SELECT COUNT(*) AS n FROM tool_events
      WHERE session_id = ? AND tool_name = 'ToolSearch' AND ts >= ? AND ts < ?`,
  );
  const firstToolAt = db.prepare(
    "SELECT tool_name FROM tool_events WHERE session_id = ? AND ts >= ? ORDER BY ts ASC LIMIT 1",
  );
  // U9 r7: an MCP tool called anywhere in the break turn is seen, not inferred, even when another
  // tool (Bash) came first in that turn.
  const mcpToolInTurn = db.prepare(
    `SELECT e.tool_name FROM tool_events e
       JOIN tool_event_metadata m ON m.event_id = e.event_id
      WHERE e.session_id = ? AND m.owner_message_id = ?
        AND e.tool_name LIKE 'mcp\\_\\_%' ESCAPE '\\'
      ORDER BY e.ts ASC, e.event_id ASC LIMIT 1`,
  );
  const mcpCallBefore = db.prepare(
    `SELECT 1 AS n FROM tool_events
      WHERE session_id = ? AND tool_name LIKE 'mcp\\_\\_%' ESCAPE '\\' AND ts < ? LIMIT 1`,
  );
  // Collect qualifying pairs per workspace for rollup.
  const byWorkspace = new Map<string, B1Pair[]>();

  for (const { row: current, previous, gapMin, ttlMin } of cacheThreadSteps(rows)) {
    if (previous !== undefined && current.ts >= ctx.fromIso && gapMin <= ttlMin) {
      if (isCacheCollapse(previous, current)) {
        const priorReads = previous.cache_read_tokens;
        const currentReads = current.cache_read_tokens;
        const avoidableCreationTokens = turnCreation(current);
        // The turn's own write tier minus the read it would have paid instead.
        const cachePricesU = cachePrices(current.unit_prices_json, current.model);
        const own = ownWriteReadPrices(current, cachePricesU);
        const netPrice = Math.max(0, own.write - own.read);
        if (!clearsEventFloor(avoidableCreationTokens * netPrice, spendOf(current.workspace_id))) {
          continue;
        }
        const savingsU =
          avoidableCreationTokens > 0 && netPrice > 0
            ? b1Savings(
                avoidableCreationTokens,
                B1_AVOIDANCE_FRACTION,
                netPrice,
                priorReads,
                currentReads,
              ).savingsU
            : null;
        const gapMs = Date.parse(current.ts) - Date.parse(previous.ts);

        let bucket = byWorkspace.get(current.workspace_id);
        if (!bucket) {
          bucket = [];
          byWorkspace.set(current.workspace_id, bucket);
        }
        bucket.push({
          prevRow: { ...previous },
          currRow: { ...current },
          avoidableCreationTokens,
          savingsU,
          rapid: isRapidCollapse(previous, current, gapMs),
          cachePricesU,
          afterToolSearch:
            (
              toolSearchBetween.get(current.session_id, previous.ts, current.ts) as {
                n: number;
              }
            ).n > 0,
          firstTool:
            (
              (mcpToolInTurn.get(current.session_id, current.message_id) ??
                firstToolAt.get(current.session_id, current.ts)) as
                | { tool_name: string }
                | undefined
            )?.tool_name ?? null,
          beforeFirstMcpCall: mcpCallBefore.get(current.session_id, current.ts) === undefined,
          rewriteCostU: Math.round(avoidableCreationTokens * netPrice),
        });
      }
    }
  }
  return { byWorkspace };
}

export const b1Detector: DetectorV2 = {
  contractVersion: 2,
  // U9 r4: per-break EVENTS list, ranked by rewrite cost (B1 owns the fix). r7: MCP tool anywhere in the break turn.
  version: "B1@u9-4",
  scope: "turn",
  inputs: {
    tables: [
      "turns",
      "sessions",
      "workspaces",
      "user_config",
      "pricing_snapshots",
      "tool_events",
      "tool_event_metadata",
    ],
  },
  descriptor: b1FindingDescriptor,
  id: "B1",
  name: "CACHE_READ_COLLAPSE_V2",

  evaluate(db: Db, ctx) {
    const { byWorkspace } = b1Analysis(db, ctx);
    const firstRead = db.prepare(
      `SELECT cache_read_tokens AS r FROM turns
        WHERE session_id = ? AND is_sidechain = 0 AND cache_read_tokens > 0
        ORDER BY ts ASC LIMIT 1`,
    );

    // Emit ONE Fired per workspace (flood rollup — spec B5 §2).
    const fired: FiredV2[] = [];
    for (const [workspaceId, unrankedPairs] of byWorkspace) {
      // U9 r4: ranked by what each collapse cost (µ$ over a cache read), not by session id.
      const pairs = [...unrankedPairs].sort((a, b) => b.rewriteCostU - a.rewriteCostU);
      // Sum savings exactly from per-pair values so the per-workspace total equals
      // the sum of the previous per-message figures (oracle invariant).
      let totalSavingsU: number | null = null;
      for (const pair of pairs) {
        if (pair.savingsU !== null) {
          totalSavingsU = (totalSavingsU ?? 0) + pair.savingsU;
        }
      }

      // All session ids contributing to this workspace's finding.
      const sessionIdSet = new Set<string>();
      for (const pair of pairs) {
        sessionIdSet.add(pair.prevRow.session_id);
        sessionIdSet.add(pair.currRow.session_id);
      }
      const sessionIds = [...sessionIdSet];
      // Bounded TEXT: keep the costliest collapses that fit; COLLAPSE_EVENT_COUNT keeps the total.
      const eventLines: string[] = [];
      for (const pair of pairs) {
        const line = b4EventLine({
          session_id: pair.currRow.session_id,
          ts: pair.currRow.ts,
          written: pair.avoidableCreationTokens,
          read: pair.currRow.cache_read_tokens,
          previous_read: pair.prevRow.cache_read_tokens,
          first_read: (firstRead.get(pair.currRow.session_id) as { r: number } | undefined)?.r ?? 0,
          gap_ms: Date.parse(pair.currRow.ts) - Date.parse(pair.prevRow.ts),
          rewrite_cost_u: pair.rewriteCostU,
          after_tool_search: pair.afterToolSearch,
          first_tool: pair.firstTool ?? "-",
        });
        if ([...eventLines, line].join("\n").length > B1_EVENTS_MAX_CHARS) break;
        eventLines.push(line);
      }

      // Aggregate token metrics across all pairs.
      let sumPriorReads = 0;
      let sumCurrentReads = 0;
      let sumCreation = 0;
      let rapidCount = 0;
      let toolSearchCount = 0;
      let rewriteCostU = 0;
      for (const pair of pairs) {
        sumPriorReads += pair.prevRow.cache_read_tokens;
        sumCurrentReads += pair.currRow.cache_read_tokens;
        sumCreation += pair.avoidableCreationTokens;
        if (pair.rapid) rapidCount++;
        if (pair.afterToolSearch) toolSearchCount++;
        rewriteCostU += pair.rewriteCostU;
      }
      const pattern = toolSearchPattern(db, pairs, ctx.toIso);
      const ratio = sumPriorReads > 0 ? Number((sumCurrentReads / sumPriorReads).toFixed(4)) : 0;

      // U9: anchors from the largest collapse (most tokens written), the one to check first.
      const firstPair = pairs.reduce((best, pair) =>
        pair.avoidableCreationTokens > best.avoidableCreationTokens ? pair : best,
      );

      fired.push({
        scopeKey: b1ScopeKey(workspaceId),
        scope_workspace_id: workspaceId,
        modeled_savings_u_per_wk: totalSavingsU,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: b1FindingDescriptor.rule_id,
            label: "CACHE_READ_UNDER_10_PERCENT_OF_PREVIOUS",
            assessment: b1FindingDescriptor.defaults.assessment,
            routing: b1FindingDescriptor.defaults.routing,
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
            // Basis P: rank value passes the stored modeled figure through.
            estimate: { ...b1Estimate({}), rank_value_u_per_wk: totalSavingsU ?? 0 },
            impact: { kind: "TOKEN_WASTE", severity: "MEDIUM", direction: "REDUCE" },
            verdict: { value: "CONFIRMED", method: "RULE" },
            metrics: {
              PREVIOUS_CACHE_READ_TOKENS: { kind: "TOKENS", value: sumPriorReads },
              CURRENT_CACHE_READ_TOKENS: { kind: "TOKENS", value: sumCurrentReads },
              CURRENT_TO_PREVIOUS_RATIO: { kind: "RATIO", value: ratio },
              CURRENT_CACHE_CREATION_TOKENS: { kind: "TOKENS", value: sumCreation },
              COLLAPSE_EVENT_COUNT: { kind: "COUNT", value: pairs.length },
              RAPID_COLLAPSE_COUNT: { kind: "COUNT", value: rapidCount },
              TOOLSEARCH_COLLAPSE_COUNT: { kind: "COUNT", value: toolSearchCount },
              REWRITE_COST_U: { kind: "NUMBER", value: rewriteCostU },
              FIRST_MCP_LOAD_COUNT: { kind: "COUNT", value: pattern.firstMcpLoad },
              SESSION_TOOLSEARCH_CALLS: { kind: "COUNT", value: pattern.sessionToolSearchCalls },
              EVENTS: { kind: "TEXT", value: eventLines.join("\n") },
            },
          },
          b1FindingDescriptor,
        ),
      });
    }

    return fired.length === 0
      ? { fired, status: "INACTIVE", note: "no reconciled in-window cache-read collapse" }
      : {
          fired,
          status: "ACTIVE",
          note: `${fired.length} workspace(s) with in-window cache-read collapse`,
        };
  },
};

/**
 * B1 ledger claims: every pair fires its workspace (no gate). Card and ledger now price the
 * same way, (write − read) at the turn's own tiers (counterfactual = its own cacheRead price).
 */
export const b1ClaimProducer: ClaimProducer = {
  detectorId: "B1",
  *produce(db, ctx) {
    const { byWorkspace } = b1Analysis(db, ctx);
    for (const [workspaceId, pairs] of byWorkspace) {
      const claimRecId = recId("B1", workspaceId, b1ScopeKey(workspaceId));
      for (const { currRow, cachePricesU } of pairs) {
        const tk = turnKey(currRow.session_id, currRow.message_id);
        const readPriceU = cachePricesU[0];
        if (currRow.cache_write_5m > 0) {
          yield {
            detectorId: "B1",
            workspaceId,
            sessionId: currRow.session_id,
            turnKey: tk,
            component: "cw5m" as const,
            slice: `cache:${currRow.message_id}`,
            tokens: currRow.cache_write_5m,
            fraction: B1_AVOIDANCE_FRACTION,
            fractionRange: B1_FRACTION_RANGE,
            assumed: true,
            counterfactualPriceU: readPriceU,
            recId: claimRecId,
          };
        }
        if (currRow.cache_write_1h > 0) {
          yield {
            detectorId: "B1",
            workspaceId,
            sessionId: currRow.session_id,
            turnKey: tk,
            component: "cw1h" as const,
            slice: `cache:${currRow.message_id}`,
            tokens: currRow.cache_write_1h,
            fraction: B1_AVOIDANCE_FRACTION,
            fractionRange: B1_FRACTION_RANGE,
            assumed: true,
            counterfactualPriceU: readPriceU,
            recId: claimRecId,
          };
        }
      }
    }
  },
};
