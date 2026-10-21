/**
 * src/ui/diagnostics/ReliabilitySection.tsx — the "Reliability" section: ranked rows (by share
 * of sessions, KTD-11) plus the risk row, always last, outside the ranking, never folded.
 */

import type { ReliabilityRow, RiskRow } from "../../query/api";
import InfoTip from "../shell/InfoTip";
import TriageRow from "./TriageRow";
import { count, countOf, money, pct, sessionLabel } from "./format";

type Row = ReliabilityRow | RiskRow;

/**
 * RC-A U1: the richest breakdown the row has — recorded labels, then its patterns (two or more;
 * one would repeat the row name), then its tool events by tool. Null when none exists.
 */
function breakdownOf(
  row: Row,
): { title: string; items: Array<{ label: string; count: number }>; tip?: string } | null {
  if (row.breakdown.length > 0) return { title: "Breakdown", items: row.breakdown };
  if (row.patterns.length >= 2)
    return {
      title: "Patterns",
      items: row.patterns.map((p) => ({ label: p.label, count: p.count })),
    };
  if (row.by_tool !== undefined && row.by_tool.length > 0)
    return {
      title: "By tool (events)",
      items: row.by_tool,
      tip: "Tool calls behind this cause, by tool. Some failing turns have no tool call (re-planning turns), so this can add up to less than the row's count.",
    };
  return null;
}

function BreakdownColumn({ row }: { row: Row }) {
  const breakdown = breakdownOf(row);
  if (breakdown === null) return null;
  return (
    <div className="triage-panel-col">
      <span className="label-caps">
        {breakdown.title}
        {breakdown.tip !== undefined && (
          <InfoTip label="About this breakdown" content={breakdown.tip} />
        )}
      </span>
      <ul className="triage-breakdown">
        {breakdown.items.map((item) => (
          <li key={item.label}>
            <span>{item.label}</span>
            <strong>{count(item.count)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** RC-A U1: no silent hiding — name the panel parts this cause has no data for, and why. */
function NotRecordedTip({ row }: { row: Row }) {
  const missing = [
    breakdownOf(row) === null && "a breakdown",
    row.top_commands.length === 0 && "command text",
    "cost" in row && row.cost.wait_ms === null && "waiting time",
  ].filter((item): item is string => item !== false);
  if (missing.length === 0) return null;
  return (
    <InfoTip
      label="About what is recorded"
      content={`Not recorded for this cause: ${missing.join(", ")}. Waiting time is recorded only for blocked tool calls, and labelled breakdowns only for blocked and destructive commands. Command text needs the tool calls behind the cause to be on record.`}
    />
  );
}

function CommandsColumn({ commands }: { commands: ReliabilityRow["top_commands"] }) {
  if (commands.length === 0) return null;
  return (
    <div className="triage-panel-col">
      <span className="label-caps">Most frequent commands</span>
      <div className="triage-commands">
        {commands.map((cmd) => (
          <span key={cmd.text} className="cmd-row">
            {cmd.text} ×{count(cmd.count)}
          </span>
        ))}
      </div>
    </div>
  );
}

function SessionsPanel({ row }: { row: Row }) {
  return (
    <p className="triage-panel-note">
      {row.sessions_affected_is_lower_bound
        ? `at least ${count(row.sessions_affected)} sessions`
        : countOf(row.sessions_affected, "sessions")}{" "}
      affected
      <InfoTip
        label="About sessions affected"
        content="Distinct sessions with this pattern in the selected window. View all to inspect them."
      />
      {row.sessions.length > 0 && (
        <>
          {" · "}
          <details className="triage-view-all">
            <summary>view all</summary>
            <ul>
              {row.sessions.map((s) => (
                <li key={s.session_id}>
                  <a href={`#/sessions/${encodeURIComponent(s.session_id)}`}>
                    {sessionLabel(s.session_id, s.title)}
                  </a>{" "}
                  · {count(s.occurrences)}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </p>
  );
}

function CostPanel({ row }: { row: ReliabilityRow }) {
  const minutes = row.cost.wait_ms === null ? null : Math.round(row.cost.wait_ms / 60_000);
  return (
    <div>
      {minutes !== null && (
        <p className="triage-panel-note">
          {minutes === 0 && (row.cost.wait_ms ?? 0) > 0
            ? "<1 min of waiting on this cause."
            : `~${minutes} min of waiting on this cause.`}
          <InfoTip
            label="About wait time"
            content="Total time spent waiting on a human response after this pattern, each wait capped at 30 minutes. Too small to rank by money."
          />
        </p>
      )}
      {row.cost.replan_u !== null && (
        <p className="triage-panel-note">
          {money(row.cost.replan_u)} spent re-planning after these failures.
          <InfoTip
            label="About re-plan cost"
            content="Upper bound: full cost of the turn after each failure."
          />
        </p>
      )}
      <SessionsPanel row={row} />
    </div>
  );
}

function Headline({ row, maxShare }: { row: Row; maxShare: number }) {
  const share = row.share;
  const replan = "cost" in row ? row.cost.replan_u : null;
  const width = share !== null && maxShare > 0 ? Math.min(100, (share / maxShare) * 100) : 0;
  return (
    <div className="triage-row-headline">
      <div className="triage-row-headline-top">
        <strong>{share === null ? "—" : `${pct(share)} of sessions`}</strong>
        <InfoTip
          label="About share of sessions"
          content="Share of this window's sessions affected by this pattern. Higher means it happens more often."
        />
        <span className="triage-row-headline-sub">
          {countOf(row.occurrences, row.count_unit)}
          {replan !== null && ` · ≈ ${money(replan)} re-planning`}
        </span>
      </div>
      {share !== null && (
        <div className="meter">
          <span style={{ width: `${width}%` }} />
        </div>
      )}
    </div>
  );
}

export default function ReliabilitySection({
  causes,
  risk,
  windowDays,
  handoffPending = false,
}: {
  causes: ReliabilityRow[];
  risk: RiskRow | null;
  windowDays: number;
  handoffPending?: boolean;
}) {
  const maxShare = Math.max(0, ...causes.map((row) => row.share ?? 0), risk?.share ?? 0);
  return (
    <section className="sec" aria-label="Reliability">
      <div className="sec-h">
        <h2>Reliability</h2>
        <span className="desc">ranked by share of sessions</span>
      </div>
      <p className="triage-panel-note diagnostics-section-desc">
        Ranked by how often they happen. Dollars shown are the re-planning cost after each failure.
      </p>
      {causes.length === 0 && risk === null ? (
        <p className="triage-panel-note">No causes in this window.</p>
      ) : (
        <div className="card triage-row-list">
          {causes.map((row) => (
            <TriageRow
              key={`${windowDays}-${row.cause_id}`}
              rank={row.rank}
              name={row.name}
              explanation={row.explanation}
              headline={<Headline row={row} maxShare={maxShare} />}
              trend={row.trend}
              trendBasis={row.trend_basis}
              handoff={row.handoff}
              handoffPending={handoffPending}
              fixQuiet={row.fix_quiet === true}
              fixSmall={row.fix_small === true}
              quietRecId={row.quiet_rec_id}
              featured={row.featured}
              accent="reliability"
              panel={
                <>
                  <BreakdownColumn row={row} />
                  <CommandsColumn commands={row.top_commands} />
                  <div className="triage-panel-col">
                    <span className="label-caps">
                      Cost
                      <NotRecordedTip row={row} />
                    </span>
                    <CostPanel row={row} />
                  </div>
                </>
              }
            />
          ))}
          {risk !== null && (
            <TriageRow
              key={`${windowDays}-risk-${risk.cause_id}`}
              rank="!"
              name={risk.name}
              explanation={risk.explanation}
              headline={<Headline row={risk} maxShare={maxShare} />}
              trend={risk.trend}
              trendBasis={risk.trend_basis}
              handoff={risk.handoff}
              handoffText={
                risk.handoff !== null
                  ? `Review ${countOf(risk.occurrences, "commands")} →`
                  : undefined
              }
              handoffPending={handoffPending}
              fixQuiet={risk.fix_quiet === true}
              fixSmall={risk.fix_small === true}
              quietRecId={risk.quiet_rec_id}
              featured={false}
              accent="risk"
              panel={
                <>
                  <BreakdownColumn row={risk} />
                  <CommandsColumn commands={risk.top_commands} />
                  <div className="triage-panel-col">
                    <span className="label-caps">
                      Affected sessions
                      <NotRecordedTip row={risk} />
                    </span>
                    <SessionsPanel row={risk} />
                  </div>
                </>
              }
            />
          )}
        </div>
      )}
    </section>
  );
}
