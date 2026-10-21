import type { GlobalOverview } from "../../query/api/overview";
import type { RecommendationCard } from "../../query/api/recommendations";
import InfoTip from "../shell/InfoTip";

/** Optional health values come from existing session, limits, and linkage endpoints; absent values omit their row. */
export interface AcrossDashboardProps {
  overview: GlobalOverview;
  adopted: RecommendationCard[];
  ingestLastAt?: string | null;
  usageSource?: "api" | "cli" | "statusline" | "unavailable" | null;
  linkageRate?: number | null;
  calibrationDriftPoints?: number | null;
  haikuSidechainTurns?: number | null;
}

const SERIES = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
];

export function AcrossDashboard({
  overview,
  adopted,
  ingestLastAt,
  usageSource,
  linkageRate,
  calibrationDriftPoints,
  haikuSidechainTurns,
}: AcrossDashboardProps) {
  const tracked = adopted.filter(
    (rec) =>
      rec.effect_cycle?.state === "OPEN_SETTLING" || rec.effect_cycle?.state === "OPEN_MEASURING",
  ).length;
  const models = overview.model_mix.filter((item) => item.turns > 0);
  const total = models.reduce((sum, item) => sum + item.turns, 0);
  const healthRows: Array<{ label: string; value: string; href: string; info: string }> = [];
  if (ingestLastAt) {
    const age = Date.now() - Date.parse(ingestLastAt);
    if (Number.isFinite(age))
      healthRows.push({
        label: "Ingest freshness",
        value: age < 60_000 ? "Just now" : `${Math.floor(age / 60_000)} min ago`,
        href: "#/settings?section=advanced",
        info: "Time since the last recorded ingest. Recent data means new sessions are appearing; check Parser Health in Settings if it stops updating.",
      });
  }
  if (usageSource)
    healthRows.push({
      label: "Usage source",
      value:
        usageSource === "api"
          ? "Claude API"
          : usageSource === "cli"
            ? "Claude Code /usage"
            : usageSource === "statusline"
              ? "Statusline"
              : "Unavailable",
      href: "#/settings?section=usage",
      info: "Where usage-limit percentages came from. Claude Code /usage, statusline or API values are usable; if unavailable, check usage tracking in Settings.",
    });
  if (linkageRate !== null && linkageRate !== undefined)
    healthRows.push({
      label: "GitHub linkage",
      value: `${Math.round(linkageRate * 100)}%`,
      href: "#/settings?section=integrations",
      info: "Share of eligible sessions linked to GitHub outcomes. A higher rate gives more complete outcome evidence; check Outcomes sync in Settings for missing links.",
    });
  if (calibrationDriftPoints !== null && calibrationDriftPoints !== undefined)
    healthRows.push({
      label: "Weekly limit calibration",
      value: `${Math.abs(calibrationDriftPoints).toFixed(1)} points ${calibrationDriftPoints >= 0 ? "high" : "low"}`,
      href: "#/settings?section=calibration",
      info: "Difference between the configured weekly limit estimate and observed usage, in percentage points. A larger gap suggests recalibration in Settings.",
    });

  return (
    <section className="sec" aria-labelledby="across-dashboard-title">
      <div className="sec-h">
        <h2 id="across-dashboard-title">Across the dashboard</h2>
      </div>
      <div className="overview-across-grid">
        <div className="card card-padded overview-across-card">
          <div className="overview-across-heading">
            <h3>
              <a href="#/recommendations">Tracked effects</a>
            </h3>
            <span className="chip">Recommendations</span>
          </div>
          <div className="overview-across-value">
            {tracked} being measured{" "}
            <InfoTip
              label="About tracked effects"
              content="Number of adopted recommendations with an open measurement cycle. More tracked changes provide before-and-after evidence; open Recommendations to review them."
            />
          </div>
          {tracked === 0 ? (
            <>
              <p>Nothing is being measured yet</p>
              <a className="btn-secondary" href="#/recommendations">
                Pick one to track →
              </a>
            </>
          ) : (
            <a href="#/recommendations">View tracked recommendations →</a>
          )}
        </div>
        <div className="card card-padded overview-across-card">
          <div className="overview-across-heading">
            <h3>
              <a href="#/sessions">Turns by model</a>
            </h3>
            <span className="chip">Sessions</span>
          </div>
          <div className="overview-across-bar" role="img" aria-label="Turn share by model">
            {models.map((item, index) => (
              <span
                key={item.model}
                style={{
                  width: `${total > 0 ? (item.turns / total) * 100 : 0}%`,
                  background: SERIES[index % SERIES.length],
                }}
              />
            ))}
          </div>
          {models.length > 0 ? (
            <ul className="overview-across-models">
              {models.map((item, index) => (
                <li key={item.model}>
                  <a href={`#/sessions?model=${encodeURIComponent(item.model)}`}>
                    <span
                      className="overview-across-dot"
                      style={{ background: SERIES[index % SERIES.length] }}
                    />
                    {item.model} · {item.turns.toLocaleString()}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              No turns in this window. <a href="#/sessions">Explore sessions →</a>
            </p>
          )}
          {haikuSidechainTurns !== null && haikuSidechainTurns !== undefined && (
            <p>
              {haikuSidechainTurns.toLocaleString()} Haiku turns are background subagent calls{" "}
              <InfoTip
                label="About Haiku background turns"
                content="Haiku turns recorded from subagent work. They contribute to model turn counts; use the Sessions model filter to inspect the sessions."
              />
            </p>
          )}
          <InfoTip
            label="About turns by model"
            content="Recorded turns split by model in this window. Larger segments mean more use of that model; open Sessions to inspect individual sessions."
          />
        </div>
        <div className="card card-padded overview-across-card">
          <div className="overview-across-heading">
            <h3>
              <a href="#/settings?section=advanced">Data health</a>
            </h3>
            <span className="chip">Settings</span>
          </div>
          {healthRows.length > 0 ? (
            <ul className="overview-health-list">
              {healthRows.map((row) => (
                <li key={row.label}>
                  <a href={row.href}>
                    {row.label}
                    <strong>{row.value}</strong>
                  </a>
                  <InfoTip label={`About ${row.label}`} content={row.info} />
                </li>
              ))}
            </ul>
          ) : (
            <p>
              No data health signals are available yet.{" "}
              <a href="#/settings?section=advanced">Open data health in Settings →</a>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
