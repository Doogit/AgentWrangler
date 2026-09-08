/**
 * src/ui/workspaces/OutcomeSummaryCard.tsx — Global success rate KPI card.
 *
 * Always renders [EXPERIMENTAL] chip. Shows N/A when data is null (token unset,
 * no linked work items). Never blocks the dashboard.
 */

import type { SuccessRateData } from "../../query/api/outcomes";
import Chip from "../shell/Chip";

interface Props {
  data: SuccessRateData | null;
}

function fmtPct(v: number | null): string {
  if (v === null) return "N/A";
  return `${(v * 100).toFixed(1)}%`;
}

export default function OutcomeSummaryCard({ data }: Props) {
  return (
    <div className="kpi card">
      <div className="kpi-label">OUTCOME SIGNAL</div>
      {data === null ? (
        <>
          <div className="kpi-off">N/A</div>
          <div className="kpi-off-hint">
            Configure a GitHub token and workspace repository mapping in Settings. Eligible sessions
            are linked to pull requests automatically when matching evidence is available.
          </div>
        </>
      ) : (
        <>
          <div className="kpi-value">{fmtPct(data.success_rate)}</div>
          <div className="kpi-subval">
            {data.terminal_n} terminal · {data.clean_success_n} clean · {data.with_deferrals_n} with
            deferrals
          </div>
          {data.no_ci_success_n > 0 && (
            <div className="kpi-subval" style={{ color: "var(--amber)" }}>
              ⚠ {data.no_ci_success_n} success(es) with no CI
            </div>
          )}
          <div
            className="kpi-fn"
            title="Completed sessions with at least one Bash tool event are eligible."
          >
            eligible sessions linked to pull requests: {fmtPct(data.linkage_rate)}
          </div>
        </>
      )}
      <div className="chips">
        <Chip kind="EXPERIMENTAL" />
        {data === null && <Chip kind="N_A" />}
      </div>
    </div>
  );
}
