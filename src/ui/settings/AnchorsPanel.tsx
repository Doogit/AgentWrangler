/**
 * src/ui/settings/AnchorsPanel.tsx — BM4 public benchmark anchor reference panel.
 *
 * Display-only. Never joined to a score.
 * Shows: avg $13/day, p90 $30/day with citation + date; "<5% of subscribers"
 * cap-impact claim; not-like-for-like caveat; and the user's own $/active-day
 * derived from existing daily trend buckets.
 *
 * Own $/active-day: fetched via existing fetchTrends (30d preset, day bucket).
 * Active days = buckets where turns > 0. Mean = SUM(cost_equiv_u for active
 * buckets) / count(active buckets) / 1_000_000.
 *
 * SEC-101: only µUSD aggregates, no transcript content.
 */

import { useEffect, useState } from "react";
import {
  ANCHOR_CAVEAT,
  CAP_IMPACT_CLAIM,
  DAILY_AVG_USD,
  DAILY_P90_USD,
} from "../../detector/benchmark-anchors";
import { fetchTrends } from "../api/client";
import InfoTip from "../shell/InfoTip";
import { SkeletonLine } from "../shell/Skeleton";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** Derive mean $/active-day from daily trend buckets (turns > 0). */
function deriveActiveDayUsd(buckets: { cost_equiv_u: number; turns: number }[]): number | null {
  const active = buckets.filter((b) => b.turns > 0);
  if (active.length === 0) return null;
  const totalU = active.reduce((s, b) => s + b.cost_equiv_u, 0);
  return totalU / active.length / 1_000_000;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AnchorsPanel() {
  const [ownUsd, setOwnUsd] = useState<number | null | "loading">("loading");
  const [ownError, setOwnError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchTrends({ preset: "30d" }, "day");
        if (cancelled) return;
        if (res?.data == null) {
          setOwnUsd(null);
          return;
        }
        setOwnUsd(deriveActiveDayUsd(res.data.buckets));
      } catch {
        if (!cancelled) {
          setOwnError(true);
          setOwnUsd(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section
      className="card"
      style={{ padding: "18px 20px", marginBottom: 16 }}
      aria-label="Benchmark anchors"
    >
      <h2 style={{ margin: "0 0 6px", fontSize: 15 }}>Published benchmarks</h2>

      {/* Mandatory caveat — adjacent to anchors, always rendered */}
      <p
        className="settings-hint"
        aria-label="not-like-for-like caveat"
        style={{ marginBottom: 14 }}
      >
        {ANCHOR_CAVEAT}
      </p>

      {/* Anchor rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Average */}
        <div className="settings-health-row" aria-label="benchmark avg per day">
          <span className="settings-health-label">
            Average daily API bill (enterprise){" "}
            <InfoTip
              label="What the average daily bill means"
              content="A published reference: the mean daily API bill across enterprise Claude Code users. It is context for your own spend, not a target — your work mix differs, so treat it as a rough yardstick."
            />
          </span>
          <span className="settings-health-value">${DAILY_AVG_USD.daily_usd}/day</span>
          <span className="section-meta">
            Source:{" "}
            <a
              href={DAILY_AVG_USD.source_url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="benchmark avg citation"
            >
              code.claude.com/docs/en/costs
            </a>{" "}
            · fetched {DAILY_AVG_USD.fetched_date}
          </span>
        </div>

        {/* P90 */}
        <div className="settings-health-row" aria-label="benchmark p90 per day">
          <span className="settings-health-label">
            90th-percentile daily API bill (enterprise){" "}
            <InfoTip
              label="What the 90th-percentile bill means"
              content="A published reference: nine in ten enterprise Claude Code users spend less than this per day. A high-usage yardstick, not a limit or a goal for your own spend."
            />
          </span>
          <span className="settings-health-value">${DAILY_P90_USD.daily_usd}/day</span>
          <span className="section-meta">
            Source:{" "}
            <a
              href={DAILY_P90_USD.source_url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="benchmark p90 citation"
            >
              code.claude.com/docs/en/costs
            </a>{" "}
            · fetched {DAILY_P90_USD.fetched_date}
          </span>
        </div>

        {/* Cap impact claim */}
        <div className="settings-health-row" aria-label="cap impact claim">
          <span className="settings-health-label">
            Reached a usage limit{" "}
            <InfoTip
              label="What the usage-limit claim means"
              content="A published reference for how often Claude Code users reach a usage limit. It describes the wider population, not your account, and does not predict when you will reach yours."
            />
          </span>
          <span className="settings-health-value">{CAP_IMPACT_CLAIM.claim}</span>
          <span className="section-meta">{CAP_IMPACT_CLAIM.source}</span>
        </div>

        {/* Own $/active-day */}
        <div className="settings-health-row" aria-label="own cost per active day">
          <span className="settings-health-label">
            Your estimated value per active day (30 days){" "}
            <InfoTip
              label="What your value per active day means"
              content="Your mean estimated value on days you actually used Claude Code in the last 30 days, at public list prices. Compare it to the published references above, not to your subscription bill."
            />
          </span>
          <span className="settings-health-value" aria-label="own active day cost value">
            {ownUsd === "loading" ? (
              <SkeletonLine width="70px" />
            ) : ownError ? (
              "unavailable"
            ) : ownUsd === null ? (
              "no data"
            ) : (
              fmtUsd(ownUsd)
            )}
          </span>
          <span className="section-meta">
            Mean over active days (turns &gt; 0) in the last 30 days.{" "}
            <a href="#/glossary">public list-price estimate</a>.
          </span>
        </div>
      </div>
    </section>
  );
}
