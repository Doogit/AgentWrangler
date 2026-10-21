/**
 * src/ui/diagnostics/TriageRow.tsx — one triage row (Avoidable spend, Reliability, or the risk
 * row): rank badge, name + explanation, a figure column (headline + meter + trend), and a
 * fixed-width hand-off action column (OV-11: the Overview C6 ranked-row pattern — rows are
 * divider-separated siblings inside one shared `.card`, not individual cards).
 *
 * The toggle button wraps only the rank and name/explanation (the `RecCard` title-toggle
 * pattern in `src/ui/recommendations/RecCard.tsx`); the figure column, InfoTips and the hand-off
 * link are grid siblings outside the button, each independently focusable. The featured row
 * starts open; giving each row a `key` that includes the window resets expansion on a window
 * change (R8) by remounting.
 */

import { type ReactNode, useId, useState } from "react";
import type { Trend } from "../../query/api/diagnostics-census";
import InfoTip from "../shell/InfoTip";
import { trendClass, trendGlyph } from "./format";

export interface TriageRowProps {
  rank: number | "!";
  name: string;
  explanation: string;
  /** Headline value + meter, built by the caller (Avoidable and Reliability shape it differently). */
  headline: ReactNode;
  trend: Trend;
  /** What the trend compares: share of spend or share of sessions. */
  trendBasis: "spend_share" | "session_rate";
  handoff: { rec_id: string; label: string } | null;
  /** Overrides the rendered hand-off text (the risk row's "Review N commands →"). Ignored when `handoff` is null. */
  handoffText?: string | undefined;
  /** F9: recs are still building, so a null `handoff` means "unknown yet", not "no fix". */
  handoffPending?: boolean;
  /** RC-B: a PROPOSED rec for this cause sits in recs history → "No fix this week". */
  fixQuiet?: boolean;
  /** RC-B: the history card behind "No fix this week"; the label links to it. */
  quietRecId?: string | undefined;
  /** RC-B: the hand-off is a below-floor card → secondary "Small fix →" with an InfoTip. */
  fixSmall?: boolean;
  featured: boolean;
  accent: "spend" | "reliability" | "risk";
  /** Expanded detail content, columns built by the caller. */
  panel: ReactNode;
}

export default function TriageRow({
  rank,
  name,
  explanation,
  headline,
  trend,
  trendBasis,
  handoff,
  handoffText,
  handoffPending = false,
  fixQuiet = false,
  quietRecId,
  fixSmall = false,
  featured,
  accent,
  panel,
}: TriageRowProps) {
  const [open, setOpen] = useState(featured);
  const panelId = useId();
  return (
    <article className="triage-row" data-accent={accent}>
      <div className="triage-row-grid">
        <button
          type="button"
          className="triage-row-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="rank-num">{rank}</span>
          <span className="triage-row-name">
            <strong>{name}</strong>
            <span className="triage-row-explanation">{explanation}</span>
          </span>
        </button>
        <div className="triage-row-figure">
          {headline}
          <span className={`triage-row-trend ${trendClass(trend)}`}>
            {trendGlyph(trend)} {trend}
            <InfoTip
              label="About the trend"
              content={`This cause's ${trendBasis === "spend_share" ? "share of spend" : "share of sessions"}, compared with the previous window of the same length. Rising means this cause is growing, which is worse; falling means it is shrinking.`}
            />
          </span>
        </div>
        {handoff === null ? (
          <span className="handoff-none">
            {handoffPending ? (
              "Checking for a fix…"
            ) : fixQuiet ? (
              <>
                {quietRecId === undefined ? (
                  "No fix this week"
                ) : (
                  <a href={`#/recommendations?focus=${encodeURIComponent(quietRecId)}`}>
                    No fix this week
                  </a>
                )}{" "}
                <InfoTip
                  label="About No fix this week"
                  content="A recommendation for this cause exists but has not fired in the last week."
                />
              </>
            ) : (
              "No fix yet"
            )}
          </span>
        ) : fixSmall ? (
          <span>
            <a
              className="btn-secondary"
              href={`#/recommendations?focus=${encodeURIComponent(handoff.rec_id)}`}
            >
              {`${handoff.label} →`}
            </a>{" "}
            <InfoTip
              label="About Small fix"
              content="Below the low-impact threshold on Recommendations."
            />
          </span>
        ) : (
          <a
            className={featured ? "btn-primary" : "btn-secondary"}
            href={`#/recommendations?focus=${encodeURIComponent(handoff.rec_id)}`}
          >
            {handoffText ?? `${handoff.label} →`}
          </a>
        )}
      </div>
      {open && (
        <div id={panelId} className="inset-panel triage-row-panel">
          {panel}
        </div>
      )}
    </article>
  );
}
