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
    <div
      style={{
        minWidth: 0,
        padding: 12,
        border: "1px solid var(--line)",
        borderRadius: 6,
        background: "var(--panel2)",
      }}
    >
      <div className="kpi-label">{label}</div>
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
    <div
      data-testid="workspace-outcome-stat-cards"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
        gap: 10,
      }}
    >
      <StatCard label="Successful outcome">
        <div className="kpi-value">{fmtPct(row.success_rate)}</div>
        <div className="kpi-subval">
          {row.success_n}/{row.terminal_n} terminal work items
        </div>
      </StatCard>
      <StatCard label="Terminal linked work">
        <div className="kpi-value">
          {row.terminal_n}/{row.total_n}
        </div>
        <div className="kpi-subval">terminal linked work items</div>
      </StatCard>
      <StatCard label="Open linked work">
        <div className="kpi-value">
          {row.in_progress_n}/{row.total_n}
        </div>
        <div className="kpi-subval">OPEN/UNREPORTED linked work items</div>
      </StatCard>
      <div style={{ gridColumn: "1 / -1", color: "var(--text-muted)", fontSize: 11 }}>
        Linked work items are early observed signals; outcome methodology remains under validation.{" "}
        <Chip kind="EXPERIMENTAL" />
      </div>
    </div>
  );
}
