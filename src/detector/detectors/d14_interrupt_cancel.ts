/** D14 implements library D2 interrupt/cancel classification from closed persisted signals. */

import type { Db } from "../../db/open.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { d14Estimate } from "../savings.js";
import { D14_ESC_SQL, D14_NOT_SESSION_END, wastedTurnClaims } from "../turn-claim.js";
import type { DetectorV2, FiredV2 } from "../types.js";

const INTERRUPT_KINDS = ["PURE_INTERRUPT", "KILLED_NO_PROMPT"] as const;
type InterruptKind = (typeof INTERRUPT_KINDS)[number];

interface InterruptRow {
  readonly event_id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly ts: string;
  readonly interrupt_kind: InterruptKind;
}

export const d14FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "D14",
  // Runtime D2 is already the persisted SESSION_LONG_FULL_CONTEXT detector.
  // This library-D2 rule therefore has a distinct runtime ID.
  rule_id: "D2",
  labels: INTERRUPT_KINDS,
  metrics: {
    INTERRUPT_KIND: { kind: "ENUM", values: INTERRUPT_KINDS },
    INTERRUPT_COUNT: { kind: "COUNT" },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "ASSERTED",
      provenance: { source: "CLASSIFIER", version: "interrupt-1" },
    },
    routing: { tier: "T2" },
  },
  presentation: {
    category: "SESSION_HYGIENE",
    lever: "Review the classified interruption before repeating the interrupted task.",
    target_metric: "interrupt_cancel_count",
    title: "Interrupted or cancelled tool requests",
  },
} as const);

export const d14Detector: DetectorV2 = {
  contractVersion: 2,
  version: "D14@u7-2",
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
  descriptor: d14FindingDescriptor,
  id: "D14",
  name: "INTERRUPT_CANCEL_CLASSIFICATION_V2",

  evaluate(db: Db, ctx) {
    const rows = db
      .prepare(
        `SELECT e.event_id, e.session_id, s.workspace_id, e.ts, e.interrupt_kind
           FROM tool_events e
           JOIN tool_event_metadata m ON m.event_id = e.event_id
           JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
           JOIN sessions s ON s.session_id = e.session_id
          WHERE e.ts >= ? AND e.ts < ?
            AND s.state = 'RECONCILED'
            AND t.is_sidechain = 0
            AND t.provisional = 0
            AND e.interrupt_kind IN ('PURE_INTERRUPT', 'KILLED_NO_PROMPT')
            AND e.interrupt_classifier_version = 'interrupt-1'
            AND ${D14_NOT_SESSION_END}
            -- A reconciled session's prompt correction within two later main-chain turns
            -- makes the interruption a good interrupt rather than detector evidence.
            AND NOT EXISTS (
              SELECT 1
                FROM ingest_metric_events user_turn
               WHERE user_turn.session_id = e.session_id
                 AND user_turn.is_user_turn = 1
                 AND user_turn.user_turn_ts > e.ts
                 AND (
                   SELECT COUNT(*)
                     FROM turns later_turn
                    WHERE later_turn.session_id = e.session_id
                      AND later_turn.is_sidechain = 0
                      AND later_turn.provisional = 0
                      AND later_turn.ts > e.ts
                      AND later_turn.ts <= user_turn.user_turn_ts
                 ) <= 2
            )
          ORDER BY s.workspace_id, e.session_id, e.interrupt_kind, e.ts, e.event_id`,
      )
      .all(ctx.fromIso, ctx.toIso) as InterruptRow[];
    // RC-D14: a plain Esc has no tool event; it is a user record of its own (PURE_INTERRUPT).
    const escRows = (
      db.prepare(D14_ESC_SQL).all(ctx.fromIso, ctx.toIso) as Array<
        Omit<InterruptRow, "interrupt_kind">
      >
    ).map((row): InterruptRow => ({ ...row, interrupt_kind: "PURE_INTERRUPT" }));
    if (escRows.length > 0) {
      const order = (r: InterruptRow) => [
        r.workspace_id,
        r.session_id,
        r.interrupt_kind,
        r.ts,
        r.event_id,
      ];
      rows.push(...escRows);
      rows.sort((a, b) => {
        const ka = order(a);
        const kb = order(b);
        for (let i = 0; i < ka.length; i++) {
          if (ka[i] !== kb[i]) return (ka[i] as string) < (kb[i] as string) ? -1 : 1;
        }
        return 0;
      });
    }

    const groups = new Map<string, InterruptRow[]>();
    for (const row of rows) {
      const key = `${row.workspace_id}\0${row.session_id}\0${row.interrupt_kind}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [row]);
      else group.push(row);
    }

    // rank = 0.5 × Σ cost_equiv_u over this session's D14-claimed turns (distinct, after
    // the claim order D7 excl → C7 > C3 > C4 > C1 > C2 > C9 > D14 > D11).
    const d14Claimed = wastedTurnClaims(db, ctx).get("D14") ?? new Set<string>();
    const turnCostQ = db.prepare(
      "SELECT cost_equiv_u FROM turns WHERE session_id = ? AND message_id = ?",
    );
    const claimedCostU = (sessionId: string): number => {
      let sum = 0;
      for (const key of d14Claimed) {
        const pipeIdx = key.indexOf("|");
        if (key.slice(0, pipeIdx) !== sessionId) continue;
        const row = turnCostQ.get(sessionId, key.slice(pipeIdx + 1)) as
          | { cost_equiv_u: number | null }
          | undefined;
        sum += row?.cost_equiv_u ?? 0;
      }
      return sum;
    };

    const fired: FiredV2[] = [];
    for (const group of groups.values()) {
      const first = group[0];
      if (first === undefined) continue;
      const estimate = d14Estimate({ costEquivU: claimedCostU(first.session_id) });
      fired.push({
        scopeKey: `D14|${first.workspace_id}|${first.session_id}|${first.interrupt_kind}`,
        scope_workspace_id: first.workspace_id,
        modeled_savings_u_per_wk: null,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: d14FindingDescriptor.rule_id,
            label: first.interrupt_kind,
            assessment: d14FindingDescriptor.defaults.assessment,
            routing: d14FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            // Rows are ordered ascending; retain and emit the newest bounded anchors.
            anchors: group.slice(-5).map((row) => ({
              session_id: findingIds.session(row.session_id),
              timestamp: row.ts,
              event_id: findingIds.event(row.event_id),
            })),
            session_ids: [first.session_id],
            estimate,
            impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
            verdict: { value: "CONFIRMED", method: "RULE" },
            metrics: {
              INTERRUPT_KIND: { kind: "ENUM", value: first.interrupt_kind },
              INTERRUPT_COUNT: { kind: "COUNT", value: group.length },
            },
          },
          d14FindingDescriptor,
        ),
      });
    }

    if (fired.length > 0) {
      return { fired, status: "ACTIVE", note: `${rows.length} interrupt or cancellation event(s)` };
    }
    const { n: excluded } = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tool_events
          WHERE ts >= ? AND ts < ?
            AND interrupt_kind IN ('PURE_INTERRUPT', 'KILLED_NO_PROMPT')
            AND interrupt_classifier_version = 'interrupt-1'`,
      )
      .get(ctx.fromIso, ctx.toIso) as { n: number };
    // RC-D14: the main-chain user Esc records too (both variants).
    const { n: escSeen } = db
      .prepare(
        `SELECT COUNT(*) AS n FROM ingest_metric_events
          WHERE event_ts >= ? AND event_ts < ?
            AND is_sidechain = 0 AND is_interrupt = 1 AND classifier_version = 'classifier-2'`,
      )
      .get(ctx.fromIso, ctx.toIso) as { n: number };
    const seen = excluded + escSeen;
    return {
      fired,
      status: "INACTIVE",
      note:
        seen === 0
          ? "no persisted interrupt or cancellation classifications"
          : `${seen} interrupt or cancellation classification(s) in window, all excluded (session end, sidechain/provisional, unreconciled, corrected by the next prompt, or an Esc on a tool prompt, which is a tool denial)`,
    };
  },
};
