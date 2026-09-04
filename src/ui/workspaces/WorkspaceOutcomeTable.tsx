/**
 * src/ui/workspaces/WorkspaceOutcomeTable.tsx — Per-workspace outcome table.
 *
 * Renders EXPERIMENTAL chip on the table header. Shows empty state when
 * no linked work items exist.
 */

import type { WorkspaceOutcomeSummary } from "../../query/api/outcomes";
import Chip from "../shell/Chip";

interface Props {
  rows: WorkspaceOutcomeSummary[] | null;
  workspaceSpendById?: ReadonlyMap<string, number | null>;
}

function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtScore(v: number | null): string {
  if (v === null) return "\u2014";
  return `${v.toFixed(0)}%`;
}

function fmtUsdPerTurn(v: number | null | undefined): string {
  if (v == null) return "\u2014";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
}

export default function WorkspaceOutcomeTable({ rows, workspaceSpendById }: Props) {
  return (
    <div className="card" style={{ marginBottom: 13 }}>
      <div className="section-head">
        <h2>Workspace Outcomes</h2>
        <div className="chips">
          <Chip kind="EXPERIMENTAL" />
        </div>
      </div>

      {rows === null || rows.length === 0 ? (
        <div className="banner banner-info">
          <span>
            No linked work items. Map a repository in Settings and configure a GitHub token to
            enable outcome linkage.
          </span>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Workspace</th>
                <th>$/turn</th>
                <th title="100 minus Opus share across non-sidechain, non-provisional turns">
                  Routing proxy
                </th>
                <th>Total PRs</th>
                <th>In Progress</th>
                <th>Success</th>
                <th>Failure</th>
                <th>Success Rate</th>
                <th>Linkage Rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.workspace_id}>
                  <td>{row.project_slug}</td>
                  <td>{fmtUsdPerTurn(workspaceSpendById?.get(row.workspace_id))}</td>
                  <td>{fmtScore(row.adherence_score)}</td>
                  <td>{row.total_n}</td>
                  <td>{row.in_progress_n}</td>
                  <td>{row.success_n}</td>
                  <td>{row.failure_n}</td>
                  <td>{fmtPct(row.success_rate)}</td>
                  <td>{fmtPct(row.linkage_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
