/**
 * A2 BACKGROUND_AGENT_TRANSCRIPT_BLOAT.
 *
 * TaskOutput results above 10 KiB are retained by a parent conversation. This
 * detector only accepts events with an owned, reconciled main-chain turn, so
 * incomplete ownership and sidechain/provisional data fail closed.
 */

import type { Db } from "../../db/open.js";
import { pctOfSpend, workspaceSpendU } from "../../query/spend.js";
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
  A2_AVOIDANCE_FRACTION,
  ESTIMATOR_BYTES_PER_TOKEN,
  a2Estimate,
  a2Savings,
  carryPriceUsdPerMtok,
} from "../savings.js";
import type { DetectorV2, FiredV2 } from "../types.js";
import { blendedCacheWritePriceForWorkspace } from "../write-price.js";
import { A1_RESULT_BYTES_THRESHOLD } from "./a1_tool_result_bloat.js";

export const A2_TASK_OUTPUT_BYTES_THRESHOLD = 10 * 1024;

/** A2's ASSUMED avoidance-fraction [min, max], read from the quantity contract (F1). */
const A2_FRACTION_CONSTANT = DETECTOR_CONTRACTS.A2?.constants.find(
  (constant) => constant.name === "A2_AVOIDANCE_FRACTION",
);
const A2_FRACTION_RANGE: readonly [number, number] =
  A2_FRACTION_CONSTANT && A2_FRACTION_CONSTANT.status === "ASSUMED"
    ? [A2_FRACTION_CONSTANT.min, A2_FRACTION_CONSTANT.max]
    : [0.33, 0.7]; // fallback literal mirrors contracts.ts DETECTOR_CONTRACTS.A2

interface TaskOutputRow {
  event_id: string;
  session_id: string;
  workspace_id: string;
  ts: string;
  result_bytes: number;
  owner_message_id: string;
}

/** Card gate: the results' carry cost as a % of the workspace's spend in the window (U7). */
export const A2_MIN_PCT_OF_SPEND = 0.1;

export const a2FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "A2",
  rule_id: "A2_BACKGROUND_AGENT_TRANSCRIPT_BLOAT",
  labels: ["TASK_OUTPUT_OVER_10_KIB"],
  metrics: {
    EVENT_COUNT: { kind: "COUNT" },
    RESULT_BYTES_TOTAL: { kind: "BYTES" },
    MAX_RESULT_BYTES: { kind: "BYTES" },
    THRESHOLD_BYTES: { kind: "BYTES" },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "ASSERTED",
      provenance: { source: "RULE", version: "a2-v1" },
    },
    routing: { tier: "T3" },
  },
  presentation: {
    category: "TOOLING",
    lever:
      "Have background tasks write detailed output to files and read back only what is needed.",
    target_metric: "task_output_result_bytes",
    title: "Large background-task results",
  },
} as const);

function eventOrder(a: TaskOutputRow, b: TaskOutputRow): number {
  return (
    b.result_bytes - a.result_bytes ||
    b.ts.localeCompare(a.ts) ||
    a.event_id.localeCompare(b.event_id)
  );
}

export const a2Detector: DetectorV2 = {
  contractVersion: 2,
  version: "A2@u7-1",
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
  descriptor: a2FindingDescriptor,
  id: "A2",
  name: "BACKGROUND_AGENT_TRANSCRIPT_BLOAT_V2",

  evaluate(db: Db, ctx) {
    const bptResolution = resolveBytesPerToken(db);
    const resultCarry = createResultCarry(db);

    const rows = db
      .prepare(
        `SELECT e.event_id, e.session_id, t.workspace_id, e.ts, e.result_bytes,
                m.owner_message_id
           FROM tool_events e
           JOIN tool_event_metadata m ON m.event_id = e.event_id
           JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
          WHERE e.ts >= ? AND e.ts < ?
            AND e.tool_name = 'TaskOutput'
            AND e.result_bytes > ?
            AND t.is_sidechain = 0
            AND t.provisional = 0
          ORDER BY t.workspace_id ASC, e.ts ASC, e.event_id ASC`,
      )
      .all(ctx.fromIso, ctx.toIso, A2_TASK_OUTPUT_BYTES_THRESHOLD) as TaskOutputRow[];

    const byWorkspace = new Map<string, TaskOutputRow[]>();
    for (const row of rows) {
      if (
        !Number.isSafeInteger(row.result_bytes) ||
        row.result_bytes <= A2_TASK_OUTPUT_BYTES_THRESHOLD
      )
        continue;
      const events = byWorkspace.get(row.workspace_id);
      if (events === undefined) byWorkspace.set(row.workspace_id, [row]);
      else events.push(row);
    }

    const fired: FiredV2[] = [];
    for (const [workspaceId, events] of [...byWorkspace.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const ordered = [...events].sort(eventOrder);
      const totalBytes = ordered.reduce((sum, event) => sum + event.result_bytes, 0);
      if (!Number.isSafeInteger(totalBytes))
        throw new TypeError("A2 aggregate result bytes must be a safe integer");
      const largest = ordered[0];
      if (largest === undefined) continue;
      const sessionIds = [...new Set(ordered.map((event) => event.session_id))].sort().slice(0, 20);

      // U7: each result is priced along its owner chain (one write + carry − 1 reads), over the
      // same set the ledger claims: results above A1's 25,600 B floor are A1's.
      const bpt = bptResolution.calibrated ? bptResolution.ratio : ESTIMATOR_BYTES_PER_TOKEN;
      let rankValueU = 0;
      let carryCostU = 0;
      for (const event of ordered) {
        if (event.result_bytes > A1_RESULT_BYTES_THRESHOLD) continue;
        const carried = resultCarry(event.session_id, event.ts, event.owner_message_id);
        if (carried === undefined) continue;
        const avoidableBytes = event.result_bytes - A2_TASK_OUTPUT_BYTES_THRESHOLD;
        rankValueU +=
          a2Estimate({
            avoidableBytes,
            bytesPerToken: bpt,
            carryTurns: carried.carry,
            writePriceUsdPerMtok: carried.writePrice,
            cacheReadPriceUsdPerMtok: carried.readPrice,
          }).rank_value_u_per_wk ?? 0;
        carryCostU +=
          (event.result_bytes / bpt) *
          carryPriceUsdPerMtok(carried.carry, carried.writePrice, carried.readPrice);
      }
      // Gate (settled % floor): the results' carry cost must reach 0.1% of the workspace's spend.
      const spendU = workspaceSpendU(
        db,
        workspaceId,
        Date.parse(ctx.fromIso),
        Date.parse(ctx.toIso),
      );
      if ((pctOfSpend(carryCostU, spendU) ?? 0) < A2_MIN_PCT_OF_SPEND) continue;
      const estimate = { ...a2Estimate({}), rank_value_u_per_wk: Math.round(rankValueU) };

      // Compute modeled savings (gate: calibrated + writePrice > 0 + avoidableBytes > 0).
      let modeledSavingsU: number | null = null;
      if (bptResolution.calibrated) {
        let avoidableBytes = 0;
        for (const event of ordered) {
          if (event.result_bytes > A1_RESULT_BYTES_THRESHOLD) continue;
          avoidableBytes += event.result_bytes - A2_TASK_OUTPUT_BYTES_THRESHOLD;
        }
        if (avoidableBytes > 0) {
          const writePrice = blendedCacheWritePriceForWorkspace(
            db,
            workspaceId,
            ctx.fromIso,
            ctx.toIso,
          );
          if (writePrice > 0) {
            const { savingsU } = a2Savings(avoidableBytes, bptResolution.ratio, writePrice, 0);
            modeledSavingsU = savingsU;
          }
        }
      }

      fired.push({
        scopeKey: `A2|${workspaceId}`,
        scope_workspace_id: workspaceId,
        modeled_savings_u_per_wk: modeledSavingsU,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: a2FindingDescriptor.rule_id,
            label: "TASK_OUTPUT_OVER_10_KIB",
            assessment: a2FindingDescriptor.defaults.assessment,
            routing: a2FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            anchors: ordered.slice(0, 5).map((event) => ({
              session_id: findingIds.session(event.session_id),
              timestamp: event.ts,
              event_id: findingIds.event(event.event_id),
            })),
            session_ids: sessionIds,
            estimate,
            impact: { kind: "TOKEN_WASTE", severity: "MEDIUM", direction: "REDUCE" },
            verdict: { value: "CONFIRMED", method: "RULE" },
            metrics: {
              EVENT_COUNT: { kind: "COUNT", value: ordered.length },
              RESULT_BYTES_TOTAL: { kind: "BYTES", value: totalBytes },
              MAX_RESULT_BYTES: { kind: "BYTES", value: largest.result_bytes },
              THRESHOLD_BYTES: { kind: "BYTES", value: A2_TASK_OUTPUT_BYTES_THRESHOLD },
            },
          },
          a2FindingDescriptor,
        ),
      });
    }

    return fired.length === 0
      ? { fired, status: "INACTIVE", note: "no owned reconciled TaskOutput result exceeded 10 KiB" }
      : {
          fired,
          status: "ACTIVE",
          note: `${rows.length} oversized TaskOutput event(s) across ${fired.length} workspace(s)`,
        };
  },
};

interface A2ResultEventRow {
  event_id: string;
  session_id: string;
  workspace_id: string;
  ts: string;
  result_bytes: number;
  owner_message_id: string;
}

/**
 * A2 ledger claims (P3.L L3): a raw-token write claim on the first later same-chain turn, plus
 * carry claims on the later main-thread turns that read it back (U7). Reuses
 * `evaluate()`'s own selection but excludes events over 25.6 KiB — A1 owns those (one owner
 * per event). `raw` uses the calibrated bytes/token ratio when available, else the 2.7
 * estimator fallback (same as `evaluate()`'s own `a2Estimate` call).
 */
export const a2ClaimProducer: ClaimProducer = {
  detectorId: "A2",
  *produce(db, ctx) {
    const bptResolution = resolveBytesPerToken(db);
    const bpt = bptResolution.calibrated ? bptResolution.ratio : ESTIMATOR_BYTES_PER_TOKEN;

    const rows = db
      .prepare(
        `SELECT e.event_id, e.session_id, t.workspace_id, e.ts, e.result_bytes,
                m.owner_message_id
           FROM tool_events e
           JOIN tool_event_metadata m ON m.event_id = e.event_id
           JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
          WHERE e.ts >= ? AND e.ts < ?
            AND e.tool_name = 'TaskOutput'
            AND e.result_bytes > ?
            AND e.result_bytes <= ?
            AND t.is_sidechain = 0
            AND t.provisional = 0
          ORDER BY e.ts ASC, e.event_id ASC`,
      )
      .all(
        ctx.fromIso,
        ctx.toIso,
        A2_TASK_OUTPUT_BYTES_THRESHOLD,
        A1_RESULT_BYTES_THRESHOLD,
      ) as A2ResultEventRow[];

    const budget = new Map<string, number>();
    for (const row of rows) {
      const raw = Math.round((row.result_bytes - A2_TASK_OUTPUT_BYTES_THRESHOLD) / bpt);
      if (raw <= 0) continue;
      yield* resultClaimsForEvent(
        db,
        ctx,
        {
          detectorId: "A2",
          event: {
            eventId: row.event_id,
            sessionId: row.session_id,
            ts: row.ts,
            ownerMessageId: row.owner_message_id,
          },
          raw,
          includeCarry: true,
          recId: recId("A2", row.workspace_id, `A2|${row.workspace_id}`),
          fraction: A2_AVOIDANCE_FRACTION,
          fractionRange: A2_FRACTION_RANGE,
        },
        budget,
      );
    }
  },
};
