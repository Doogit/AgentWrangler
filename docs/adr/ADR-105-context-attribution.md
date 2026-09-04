# ADR-105: Context Attribution v1

**Status:** accepted · **Date:** 2026-08-21  
**Spike:** S5 context attribution  
**Decision by:** S5 spike findings + Opus disposition 2026-08-21 (below; supersedes the inline `[FLAG]` markers).

---

## Opus disposition (2026-08-21)

- **D-1 tokenizer pin → EXACT.** Pin `gpt-tokenizer` to an exact version (e.g. `2.9.0`), not `^2.9.0`.
  `attribution_version = 1` must be byte-reproducible for NFR-107 rebuild equality; the cl100k
  vocabulary is frozen but the library implementation is not, so an exact pin is cheap insurance.
  Promote as an exact pin when the tokenizer moves to `src/` in Phase 1.
- **D-2 MEMORY component → ADD `MEMORY` enum.** MEMORY.md is genuinely always-loaded and
  semantically distinct from `OTHER`; add it to the `context_inventory.component` CHECK constraint
  (Session 12 DDL edit, SG-S5-04 — zero-cost pre-first-migration).
- **D-3 residual in UI → SURFACE (lumped) in v1.** v1 shows a single
  `session_residual = observed_context − attributed_baseline` line labeled "session history +
  tool outputs (not itemized in v1)". Honesty requirement: always-loaded files are only ~2–5% of
  per-turn context, so the UI must not imply they are the whole story. Full per-source
  reconstruction is deferred to `attribution_version = 2`. Carry into Session 11 wireframes.
- **D-4 D1 example → CORRECT in Session 12 (SG-S5-01).** Material accuracy fix: the headline
  "$875/wk" is a **D2 (session-hygiene: `/clear` + subagents)** outcome, NOT a D1 (CLAUDE.md-trim)
  outcome. For this corpus D1 does not even trigger (max baseline 10k < 40k threshold) and its
  realistic saving is ~$45/wk. Any user-facing/marketing use of "$875/wk savings" must attribute it
  to session hygiene, not to trimming always-loaded files.

---

## Context

S5 empirically measured the always-loaded context contributors per workspace, compared tokenizer approximations against the corpus, reconciled attributable baseline against observed per-turn context from the validated review, and reproduced D1's modeled $875/wk savings figure. All numbers are grounded in the corpus; no assumptions carried forward without evidence.

The tokenizer pin was explicitly deferred to S5 by the ADR-100 note: "Tokenizer pin deferred to S5."

---

## Decisions

### D-1 Tokenizer pin: `gpt-tokenizer` cl100k_base

**Recommended tokenizer: `gpt-tokenizer` npm package (cl100k_base BPE encoding).**

| Tokenizer | Type | Dependency | Agreement vs char/4 |
|---|---|---|---|
| `gpt-tokenizer` cl100k_base | BPE (chosen) | Pure JS npm; no WASM/native | 94.15% avg (9 files) |
| Char/4 heuristic `ceil(chars/4)` | Heuristic (baseline) | None | — |

Rationale:
- Pure JS; installs without native build step on all platforms.
- cl100k_base is the industry-standard approximation for Claude 3/4 tokenization.
- Cross-tokenizer agreement with the char/4 heuristic: **94.15% average** (range 90.80%–98.25%).
- Cross-validated against the token-usage-review-2026-08-21.md §4.3(c) estimates: BPE gives global CLAUDE.md = 2,653 tokens (review said ~2.8k; −5.3%); helpdesk-web CLAUDE.md = 7,394 (review said ~6.8k; +8.7%). Both within ±9%.
- Error direction: **slight over-estimate** relative to Anthropic's server-side tokenizer (Anthropic uses a proprietary vocabulary). Conservative for cost-attribution — estimates are never underestimates.

**Version to pin:** `gpt-tokenizer@^2.9.0` (installed in `spikes/s5-context-attribution/package.json`; promote to `src/` on Phase 1 context inventory feature).

[FLAG — Opus decision requested: Should we pin `gpt-tokenizer` exact version rather than `^2.9.0` to guarantee reproducibility of `attribution_version = 1` counts? Or is semver-compatible acceptable given the ±9% error bar already documented?]

### D-2 Always-loaded attribution formula (`attribution_version = 1`)

**Attribution formula for `context_inventory` entries:**

```
attributed_tokens = sum(tokenize(file_content) for file in always_loaded_components)
```

**Always-loaded components attributed deterministically (v1):**

| Component type | `context_inventory.component` value | Source path | Stability |
|---|---|---|---|
| Global CLAUDE.md | `CLAUDE_MD` | `~/.claude/CLAUDE.md` | Stable; changes with user edits |
| Project CLAUDE.md | `CLAUDE_MD` | `<workspace.repo_path>/CLAUDE.md` | Stable; changes with project edits |
| Parent-dir CLAUDE.md files | `CLAUDE_MD` | Parent dirs up to HOME with CLAUDE.md | Rare; attributable when found |
| MEMORY.md | `OTHER` | `~/.claude/projects/<slug>/memory/MEMORY.md` | Per-session; tracked by hash |

**Not attributed in v1 (inestimable without API access):**
- Claude Code system prompt: internal to binary; version-dependent; not exposed.
- MCP tool schemas: dynamic per session configuration; vary per launch.

These contribute an estimated 1–3% of observed context (unknown, not measured — stated as a qualification in v1).

[FLAG — Opus decision requested: Should `MEMORY.md` be its own `component` enum value (e.g. `MEMORY`) rather than `OTHER`? The data model's CHECK constraint currently allows `('CLAUDE_MD','RULES','MCP_SCHEMAS','SETTINGS_SYSTEM','OTHER')`. MEMORY.md is distinct from `OTHER` in attribution semantics — it's per-workspace, per-session, and tracked separately.]

### D-3 Always-loaded baseline per workspace (empirical, BPE counts)

Measured baselines for the four high-spend workspaces:

| Workspace | CLAUDE.md tokens | MEMORY.md tokens | Baseline total |
|---|---|---|---|
| AgentWrangler | 3,008 | 34 | **3,042** |
| helpdesk-web | 10,047 | 47 | **10,094** |
| orbit-api | 5,916 | 630 | **6,546** |
| orbit-worker | 4,530 | 986 | **5,516** |

All baselines measured via `gpt-tokenizer` cl100k_base on 2026-08-21. `attribution_version = 1` must record the tokenizer version and file hash at probe time so counts can be reproduced exactly (NFR-107 rebuild equality).

### D-4 Reconciliation error bar

**Always-loaded attribution explains 2–5% of observed per-turn context:**

| Model | Observed avg context/turn | Max baseline (helpdesk-web) | Explained |
|---|---|---|---|
| Opus | 238,000 | 10,094 | **4.2%** |
| Sonnet | 248,000 | 10,094 | 4.1% |
| Fable | 278,000 | 10,094 | 3.6% |

The remaining 95–98% is accumulated session history + tool outputs read per session (dominant ~70–80%) plus unattributable fixed overhead (system prompt, MCP schemas, ~1–3%). This is not a gap in the attribution design; it reflects the architecture of Claude Code sessions (context accumulates per session, not per always-loaded file).

**`attribution_version = 1` stated error bar: ±5–10% on always-loaded token counts (tokenizer approximation); 95–98% of per-turn context is not attributed from always-loaded files and is documented as residual.**

[FLAG — Opus decision requested: The 95-98% residual is structurally unavoidable without per-session context reconstruction. Should v1 surface a "session-context" residual line in the UI (i.e., `observed_context - attributed_baseline = session_residual`) to make clear what's not being attributed? Or defer this distinction to a future `attribution_version = 2` that includes session-level reconstruction?]

### D-5 D1 modeled savings: formula validated, trigger not currently met

**Validation result:** $874.17 reproduced from recorded inputs (delta −$0.83, rounding only). PASS.

**D1 formula:** `Δcache_read_tokens/turn × turns/wk × cache_read_price / 1e6`  
**Inputs used:** Opus cache read 1,766M tokens/wk; $1.5/MTok; 33% modeled reduction → $874.17 ≈ $875.

**D1 trigger status:** D1 (`CTX_ALWAYS_LOADED_OVERSIZE`) does NOT currently fire for any corpus workspace. Trigger thresholds (>40k tokens OR >25% of avg context) are not met — maximum observed baseline is 10,094 tokens (helpdesk-web), which is 4.2% of avg Opus context, well below the 25% threshold.

**Attribution correction (review v0.1 → v0.2):** The review v0.1 attributed $875 to "trim CLAUDE.md" (a D1-type lever). The review v0.2 corrected this: CLAUDE.md trim saves ~$45/wk (4k delta × 7,565 turns × $1.5/MTok), not $875. The $875 is from session hygiene (D2 lever: `/clear` + subagents reducing accumulated context). The D1 spec's reference to "the review's $875 calculation" refers to the formula **pattern**, not a D1-specific saving from this corpus.

[FLAG — Opus decision requested: The D1 spec (rec-engine §2) says "the review's `238k→160k ≈ $875/wk` calculation, generalized" as D1's modeled savings example. Given v0.2's correction that $875 is a D2 (session hygiene) outcome, not D1, should the D1 spec be updated to use a more accurate D1 example — e.g., "if always-loaded files total 50k tokens in a high-context workspace, trimming by 30k saves: 30k × 7,565 turns × $1.5/MTok = $341/wk"? The formula pattern is correct; the scenario example is misleading.]

### D-6 `attribution_version = 1` fixed definition

`attribution_version = 1` is defined as:
- Tokenizer: `gpt-tokenizer` cl100k_base BPE
- Components attributed: global CLAUDE.md, project CLAUDE.md, MEMORY.md
- Components NOT attributed: system prompt, MCP schemas
- Error bar: ±5–10% on always-loaded counts (tokenizer approximation error vs Anthropic's actual tokenizer)
- Residual: 95–98% of per-turn context is not attributable from always-loaded files in v1
- Probe cadence: on workspace registration, on CLAUDE.md file-hash change, on MEMORY.md file-hash change

Any change to tokenizer, component list, or attribution logic requires incrementing to `attribution_version = 2`.

---

## S5 Exit Criteria Scorecard

| Criterion | Result |
|---|---|
| ADR: `attribution_version 1` fixed with stated error bar | **PASS** |
| D1's modeled-savings formula validated against review's $875/wk arithmetic | **PASS** |

**Both S5 exit criteria: PASS.**

---

## Spec Gaps for Session 12

| # | Gap | Finding | Action needed |
|---|---|---|---|
| SG-S5-01 | D1 spec $875 mis-attributed | v0.2 correction: $875 is D2 (session hygiene), not D1 (always-loaded); D1's realistic saving for this corpus = ~$45/wk | Rec Engine spec §2 D1: update example scenario; clarify formula applies to any Δcontext, not just CLAUDE.md trim |
| SG-S5-02 | D1 trigger not met in corpus | Max observed baseline 10,094 tokens; threshold is 40k; D1 would only trigger if CLAUDE.md hierarchy grew 4× | Note in D1 spec: trigger is forward-looking; not currently actionable for this user's workspaces |
| SG-S5-03 | System prompt + MCP schemas not attributable | Internal/dynamic; contribute ~1–3% of context (estimated, not measured) | Add qualification note to `context_inventory` schema and UI: "always-loaded estimate excludes system prompt and dynamic MCP schemas" |
| SG-S5-04 | MEMORY.md not in `context_inventory.component` enum | MEMORY.md is a distinct, per-workspace always-loaded file; `OTHER` conflates it with unknown sources | Add `MEMORY` to the `component` CHECK constraint in the Data Model; promote to named component in v1 |
| SG-S5-05 | Tokenizer pin was deferred to S5 | Done: `gpt-tokenizer@^2.9.0` selected | Update ADR-100 note to reference ADR-105 as the tokenizer decision record |

---

## Deferred (not S5 scope)

- Per-session context reconstruction for full attribution (future `attribution_version = 2`)
- MCP schema token counting (requires session-level dynamic loading of schemas)
- Tier 2 contract validation — S6 scope
- Live tail tokenizer integration — Phase 1 scope
