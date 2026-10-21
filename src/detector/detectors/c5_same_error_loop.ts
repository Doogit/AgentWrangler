/**
 * C5 SAME_ERROR_LOOP.
 *
 * Finds repeated tool failures with the same retained error text within one
 * reconciled session. Tool names and closed error classes are grouping-only
 * facts: the persisted finding contains aggregates and structural anchors only.
 */

import type { Db } from "../../db/open.js";
import { computeN } from "../../ingest/n-computability.js";
import { PricingSnapshotStore, modelTier } from "../../ingest/pricing.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { c5Estimate, reclaimableCeu } from "../savings.js";
import { blendedTierPrice } from "../tier-price.js";
import { isBenignFailure } from "../turn-claim.js";
import type { DetectorV2, FiredV2 } from "../types.js";

export const C5_MIN_IDENTICAL_ERRORS = 3;
/** Consecutive identical errors further apart than this are separate mistakes, not one retry loop. */
export const C5_MAX_RETRY_GAP_MS = 10 * 60_000;
/** Magnitude bands are CEU, not confidence labels. */
export const C5_CEU_MEDIUM_THRESHOLD = 1_000;
export const C5_CEU_HIGH_THRESHOLD = 10_000;
/** R8 §8.4's documented JSON/tool-result bytes-to-token proxy. */
export const C5_TOOL_BYTES_PER_TOKEN = 3.4;

/** A shell command that ran reports "Exit code N"; any other shell error never ran (F30). */
const SHELL_RAN = /^\s*Exit code -?\d+/;
/** The settings deny-rule texts the ingest labels `deny-rule` (parser.ts). */
const DENY_RULE =
  /^Permission to use .* has been denied\.$|^File is in a directory that is denied by your permission settings\./;

/**
 * F32 (2026-10-14): a call that never ran or that C9 counts, read from its own error text. C9's
 * ingest labels sit on the tool result line, whose id is no tool event id, so they cannot be
 * joined per call; hook blocks and rejections are left to `isBenignFailure`.
 */
function isNeverRanOrDenied(toolName: string, error: string): boolean {
  if ((toolName === "Bash" || toolName === "PowerShell") && !SHELL_RAN.test(error)) return true;
  return DENY_RULE.test(error);
}

interface ErrorRow {
  readonly event_id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly ts: string;
  readonly block_index: number;
  readonly model: string | null;
  readonly output_tokens: number;
  readonly pricing_snapshot_id: string | null;
  readonly input_bytes: number | null;
  readonly result_bytes: number | null;
  readonly tool_name: string;
  /** Null when the classifier has no label for the error (most shell, browser and MCP errors). */
  readonly tool_error_class: string | null;
  readonly error_text: string | null;
  readonly command_text: string | null;
  readonly owner_message_id: string;
}

interface PricingSnapshotRow {
  readonly model_tier: string;
  readonly unit_prices_json: string;
}

/**
 * Returns the per-turn output/input list-price ratio only when the turn's
 * snapshot is present, well-formed, and belongs to that turn's model tier.
 * Output quota weighting is still an estimate, but a missing/mismatched price
 * must not manufacture an output CEU term.
 */
function outputCeuWeight(db: Db, error: ErrorRow): number | null {
  const tier = modelTier(error.model);
  if (tier === null || error.pricing_snapshot_id === null) return null;
  const row = db
    .prepare(
      `SELECT model_tier, unit_prices_json
         FROM pricing_snapshots
        WHERE snapshot_id = ?`,
    )
    .get(error.pricing_snapshot_id) as PricingSnapshotRow | undefined;
  if (row === undefined || row.model_tier !== tier) return null;

  try {
    const prices: unknown = JSON.parse(row.unit_prices_json);
    if (!Array.isArray(prices)) return null;
    const [input, output] = prices;
    if (
      typeof input !== "number" ||
      typeof output !== "number" ||
      !Number.isFinite(input) ||
      !Number.isFinite(output) ||
      input <= 0 ||
      output < 0
    ) {
      return null;
    }
    return output / input;
  } catch {
    return null;
  }
}

function callAndResultTokens(error: ErrorRow): number {
  const bytes = Math.max(0, error.input_bytes ?? 0) + Math.max(0, error.result_bytes ?? 0);
  return bytes / C5_TOOL_BYTES_PER_TOKEN;
}

function normalizedClusterText(text: string | null): string | null {
  if (text === null) return null;
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized === "" ? null : normalized;
}

/** The retained error text, normalized; null when none was kept (a row with no text joins no loop). */
function errorClusterKey(error: ErrorRow): string | null {
  return normalizedClusterText(error.error_text);
}

interface ErrorLoop {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly toolName: string;
  readonly errorClass: string | null;
  readonly errors: readonly ErrorRow[];
}

export const c5FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "C5",
  rule_id: "C5_SAME_ERROR_LOOP",
  labels: ["SAME_ERROR_LOOP"],
  metrics: {
    ERROR_LOOP_COUNT: { kind: "COUNT" },
    REPEATED_ERROR_COUNT: { kind: "COUNT" },
    LOOP_EXCESS_ERROR_COUNT: { kind: "COUNT" },
    AFFECTED_TOOL_COUNT: { kind: "COUNT" },
    AFFECTED_ERROR_CLASS_COUNT: { kind: "COUNT" },
    CONSERVATIVE_FLOOR_CEU: { kind: "NUMBER" },
    // Largest loop's tool and retained error excerpt ("" when no slice was retained).
    TOP_LOOP_TOOL: { kind: "TEXT", max: 128 },
    TOP_LOOP_ERROR_TEXT: { kind: "TEXT" },
  },
  facets: ["impact", "ceu", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "REVIEW",
      provenance: { source: "CLASSIFIER", version: "tool-error-1" },
    },
    routing: { tier: "T3" },
  },
  presentation: {
    category: "TOOLING",
    lever: "After 3 identical tool errors, stop and read the root cause instead of retrying.",
    target_metric: "same_error_loop_count",
    title: "Repeated identical tool errors",
  },
} as const);

function rowOrder(a: ErrorRow, b: ErrorRow): number {
  return (
    a.ts.localeCompare(b.ts) ||
    a.block_index - b.block_index ||
    a.event_id.localeCompare(b.event_id)
  );
}

export function c5CeuBand(ceu: number): "LOW" | "MEDIUM" | "HIGH" {
  if (ceu >= C5_CEU_HIGH_THRESHOLD) return "HIGH";
  if (ceu >= C5_CEU_MEDIUM_THRESHOLD) return "MEDIUM";
  return "LOW";
}

export const c5Detector: DetectorV2 = {
  contractVersion: 2,
  // U9 r2: a loop needs identical errors within 10 minutes of each other. r7: C9's classified denials are not loops.
  // F32: a shell error without `Exit code N` (never ran) or with deny-rule text is not a loop.
  version: "C5@f32-1",
  scope: "session",
  inputs: {
    tables: [
      "turns",
      "sessions",
      "workspaces",
      "user_config",
      "pricing_snapshots",
      "tool_events",
      "tool_event_metadata",
      "tool_event_content",
      "ingest_metric_events",
    ],
  },
  descriptor: c5FindingDescriptor,
  id: "C5",
  name: "SAME_ERROR_LOOP_V2",

  evaluate(db: Db, ctx) {
    const rows = db
      .prepare(
        `SELECT e.event_id, e.session_id, s.workspace_id, e.ts, m.block_index,
                t.model, t.output_tokens, t.pricing_snapshot_id,
                e.input_bytes, e.result_bytes, e.tool_name, e.tool_error_class,
                json_extract(c.content_json, '$.error') AS error_text,
                json_extract(c.content_json, '$.command') AS command_text,
                m.owner_message_id
           FROM tool_events e
           JOIN tool_event_metadata m ON m.event_id = e.event_id
           JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
           JOIN sessions s ON s.session_id = e.session_id
           LEFT JOIN tool_event_content c ON c.event_id = e.event_id
          WHERE e.ts >= ? AND e.ts < ?
            AND s.state = 'RECONCILED'
            AND m.owner_message_id IS NOT NULL
            AND t.is_sidechain = 0
            AND t.provisional = 0
            AND e.exit_class = 'ERROR'
          ORDER BY s.workspace_id, e.session_id, e.tool_name, error_text, e.tool_error_class,
                   e.ts, m.block_index, e.event_id`,
      )
      .all(ctx.fromIso, ctx.toIso) as ErrorRow[];

    // Every ERROR is a candidate, whether or not the classifier labelled it: the label gate used
    // to drop 94% of them, so shell, browser and MCP loops could never fire. A call blocked or
    // declined before it ran, or an expected non-zero exit, is no failure to loop on.
    const grouped = new Map<string, ErrorRow[]>();
    for (const row of rows) {
      const text = errorClusterKey(row);
      if (
        text === null ||
        isNeverRanOrDenied(row.tool_name, row.error_text ?? "") ||
        isBenignFailure(row.command_text, row.error_text, row.tool_name)
      ) {
        continue;
      }
      const key = `${row.workspace_id}\0${row.session_id}\0${row.tool_name}\0${text}`;
      const group = grouped.get(key);
      if (group === undefined) grouped.set(key, [row]);
      else group.push(row);
    }

    const loops: ErrorLoop[] = [];
    for (const events of grouped.values()) {
      // Count distinct owner turns: parallel calls in one turn are not retries.
      const seenTurns = new Set<string>();
      const distinct = [...events].sort(rowOrder).filter((row) => {
        if (seenTurns.has(row.owner_message_id)) return false;
        seenTurns.add(row.owner_message_id);
        return true;
      });
      // U9 r2: a loop is retries close in time. The same error text hours apart (three Writes to
      // three files over 85 minutes) is a repeated mistake, not a loop: split on a long gap.
      const runs: ErrorRow[][] = [];
      for (const row of distinct) {
        const run = runs[runs.length - 1];
        const last = run?.[run.length - 1];
        if (
          run !== undefined &&
          last !== undefined &&
          Date.parse(row.ts) - Date.parse(last.ts) <= C5_MAX_RETRY_GAP_MS
        ) {
          run.push(row);
        } else {
          runs.push([row]);
        }
      }
      for (const errors of runs) {
        if (errors.length < C5_MIN_IDENTICAL_ERRORS) continue;
        const first = errors[0];
        if (first === undefined) continue;
        loops.push({
          sessionId: first.session_id,
          workspaceId: first.workspace_id,
          toolName: first.tool_name,
          errorClass: first.tool_error_class,
          errors: [...errors].sort(rowOrder),
        });
      }
    }

    const bySession = new Map<string, ErrorLoop[]>();
    for (const loop of loops) {
      const key = `${loop.workspaceId}\0${loop.sessionId}`;
      const group = bySession.get(key);
      if (group === undefined) bySession.set(key, [loop]);
      else group.push(loop);
    }

    const pricing = new PricingSnapshotStore(db, ctx.toIso);
    const fired: FiredV2[] = [];
    for (const sessionLoops of [...bySession.values()].sort((a, b) => {
      const firstA = a[0];
      const firstB = b[0];
      if (firstA === undefined || firstB === undefined) return 0;
      return (
        firstA.workspaceId.localeCompare(firstB.workspaceId) ||
        firstA.sessionId.localeCompare(firstB.sessionId)
      );
    })) {
      const first = sessionLoops[0];
      if (first === undefined) continue;
      const errors = sessionLoops.flatMap((loop) => loop.errors).sort(rowOrder);
      const topLoop = sessionLoops.reduce((top, loop) =>
        loop.errors.length > top.errors.length ? loop : top,
      );
      // The first two identical errors establish the loop. Only later errors are
      // conservatively reclaimable; each gets its own model weights and N window.
      const loopExcessErrors = sessionLoops
        .flatMap((loop) => loop.errors.slice(C5_MIN_IDENTICAL_ERRORS - 1))
        .sort(rowOrder);
      const ceuEstimates = loopExcessErrors.map((error) => {
        const n = computeN(db, error.session_id, error.ts);
        const cachedSpan = reclaimableCeu(
          callAndResultTokens(error),
          n.conservativeFloor ? null : n.n,
          pricing.reclaimableCeuWeights(error.model),
          { nVerified: !n.conservativeFloor },
        );
        const outputWeight = outputCeuWeight(db, error);
        const outputCeu = outputWeight === null ? 0 : error.output_tokens * outputWeight;
        return {
          eventId: error.event_id,
          floorCeu: cachedSpan.floor.ceu + outputCeu,
          expectedCeu:
            cachedSpan.expected === null || outputWeight === null
              ? null
              : cachedSpan.expected.ceu + outputCeu,
        };
      });
      const conservativeFloorCeu = ceuEstimates.reduce(
        (total, estimate) => total + estimate.floorCeu,
        0,
      );
      const expectedCeu = ceuEstimates.every((estimate) => estimate.expectedCeu !== null)
        ? ceuEstimates.reduce((total, estimate) => total + (estimate.expectedCeu ?? 0), 0)
        : null;
      const displayedCeu = expectedCeu ?? conservativeFloorCeu;
      // MED-3 (operator 2026-09-22): D7 is the single owner of loop economics
      // (cap-weighted read basis). C5 clusters the SAME identical-error loops on an
      // input basis, so pricing it here double-counted the same loop turns in the
      // efficiency-headroom SUM. C5 stays a friction/advisory finding with null $/wk;
      // the displayed CEU band below remains as loop-severity context, not a $ claim.
      const modeledSavingsUPerWk: number | null = null;
      const ceuByEventId = new Map(
        ceuEstimates.map((estimate) => [
          estimate.eventId,
          estimate.expectedCeu ?? estimate.floorCeu,
        ]),
      );
      // Loop-establishing errors contribute no reclaimable CEU. Rank excess
      // errors by their individually computed CEU contribution, resolving ties
      // by recency, then emit the selected anchors chronologically.
      const anchors = errors
        .map((error) => ({ error, ceu: ceuByEventId.get(error.event_id) ?? 0 }))
        .sort((a, b) => b.ceu - a.ceu || rowOrder(b.error, a.error))
        .slice(0, 5)
        .sort((a, b) => rowOrder(a.error, b.error));
      fired.push({
        scopeKey: `C5|${first.workspaceId}|${first.sessionId}`,
        scope_workspace_id: first.workspaceId,
        modeled_savings_u_per_wk: modeledSavingsUPerWk,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: c5FindingDescriptor.rule_id,
            label: "SAME_ERROR_LOOP",
            assessment: c5FindingDescriptor.defaults.assessment,
            routing: c5FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            anchors: anchors.map(({ error: row }) => ({
              session_id: findingIds.session(row.session_id),
              timestamp: row.ts,
              event_id: findingIds.event(row.event_id),
            })),
            session_ids: [first.sessionId],
            estimate: c5Estimate({
              conservativeFloorCeu,
              // Each excess error's floor CEU priced at its own turn's tier input rate.
              inputPriceUsdPerMtok: blendedTierPrice(
                db,
                ceuEstimates.map((estimate, i) => ({
                  model: loopExcessErrors[i]?.model ?? null,
                  weight: estimate.floorCeu,
                })),
                0,
              ),
            }),
            impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
            ceu: {
              value: displayedCeu,
              band: c5CeuBand(displayedCeu),
              provenance: expectedCeu === null ? "FLOOR" : "ESTIMATED",
            },
            verdict: { value: "CONFIRMED", method: "RULE" },
            metrics: {
              ERROR_LOOP_COUNT: { kind: "COUNT", value: sessionLoops.length },
              REPEATED_ERROR_COUNT: { kind: "COUNT", value: errors.length },
              LOOP_EXCESS_ERROR_COUNT: {
                kind: "COUNT",
                value: sessionLoops.reduce(
                  (total, loop) => total + loop.errors.length - (C5_MIN_IDENTICAL_ERRORS - 1),
                  0,
                ),
              },
              AFFECTED_TOOL_COUNT: {
                kind: "COUNT",
                value: new Set(sessionLoops.map((loop) => loop.toolName)).size,
              },
              AFFECTED_ERROR_CLASS_COUNT: {
                kind: "COUNT",
                // Text-based clustering can place multiple tool_error_class values in
                // one loop, so count distinct classes across every error, not per-loop
                // first rows.
                value: new Set(
                  sessionLoops
                    .flatMap((loop) => loop.errors)
                    .map((e) => e.tool_error_class)
                    .filter((errorClass) => errorClass !== null),
                ).size,
              },
              CONSERVATIVE_FLOOR_CEU: { kind: "NUMBER", value: conservativeFloorCeu },
              TOP_LOOP_TOOL: { kind: "TEXT", value: topLoop.toolName.slice(0, 128) },
              TOP_LOOP_ERROR_TEXT: {
                kind: "TEXT",
                value: (topLoop.errors[0]?.error_text ?? "").trim().slice(0, 4_000),
              },
            },
          },
          c5FindingDescriptor,
        ),
      });
    }

    return fired.length === 0
      ? { fired, status: "INACTIVE", note: "no repeated identically classified tool errors" }
      : { fired, status: "ACTIVE", note: `${loops.length} same-error loop(s)` };
  },
};
