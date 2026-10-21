/**
 * A1 TOOL_RESULT_BLOAT.
 *
 * Fires per workspace when an individual tool result is strictly larger than
 * 25 KiB; the card breaks the bytes down by tool (P3.1 review 1, R2.3). Only persisted size and structural identity are
 * used; raw tool output and raw/custom tool names never enter the finding.
 */

import type { Db } from "../../db/open.js";
import { resolveBytesPerToken } from "../calibration.js";
import type { ClaimProducer } from "../claim-ledger.js";
import { DETECTOR_CONTRACTS } from "../contracts.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { recId } from "../rec-id.js";
import { createResultCarry, resultClaimsForEvent } from "../result-claims.js";
import {
  A1_AVOIDANCE_FRACTION,
  A1_RESULT_BYTES_THRESHOLD,
  ESTIMATOR_BYTES_PER_TOKEN,
  a1Estimate,
  a1Savings,
} from "../savings.js";
import type { DetectorV2, FiredV2 } from "../types.js";
import { blendedCacheWritePriceForWorkspace } from "../write-price.js";

export { A1_RESULT_BYTES_THRESHOLD };

/** A1's ASSUMED avoidance-fraction [min, max], read from the quantity contract (F1). */
const A1_FRACTION_CONSTANT = DETECTOR_CONTRACTS.A1?.constants.find(
  (constant) => constant.name === "A1_AVOIDANCE_FRACTION",
);
const A1_FRACTION_RANGE: readonly [number, number] =
  A1_FRACTION_CONSTANT && A1_FRACTION_CONSTANT.status === "ASSUMED"
    ? [A1_FRACTION_CONSTANT.min, A1_FRACTION_CONSTANT.max]
    : [0.33, 0.7]; // fallback literal mirrors contracts.ts DETECTOR_CONTRACTS.A1

interface ToolResultRow {
  event_id: string;
  session_id: string;
  workspace_id: string;
  ts: string;
  tool_name: string;
  result_bytes: number;
  owner_message_id: string | null;
}

export const a1FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "A1",
  rule_id: "A1_TOOL_RESULT_BLOAT",
  labels: ["TOOL_RESULT_OVER_25_KIB"],
  metrics: {
    EVENT_COUNT: { kind: "COUNT" },
    RESULT_BYTES_TOTAL: { kind: "BYTES" },
    MAX_RESULT_BYTES: { kind: "BYTES" },
    THRESHOLD_BYTES: { kind: "BYTES" },
    /** U9 r8: the Read tool's share of the large results, so the card can say what a Read rule reaches. */
    READ_EVENT_COUNT: { kind: "COUNT", optional: true },
    READ_RESULT_BYTES: { kind: "BYTES", optional: true },
    /** R6-03 legacy, no longer emitted: since U7 the rank itself covers every large result. */
    ALL_RESULTS_CARRY_U_PER_WK: { kind: "INTEGER", optional: true },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "ASSERTED",
      provenance: { source: "RULE", version: "a1-v1" },
    },
    routing: { tier: "T3" },
  },
  presentation: {
    category: "TOOLING",
    // U7: re-sends are priced in the main conversation and inside subagents alike.
    lever: "Shrink the large tool result that costs the most in re-sends",
    target_metric: "tool_result_bytes",
    title: "Large tool results",
  },
} as const);

function eventOrder(a: ToolResultRow, b: ToolResultRow): number {
  return (
    b.result_bytes - a.result_bytes ||
    b.ts.localeCompare(a.ts) ||
    a.event_id.localeCompare(b.event_id)
  );
}

export const a1Detector: DetectorV2 = {
  contractVersion: 2,
  // U9 r4: estimate prices the write turn's 5m/1h mix, as the ledger does. r8: records the Read share (READ_EVENT_COUNT, READ_RESULT_BYTES).
  version: "A1@u9-2",
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
      "ingest_metric_events",
    ],
  },
  descriptor: a1FindingDescriptor,
  id: "A1",
  name: "TOOL_RESULT_BLOAT_V2",

  evaluate(db: Db, ctx) {
    const bptResolution = resolveBytesPerToken(db);
    // U7: no D6 exclusion. D6 prices only results at or under 25,600 B, so the sets are disjoint.

    const rows = db
      .prepare(
        `SELECT e.event_id, e.session_id, s.workspace_id, e.ts, e.tool_name, e.result_bytes,
                m.owner_message_id
           FROM tool_events e
           JOIN sessions s ON s.session_id = e.session_id
           LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
          WHERE e.ts >= ? AND e.ts < ?
            AND e.result_bytes > ?
          ORDER BY s.workspace_id ASC, e.ts ASC, e.event_id ASC`,
      )
      .all(ctx.fromIso, ctx.toIso, A1_RESULT_BYTES_THRESHOLD) as ToolResultRow[];

    const groups = new Map<string, { workspaceId: string; events: ToolResultRow[] }>();
    for (const row of rows) {
      if (
        !Number.isSafeInteger(row.result_bytes) ||
        row.result_bytes <= A1_RESULT_BYTES_THRESHOLD
      ) {
        continue;
      }
      const group = groups.get(row.workspace_id);
      if (group === undefined) {
        groups.set(row.workspace_id, { workspaceId: row.workspace_id, events: [row] });
      } else {
        group.events.push(row);
      }
    }

    // Cache blended write prices per workspace to avoid repeated queries.
    const writePriceByWorkspace = new Map<string, number>();
    const resultCarry = createResultCarry(db);

    const fired: FiredV2[] = [];
    for (const { workspaceId, events } of [...groups.values()].sort((a, b) =>
      a.workspaceId.localeCompare(b.workspaceId),
    )) {
      const ordered = [...events].sort(eventOrder);
      const totalBytes = ordered.reduce((sum, event) => sum + event.result_bytes, 0);
      if (!Number.isSafeInteger(totalBytes)) {
        throw new TypeError("A1 aggregate result bytes must be a safe integer");
      }
      const largest = ordered[0];
      if (largest === undefined) continue;
      const readEvents = ordered.filter((event) => event.tool_name === "Read");
      const sessionIds = [...new Set(ordered.map((event) => event.session_id))].sort().slice(0, 20);

      // U7: the rank prices every large result, the same set the ledger headline claims, each
      // carried along its owner chain (main thread or the subagent that read it). The lead target
      // is only where the card says to start.
      let estimateRankValue = 0;
      for (const event of ordered) {
        const carried = resultCarry(event.session_id, event.ts, event.owner_message_id);
        if (carried === undefined) continue;
        const estimate = a1Estimate({
          resultBytes: event.result_bytes,
          carryTurns: carried.carry,
          // U9: the write turn's own 5m/1h mix, as the ledger's write claim pays it.
          writePriceUsdPerMtok: carried.mixedWritePrice,
          cacheReadPriceUsdPerMtok: carried.readPrice,
        });
        estimateRankValue += estimate.rank_value_u_per_wk ?? 0;
      }

      // Compute modeled savings (gate: calibrated + writePrice > 0 + avoidableBytes > 0).
      let modeledSavingsU: number | null = null;
      if (bptResolution.calibrated) {
        let avoidableBytes = 0;
        for (const event of ordered) {
          avoidableBytes += Math.max(0, event.result_bytes - A1_RESULT_BYTES_THRESHOLD);
        }
        if (avoidableBytes > 0) {
          let writePrice = writePriceByWorkspace.get(workspaceId);
          if (writePrice === undefined) {
            writePrice = blendedCacheWritePriceForWorkspace(
              db,
              workspaceId,
              ctx.fromIso,
              ctx.toIso,
            );
            writePriceByWorkspace.set(workspaceId, writePrice);
          }
          if (writePrice > 0) {
            const { savingsU } = a1Savings(avoidableBytes, bptResolution.ratio, writePrice, 0);
            modeledSavingsU = savingsU;
          }
        }
      }

      fired.push({
        scopeKey: `A1|${workspaceId}`,
        scope_workspace_id: workspaceId,
        modeled_savings_u_per_wk: modeledSavingsU,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: a1FindingDescriptor.rule_id,
            label: "TOOL_RESULT_OVER_25_KIB",
            assessment: a1FindingDescriptor.defaults.assessment,
            routing: a1FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            anchors: ordered.slice(0, 5).map((event) => ({
              session_id: findingIds.session(event.session_id),
              timestamp: event.ts,
              event_id: findingIds.event(event.event_id),
            })),
            session_ids: sessionIds,
            estimate: {
              basis: "E",
              rank_value_u_per_wk: estimateRankValue,
              summable: true,
              label: "tool-result carry estimate",
            },
            impact: { kind: "TOKEN_WASTE", severity: "MEDIUM", direction: "REDUCE" },
            verdict: { value: "CONFIRMED", method: "RULE" },
            metrics: {
              EVENT_COUNT: { kind: "COUNT", value: ordered.length },
              RESULT_BYTES_TOTAL: { kind: "BYTES", value: totalBytes },
              MAX_RESULT_BYTES: { kind: "BYTES", value: largest.result_bytes },
              THRESHOLD_BYTES: { kind: "BYTES", value: A1_RESULT_BYTES_THRESHOLD },
              ...(readEvents.length === 0
                ? {}
                : {
                    READ_EVENT_COUNT: { kind: "COUNT", value: readEvents.length },
                    READ_RESULT_BYTES: {
                      kind: "BYTES",
                      value: readEvents.reduce((sum, event) => sum + event.result_bytes, 0),
                    },
                  }),
            },
          },
          a1FindingDescriptor,
        ),
      });
    }

    return fired.length === 0
      ? { fired, status: "INACTIVE", note: "no tool result exceeded 25 KiB" }
      : {
          fired,
          status: "ACTIVE",
          note: `${rows.length} oversized tool result event(s) across ${fired.length} workspace(s)`,
        };
  },
};

interface A1ResultEventRow {
  event_id: string;
  session_id: string;
  workspace_id: string;
  ts: string;
  result_bytes: number;
  owner_message_id: string | null;
}

/**
 * A1 ledger claims (P3.L L3): a raw-token write claim on the first later same-chain turn,
 * plus carry claims on every later turn after that — reusing `evaluate()`'s own oversized-event
 * selection (all tools, main + sidechain, no D6 exclusion; D6 prices only results at or under
 * 25,600 B, U7). `raw` uses the fixed 2.7 bytes/token estimator basis (`a1Estimate`), never the
 * calibrated ratio.
 */
export const a1ClaimProducer: ClaimProducer = {
  detectorId: "A1",
  *produce(db, ctx) {
    const rows = db
      .prepare(
        `SELECT e.event_id, e.session_id, s.workspace_id, e.ts, e.result_bytes,
                m.owner_message_id
           FROM tool_events e
           JOIN sessions s ON s.session_id = e.session_id
           LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
          WHERE e.ts >= ? AND e.ts < ?
            AND e.result_bytes > ?
          ORDER BY e.ts ASC, e.event_id ASC`,
      )
      .all(ctx.fromIso, ctx.toIso, A1_RESULT_BYTES_THRESHOLD) as A1ResultEventRow[];

    const budget = new Map<string, number>();
    for (const row of rows) {
      const raw = Math.round(
        (row.result_bytes - A1_RESULT_BYTES_THRESHOLD) / ESTIMATOR_BYTES_PER_TOKEN,
      );
      if (raw <= 0) continue;
      yield* resultClaimsForEvent(
        db,
        ctx,
        {
          detectorId: "A1",
          event: {
            eventId: row.event_id,
            sessionId: row.session_id,
            ts: row.ts,
            ownerMessageId: row.owner_message_id,
          },
          raw,
          includeCarry: true,
          recId: recId("A1", row.workspace_id, `A1|${row.workspace_id}`),
          fraction: A1_AVOIDANCE_FRACTION,
          fractionRange: A1_FRACTION_RANGE,
        },
        budget,
      );
    }
  },
};
