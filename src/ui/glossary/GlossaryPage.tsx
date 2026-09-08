/**
 * src/ui/glossary/GlossaryPage.tsx — "How to read this dashboard" (NU5).
 *
 * One static page explaining the load-bearing metric vocabulary in plain
 * language. Copy is single-sourced from the existing InfoTips / Chip tooltips
 * (FB8 audited) — a diverging paraphrase is a bug. The honesty-tier chips are
 * rendered from the real Chip component + KIND_TOOLTIP so every chip named here
 * appears verbatim as it does elsewhere in the UI. Theme-aware via CSS tokens.
 */

import Chip, { type ChipProps, KIND_TOOLTIP } from "../shell/Chip";

// The honesty tiers a reader meets across the dashboard, in the order they
// most commonly appear. Definitions come straight from Chip's KIND_TOOLTIP.
const TIER_KINDS: Array<ChipProps["kind"]> = [
  "EXACT",
  "LIST_EQUIV",
  "MODELED",
  "PROXY",
  "OBS_PROXY",
  "DIRECTIONAL",
  "EXPERIMENTAL",
];

interface Section {
  id: string;
  title: string;
  body: React.ReactNode;
}

const SECTIONS: Section[] = [
  {
    id: "glossary-list-equiv",
    title: "Estimated value and usage limits",
    body: (
      <>
        <p>
          Dollar figures show what the same token use would cost at public API list prices. They are
          <strong> not your Claude subscription bill</strong>. Check /usage or the 5-hour and 7-day
          bars for your current allowance.
        </p>
        <p>
          The usage-limit estimate approximates how quickly activity uses your Claude allowance.
          Cache reads count less than new tokens in this estimate, but the exact weighting is not
          published. Use the live usage bars for your actual limit.
        </p>
      </>
    ),
  },
  {
    id: "glossary-honesty-tiers",
    title: "How certain each number is",
    body: (
      <>
        <p>
          Every number carries a chip saying how strong its evidence is. Act on the top tiers first.
        </p>
        <dl className="glossary-chip-list">
          {TIER_KINDS.map((kind) => (
            <div className="glossary-chip-row" key={kind}>
              <dt>
                <Chip kind={kind} />
              </dt>
              <dd>{KIND_TOOLTIP[kind]}</dd>
            </div>
          ))}
          <div className="glossary-chip-row">
            <dt>
              <output className="chip bfc-chip-low-confidence" aria-label="LOW CONFIDENCE">
                LOW CONFIDENCE
              </output>
            </dt>
            <dd>
              Shown on a limit calibrated from under 10% usage, so the projected cap is a rough
              guess. Re-calibrate after you've used ~10% of a window for a stable number.
            </dd>
          </div>
        </dl>
      </>
    ),
  },
  {
    id: "glossary-cache",
    title: "Cache write vs read economics",
    body: (
      <p>
        Cache writes happen when Claude stores the current instructions and history for reuse. A
        high share usually means the saved context keeps being replaced. Returning after the cache
        expires can rebuild that context and increase token use.
      </p>
    ),
  },
  {
    id: "glossary-verdict",
    title: "Verdict band",
    body: (
      <p>
        Change versus the prior 7 days for spend, cache-write share, and hot-session count. A green
        delta is improvement; a red one is where this week got worse.
      </p>
    ),
  },
  {
    id: "glossary-friction",
    title: "Friction band",
    body: (
      <p>
        A low, elevated, or high signal based on error and failed-test counts, compactions, recorded
        interruptions, and the share of user messages. Repeated loops are a separate signal. Peak
        friction is the highest band among the sessions being summarized, not an average or proof of
        wasted work.
      </p>
    ),
  },
  {
    id: "glossary-offload",
    title: "Offload share",
    body: (
      <p>
        The share of turns handled by subagents instead of the main conversation. It is shown as a
        trend, not a target: more subagents are not automatically better.
      </p>
    ),
  },
  {
    id: "glossary-percentiles",
    title: "Self-percentiles",
    body: (
      <p>
        "top X% by spend" ranks a session against your OWN workspace history (the only honest peer
        group) — at or above X% of your sessions in this workspace over the trailing 90 days. It is
        withheld below a peer set of 20 so a tiny sample never shows a misleading rank.
      </p>
    ),
  },
  {
    id: "glossary-linkage",
    title: "Linkage coverage",
    body: (
      <p>
        The percentage of in-window sessions linked to a PR — unlinked spend is excluded from the
        linked-only success and cost-per-success views. When it's low, those views are bounded by
        what could be linked, not by all your work.
      </p>
    ),
  },
];

export default function GlossaryPage() {
  return (
    <div>
      <div className="page-top">
        <div className="page-title">
          <h1>How to read this dashboard</h1>
          <p className="page-sub">Plain-language definitions for the load-bearing metrics</p>
        </div>
      </div>

      {SECTIONS.map((section) => (
        <section
          key={section.id}
          className="card glossary-section"
          data-testid={section.id}
          aria-labelledby={`${section.id}-title`}
          style={{ padding: "16px 20px", marginBottom: 13 }}
        >
          <h2 id={`${section.id}-title`} style={{ margin: "0 0 8px", fontSize: 15 }}>
            {section.title}
          </h2>
          {section.body}
        </section>
      ))}
    </div>
  );
}
