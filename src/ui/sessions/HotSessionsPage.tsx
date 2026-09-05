import { useEffect, useState } from "react";
import type { HotSessionRowWithPercentile } from "../../query/api/hot-sessions.js";
import { mockHotSessions } from "../api/fixtures";
import { relativeTime } from "../lib/relative-time";
import { shortId } from "../lib/short-id";
import Chip from "../shell/Chip";
import EmptyState from "../shell/EmptyState";
import InfoTip from "../shell/InfoTip";
import { FrictionCell, type FrictionCounts } from "./FrictionCell";
import { SpendPercentileChip } from "./SpendPercentileChip";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; rows: HotSessionRowWithPercentile[] };

function fmtUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

function copyText(value: string): void {
  void navigator.clipboard?.writeText(value);
}

export default function HotSessionsPage({
  onSelectSession,
}: {
  onSelectSession: (id: string) => void;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch("/api/hot-sessions");
        if (!response.ok) {
          throw new Error(`/api/hot-sessions returned ${response.status}`);
        }
        const value: unknown = await response.json();
        if (!Array.isArray(value)) {
          throw new Error("/api/hot-sessions returned a non-array response");
        }
        if (!cancelled) setState({ status: "ok", rows: value as HotSessionRowWithPercentile[] });
      } catch (error: unknown) {
        // Test/demo capture instance runs `vite --mode test` with no /api backend,
        // so the fetch above fails. Render anonymized fixtures instead of an error
        // banner so the dashboard is presentable offline. Prod (MODE !== "test")
        // always shows the real error; unit tests mock fetch and never reach here.
        if (import.meta.env.MODE === "test") {
          const pct = [0.94, 0.61, 0.27];
          const rows: HotSessionRowWithPercentile[] = mockHotSessions().map((row, i) => ({
            ...row,
            spend_percentile: pct[i] ?? null,
            spend_percentile_n: 12,
          }));
          if (!cancelled) setState({ status: "ok", rows });
          return;
        }
        if (!cancelled) setState({ status: "error", message: String(error) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const pageHeader = (
    <div className="page-top">
      <div className="page-title">
        <h1>Sessions</h1>
        <p className="page-sub">Highest-cost sessions with output / context split</p>
      </div>
    </div>
  );

  if (state.status === "loading") {
    return (
      <div className="hot-sessions">
        {pageHeader}
        <div className="card" aria-busy="true" aria-label="Loading hot sessions">
          Loading sessions...
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="hot-sessions">
        {pageHeader}
        <div className="banner banner-error" role="alert">
          Could not load sessions: {state.message}
        </div>
      </div>
    );
  }

  const rows = [...state.rows].sort((left, right) => right.cost_equiv_u - left.cost_equiv_u);
  const maxCost = Math.max(...rows.map((row) => row.cost_equiv_u), 1);

  return (
    <div className="hot-sessions">
      {pageHeader}
      <div className="card" style={{ marginBottom: 13 }}>
        <div className="section-head">
          <h2>Hot sessions</h2>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            headline="No session cost data yet"
            why="The daemon has not recorded any completed sessions with token usage."
            whatWillAppear="Cost-ranked sessions will appear after the next observed session completes."
            command="claude"
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Workspace</th>
                  <th scope="col">
                    Cost ($){" "}
                    <InfoTip
                      label="What Cost means"
                      content="Modeled USD-equivalent at list prices, not billed spend. Use it to rank which sessions are worth optimizing, not as an invoice."
                    />
                  </th>
                  <th scope="col">
                    Output / context (avg){" "}
                    <InfoTip
                      label="What Ctx/turn means"
                      content="Average context tokens re-read on every turn — the main driver of cost, since the whole context is re-sent each turn. A high number means it's time to /clear or split the task."
                    />
                  </th>
                  <th scope="col">Model</th>
                  <th scope="col">Turns</th>
                  <th scope="col">
                    Friction{" "}
                    <InfoTip
                      label="What Friction means"
                      content="A coarse band (low/medium/high) for how much a session stalled on errors, retries, and dead ends. High-friction sessions are where cleanup time hides."
                    />
                  </th>
                  <th scope="col">Last active</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr
                    key={row.session_id}
                    className="hot-session-row"
                    onClick={() => onSelectSession(row.session_id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ")
                        onSelectSession(row.session_id);
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <td>{index + 1}</td>
                    <td>
                      <button
                        type="button"
                        className="live-session-link"
                        onClick={(event) => {
                          event.stopPropagation();
                          copyText(row.session_id);
                          onSelectSession(row.session_id);
                        }}
                        aria-label={`Copy and open session ${row.session_id}`}
                        title={row.session_id}
                      >
                        <span>{row.workspace_id}</span>
                        <span aria-hidden="true"> · </span>
                        <span className="section-meta">{shortId(row.session_id)}</span>
                      </button>
                    </td>
                    <td>
                      <div style={{ display: "grid", gap: 5, minWidth: 92 }}>
                        <span>{fmtUsd(row.cost_equiv_u)}</span>
                        <span
                          aria-label={`${Math.round((row.cost_equiv_u / maxCost) * 100)}% of highest session cost`}
                          style={{
                            height: 5,
                            width: `${Math.max((row.cost_equiv_u / maxCost) * 100, 2)}%`,
                            borderRadius: 999,
                            background: "var(--series-1)",
                          }}
                        />
                        <SpendPercentileChip
                          percentile={row.spend_percentile}
                          n={row.spend_percentile_n}
                        />
                      </div>
                    </td>
                    <td>
                      {fmtTokens(row.avg_output_tokens)} out / {fmtTokens(row.avg_context_tokens)}{" "}
                      ctx
                    </td>
                    <td>
                      <Chip kind="MODELED" label={row.model} title={`Model: ${row.model}`} />
                    </td>
                    <td>{fmtTokens(row.turns)}</td>
                    <td>
                      <FrictionCell
                        counts={
                          {
                            api_error_count: row.api_error_count,
                            tool_error_count: row.tool_error_count,
                            test_fail_count: row.test_fail_count,
                            compaction_count: row.compaction_count,
                            interrupt_count: row.interrupt_count,
                            user_turn_count: row.user_turn_count,
                            turn_count: row.turns,
                            gap_median_s: row.gap_median_s,
                            gap_p90_s: row.gap_p90_s,
                            long_gap_count: row.long_gap_count,
                            gap_n: row.gap_n,
                          } satisfies FrictionCounts
                        }
                      />
                    </td>
                    <td title={row.last_turn_at}>{relativeTime(row.last_turn_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
