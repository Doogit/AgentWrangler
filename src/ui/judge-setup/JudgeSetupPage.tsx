import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { CategoryOutcome, CheckOutcome } from "../../detector/setup-grade";
import type { JudgeVerdict } from "../../judge/verdict";
import type { JudgeSetupResponse } from "../../query/api/judge-setup";
import { fetchJudgeSetup } from "../api/client";
import AsyncErrorState from "../shell/AsyncErrorState";
import InfoTip from "../shell/InfoTip";
import { SkeletonBlock, SkeletonLine } from "../shell/Skeleton";
import JudgeReview from "./JudgeReview";
import { type Tone, scoreTone, tierTone } from "./bands";
import { evidenceText } from "./evidence";
import { FIELD_CAP, STANCE_LABEL, cleanText } from "./narrative";
import { buildShareCard } from "./share-card";

type Disagreement = JudgeVerdict["disagreements"][number];
type Disagreements = ReadonlyMap<string, Disagreement>;

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; data: JudgeSetupResponse };

const RESULT_LABEL: Record<CheckOutcome["result"], string> = {
  PASS: "✓ Pass",
  PARTIAL: "◐ Partial",
  FAIL: "✗ Fail",
  NO_DATA: "— No data",
};

const RESULT_TONE: Record<CheckOutcome["result"], Tone> = {
  PASS: "green",
  PARTIAL: "amber",
  FAIL: "rose",
  NO_DATA: "plain",
};

const SEVERITY_TONE: Record<string, Tone> = {
  critical: "rose",
  important: "amber",
  minor: "plain",
};

function ToneChip({
  tone,
  children,
  testId,
}: {
  tone: Tone;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span className="chip judge-chip" data-tone={tone} data-testid={testId}>
      {children}
    </span>
  );
}

const NO_DATA_TIP =
  "No data means the check could not be scored: the setting is unreadable, or there is not yet enough observed activity. It is left out of the score instead of counting as a pass or a fail. Keep using Claude Code and it fills in; nothing to fix.";

function formatUsd(value: number): string {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/wk`;
}

function CheckRow({
  check,
  data,
  disagreement,
  focused,
}: {
  check: CheckOutcome;
  data: JudgeSetupResponse;
  disagreement: Disagreement | undefined;
  focused: boolean;
}) {
  const rubric = data.rubric.checks.find((c) => c.check_id === check.check_id);
  const money = data.dollars.per_check.find((d) => d.check_id === check.check_id);
  const recId = money?.rec_ids[0];
  const gate = data.rubric.gates.find((g) => g.check_id === check.check_id);
  const evidence = evidenceText(
    check.check_id,
    check.value,
    check.sample,
    data.allow_all_bash_files,
  );
  return (
    <li
      className="judge-check"
      id={`judge-check-${check.check_id}`}
      data-result={check.result}
      data-focused={focused ? "true" : undefined}
    >
      <div className="judge-check-head">
        <ToneChip tone={RESULT_TONE[check.result]}>{RESULT_LABEL[check.result]}</ToneChip>
        {check.result === "NO_DATA" && <InfoTip label="What No data means" content={NO_DATA_TIP} />}
        {rubric && (
          <ToneChip tone={SEVERITY_TONE[rubric.severity] ?? "plain"}>
            {rubric.severity.charAt(0).toUpperCase() + rubric.severity.slice(1)}
          </ToneChip>
        )}
        {gate && <ToneChip tone="violet">Gate · {gate.boundary}</ToneChip>}
        {rubric?.cap && <ToneChip tone="rose">Caps at {rubric.cap.tier}</ToneChip>}
        <span className="judge-check-statement">{rubric?.statement ?? check.check_id}</span>
      </div>
      {disagreement && (
        <details className="judge-ai-disagrees">
          <summary className="chip chip-plain">AI disagrees</summary>
          <p>
            <b>{STANCE_LABEL[disagreement.stance] ?? "AI disagrees"}</b> (AI opinion, unverified;
            the result above is unchanged): {cleanText(disagreement.reason, FIELD_CAP.reason)}
          </p>
        </details>
      )}
      <div className="judge-check-meta">
        {evidence !== null && <span>{evidence}</span>}
        {check.needs !== null && <span>Needs: {check.needs}</span>}
        {check.result !== "PASS" && <HowTo steps={rubric?.how_to} />}
        {money?.dollars_per_week !== null && money?.dollars_per_week !== undefined ? (
          <span>
            Costing about <b className="judge-money">{formatUsd(money.dollars_per_week)}</b>{" "}
            <InfoTip
              label="What the check dollar figure means"
              content="A modeled weekly amount from the recommendation that prices this gap, net of overlaps. It is an estimate, not a bill. Fixing the item is how you recover it."
            />
          </span>
        ) : null}
        {recId !== undefined ? (
          <a href={`#/recommendations?focus=${encodeURIComponent(recId)}`}>See the fix →</a>
        ) : (
          rubric && (
            <a href={rubric.source_url} target="_blank" rel="noreferrer">
              Cited doc ({rubric.source_date}) →
            </a>
          )
        )}
      </div>
    </li>
  );
}

const PANEL_ID = "judge-checks-panel";
const SLOW_LOAD_MS = 5_000;

function CategoryCard({
  category,
  checks,
  data,
  threshold,
  open,
  onToggle,
}: {
  category: CategoryOutcome;
  checks: CheckOutcome[];
  data: JudgeSetupResponse;
  threshold: number;
  open: boolean;
  onToggle: () => void;
}) {
  const scored = category.status === "scored" && category.score !== null;
  const tone: Tone = scored ? scoreTone(data.rubric, category.score as number) : "plain";
  const counts: { result: CheckOutcome["result"]; word: string }[] = [
    { result: "PASS", word: "pass" },
    { result: "FAIL", word: "fail" },
    { result: "PARTIAL", word: "partial" },
    { result: "NO_DATA", word: "no data" },
  ];
  return (
    <section
      className="card kpi judge-category"
      data-tone={tone}
      data-status={scored ? "scored" : "insufficient-data"}
      data-open={open ? "true" : undefined}
      aria-label={category.label}
    >
      <div className="lbl">
        <span>
          {category.label}{" "}
          <InfoTip
            label={`What the ${category.label} score means`}
            content={`Share of the available points earned across this category's checks that have data (0-100, higher is better). It counts toward the overall score with weight ${category.weight}. Open the checks to see what to fix.`}
          />
        </span>
      </div>
      {scored ? (
        <div className="v num">
          {Math.round(category.score as number)}
          <span className="judge-score-of">/100</span>
        </div>
      ) : (
        <div className="v judge-insufficient">
          <span className="chip chip-plain">Insufficient data</span>{" "}
          <InfoTip
            label="What insufficient data means"
            content={`Fewer than ${threshold} checks in this category have data, so no score is shown and it is left out of the overall grade. It is not a failing mark. It fills in as the missing data accrues.`}
          />
        </div>
      )}
      <div className="cmp num">
        {category.scored_checks} of {category.total_checks} checks have data
      </div>
      <div className="meter judge-cat-meter" aria-hidden="true">
        {scored && <span style={{ width: `${clampPct(category.score as number)}%` }} />}
      </div>
      <div className="judge-chip-row">
        {counts.map(({ result, word }) => {
          const n = checks.filter((c) => c.result === result).length;
          return n > 0 ? (
            <ToneChip key={result} tone={RESULT_TONE[result]}>
              {n} {word}
            </ToneChip>
          ) : null;
        })}
      </div>
      <button
        type="button"
        className="more judge-more"
        aria-expanded={open}
        aria-controls={open ? PANEL_ID : undefined}
        onClick={onToggle}
      >
        {open ? "Hide checks ↑" : "Show checks →"}
      </button>
    </section>
  );
}

function CategoryChecksPanel({
  category,
  checks,
  data,
  onClose,
  disagreements,
  focusCheck,
  focusSeq,
}: {
  category: CategoryOutcome;
  checks: CheckOutcome[];
  data: JudgeSetupResponse;
  onClose: () => void;
  disagreements: Disagreements;
  focusCheck: string | null;
  focusSeq: number;
}) {
  const ref = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusSeq re-scrolls when the same check is followed again
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const row = focusCheck === null ? null : document.getElementById(`judge-check-${focusCheck}`);
    (row ?? el).scrollIntoView?.({ block: row ? "center" : "nearest", behavior: "smooth" });
  }, [focusCheck, focusSeq]);
  return (
    <section
      className="inset-panel judge-checks-panel"
      id={PANEL_ID}
      ref={ref}
      tabIndex={-1}
      aria-labelledby="judge-checks-panel-title"
    >
      <div className="judge-checks-panel-head">
        <h3 id="judge-checks-panel-title">{category.label} checks</h3>
        <button type="button" className="btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
      <ul className="judge-checks">
        {checks.map((c) => (
          <CheckRow
            key={c.check_id}
            check={c}
            data={data}
            disagreement={disagreements.get(c.check_id)}
            focused={c.check_id === focusCheck}
          />
        ))}
      </ul>
    </section>
  );
}

/** `#/judge-setup?check=<id>` (links from the AI review) → that check id. */
function hashCheck(): string | null {
  const q = window.location.hash.split("?")[1];
  return q ? new URLSearchParams(q).get("check") : null;
}

function Categories({
  data,
  disagreements,
}: {
  data: JudgeSetupResponse;
  disagreements: Disagreements;
}) {
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [focusCheck, setFocusCheck] = useState<string | null>(null);
  const [focusSeq, setFocusSeq] = useState(0);
  useEffect(() => {
    const follow = () => {
      const id = hashCheck();
      const check = id === null ? undefined : data.grade.checks.find((c) => c.check_id === id);
      if (!check) return;
      setOpenCat(check.category);
      setFocusCheck(check.check_id);
      setFocusSeq((n) => n + 1);
    };
    // Re-clicking a link to the current hash fires no hashchange; scroll to the row again anyway.
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href^='#/judge-setup?check=']");
      if (a && a.getAttribute("href") === window.location.hash) follow();
    };
    follow();
    window.addEventListener("hashchange", follow);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", follow);
      document.removeEventListener("click", onClick);
    };
  }, [data]);
  const opened = data.grade.categories.find((c) => c.category === openCat);
  const checksFor = (cat: string) => data.grade.checks.filter((c) => c.category === cat);
  return (
    <section className="sec" aria-labelledby="judge-categories-title">
      <div className="sec-h">
        <h2 id="judge-categories-title">Categories</h2>
        <span className="desc">
          <ToneChip tone="violet" testId="judge-scored-chip">
            {data.grade.categories.filter((c) => c.score !== null).length} of{" "}
            {data.grade.categories.length} scored
          </ToneChip>
        </span>
      </div>
      <div className="grid g4">
        {data.grade.categories.map((category) => (
          <CategoryCard
            key={category.category}
            category={category}
            checks={checksFor(category.category)}
            data={data}
            threshold={data.rubric.min_category_checks}
            open={openCat === category.category}
            onToggle={() => {
              setFocusCheck(null);
              setOpenCat((o) => (o === category.category ? null : category.category));
            }}
          />
        ))}
      </div>
      {opened && (
        <CategoryChecksPanel
          key={opened.category}
          category={opened}
          checks={checksFor(opened.category)}
          data={data}
          onClose={() => setOpenCat(null)}
          disagreements={disagreements}
          focusCheck={focusCheck}
          focusSeq={focusSeq}
        />
      )}
    </section>
  );
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

function Headline({ data }: { data: JudgeSetupResponse }) {
  const { grade } = data;
  const scoredCats = grade.categories.filter((c) => c.score !== null);
  const cap = grade.caps.find((c) => c.binding);
  const holding = grade.gates.filter((g) => g.holding);
  const holdText = (noun: string, n: number): string => {
    if (grade.overall === null || !grade.tier_by_score || !grade.tier) return "";
    const raw = Math.floor(grade.overall_before_hold ?? grade.overall);
    return ` Your score of ${raw} would earn ${grade.tier_by_score}, but ${n} ${noun}${n === 1 ? "" : "s"} ${n === 1 ? "holds" : "hold"} you at ${grade.tier}, so your score is shown as ${Math.floor(grade.overall)}. Fix ${n === 1 ? "it" : "them"} to unlock ${grade.tier_by_score}.`;
  };
  // The awarded tier (after caps and gates) colors the meter, matching the tier chip.
  const overallTone: Tone = grade.tier !== null ? tierTone(data.rubric, grade.tier) : "plain";

  return (
    <section
      className="card card-padded judge-headline"
      data-tone={overallTone}
      aria-labelledby="judge-headline-title"
    >
      {grade.tier !== null && grade.overall !== null ? (
        <>
          <div className="judge-tier-row">
            <h2 id="judge-headline-title" className="judge-tier" data-testid="judge-tier">
              {grade.tier}
            </h2>
            <ToneChip tone={tierTone(data.rubric, grade.tier)} testId="judge-tier-chip">
              Tier {data.rubric.tier_names.indexOf(grade.tier) + 1} of{" "}
              {data.rubric.tier_names.length}
            </ToneChip>
            <InfoTip
              label="What the tier means"
              content="Your tier comes from the overall score, then is held down by unmet gates or security caps. Higher is better. The items below say what moves you up."
            />
            {cap ? (
              <span className="chip judge-chip-capped">⚠ Capped</span>
            ) : holding.length > 0 ? (
              <span className="chip unv">Held at boundary</span>
            ) : null}
          </div>
          <div className="meter-row judge-overall-meter">
            <div className="meter-head">
              <span className="meter-name">
                Overall{" "}
                <InfoTip
                  label="What the overall score means"
                  content="A weighted average of the categories that have data. A cap or gate can hold the tier below what this score earns."
                />
              </span>
              {/* Floor, not round: 59.6 is still below Operator's 60, so it must not read "60". */}
              <b className="meter-pct num judge-overall">{Math.floor(grade.overall)}/100</b>
            </div>
            <div className="meter">
              <span style={{ width: `${clampPct(grade.overall)}%` }} />
              {data.rubric.tier_floors
                .filter((f) => f > 0 && f < 100)
                .map((f) => (
                  <div className="pace" key={f} style={{ left: `${f}%` }} />
                ))}
            </div>
            <div className="rate num">
              <span>
                Tier floors:{" "}
                {data.rubric.tier_names
                  .map((name, i) => `${name} ${data.rubric.tier_floors[i]}+`)
                  .join(" · ")}
              </span>
            </div>
          </div>
        </>
      ) : (
        <div>
          <div className="judge-tier-row">
            <h2 id="judge-headline-title" className="judge-no-tier" data-testid="judge-no-tier">
              No tier yet
            </h2>
            <span className="chip chip-plain">Not enough data</span>
          </div>
          {grade.data_needed && (
            <>
              <p>{grade.data_needed.message}</p>
              <ul className="judge-needed">
                {grade.data_needed.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {scoredCats.length > 0 && (
            <ul className="judge-available">
              {scoredCats.map((c) => (
                <li key={c.category}>
                  {c.label}: {Math.round(c.score as number)}/100
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {cap && (
        <div className="judge-banner judge-banner-capped" role="note">
          <strong>⚠ Capped at {cap.tier}.</strong> {cap.reason}
          {holdText("security issue", grade.caps.filter((c) => c.binding).length)}
        </div>
      )}
      {holding.map((g) => (
        <div className="judge-banner" role="note" key={g.gate_id}>
          <strong>Held at the {g.boundary} boundary.</strong> {g.message}
        </div>
      ))}
      {!cap && holding.length > 0 && (
        <div className="judge-banner" role="note">
          {holdText("missing requirement", holding.length)}
        </div>
      )}
    </section>
  );
}

function HowTo({ steps }: { steps: readonly string[] | undefined }) {
  if (!steps || steps.length === 0) return null;
  return (
    <ol className="judge-howto" data-testid="judge-howto">
      {steps.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </ol>
  );
}

function NextTier({ data }: { data: JudgeSetupResponse }) {
  const { grade, dollars, rubric } = data;
  if (!grade.next_tier) return null;
  const gap = dollars.next_tier_gap;
  const money = new Map(dollars.per_check.map((d) => [d.check_id, d]));
  return (
    <section
      className="card card-padded judge-next"
      data-tone={tierTone(rubric, grade.next_tier.tier)}
      aria-labelledby="judge-next-title"
    >
      <div className="judge-next-head">
        <h2 id="judge-next-title">
          To reach '{grade.next_tier.tier}' level{" "}
          <InfoTip
            label="What the next-tier items mean"
            content="The items standing between you and the next tier. Fix them to move up; the dollar figures are modeled weekly amounts where a recommendation prices the gap."
          />
        </h2>
        <ToneChip tone={tierTone(rubric, grade.next_tier.tier)}>
          {grade.next_tier.items.length} {grade.next_tier.items.length === 1 ? "item" : "items"}
        </ToneChip>
      </div>
      <ul className="judge-next-items">
        {grade.next_tier.items.map((i) => {
          const d = money.get(i.check_id);
          const rc = rubric.checks.find((c) => c.check_id === i.check_id);
          const recId = d?.rec_ids[0];
          const outcome = grade.checks.find((c) => c.check_id === i.check_id);
          const evidence = outcome
            ? evidenceText(i.check_id, outcome.value, outcome.sample, data.allow_all_bash_files)
            : null;
          const where = data.where?.[i.check_id];
          return (
            <li key={`${i.kind}-${i.check_id}`} className="judge-next-item">
              {(i.kind === "gate" || i.kind === "cap") && (
                <div className="judge-check-head">
                  <ToneChip tone={i.kind === "gate" ? "violet" : "rose"}>
                    Blocks this level
                  </ToneChip>
                  <InfoTip
                    label="What Blocks this level means"
                    content={
                      i.kind === "gate"
                        ? "Until this is fixed, your tier is held at the level below, no matter how high your score is."
                        : "A security problem caps your tier at the level below until it is fixed, no matter how high your score is."
                    }
                  />
                </div>
              )}
              <dl className="judge-next-lines">
                <div>
                  <dt>The problem</dt>
                  <dd>{i.message}</dd>
                </div>
                {rc && (
                  <div>
                    <dt>What to do</dt>
                    <dd>
                      {rc.statement}
                      <HowTo steps={rc.how_to} />
                    </dd>
                  </div>
                )}
                {evidence !== null && (
                  <div>
                    <dt>What we saw</dt>
                    <dd>{evidence}</dd>
                  </div>
                )}
                {where && where.length > 0 && (
                  <div>
                    <dt>Where</dt>
                    <dd>
                      <ul className="judge-where">
                        {where.map((w) => (
                          <li key={w.label}>
                            {w.label}: {w.missed} of {w.total}{" "}
                            {w.total === 1 ? "session" : "sessions"} missed it
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                )}
                {rc?.measured && (
                  <div>
                    <dt>What counts</dt>
                    <dd>{rc.measured}</dd>
                  </div>
                )}
                {rc?.done_when && (
                  <div>
                    <dt>Done when</dt>
                    <dd>{rc.done_when}</dd>
                  </div>
                )}
              </dl>
              <div className="judge-check-meta">
                {d && d.dollars_per_week !== null ? (
                  <b className="judge-money">{formatUsd(d.dollars_per_week)}</b>
                ) : null}
                {recId !== undefined ? (
                  <a href={`#/recommendations?focus=${encodeURIComponent(recId)}`}>See the fix →</a>
                ) : (
                  rc && (
                    <a href={rc.source_url} target="_blank" rel="noreferrer">
                      How to fix it (Claude Code docs) →
                    </a>
                  )
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {gap && gap.dollars_per_week !== null && (
        <p className="judge-gap" data-testid="judge-gap">
          About <b className="judge-money">{formatUsd(gap.dollars_per_week)}</b> to close the gap
          {gap.label && <ToneChip tone="plain">{gap.label}</ToneChip>}{" "}
          <InfoTip
            label="What the dollar gap means"
            content="The summed weekly cost of the next-tier items that a recommendation prices. Items without a price are left out, so it understates when it says 'measured items only'. An estimate, not a bill."
          />
        </p>
      )}
      {data.dollars_pending && (
        <p className="judge-gap" data-testid="judge-dollars-pending">
          Dollar figures are still being worked out. Reload in a few minutes to see them.
        </p>
      )}
    </section>
  );
}

function windowDays(window: { from: string; to: string }): number | null {
  const ms = Date.parse(window.to) - Date.parse(window.from);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 86_400_000) : null;
}

function Rubric({ data }: { data: JudgeSetupResponse }) {
  const { rubric } = data;
  const days = windowDays(data.grade.window);
  const floors = rubric.tier_names
    .map((name, i) => ({ name, floor: rubric.tier_floors[i] ?? 0 }))
    .filter((t) => t.floor > 0)
    .map((t) => `${t.name} ${t.floor}`)
    .join(" · ");
  const totalWeight = rubric.categories.reduce((sum, c) => sum + c.weight, 0);
  const [open, setOpen] = useState(false);
  return (
    <section className="sec judge-rubric" aria-labelledby="judge-rubric-title">
      <div className="sec-h">
        <h2 id="judge-rubric-title">How this is graded</h2>
        <span className="desc">
          <ToneChip tone="violet">Rubric {rubric.version}</ToneChip>
        </span>
      </div>
      <div className="card card-padded">
        <p className="judge-rubric-summary" data-testid="judge-rubric-summary">
          {rubric.checks.length} checks across {rubric.categories.length} categories, scored from
          your Claude Code config files
          {days !== null ? ` and your last ${days} days of sessions` : ""}. Severe failures weigh
          more. Tier floors: {floors}. A security problem caps your tier no matter the score. Every
          check cites its source.
        </p>
        <details className="judge-details" onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary className="btn-secondary">
            {open ? "Hide the rubric" : "Show the rubric"}
          </summary>
          <div className="inset-panel judge-rubric-body">
            <h3>
              Tier ladder{" "}
              <InfoTip
                label="What the tier ladder means"
                content="Your overall score (0-100) places you on one of these tiers. The number is the lowest score that earns the tier. Gates and caps can still hold you lower."
              />
            </h3>
            <ol className="judge-ladder">
              {rubric.tier_names.map((name, i) => (
                <li key={name} data-tone={tierTone(rubric, name)} className="judge-ladder-step">
                  <span className="judge-ladder-name">{name}</span>
                  <span className="judge-ladder-floor num">{rubric.tier_floors[i]}+</span>
                </li>
              ))}
            </ol>
            <div className="judge-callouts">
              <p className="judge-banner">
                <strong>Coverage rule.</strong> No tier is given until at least{" "}
                {Math.round(rubric.min_coverage * 100)}% of the category weight has data. A category
                needs {rubric.min_category_checks} checks with data to be scored.
              </p>
              <p className="judge-banner judge-banner-capped">
                <strong>Security cap.</strong> A security problem caps your tier no matter the
                score.
              </p>
            </div>
            <h3>
              Category weights{" "}
              <InfoTip
                label="What the category weights mean"
                content="How much each category counts toward the overall score. A heavier category moves the score more. The bar shows its share of the total weight."
              />
            </h3>
            <div className="judge-weights" data-tone="violet">
              {rubric.categories.map((c) => {
                const share = totalWeight > 0 ? (c.weight / totalWeight) * 100 : 0;
                return (
                  <div className="meter-row" key={c.category}>
                    <div className="meter-head">
                      <span className="meter-name">{c.label}</span>
                      <b className="meter-pct num">
                        {Math.round(share)}%{" "}
                        <span className="judge-weight-raw">(weight {c.weight})</span>
                      </b>
                    </div>
                    <div className="meter">
                      <span style={{ width: `${clampPct(share)}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <h3>
              Gates{" "}
              <InfoTip
                label="What the gates mean"
                content="A gate is a must-have for a tier. If you miss it, you stay one tier below, however high your score is."
              />
            </h3>
            <ul className="judge-gates">
              {rubric.gates.map((g) => (
                <li key={g.gate_id} className="judge-gate" data-tone={tierTone(rubric, g.boundary)}>
                  <ToneChip tone={tierTone(rubric, g.boundary)}>Needed for {g.boundary}</ToneChip>
                  <span>
                    {rubric.checks.find((c) => c.check_id === g.check_id)?.statement ?? g.unmet}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      </div>
    </section>
  );
}

function Delta({ data }: { data: JudgeSetupResponse }) {
  const delta = data.delta;
  if (delta === null) return null;
  const fmt = (n: number | null) => (n === null ? "n/a" : Math.floor(n).toString());
  const sign = (n: number | null) =>
    n === null
      ? "n/a"
      : n > 0
        ? `↑ ${Math.round(n)}`
        : n < 0
          ? `↓ ${Math.abs(Math.round(n))}`
          : "no change";
  return (
    <section
      className="sec judge-delta"
      aria-labelledby="judge-delta-title"
      data-testid="judge-delta"
    >
      <div className="sec-h">
        <h2 id="judge-delta-title">
          Since your last grade{" "}
          <InfoTip
            label="What the change since last grade means"
            content="The difference between this grade and the previous saved one. Scores and tiers only. Improving is good; a drop usually means a setting changed or recent activity shifted."
          />
        </h2>
        <span className="desc">
          <ToneChip
            tone={
              delta.overall_change === null || delta.overall_change === 0
                ? "plain"
                : delta.overall_change > 0
                  ? "green"
                  : "rose"
            }
          >
            {sign(delta.overall_change)}
          </ToneChip>
        </span>
      </div>
      <div className="card card-padded">
        <p>
          Overall {fmt(delta.previous_overall)} → {fmt(delta.current_overall)} (
          {sign(delta.overall_change)})
          {delta.tier_changed &&
            `. Tier ${delta.previous_tier ?? "none"} → ${delta.current_tier ?? "none"}`}
        </p>
        {delta.rubric_changed && (
          <p className="judge-banner" role="note">
            <strong>Rubric changed.</strong> The checks or scoring rules were updated since the
            previous grade ({delta.previous_rubric_version} → {delta.current_rubric_version}), so
            part of this change may come from the rubric, not your setup.
          </p>
        )}
        <ul>
          {delta.categories
            .filter((c) => c.change !== null && c.change !== 0)
            .map((c) => (
              <li key={c.category}>
                {data.grade.categories.find((g) => g.category === c.category)?.label ?? c.category}:{" "}
                {sign(c.change)}
              </li>
            ))}
        </ul>
      </div>
    </section>
  );
}

function CopySummaryButton({ data }: { data: JudgeSetupResponse }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary"
      title="Copies your tier and scores as text. No paths, workspace names or config text."
      onClick={() => {
        void navigator.clipboard.writeText(buildShareCard(data)).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2_000);
        });
      }}
    >
      {copied ? "Copied" : "Copy summary"}
    </button>
  );
}

export default function JudgeSetupPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);
  const [slow, setSlow] = useState(false);
  const [aiVerdict, setAiVerdict] = useState<JudgeVerdict | null>(null);
  const data = state.status === "ok" ? state.data : null;
  const disagreements = useMemo<Disagreements>(
    () => new Map((aiVerdict?.disagreements ?? []).map((d) => [d.check_id, d])),
    [aiVerdict],
  );
  const reviewChecks = useMemo(
    () =>
      new Map(
        (data?.rubric.checks ?? []).map((c) => [
          c.check_id,
          { statement: c.statement, source_url: c.source_url },
        ]),
      ),
    [data],
  );
  const activeCaps = useMemo(
    () => new Map((data?.grade.caps ?? []).map((c) => [c.check_id, c.tier])),
    [data],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is an intentional re-fetch trigger
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setSlow(false);
    const slowTimer = window.setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    fetchJudgeSetup()
      .then((data) => {
        if (!cancelled) setState({ status: "ok", data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
      window.clearTimeout(slowTimer);
    };
  }, [refreshKey]);

  return (
    <div className="judge-page">
      <div className="page-top">
        <div className="page-title">
          <h1>Rate my setup</h1>
          <p className="page-sub">
            A graded read of your Claude Code configuration and habits, with what to fix next
          </p>
        </div>
        {state.status === "ok" && (
          <div className="page-top-controls">
            <CopySummaryButton data={state.data} />
          </div>
        )}
      </div>

      {state.status === "loading" && (
        <div data-section-status="pending" aria-busy="true" aria-label="Loading setup grade">
          <output aria-live="polite" className="judge-loading" data-testid="judge-loading">
            <span>
              Rating your setup… reading your Claude Code config and your last 30 days of sessions.
              The first load after the app starts can take a little while.
            </span>
            {slow && (
              <span>Still working — the app is finishing its first scan of your sessions.</span>
            )}
          </output>
          <div className="card" style={{ padding: 16, marginBottom: 13 }}>
            <SkeletonBlock height={96} />
          </div>
          <div className="grid g4" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div className="card" style={{ padding: 16 }} key={i}>
                <SkeletonLine width="50%" />
                <SkeletonBlock height={40} />
                <SkeletonLine width="70%" />
              </div>
            ))}
          </div>
        </div>
      )}
      {state.status === "error" && (
        <AsyncErrorState resource="judge-setup" onRetry={() => setRefreshKey((k) => k + 1)} />
      )}
      {state.status === "ok" && (
        <>
          <Headline data={state.data} />
          <NextTier data={state.data} />
          {state.data.unreadable_surfaces && state.data.unreadable_surfaces.length > 0 && (
            <p className="judge-unreadable" data-testid="judge-unreadable">
              Could not read: {state.data.unreadable_surfaces.join(", ")}. Checks that depend on
              these have no data and are left out of the score.
            </p>
          )}
          <Categories data={state.data} disagreements={disagreements} />
          <JudgeReview
            checks={reviewChecks}
            activeCaps={activeCaps}
            onVerdict={(v) => setAiVerdict(v)}
          />
          <Rubric data={state.data} />
          <Delta data={state.data} />
        </>
      )}
    </div>
  );
}
