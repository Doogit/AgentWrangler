# D11 fixtures (TOOL_ERROR_RATE, workspace)

Generator: scratch `gen.ts` (synth.ts `assistant` / `userToolResult`). One session per case, one tool call per assistant turn
(main chain, non-sidechain). Params: `bashCalls`, `bashErrors`, `psCalls`, `psErrors`.
Bash errors: `is_error` + "Exit code 127 / bash: nosuchcmd: command not found". PowerShell errors: `is_error` +
"Exit code 1 / The term 'Get-NoSuchThing' is not recognized as the name of a cmdlet, ..." (both start with "Exit code N", so
they ran, and are shell-level failures). OK calls have no `is_error`. Sessions are reconciled by the backscan.

Positive: Bash 66 calls / 3 errors (rate 0.04545); PowerShell 50 calls / 1 error (rate 0.02). Meets: both shells >= D11_MIN_CALLS 50;
worse shell (Bash) errors 3 >= D11_MIN_HIGHER_ERRORS 3; ratio 0.04545 / 0.02 = 2.27 >= D11_RATE_RATIO 1.5.
Positive sits one unit past the call and error floors (Bash errors exactly 3, PS calls exactly 50).
The positive's 3 Bash errors name 3 different commands (nosuchcmd, missingtool, badbinary): 3 identical failures would be
a C7 cluster, which claims those turns first (C7@rcb-2 no longer skips Bash rows with no command family).

Near misses (each changes ONE parameter from the positive):
- `near-miss-calls-ps` (D11_MIN_CALLS, `>=` 50): psCalls 50 -> 49. PS rate 1/49 = 0.0204, ratio 2.22, errors 3 still met, so only the volume floor fails.
- `near-miss-calls-bash` (D11_MIN_CALLS): bashCalls 66 -> 49. Bash rate 3/49 = 0.0612, ratio 3.06, errors still 3; only Bash volume fails.
- `near-miss-errors` (D11_MIN_HIGHER_ERRORS, `>=` 3): bashErrors 3 -> 2. Bash rate 2/66 = 0.0303, ratio 1.52 still >= 1.5; calls still met, so only the error floor fails.
- `near-miss-ratio` (D11_RATE_RATIO, `>=` 1.5): bashCalls 66 -> 101. Bash rate 3/101 = 0.0297, ratio 1.485 < 1.5. Errors 3 and calls met. Not a one-unit
  step: with integer calls and a PS rate of 1/50, the adjacent value bashCalls 100 gives a ratio of exactly 1.5 (would fire under `>=`, and risks float
  equality), so 101 is the first value strictly below. Positive (66) is well past it; the bracket is 66 (2.27) vs 101 (1.485).

Not covered: the zero-lower-rate rule (worse rate > 0 replaces the ratio test) and the "ties pick Bash" rule.

## Results (gate: `npx vitest run ... can-fire.test.ts -t "D11 "`)
5 passed (positive fires; 4 near misses silent). No findings. Max JSONL line 429 chars; total fixture 356 KB across 5 cases (~71 KB each).

## Read list
dh-contracts.md (Index + D11 card), synth.ts, detector-health/harness.ts, fixtures/detector-health/C1/{README.md,manifest.json,positive/c1-positive.jsonl head},
fixtures/ingest/gs-c7-bashfail (grep line), 001_observe.sql (grep line)

## Mutants (not run)
- D11_MIN_CALLS 50: `< 50` skips -> `< 49` (accept 49): near-miss-calls-ps and near-miss-calls-bash go RED.
- D11_MIN_HIGHER_ERRORS 3: `>= 3` -> `>= 2`: near-miss-errors goes RED.
- D11_RATE_RATIO 1.5: shift to 1.4 (or lower than 1.485): near-miss-ratio goes RED.
