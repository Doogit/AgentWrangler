# D10 fixtures

Generator: a scratch `gen.ts` (synth.ts builders). One session, 40 non-sidechain turns one minute apart. Every turn:
input 100 + cache read 19,900 = 20,000 context tokens (mean context = 20,000), output 20,000 tokens. The large output makes
total spend dominate, so the modelled saving stays far below gate (a) (0.5% of spend); only gate (b) can decide.
Rows file adds one `catalog_items` row: a standalone skill (`kind=skill`, no plugin) with no Skill tool call in the window, so it
is a candidate. Its `tokens` is the only parameter that differs between cases.

Positive: candidate tokens = 1000. Card clauses met: catalog row exists; one candidate (unused standalone skill); removable tokens
1000 > 0; gate (b) removable/mean context = 1000 / 20000 = 0.05 >= D10_MIN_CONTEXT_SHARE (0.05).

Near miss: constant `D10_MIN_CONTEXT_SHARE` (0.05, operator `>=`). Candidate tokens = 999 (one unit below 5% of 20,000 =
1000). Only `tokens` changed. Removable tokens still > 0 and gate (a) is off in both cases (spend is output-dominated), so the
silence comes from gate (b) alone.

Skipped near misses:
- `D10_MIN_PCT_OF_SPEND` (gate a): needs the exact spend and blended cache-read price to land on 0.5%; not buildable from the card
  alone without guessing the price, so no near miss is claimed.
- `removable tokens > 0`: at exactly 0 both gates fail trivially (0 >= 0.05 * mean is false), so a near miss would not
  distinguish `>` from `>=`; skipped.
