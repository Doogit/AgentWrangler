/**
 * src/ui/overview/WorkspaceTable.tsx — Per-workspace spend comparison table.
 *
 * Contract:
 *   - Spend column always shows a real USD figure (never N/A) — cost_equiv_u
 *     is a real LIST_EQUIV value from the DTO.
 *   - "Top waste source" column shows the workspace's top active DetectorEngine rec
 *     by reader-facing lever name (e.g. "Marathon sessions · active", EXPERIMENTAL-styled)
 *     or "—" when none. Fed by a topRecByWorkspace prop (WorkspaceSummary DTO is frozen).
 *   - Loading state uses SkeletonRow (visually distinct from empty state).
 *   - Claim kind: LIST_EQUIV for the cost column.
 */

import type { WorkspaceSummary } from "../../query/api/overview";
import { type WorkspaceLabelInput, workspaceLabel } from "../lib/workspace-label";
import Chip from "../shell/Chip";
import { SkeletonRow } from "../shell/Skeleton";

/**
 * Reader-facing waste-source lever name per detector id (taxonomy §1b/§7).
 * Short forms for the compact table cell; falls back to the raw id if unmapped.
 */
const LEVER_BY_DETECTOR: Record<string, string> = {
  D1: "CLAUDE.md / memory",
  D2: "Marathon sessions",
  D4: "Model routing",
  D5: "Limit warning",
  D6: "Tool-result bloat",
  D8: "Cache misses",
  D9: "Background sessions",
  D10: "Tool catalog",
};

/** Top active rec per workspace (highest modeled savings). */
export interface TopRec {
  detector_id: string;
  state: string;
  /** Modeled µUSD/wk used to pick the top rec; -1 when the rec has no savings model. */
  savings?: number;
}

interface WorkspaceTableProps {
  workspaces: Array<WorkspaceSummary & WorkspaceLabelInput>;
  globalCostU: number;
  globalTurns: number;
  isLoading: boolean;
  /** workspace_id → top active rec; absent = no active rec for that workspace. */
  topRecByWorkspace?: Map<string, TopRec>;
  /**
   * When true, renders as a compact teaser (no global-total footer row,
   * heading says "Top Workspaces", shows "All workspaces ->" link).
   * The caller is responsible for slicing the workspaces array to 3.
   */
  teaser?: boolean;
}

function fmtUsd(u: number): string {
  const usd = u / 1_000_000;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtUsdPerTurn(n: number | null): string {
  if (n === null) return "—";
  return `$${n.toFixed(3)}`;
}

function labelWorkspace(workspace: WorkspaceSummary & WorkspaceLabelInput): string {
  return workspaceLabel({
    workspace_id: workspace.workspace_id,
    repo_owner: workspace.repo_owner ?? null,
    repo_name: workspace.repo_name ?? null,
    repo_path: workspace.repo_path ?? null,
    repo_canonical: workspace.repo_canonical ?? null,
  });
}

export default function WorkspaceTable({
  workspaces,
  globalCostU,
  globalTurns,
  isLoading,
  topRecByWorkspace,
  teaser = false,
}: WorkspaceTableProps) {
  const globalUsdPerTurn = globalTurns > 0 ? globalCostU / 1_000_000 / globalTurns : null;

  return (
    <div className="card" style={{ marginBottom: 13 }}>
      <div className="section-head">
        <h2>{teaser ? "Top Workspaces" : "Workspace Comparison"}</h2>
        <span className="section-meta">
          <Chip kind="LIST_EQUIV" />
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Workspace</th>
              <th>Spend</th>
              <th>Share</th>
              <th>Live now</th>
              <th>$/turn</th>
              <th>Top waste source</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <>
                <SkeletonRow cols={6} />
                <SkeletonRow cols={6} />
                <SkeletonRow cols={6} />
              </>
            )}
            {!isLoading &&
              workspaces.map((ws) => (
                <tr key={ws.workspace_id}>
                  <td>
                    {labelWorkspace(ws)}
                    {ws.has_live && (
                      <span
                        className="nav-dot"
                        style={{ marginLeft: 6, display: "inline-block" }}
                        aria-label="has live session"
                      />
                    )}
                  </td>
                  <td>{fmtUsd(ws.cost_equiv_u)}</td>
                  <td>{fmtPct(ws.cost_share)}</td>
                  <td>{ws.has_live ? "● live" : "0"}</td>
                  <td>{fmtUsdPerTurn(ws.usd_per_turn)}</td>
                  <td>
                    {(() => {
                      const rec = topRecByWorkspace?.get(ws.workspace_id);
                      return rec === undefined ? (
                        <Chip kind="N_A" label="—" />
                      ) : (
                        <Chip
                          kind="EXPERIMENTAL"
                          label={`${LEVER_BY_DETECTOR[rec.detector_id] ?? rec.detector_id} · ${rec.state.toLowerCase()}`}
                        />
                      );
                    })()}
                  </td>
                </tr>
              ))}
          </tbody>
          {!isLoading && workspaces.length > 0 && !teaser && (
            <tfoot>
              <tr className="total-row">
                <td>TOTAL (global)</td>
                <td>{fmtUsd(globalCostU)}</td>
                <td>100%</td>
                <td>{"—"}</td>
                <td>{globalUsdPerTurn !== null ? `~$${globalUsdPerTurn.toFixed(3)}` : "—"}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {teaser && (
        <div style={{ textAlign: "right", padding: "4px 0 2px" }}>
          <a
            href="#/workspaces"
            style={{ fontSize: 12.5, color: "var(--teal)" }}
            data-testid="all-workspaces-link"
          >
            All workspaces {"→"}
          </a>
        </div>
      )}
      <div className="table-footnotes">
        {"¹"} Spend = list-price equivalent (LIST_EQUIV) {"—"} not billing data. {"²"} Top waste
        source = highest-modeled active DetectorEngine recommendation scoped to this workspace
        (EXPERIMENTAL); {"“—”"} = none.
      </div>
    </div>
  );
}
