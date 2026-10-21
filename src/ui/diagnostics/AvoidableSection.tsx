/**
 * src/ui/diagnostics/AvoidableSection.tsx — the "Avoidable spend" section: banner, ranked rows
 * (KTD-11), and the fold for causes under 0.5% of spend.
 */

import { useState } from "react";
import type { AvoidableRow } from "../../query/api";
import InfoTip from "../shell/InfoTip";
import TriageRow from "./TriageRow";
import { count, countOf, money, pct, sessionLabel, turnHref } from "./format";

function WhenPanel({ when }: { when: AvoidableRow["when"] }) {
  if (when === null)
    return <p className="triage-panel-note">Not enough timing data for this window.</p>;
  const max = Math.max(1, ...when.buckets);
  return (
    <div className="triage-when">
      <div className="triage-when-bars">
        {when.buckets.map((value, index) => {
          const height = `${(value / max) * 100}%`;
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed 6-bucket session timeline
          return <span key={index} className="triage-when-bar" style={{ height }} />;
        })}
      </div>
      <div className="triage-when-labels">
        <span>session start</span>
        <span>session end</span>
      </div>
      <p className="triage-panel-note">Concentrated in the {when.heaviest} part of sessions.</p>
    </div>
  );
}

function ExamplePanel({ example }: { example: AvoidableRow["example"] }) {
  if (example === null)
    return <p className="triage-panel-note">No example available for this window.</p>;
  const href = turnHref(example.session_id, example.message_id, example.turn_index);
  return (
    <div className="triage-example">
      <p>
        Session "{sessionLabel(example.session_id, example.title)}"
        {example.turn_index !== undefined && <> · turn {example.turn_index}</>}
      </p>
      <p className="triage-panel-note">{example.figure_line}</p>
      {href !== null && <a href={href}>Open turn {example.turn_index} →</a>}
    </div>
  );
}

function PatternsPanel({ row }: { row: AvoidableRow }) {
  return (
    <div className="triage-patterns">
      <div className="triage-chip-row">
        {row.patterns.map((pattern) => (
          <span key={pattern.code} className="chip chip-plain" title={pattern.code}>
            {pattern.label}
          </span>
        ))}
      </div>
      <p className="triage-panel-note">
        {row.sessions_affected_is_lower_bound
          ? `at least ${count(row.sessions_affected)} sessions`
          : countOf(row.sessions_affected, "sessions")}{" "}
        affected
        <InfoTip
          label="About sessions affected"
          content="Distinct sessions with this cause in the selected window. More sessions mean wider impact; view all to inspect them."
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
                    · {s.avoidable_u === undefined ? count(s.occurrences) : money(s.avoidable_u)}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </p>
    </div>
  );
}

function Headline({ row, maxShare }: { row: AvoidableRow; maxShare: number }) {
  const estimated = row.avoidable_u !== null;
  const width = estimated && maxShare > 0 ? Math.min(100, ((row.share ?? 0) / maxShare) * 100) : 0;
  const standalone = row.standalone_u;
  if (!estimated && typeof standalone === "number" && standalone > 0) {
    return (
      <div className="triage-row-headline" data-testid={`triage-standalone-${row.cause_id}`}>
        <div className="triage-row-headline-top">
          <strong>
            {money(standalone) === "$0.00" ? "under $0.01" : money(standalone)}/wk estimate
          </strong>
          <InfoTip
            label="About this estimate"
            content="Standalone estimate from this cause's own recommendations (see their details). Some of this cost is also counted by other causes, so it is left out of the Avoidable total and the ranking."
          />
          <span className="triage-row-headline-sub">not in total</span>
        </div>
      </div>
    );
  }
  return (
    <div className="triage-row-headline">
      <div className="triage-row-headline-top">
        <strong>{estimated ? `${pct(row.share)} of spend` : "Not estimated"}</strong>
        <InfoTip
          label={estimated ? "About avoidable share" : "About not estimated"}
          content={
            estimated
              ? "Share of this window's total spend behind this cause. Higher means more of your spend traces to it."
              : "A dollar figure for this cause is not available yet, so it is ranked by how often it occurred instead."
          }
        />
        {estimated && <span className="triage-row-headline-sub">{money(row.avoidable_u)}</span>}
      </div>
      {estimated && (
        <div className="meter">
          <span style={{ width: `${width}%` }} />
        </div>
      )}
    </div>
  );
}

export default function AvoidableSection({
  causes,
  banner,
  windowDays,
  handoffPending = false,
}: {
  causes: AvoidableRow[];
  banner: { not_estimated_count: number } | null;
  windowDays: number;
  handoffPending?: boolean;
}) {
  const [showFolded, setShowFolded] = useState(false);
  const visible = causes.filter((row) => !row.folded || showFolded);
  const folded = causes.filter((row) => row.folded);
  const maxShare = Math.max(0, ...causes.map((row) => row.share ?? 0));
  const rankedBySpend = causes.some((row) => row.avoidable_u !== null);
  return (
    <section className="sec" aria-label="Avoidable spend">
      <div className="sec-h">
        <h2>Avoidable spend</h2>
        <span className="desc">
          {rankedBySpend ? "ranked by share of spend" : "ranked by how often it happens"}
        </span>
      </div>
      <p className="triage-panel-note diagnostics-section-desc">
        Each row is one root cause. It bundles every pattern that comes from that cause.
      </p>
      {banner !== null && (
        // biome-ignore lint/a11y/useSemanticElements: status banner uses role="status"; <output> semantics differ
        <p className="diagnostics-banner" role="status">
          Nothing here is worth more than 1% of your spend in this window.
          {banner.not_estimated_count > 0 &&
            ` (${banner.not_estimated_count} causes not estimated yet)`}
        </p>
      )}
      {causes.length === 0 ? (
        <p className="triage-panel-note">No causes in this window.</p>
      ) : (
        <div className="card triage-row-list">
          {visible.map((row) => (
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
              accent="spend"
              panel={
                <>
                  <div className="triage-panel-col">
                    <span className="label-caps">When it happens</span>
                    <WhenPanel when={row.when} />
                  </div>
                  <div className="triage-panel-col">
                    <span className="label-caps">Example</span>
                    <ExamplePanel example={row.example} />
                  </div>
                  <div className="triage-panel-col">
                    <span className="label-caps">Patterns in this cause</span>
                    <PatternsPanel row={row} />
                  </div>
                </>
              }
            />
          ))}
          {folded.length > 0 && !showFolded && (
            <div className="triage-fold-bar">
              <span className="triage-panel-note">
                {folded.length} smaller cause{folded.length === 1 ? "" : "s"} under 0.5% of spend (
                {folded.map((row) => row.name).join(", ")})
              </span>
              <button type="button" className="btn-secondary" onClick={() => setShowFolded(true)}>
                Show {folded.length} more
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
