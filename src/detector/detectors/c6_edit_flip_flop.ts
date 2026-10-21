/**
 * C6 EDIT_FLIP_FLOP.
 *
 * Detects an Edit that reverts an earlier Edit on the same file in the same
 * session: its new_string hash equals the earlier old_string hash AND its
 * old_string hash equals the earlier new_string hash (a true A -> B, B -> A swap).
 * Hashes come from migration 044 (new ingest only; older rows have none) and never
 * leave the detector: findings contain only opaque event/session anchors and counts.
 *
 * $ (RR U13): a swap shows two edits cancelled out, but not which one was the mistake, so only
 * the redo is priced: the turn that issued each reverting edit. The card claims those turns in
 * full in the reliability lane (an upper bound); the detector's own estimate is the avoidable
 * share (CX_WASTED_TURN_AVOIDANCE_FRACTION) of the same turns' cost. The card stays REVIEW.
 */

import type { Db } from "../../db/open.js";
import type { ClaimProducer } from "../claim-ledger.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { recId } from "../rec-id.js";
import { c6Estimate } from "../savings.js";
import type { DetectorContext, DetectorV2, FiredV2 } from "../types.js";
import {
  type WasteTurn,
  createTurnIndex,
  wasteTurnClaims,
  wasteTurnCostU,
} from "../waste-turn-claims.js";

interface EditRow {
  readonly event_id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly ts: string;
  readonly block_index: number;
  readonly file_path_hash: string;
  readonly edit_old_string_hash: string;
  readonly edit_new_string_hash: string;
  readonly owner_message_id: string;
}

interface FlipFlop {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly anchor: EditRow;
}

export const c6FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "C6",
  rule_id: "C6_EDIT_FLIP_FLOP",
  labels: ["EDIT_FLIP_FLOP"],
  metrics: {
    FLIP_FLOP_COUNT: { kind: "COUNT" },
    AFFECTED_FILE_COUNT: { kind: "COUNT" },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "REVIEW",
      provenance: { source: "RULE", version: "c6-v2" },
    },
    routing: { tier: "T3" },
  },
  presentation: {
    category: "TOOLING",
    lever: "Investigate conflicting edit instructions before retrying the same file.",
    target_metric: "edit_flip_flop_count",
    title: "Repeated edit reversals",
  },
} as const);

function rowOrder(a: EditRow, b: EditRow): number {
  return (
    a.ts.localeCompare(b.ts) ||
    a.block_index - b.block_index ||
    a.event_id.localeCompare(b.event_id)
  );
}

/** Every reverting edit in the window (main chain, settled turns). */
function findFlips(db: Db, ctx: DetectorContext): FlipFlop[] {
  const rows = db
    .prepare(
      `SELECT e.event_id, e.session_id, s.workspace_id, e.ts, m.block_index,
              m.file_path_hash, m.edit_old_string_hash, m.edit_new_string_hash,
              m.owner_message_id
         FROM tool_events e
         JOIN tool_event_metadata m ON m.event_id = e.event_id
         JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
         JOIN sessions s ON s.session_id = e.session_id
        WHERE e.tool_name = 'Edit'
          AND e.ts >= ? AND e.ts < ?
          AND m.file_path_hash IS NOT NULL
          AND m.edit_old_string_hash IS NOT NULL
          AND m.edit_new_string_hash IS NOT NULL
          AND m.edit_old_string_hash != m.edit_new_string_hash
          AND m.owner_message_id IS NOT NULL
          AND t.is_sidechain = 0
          AND t.provisional = 0
        ORDER BY s.workspace_id ASC, e.session_id ASC, m.file_path_hash ASC,
                 e.ts ASC, m.block_index ASC, e.event_id ASC`,
    )
    .all(ctx.fromIso, ctx.toIso) as EditRow[];

  const byFile = new Map<string, EditRow[]>();
  for (const row of rows) {
    const key = `${row.workspace_id}\0${row.session_id}\0${row.file_path_hash}`;
    const group = byFile.get(key);
    if (group === undefined) byFile.set(key, [row]);
    else group.push(row);
  }

  const flips: FlipFlop[] = [];
  for (const events of byFile.values()) {
    // Swap keys (old\0new) of every earlier edit on this file.
    const seen = new Set<string>();
    for (const edit of [...events].sort(rowOrder)) {
      // A revert of an earlier X -> Y is this edit Y -> X.
      if (seen.has(`${edit.edit_new_string_hash}\0${edit.edit_old_string_hash}`)) {
        flips.push({ sessionId: edit.session_id, workspaceId: edit.workspace_id, anchor: edit });
      }
      seen.add(`${edit.edit_old_string_hash}\0${edit.edit_new_string_hash}`);
    }
  }
  return flips;
}

/** The turns that issued the reverting edits: the redo work. */
function redoTurns(flips: readonly FlipFlop[]): WasteTurn[] {
  return flips.map((flip) => ({
    sessionId: flip.sessionId,
    messageId: flip.anchor.owner_message_id,
  }));
}

const cardRecId = (workspaceId: string, sessionId: string) =>
  recId("C6", workspaceId, `C6|${workspaceId}|${sessionId}`);

export const c6Detector: DetectorV2 = {
  contractVersion: 2,
  version: "C6@u13-1",
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
    ],
  },
  descriptor: c6FindingDescriptor,
  id: "C6",
  name: "EDIT_FLIP_FLOP_V2",

  evaluate(db: Db, ctx) {
    const flips = findFlips(db, ctx);
    const index = createTurnIndex(db, ctx);

    const bySession = new Map<string, FlipFlop[]>();
    for (const flip of flips) {
      const key = `${flip.workspaceId}\0${flip.sessionId}`;
      const group = bySession.get(key);
      if (group === undefined) bySession.set(key, [flip]);
      else group.push(flip);
    }

    const fired: FiredV2[] = [];
    for (const flipsInSession of [...bySession.values()].sort((a, b) => {
      const firstA = a[0];
      const firstB = b[0];
      if (firstA === undefined || firstB === undefined) return 0;
      return (
        firstA.workspaceId.localeCompare(firstB.workspaceId) ||
        firstA.sessionId.localeCompare(firstB.sessionId)
      );
    })) {
      const first = flipsInSession[0];
      if (first === undefined) continue;
      const ordered = [...flipsInSession].sort((a, b) => rowOrder(a.anchor, b.anchor));
      const affectedFiles = new Set(ordered.map((flip) => `${flip.anchor.file_path_hash}`)).size;
      const estimate = c6Estimate({ costEquivU: wasteTurnCostU(index, redoTurns(ordered)) });
      fired.push({
        scopeKey: `C6|${first.workspaceId}|${first.sessionId}`,
        scope_workspace_id: first.workspaceId,
        modeled_savings_u_per_wk: estimate.rank_value_u_per_wk,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: c6FindingDescriptor.rule_id,
            label: "EDIT_FLIP_FLOP",
            assessment: c6FindingDescriptor.defaults.assessment,
            routing: c6FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            // No per-anchor CEU: anchors are chronological, so retain the newest five.
            anchors: ordered.slice(-5).map((flip) => ({
              session_id: findingIds.session(flip.sessionId),
              timestamp: flip.anchor.ts,
              event_id: findingIds.event(flip.anchor.event_id),
            })),
            session_ids: [first.sessionId],
            estimate,
            impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
            verdict: { value: "CONFIRMED", method: "RULE" },
            metrics: {
              FLIP_FLOP_COUNT: { kind: "COUNT", value: ordered.length },
              AFFECTED_FILE_COUNT: { kind: "COUNT", value: affectedFiles },
            },
          },
          c6FindingDescriptor,
        ),
      });
    }

    return fired.length === 0
      ? { fired, status: "INACTIVE", note: "no Edit reverted by a later swap edit" }
      : { fired, status: "ACTIVE", note: `${flips.length} edit reversal sequence(s)` };
  },
};

/**
 * C6 ledger claims (RR U13): each flip-flop's redo turn, claimed in full in the reliability
 * lane to its session's card.
 */
export const c6ClaimProducer: ClaimProducer = {
  detectorId: "C6",
  *produce(db, ctx) {
    const flips = findFlips(db, ctx);
    const workspaceBySession = new Map(flips.map((flip) => [flip.sessionId, flip.workspaceId]));
    yield* wasteTurnClaims(
      createTurnIndex(db, ctx),
      "C6",
      (turn) => cardRecId(workspaceBySession.get(turn.sessionId) ?? "", turn.sessionId),
      redoTurns(flips),
    );
  },
};
