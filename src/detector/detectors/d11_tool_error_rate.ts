/**
 * D11 TOOL_ERROR_RATE — directional Bash-vs-PowerShell friction signal (signal a).
 *
 * Fires when one of the two substitutable repo/file-op shells errors at >= 1.5x
 * the other's 7d rate and both clear a minimum call volume. Calls that never ran
 * and benign exits are left out (`d11Outcome`). Non-CONTEXT, so it
 * carries NO headroom (the query layer would emit null anyway); before/after
 * error rates ship as plain evidence numbers. SEC-101: aggregate counts + the
 * harness tool-name enum only — no command text.
 */

import type { Db } from "../../db/open.js";
import { d11Estimate } from "../savings.js";
import {
  D11_MIN_CALLS,
  D11_MIN_HIGHER_ERRORS,
  D11_RATE_RATIO,
  d11Outcome,
  d11ShellRates,
  turnKey,
  wastedTurnClaims,
} from "../turn-claim.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";

interface ErrorTurnRow {
  session_id: string;
  owner_message_id: string;
  is_sidechain: number;
  cost_equiv_u: number | null;
}

/** A failed call of the higher-error shell; turn columns are null when it has no owner turn. */
interface FailureRow {
  session_id: string;
  owner_message_id: string | null;
  is_sidechain: number | null;
  cost_equiv_u: number | null;
  provisional: number | null;
  exit_class: string;
  command_text: string | null;
  error_text: string | null;
}

export const d11Detector: Detector = {
  contractVersion: 1,
  version: "D11@workspace-v2",
  scope: "cross-session",
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
  id: "D11",
  name: "TOOL_ERROR_RATE",

  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    const byWorkspace = d11ShellRates(db, ctx);
    const fired: Fired[] = [];
    let ownClaims: Set<string> | undefined;
    for (const [workspaceId, rates] of byWorkspace) {
      const bash = rates.get("Bash");
      const powerShell = rates.get("PowerShell");
      if (
        bash === undefined ||
        powerShell === undefined ||
        bash.calls < D11_MIN_CALLS ||
        powerShell.calls < D11_MIN_CALLS
      )
        continue;

      const bashRate = bash.errors / bash.calls;
      const powerShellRate = powerShell.errors / powerShell.calls;
      const higherRate = Math.max(bashRate, powerShellRate);
      const lowerRate = Math.min(bashRate, powerShellRate);
      const bashIsWorse = bashRate >= powerShellRate;
      const preferred = bashIsWorse ? powerShell : bash;
      const worse = bashIsWorse ? bash : powerShell;
      const meetsMinimumErrors = worse.errors >= D11_MIN_HIGHER_ERRORS;
      const meetsRatio =
        lowerRate === 0
          ? meetsMinimumErrors && higherRate > 0
          : meetsMinimumErrors && higherRate >= D11_RATE_RATIO * lowerRate;
      if (!meetsRatio) continue;
      ownClaims ??= wastedTurnClaims(db, ctx).get("D11") ?? new Set();

      // Derive the preferred (lower-error) vs. discouraged (higher-error) tool from
      // the data — never hardcode a direction, or the advice inverts in a week where
      // PowerShell is the better-behaved shell.
      const preferredPct = Number(((preferred.errors / preferred.calls) * 100).toFixed(1));
      const worsePct = Number(((worse.errors / worse.calls) * 100).toFixed(1));
      const failures = (
        db
          .prepare(
            `SELECT e.session_id, m.owner_message_id, t.is_sidechain, t.cost_equiv_u, t.provisional,
                    e.exit_class,
                    json_extract(c.content_json, '$.command') AS command_text,
                    json_extract(c.content_json, '$.error') AS error_text
             FROM tool_events e
             JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
             LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
             LEFT JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
             LEFT JOIN tool_event_content c ON c.event_id = e.event_id
            WHERE e.ts >= ? AND e.ts < ?
              AND s.workspace_id = ?
              AND e.tool_name = ?
              AND e.exit_class = 'ERROR'`,
          )
          .all(ctx.fromIso, ctx.toIso, workspaceId, worse.tool_name) as FailureRow[]
      ).filter((row) => d11Outcome(row.exit_class, row.command_text, row.error_text) === "ERROR");
      const errorTurns = failures.filter(
        (row): row is FailureRow & ErrorTurnRow =>
          row.owner_message_id !== null && row.provisional === 0,
      );

      // Sidechain turns do not participate in wastedTurnClaims. Main-chain turns
      // are priced only when D11 owns the claim after C7 > C3 > C4 > C1 > C2 > C9 > D14.
      const pricedTurns = new Map<string, ErrorTurnRow>();
      for (const row of errorTurns) {
        const key = turnKey(row.session_id, row.owner_message_id);
        if (row.is_sidechain === 1 || ownClaims.has(key)) pricedTurns.set(key, row);
      }
      const costEquivU = [...pricedTurns.values()].reduce(
        (total, row) => total + (row.cost_equiv_u ?? 0),
        0,
      );
      const excessErrors = worse.errors - worse.calls * lowerRate;
      const estimate = d11Estimate({
        excessErrors,
        higherErrorCount: worse.errors,
        costEquivU,
      });
      const sessionIds = [...new Set(failures.map((row) => row.session_id))].sort().slice(0, 20);

      fired.push({
        scopeKey: `D11|tool-error-rate|${workspaceId}`,
        scope_workspace_id: workspaceId,
        modeled_savings_u_per_wk: null,
        modeled_formula_json: { estimate },
        payload: {
          version: 1,
          template_id: "D11_TOOL_ERROR_RATE",
          facts: {
            session_ids: sessionIds,
            bash_error_ratio: bashRate,
            powershell_error_ratio: powerShellRate,
            bash_call_count: bash.calls,
            powershell_call_count: powerShell.calls,
            bash_error_count: bash.errors,
            powershell_error_count: powerShell.errors,
            preferred_tool: bashIsWorse ? "PowerShell" : "Bash",
            higher_error_tool: bashIsWorse ? "Bash" : "PowerShell",
          },
        },
      });
    }

    return {
      fired,
      status: fired.length > 0 ? "ACTIVE" : "INACTIVE",
      note:
        fired.length > 0
          ? "Bash/PowerShell error-rate ratio met in a workspace over the trailing 7d"
          : "No workspace met Bash/PowerShell 7d volume and error-rate thresholds",
    };
  },
};
