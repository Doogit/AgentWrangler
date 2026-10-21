import type { HotSessionRow } from "../../query/spend";
import { shortId } from "../lib/short-id";
import { workspaceLabel } from "../lib/workspace-label";
import InfoTip from "../shell/InfoTip";

/** Supply the five rows from GET /api/hot-sessions?preset=7d&limit=5 and the same window's total cost. */
export interface ExpensiveSessionsProps {
  sessions: HotSessionRow[];
  windowCostU: number;
}

const dollars = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
const tokens = (value: number) => `${Math.round(value / 1000).toLocaleString()}K`;

export function ExpensiveSessions({ sessions, windowCostU }: ExpensiveSessionsProps) {
  return (
    <section className="sec" aria-labelledby="expensive-sessions-title">
      <div className="sec-h">
        <h2 id="expensive-sessions-title">
          <a href="#/sessions?sort=cost&direction=desc">Most expensive sessions this week</a>
        </h2>
        <a href="#/sessions?sort=cost&direction=desc">All sessions by cost →</a>
      </div>
      <div className="card card-padded">
        {sessions.length === 0 ? (
          <p>
            No sessions in the past seven days. <a href="#/sessions">Explore all sessions →</a>
          </p>
        ) : (
          <div className="table-wrap">
            <table className="overview-expensive-table">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Workspace</th>
                  <th>Primary model</th>
                  <th>
                    Turns{" "}
                    <InfoTip
                      label="About session turns"
                      content="Number of recorded turns in the session. More turns can increase cost; open the session to inspect the timeline."
                    />
                  </th>
                  <th>
                    Avg context{" "}
                    <InfoTip
                      label="About average context"
                      content="Average context tokens per turn. Higher context can cost more; inspect the session for large or repeated inputs."
                    />
                  </th>
                  <th>
                    Peak context{" "}
                    <InfoTip
                      label="About peak context"
                      content="Largest context in one turn. More than 200K tokens is highlighted for inspection; open the session timeline to find that peak."
                    />
                  </th>
                  <th>
                    Cost{" "}
                    <InfoTip
                      label="About session cost"
                      content="Estimated list-equivalent cost of this session. Higher cost makes it a good place to inspect usage patterns."
                    />
                  </th>
                  <th>
                    Share of week{" "}
                    <InfoTip
                      label="About share of week"
                      content="This session's cost divided by total cost in the same seven-day window. A longer bar means it accounts for more weekly spend."
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessions.slice(0, 5).map((row) => {
                  const share =
                    windowCostU > 0
                      ? Math.min(100, Math.max(0, (row.cost_equiv_u / windowCostU) * 100))
                      : 0;
                  return (
                    <tr key={row.session_id}>
                      <td>
                        <a
                          href={`#/sessions/${encodeURIComponent(row.session_id)}`}
                          title={row.title || row.session_id}
                        >
                          {row.title || shortId(row.session_id)}
                        </a>
                      </td>
                      <td>
                        <a href={`#/workspaces/${encodeURIComponent(row.workspace_id)}`}>
                          {row.repo_owner && row.repo_name
                            ? workspaceLabel({
                                workspace_id: row.workspace_id,
                                repo_owner: row.repo_owner,
                                repo_name: row.repo_name,
                              })
                            : row.workspace_id}
                        </a>
                      </td>
                      <td>{row.model}</td>
                      <td>{row.turns.toLocaleString()}</td>
                      <td>{tokens(row.avg_context_tokens)}</td>
                      <td
                        className={
                          row.max_context_tokens > 200_000 ? "overview-peak-high" : undefined
                        }
                      >
                        {tokens(row.max_context_tokens)}
                      </td>
                      <td>{dollars(row.cost_equiv_u)}</td>
                      <td>
                        <div className="overview-session-share">
                          <div className="overview-session-share-track">
                            <span
                              style={{ width: `${share}%` }}
                              data-testid={`session-share-${row.session_id}`}
                            />
                          </div>
                          <span>{Math.round(share)}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
