import { useQuery } from "@tanstack/react-query";
import { fetchJudgeSetup } from "../api/client";
import { queryClient } from "../api/query-client";
import { queryKeys } from "../api/query-keys";
import { tierTone } from "../judge-setup/bands";
import InfoTip from "../shell/InfoTip";
import KpiCard from "./KpiCard";

/** Each grade runs an env scan, so the Overview fetches it once per visit window, never on a poll. */
const GRADE_STALE_MS = 5 * 60_000;

const INFO =
  "Your setup's overall score out of 100 and the tier it earns, from the Rate my setup tab. A cap or gate can hold the tier, and the score, below what your settings and habits would otherwise earn. Higher is better.";

/** Overview KPI tile for the setup grade (JMS U12). Never blocks the strip: it loads and fails on its own. */
export default function SetupGradeCard() {
  const query = useQuery(
    {
      queryKey: queryKeys.judgeSetup(),
      queryFn: () => fetchJudgeSetup(),
      staleTime: GRADE_STALE_MS,
    },
    queryClient,
  );
  const base = {
    label: "Rate my setup",
    info: INFO,
    dataMetric: "setup.grade",
    className: "setup-grade",
    moreHref: "#/judge-setup",
    moreLabel: "Rate my setup →",
  };
  const data = query.data;
  if (!data) {
    return <KpiCard {...base} value="—" cmp={query.isError ? "Grade unavailable" : "Loading…"} />;
  }

  const { grade, rubric, delta } = data;
  if (grade.overall === null || grade.tier === null) {
    return (
      <KpiCard
        {...base}
        value="—"
        cmp={grade.data_needed?.message ?? "Not enough data to grade yet"}
      />
    );
  }

  const tone = tierTone(rubric, grade.tier);
  const cap = grade.caps.find((c) => c.binding);
  const next = grade.next_tier;
  const detail = cap?.reason ?? next?.items[0]?.message;
  // Floor, not round, as the tab does: 59.6 is still below Operator's 60.
  const floor = (n: number | null) => (n === null ? "n/a" : Math.floor(n).toString());
  // The change between the two shown (floored) scores, so "↓14 (73→59)" always adds up.
  const change =
    delta && delta.previous_overall !== null && delta.current_overall !== null
      ? Math.floor(delta.current_overall) - Math.floor(delta.previous_overall)
      : null;

  return (
    <KpiCard
      {...base}
      value={`${Math.floor(grade.overall)}/100`}
      valueExtra={
        <span className="setup-grade-chips">
          <span className="chip judge-chip" data-tone={tone}>
            {grade.tier}
          </span>
          {cap && <span className="chip judge-chip-capped">⚠ Capped</span>}
        </span>
      }
    >
      <div
        className="meter setup-ladder"
        data-testid="setup-ladder"
        data-tone={tone}
        role="img"
        aria-label={`Score ${Math.floor(grade.overall)} of 100. Tier floors at ${rubric.tier_floors.filter((f) => f > 0).join(", ")}.`}
      >
        <span className="setup-ladder-fill" style={{ width: `${grade.overall}%` }} />
        {rubric.tier_floors
          .filter((f) => f > 0)
          .map((f) => (
            <i key={f} className="setup-ladder-tick" style={{ left: `${f}%` }} />
          ))}
      </div>
      {next && (
        <div className="cmp setup-grade-next">
          Next: <b>{next.tier}</b> — {next.items.length}{" "}
          {next.items.length === 1 ? "item" : "items"}
        </div>
      )}
      {detail && <div className="foot setup-grade-detail">{detail}</div>}
      {delta && change !== null && (
        <div className="cmp setup-grade-delta">
          <span className={change > 0 ? "ok" : change < 0 ? "bad" : ""}>
            {change > 0 ? "↑" : change < 0 ? "↓" : "±"}
            {Math.abs(change)}
          </span>{" "}
          vs last grade ({floor(delta.previous_overall)}→{floor(delta.current_overall)}){" "}
          <InfoTip
            label="About the change since last grade"
            content="The difference between this score and the previous saved grade. Up is better; a drop usually means a setting changed or recent activity shifted."
          />
        </div>
      )}
    </KpiCard>
  );
}
