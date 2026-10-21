import type { JudgeVerdict } from "../../judge/verdict";
import InfoTip from "../shell/InfoTip";
import { FIELD_CAP, STANCE_LABEL, checkHref, cleanText, safeLink } from "./narrative";

export interface NarrativeCheck {
  statement: string;
  source_url: string;
}

/**
 * The stored AI review as cards (plan U10 "rendering"). Every model string goes through `cleanText` and renders as
 * a plain text node; links are only ones built here and checked by `safeLink`. No tier/score styling, no numbers.
 */
export default function JudgeNarrative({
  verdict,
  checks,
  activeCaps,
}: {
  verdict: JudgeVerdict;
  /** Rubric checks by id: the display name and the cited doc. */
  checks: ReadonlyMap<string, NarrativeCheck>;
  /** check_id → tier, for each cap the scorecard currently applies. */
  activeCaps: ReadonlyMap<string, string>;
}) {
  const citationUrls = [...checks.values()].map((c) => c.source_url);
  const nameOf = (id: string) => checks.get(id)?.statement ?? "a scorecard check";
  return (
    <section className="judge-ai" aria-labelledby="judge-ai-label">
      <div className="judge-ai-label">
        <h3 id="judge-ai-label">AI opinion (unverified)</h3>
        <InfoTip
          label="What the AI opinion is"
          content="Claude read the setup summary shown on the consent screen and wrote this. It is an opinion: it can be wrong, it was not checked by the app, and it never changes your score or tier above. Act on it only after checking the linked scorecard row or doc."
        />
      </div>
      <p className="judge-ai-verdict">{cleanText(verdict.verdict, FIELD_CAP.verdict)}</p>

      {verdict.findings.length > 0 && (
        <ol className="judge-ai-findings">
          {verdict.findings.map((f, i) => {
            const capTier = f.check_id === null ? undefined : activeCaps.get(f.check_id);
            const row = f.check_id === null ? null : checkHref(f.check_id);
            const doc =
              f.check_id === null
                ? null
                : safeLink(checks.get(f.check_id)?.source_url ?? "", citationUrls);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: findings are a fixed, ranked list
              <li key={i} className="judge-ai-finding" data-flagged={capTier ? "true" : undefined}>
                <div className="judge-ai-finding-head">
                  <span className="rank-num">{i + 1}</span>
                  <h4>{cleanText(f.title, FIELD_CAP.title)}</h4>
                </div>
                {capTier && (
                  <p className="judge-ai-flag">
                    ⚠ Flagged: this conflicts with an active cap (the scorecard holds your tier at{" "}
                    {capTier} because of this check). Fix the check as the scorecard row says before
                    following this suggestion.
                  </p>
                )}
                <blockquote className="judge-ai-quote">
                  {cleanText(f.evidence, FIELD_CAP.evidence)}
                </blockquote>
                <dl className="judge-ai-dl">
                  <dt>Why it matters</dt>
                  <dd>{cleanText(f.why, FIELD_CAP.why)}</dd>
                  <dt>Suggested change</dt>
                  <dd>{cleanText(f.change, FIELD_CAP.change)}</dd>
                </dl>
                <div className="judge-ai-links">
                  {f.check_id !== null && row !== null && (
                    <a href={row}>See “{nameOf(f.check_id)}” in your scorecard →</a>
                  )}
                  {doc !== null && (
                    <a href={doc} target="_blank" rel="noopener noreferrer">
                      Cited doc ({new URL(doc).host}) →
                    </a>
                  )}
                  {f.source !== null && (
                    <span className="judge-ai-source">
                      From: {cleanText(f.source, FIELD_CAP.item)}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {verdict.disagreements.length > 0 && (
        <div className="judge-ai-block">
          <h4>Where the AI disagrees with the scorecard</h4>
          <ul className="judge-ai-disagree">
            {verdict.disagreements.map((d) => {
              const row = checkHref(d.check_id);
              return (
                <li key={d.check_id}>
                  <span className="chip chip-plain">
                    {STANCE_LABEL[d.stance] ?? "AI disagrees"}
                  </span>{" "}
                  {row !== null ? <a href={row}>{nameOf(d.check_id)}</a> : nameOf(d.check_id)}
                </li>
              );
            })}
          </ul>
          <p className="judge-ai-note">
            The scores are unchanged. Open a check to read the AI's reason.
          </p>
        </div>
      )}

      {verdict.cannot_judge.length > 0 && (
        <div className="judge-ai-block judge-ai-muted">
          <h4>What the AI could not judge</h4>
          <ul>
            {verdict.cannot_judge.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: plain strings may repeat
              <li key={i}>{cleanText(c, FIELD_CAP.item)}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
