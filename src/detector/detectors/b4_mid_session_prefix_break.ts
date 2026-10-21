/**
 * B4 MID_SESSION_PREFIX_BREAK. The "rapid" subset of B1: a collapse that came within 5
 * minutes of the previous turn and wrote at least double what that turn wrote. It is built
 * from B1's own events (one collapse predicate, one floor, one pricing), so every B4 event is
 * a B1 event, and B1's finding carries the count as RAPID_COLLAPSE_COUNT. B4 has no summable $.
 */

import type { Db } from "../../db/open.js";
import {
  type B4Event,
  RAPID_CREATION_RATIO,
  RAPID_CREATION_THRESHOLD,
  RAPID_MAX_GAP_MS,
  b4EventLine,
  ownWriteReadPrices,
  parseB4Events,
  turnCreation,
} from "../cache-collapse.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { B4_AVOIDANCE_FRACTION, b4Estimate } from "../savings.js";
import type { DetectorV2, FiredV2 } from "../types.js";
import { b1Analysis, toolSearchPattern } from "./b1_cache_read_collapse.js";

export const B4_MAX_GAP_MS = RAPID_MAX_GAP_MS;
export const B4_CACHE_CREATION_THRESHOLD = RAPID_CREATION_THRESHOLD;
export const B4_CREATION_RATIO = RAPID_CREATION_RATIO;
const B4_EVENTS_MAX_CHARS = 4_000;

export { type B4Event, b4EventLine, parseB4Events };

export const b4FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "B4",
  rule_id: "B4_MID_SESSION_PREFIX_BREAK",
  labels: ["MID_SESSION_CREATION_SPIKE"],
  metrics: {
    // Per-event rows (before U9) carry the gap and previous creation; the U9 rollup omits them.
    GAP_DURATION_MS: { kind: "DURATION_MS", optional: true },
    MAX_GAP_DURATION_MS: { kind: "DURATION_MS" },
    PREVIOUS_CACHE_CREATION_TOKENS: { kind: "TOKENS", optional: true },
    /** U9 rollup: summed over every break in the workspace. */
    CURRENT_CACHE_CREATION_TOKENS: { kind: "TOKENS" },
    CREATION_THRESHOLD_TOKENS: { kind: "TOKENS" },
    CREATION_RATIO_THRESHOLD: { kind: "NUMBER", min: 0 },
    EVENT_COUNT: { kind: "COUNT", optional: true },
    TOOLSEARCH_EVENT_COUNT: { kind: "COUNT", optional: true },
    REWRITE_COST_U: { kind: "NUMBER", min: 0, optional: true },
    // U9 r2: the measured ToolSearch pattern (see toolSearchPattern in b1).
    FIRST_MCP_LOAD_COUNT: { kind: "COUNT", optional: true },
    SESSION_TOOLSEARCH_CALLS: { kind: "COUNT", optional: true },
    /** One line per break, most tokens first: see b4EventLine. */
    EVENTS: { kind: "TEXT", max: B4_EVENTS_MAX_CHARS },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "REVIEW",
      provenance: { source: "RULE", version: "b4-v1" },
    },
    routing: { tier: "INVESTIGATE" },
  },
  presentation: {
    category: "CACHE",
    lever:
      "Load on-demand tools once, at the start of a task, so the cached prompt is not rebuilt mid-session.",
    target_metric: "cache_creation_tokens",
    title: "Mid-session cache prefix break",
  },
} as const);

export const b4Detector: DetectorV2 = {
  contractVersion: 2,
  // U9 r7: first_tool from B1's pairs is the break turn's MCP tool when one ran.
  version: "B4@u9-3",
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
  descriptor: b4FindingDescriptor,
  id: "B4",
  name: "MID_SESSION_PREFIX_BREAK_V2",
  evaluate(db: Db, ctx) {
    const fired: FiredV2[] = [];
    let breakCount = 0;
    const firstRead = db.prepare(
      `SELECT cache_read_tokens AS r FROM turns
        WHERE session_id = ? AND is_sidechain = 0 AND cache_read_tokens > 0
        ORDER BY ts ASC LIMIT 1`,
    );
    for (const [workspaceId, allPairs] of b1Analysis(db, ctx).byWorkspace) {
      // U9: one finding per workspace (cards stay one per detector), largest break first.
      const pairs = allPairs
        .filter((pair) => pair.rapid)
        .sort((a, b) => turnCreation(b.currRow) - turnCreation(a.currRow));
      const top = pairs[0];
      if (top === undefined) continue;
      let creation = 0;
      let rankU = 0;
      let rewriteU = 0;
      let afterToolSearch = 0;
      const events: B4Event[] = [];
      for (const pair of pairs) {
        const { prevRow: previous, currRow: current } = pair;
        const written = turnCreation(current);
        const own = ownWriteReadPrices(current, pair.cachePricesU);
        creation += written;
        rankU += b4Estimate({
          avoidableCreationTokens: written,
          reductionFraction: B4_AVOIDANCE_FRACTION,
          writePriceUsdPerMtok: Math.max(0, own.write - own.read),
        }).rank_value_u_per_wk as number;
        rewriteU += pair.rewriteCostU;
        if (pair.afterToolSearch) afterToolSearch++;
        events.push({
          session_id: current.session_id,
          ts: current.ts,
          written,
          read: current.cache_read_tokens,
          previous_read: previous.cache_read_tokens,
          first_read: (firstRead.get(current.session_id) as { r: number } | undefined)?.r ?? 0,
          gap_ms: Date.parse(current.ts) - Date.parse(previous.ts),
          rewrite_cost_u: pair.rewriteCostU,
          after_tool_search: pair.afterToolSearch,
          first_tool: pair.firstTool ?? "-",
        });
      }
      // Bounded TEXT: keep the largest breaks that fit; EVENT_COUNT keeps the true total.
      const lines: string[] = [];
      for (const event of events) {
        const line = b4EventLine(event);
        if ([...lines, line].join("\n").length > B4_EVENTS_MAX_CHARS) break;
        lines.push(line);
      }
      const pattern = toolSearchPattern(db, pairs, ctx.toIso);
      const sessionIds = [...new Set(events.map((event) => event.session_id))].slice(0, 20);
      const { prevRow: previous, currRow: current } = top;
      breakCount += events.length;
      fired.push({
        scopeKey: `B4|${workspaceId}`,
        scope_workspace_id: workspaceId,
        // Folded into B1 (P3.2, 2026-09-25): every B4 event is an in-TTL B1 collapse
        // that B1 prices on the same turn, so B4 carries no summable $ (basis O).
        modeled_savings_u_per_wk: null,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: b4FindingDescriptor.rule_id,
            label: "MID_SESSION_CREATION_SPIKE",
            assessment: b4FindingDescriptor.defaults.assessment,
            routing: b4FindingDescriptor.defaults.routing,
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
            // Ranked by tokens written (impact), not by id.
            session_ids: sessionIds,
            estimate: { ...b4Estimate({}), rank_value_u_per_wk: Math.round(rankU) },
            impact: { kind: "TOKEN_WASTE", severity: "HIGH", direction: "REDUCE" },
            verdict: { value: "CONFIRMED", method: "RULE" },
            metrics: {
              MAX_GAP_DURATION_MS: { kind: "DURATION_MS", value: B4_MAX_GAP_MS },
              CURRENT_CACHE_CREATION_TOKENS: { kind: "TOKENS", value: creation },
              CREATION_THRESHOLD_TOKENS: { kind: "TOKENS", value: B4_CACHE_CREATION_THRESHOLD },
              CREATION_RATIO_THRESHOLD: { kind: "NUMBER", value: B4_CREATION_RATIO },
              EVENT_COUNT: { kind: "COUNT", value: events.length },
              TOOLSEARCH_EVENT_COUNT: { kind: "COUNT", value: afterToolSearch },
              REWRITE_COST_U: { kind: "NUMBER", value: rewriteU },
              FIRST_MCP_LOAD_COUNT: { kind: "COUNT", value: pattern.firstMcpLoad },
              SESSION_TOOLSEARCH_CALLS: { kind: "COUNT", value: pattern.sessionToolSearchCalls },
              EVENTS: { kind: "TEXT", value: lines.join("\n") },
            },
          },
          b4FindingDescriptor,
        ),
      });
    }
    return fired.length === 0
      ? { fired, status: "INACTIVE", note: "no mid-session cache prefix break" }
      : { fired, status: "ACTIVE", note: `${breakCount} mid-session cache prefix break(s)` };
  },
};
