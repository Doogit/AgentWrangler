/** Workspace outcome stat cards with explicit observation coverage. */

import type { ReactNode } from "react";
import type { WorkspaceOutcomeSummary } from "../../query/api/outcomes";
import Chip from "../shell/Chip";

interface Props {
  rows: WorkspaceOutcomeSummary[] | null;
  /** Retained for existing callers while the table presentation is removed. */
  workspaceSpendById?: ReadonlyMap<string, number | null>;
}

function fmtPct(value: number | null): string {
  return value === null ? "UNAVAILABLE" : `${(value * 100).toFixed(1)}%`;
}

function StatCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="card kpi">
      <div className="lbl">{label}</div>
      {children}
    </div>
  );
}

export default function WorkspaceOutcomeTable({ rows }: Props) {
  const row = rows?.[0] ?? null;

  if (row === null) {
    return (
      <div className="banner banner-info">
        No linked work items. Map a repository in Settings and configure a GitHub token to enable
        outcome linkage.
      </div>
    );
  }

  return (
    <div data-testid="workspace-outcome-stat-cards" className="grid g4">
      <StatCard label="Successful outcome">
        <div className="v num">{fmtPct(row.success_rate)}</div>
        <div className="cmp">
          {row.success_n}/{row.terminal_n} terminal work items
        </div>
      </StatCard>
      <StatCard label="Terminal linked work">
        <div className="v num">
          {row.terminal_n}/{row.total_n}
        </div>
        <div className="cmp">terminal linked work items</div>
      </StatCard>
      <StatCard label="Open linked work">
        <div className="v num">
          {row.in_progress_n}/{row.total_n}
        </div>
        <div className="cmp">OPEN/UNREPORTED linked work items</div>
      </StatCard>
      <div className="foot" style={{ gridColumn: "1 / -1", marginTop: 0 }}>
        Linked work items are early observed signals; outcome methodology remains under validation.{" "}
        <Chip kind="EXPERIMENTAL" />
      </div>
    </div>
  );
}
