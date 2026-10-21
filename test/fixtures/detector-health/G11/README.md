# G11 fixtures

Synthetic only. Generator: scratchpad `gen.ts` (synth.ts `assistant` + `toJsonl`). One workspace per case (workspace_id = case dir name). Each case = transcript dir + `rows-<case>.json` (work_items, observed_outcomes, session_work_links). Authored timestamps already put the newest turn at NOW - 1 day (2027-01-07T00:00Z), so the harness shift is 0.

## Common generator
- 20 baseline work items `gh:synth/g11#100..119`, each linked to one RECONCILED session (2 non-provisional turns, output tokens only, same workspace). Item i has (i+1)*10,000 tokens (10k..200k). Terminal times NOW-90d+2h + 4d*i. Outcomes mix SUCCESS / SUCCESS_WITH_DEFERRALS / FAILURE (MERGED or CLOSED).
- Nearest-rank p90 of 20 = ceil(18) = 18th smallest = 180,000 tokens.
- Candidate `gh:synth/g11#900`: MERGED at NOW-1d+6h (inside 7d window), OBSERVED_FAILURE, one linked session `g11-cand` (2 non-provisional turns).
- Card clauses met by positive: MERGED/OBSERVED_FAILURE, terminal in 7d; fully attributable (same workspace, reconciled, non-provisional turn); baseline 20 items all fully attributable in the 90d window (>= 20); candidate tokens 180,000 >= p90 180,000; candidate cost ~7.9% of workspace 90d spend (>= 1%); turn anchors exist.

## positive
Candidate 180,000 tokens (exactly p90, operator >=). Result: ACTIVE, 1 finding.

## near misses (each changes exactly ONE parameter from positive)
- `near-miss-count` -> G11_MIN_COMPARISON_WORK_ITEMS (>= 20): the TOP baseline item 19 (200k tokens, `g11-b19`) removed entirely (19 items). p90 of the 19 left (ceil(17.1) = 18th smallest) is still 180,000, so the candidate still meets p90 and share; only the count blocks. Fallback to sessions also has 19 (< 20). Silent. (Rebuilt for DH F1: the first version removed item 0, which raised p90 to 190,000 and let the 20 -> 19 mutant survive.)
- `near-miss-window` -> G11_TRAILING_COMPARISON_DAYS (90): baseline item 0's terminal time and its two turns moved from NOW-90d+2h to NOW-90d-1h (turns 3h/2h before it), i.e. just outside the window. Count in window = 19, sessions in window = 19. Silent. Card gives no inclusivity rule for the edge, so it sits 1h outside rather than on the edge.
- `near-miss-p90` -> p90 of baseline tokens (>=): candidate tokens 179,999 (one below p90 180,000). Spend share still ~7.9%. Silent.
- `near-miss-share` -> G11_MIN_PCT_OF_90D_SPEND (>= 1%): an unlinked filler session `g11-filler` (2026-12-01) of 15,720,001 output tokens is added. Output price is linear (15 u/token), so total workspace tokens = 18,000,001 vs candidate 180,000 -> share just under 1% (180,000 / 18,000,001). Control: filler 15,719,999 (one unit past) fires (checked once with a scratch variant, not committed). The filler is not linked to any work item and does not alter baseline count or p90. Silent.

Not targeted: G11_AVOIDANCE_FRACTION (multiplier, affects $ only); 7-day window edge and outcome type (not named thresholds).

## Results (vitest `-t "G11 "`)
- G11 positive: pass (ACTIVE, 1 finding: "1 high-spend observed failure work item(s)")
- 4 near misses: pass (INACTIVE, 0 findings: "no high-spend observed failure with a complete 90-day baseline" for all four; the note does not distinguish the reason, hence the share control above).
- Max JSONL line length < 200 chars; no fill tokens used.

## Mutants (not run unless noted)
- G11_MIN_COMPARISON_WORK_ITEMS 20 -> 19: `near-miss-count` RED (run 2026-10-13 after the F1 rebuild). (Raising to 21: positive RED.)
- G11_TRAILING_COMPARISON_DAYS 90 -> 91: `near-miss-window` RED (run 2026-10-13). Its 19 in-window items also raise p90 to 190,000, but only the oldest item can sit at the window edge, so it is left as is.
- p90 comparison `>=` -> `>`: positive RED (item equals p90). p90 rank shifted down one (ceil(0.9n)-1, p90 = 170,000): `near-miss-p90` RED.
- G11_MIN_PCT_OF_90D_SPEND 1 -> 0.99 (or lower): `near-miss-share` RED.
