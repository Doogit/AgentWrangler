# AgentWrangler — Recommendations Engine (overview)

**Status:** design / pre-alpha · applies to the **Observe** MVP (PRD v0.7.x)

AgentWrangler watches your normal Claude Code usage and turns the raw transcript data into
**evidence-backed recommendations** for cutting token spend without cutting task success. This
document explains how the recommendation engine is designed. It is a conceptual overview; the
implementation lives in the daemon and is not required reading to use the tool.

---

## Two tiers

**Tier 1 — deterministic detectors (continuous, free).** Versioned rules run over your ingested
metrics on every pass. They require no API key and never send data anywhere. Each detector defines a
trigger predicate, the evidence it cites, a modeled-savings formula, an adoption signal, and a
measured-effect definition.

**Tier 2 — "Analyze with Claude" (on demand).** A dashboard action compiles a small **evidence pack**
(derived aggregates and detector hits — no prompt or code content by default) and runs it through your
**local Claude Code CLI** (your existing subscription — no separate API key needed). The output must
satisfy a structured contract: every proposal carries a category, a lever, modeled savings with its
formula inputs, and **evidence citations that must resolve against your local database** — otherwise the
proposal is rejected. The analysis run's own cost is displayed.

---

## The honesty rules

These are load-bearing, not decoration:

- **Modeled vs measured are never mixed.** A recommendation's projected savings are *modeled*; only the
  before/after delta measured **after you adopt it** is *realized*. Modeled figures are never summed into
  a "savings achieved" total.
- **The resource is rate-limit headroom, not raw tokens.** On subscription billing, cache reads draw
  against the weekly cap at the *cached* rate (~0.1×), not full weight. Because most tokens are cache
  reads, a naïve "tokens saved" number overstates recoverable headroom by roughly 10×. Savings are
  therefore **cap-weighted** and anchored on **$/week** and **per-turn context delta**, never a raw
  token count.
- **Everything is labeled.** The recommendations surface is marked `EXPERIMENTAL` (methodology under
  validation); each modeled figure is marked `MODELED`; observed proxies carry their error band. Color is
  always paired with a text label.
- **Nothing is auto-applied.** Adoption is a manual action. The tool can *assist* an apply through the
  local CLI, but only as a dry-run → diff preview → explicit confirm → rollback job.

---

## The detector registry

Detectors are ordered by **recoverable headroom** (cap-weighted), not by raw token volume.

**Primary drivers** (highest recoverable headroom):

| Detector | What it flags | Lever |
|---|---|---|
| Cache-write / miss churn *(flagship)* | Cache-write spikes after an idle gap or resume, with little subsequent cache reuse | Pre-idle `/clear`; batch prefix edits to a session boundary; TTL (5m vs 1h) alert |
| Tool-result bloat | Large tool-result payloads carried across many later turns (size only, never content) | Trim / summarize noisy tool output |
| Idle / background sessions | Assistant turns with no preceding user turn | Close or scope idle sessions |
| Loop / retry waste | Repeated reads of the same file with no edit between; retry-after-error density | Break the loop; fix the failing step |

**Secondary / supporting:**

| Detector | Note |
|---|---|
| Oversized always-loaded context | A *secondary* lever — the trimmed prefix is re-read from cache at ~0.1× cap weight, so its raw value is easy to overstate. Every such rec carries a cache-invalidation caveat. |
| Long full-context sessions | Cache-read spend on very long, full-context sessions; savings use a visibly-labeled, unvalidated reduction assumption |
| Model-routing adherence | *Advisory only.* Which cap binds is not inferable from transcripts alone, so no crisp routing-savings dollar figure is emitted — the tool reports the observed share and rule-deviation, not a hard number. |
| Burn-forecast limit warning | Warning-class (no savings model): fires when projected token burn would exhaust the weekly limit before it resets |

---

## Adoption and measured effect

Recommendation lifecycle: `PROPOSED → ADOPTED | DISMISSED`; an adopted recommendation moves to
`MEASURING → MEASURED_EFFECTIVE | MEASURED_NO_EFFECT` after an observation window on its target metric.
For context/prefix recommendations, the **authoritative realized signal is the on-disk byte delta of the
always-loaded files** (tracked as an append-on-change history), not average context-per-turn, which is
dominated by session depth and cannot isolate a single change. When several changes fall in one window,
effect is attributed per source where the byte deltas allow and left `INCONCLUSIVE` otherwise. A realized
result below the modeled projection is treated as a limit of measurement/modeling — surfaced honestly,
never hidden.

---

*This overview tracks the Observe MVP. The full product requirements and metric definitions are the
source of truth for implementation.*
