# C1 fixtures

Generator: scratch `gen.ts` (synth.ts builders). One session, one tool call per assistant turn (main chain, non-sidechain).
Params: `editCalls`, `editErrors`, `readCalls`. Edit errors use `is_error` + "Patch failed to apply" (non-benign, not an
unread-file error). Reads are all OK (0 errors), so corpus errors = editErrors.

Positive: Edit 20 calls / 3 errors (rate 0.15); Read 21 calls / 0 errors. Corpus 41 calls / 3 errors (rate 0.0732), so
Edit rate is 2.05x corpus. Meets: corpus errors > 0; Edit calls 20 >= C1_MIN_TOOL_CALLS 20; Edit errors 3 >= C1_MIN_TOOL_ERRORS 3;
0.15 > 2 * 0.0732. Read is not an outlier (0 errors).

Near misses (each changes ONE parameter from the positive):
- `near-miss-calls` (C1_MIN_TOOL_CALLS, `>=` 20): editCalls 20 -> 19. Errors still 3; rate 0.158 vs corpus 3/40 = 0.075, still > 2x. One unit below.
- `near-miss-errors` (C1_MIN_TOOL_ERRORS, `>=` 3): editErrors 3 -> 2. Calls still 20; rate 0.10 vs corpus 2/41 = 0.049, ratio 2.05, still > 2x. One unit below.
- `near-miss-multiplier` (C1_BASELINE_MULTIPLIER, strict `>` 2x): readCalls 21 -> 20. Corpus 3/40 = 0.075; 2 * 0.075 = 0.15 = Edit rate 3/20. Exactly at the threshold, not strictly above. Calls 20 and errors 3 still met.
