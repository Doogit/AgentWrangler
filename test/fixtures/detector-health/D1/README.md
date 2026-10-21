# D1 fixtures

Generator: scratch `gen.ts` (synth.ts `assistant`). Each case = 1 session, 10 settled main-chain sonnet turns
(1 min apart), each with cache-read = CONTEXT, input/cw = 0, output = OUT, plus one `context_inventory` row
(workspace = case dir name, component CLAUDE_MD, tokens = S) in `rows-<case>.json`.

Positive (S=5000, CONTEXT=249000, OUT=0). Card clauses met: (1) 5000 > CLAUDE_MD target 2000; (2) eligible settled
turns in window, saving = 3000 x 10 x cache-read price x 0.5 > 0; (3) 5000 >= 0.02 x 249000 = 4980; (4) saving share
of 7-day spend ~0.60% >= 0.2 (spend is cache reads only; share ~= 0.5 x excess / CONTEXT).

Gates 3 and 4 only allow a one-unit excess when CONTEXT is tiny, and the share near miss then cannot be isolated, so the
positive uses S=5000 (not 2001) so every gate can be probed separately.

Near misses (each changes exactly ONE parameter from the positive):
- `near-miss-target` (D1_SOURCE_TARGETS.CLAUDE_MD, `>`): S 5000 -> 2000, exactly AT the target. Excess 0 so gate 1 fails.
- `near-miss-share` (D1_MIN_CONTEXT_SHARE, passes when >=): CONTEXT 249000 -> 251000. 5000 < 0.02 x 251000 = 5020 so gate 3
  fails. Gate 4 still holds (~0.60%), so this isolates the share clause. Not exactly at the boundary (avoids float
  equality at 0.02 x 250000).
- `near-miss-spend` (D1_MIN_PCT_OF_SPEND, passes when >=): OUT 0 -> 10200 per turn (adds output spend). Saving unchanged,
  spend per turn 74700 -> 227700 micro-USD, share ~0.1976% < 0.2. Gates 1-3 still hold.

Not covered: D1_SOURCE_TARGETS.MEMORY (1000). A MEMORY-only near miss needs the CLAUDE_MD row removed or silenced,
which changes more than one parameter of this generator. D1_TRIM_TO_TARGET_FRACTION is a multiplier, not a gate.

Caveat: the near-miss-target case is also silent via the zero-saving gate (2), so a `>` to `>=` flip on the target is an
equivalent mutant here.
