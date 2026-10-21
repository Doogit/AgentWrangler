# A2 fixtures

Generator: scratch `gen.cjs` (hand-built JSON lines in the `test/ingest/synth.ts` shape). One session, one typed prompt, one assistant turn with a `TaskOutput` tool_use, one user `tool_result` of N ASCII bytes (`<<fill:N>>`), one closing assistant turn. Both assistant turns are main-chain, reconciled, tiny usage (input 10, output 1, no cache). Parameters: N (result bytes) and S (extra input tokens on the first turn, spend only).

Positive: N = 10241, S = 0. Card clauses met: (1) TaskOutput result 10,241 > 10,240 (A2_TASK_OUTPUT_BYTES_THRESHOLD); (2) owned by a main-chain reconciled turn; (3) 10,241 <= 25,600 so it is priced, and spend is tiny so carry cost % >= 0.1 (A2_MIN_PCT_OF_SPEND); inside the 7-day window.

Near misses (each from the same generator, ONE parameter changed):
- `near-miss-bytes` (A2_TASK_OUTPUT_BYTES_THRESHOLD, `>`): N = 10240, exactly at the value, not strictly larger. Nothing else changed.
- `near-miss-a1` (A1_RESULT_BYTES_THRESHOLD, results > 25,600 excluded from pricing): N = 25601, one past the exclusion. It is selected by clause 1 but has zero carry cost, so the % gate fails. Nothing else changed.
- `near-miss-pct` (A2_MIN_PCT_OF_SPEND, fires when >= 0.1): S = 100,000,000 extra input tokens on the first turn, so the same 10,241-byte result's carry cost is far below 0.1% of spend. Not placed exactly one unit below the threshold: pricing is continuous and the exact boundary cannot be hit without reading the detector; it is a clear-below case. Nothing else changed.

A2_AVOIDANCE_FRACTION affects $ only; no near miss targets it.

## Results (vitest -t "A2 ")
All 4 cases pass: positive fires; the three near misses stay silent. (4 passed, 65 skipped.)

## Mutants (not run)
- A2_TASK_OUTPUT_BYTES_THRESHOLD: flip `>` to `>=` (or shift 10240 -> 10239): `near-miss-bytes` goes RED.
- A1_RESULT_BYTES_THRESHOLD: flip exclusion `>` to `>=` (25600 -> 25599) wouldn't affect us; instead shift to 25602 or remove the exclusion: `near-miss-a1` goes RED.
- A2_MIN_PCT_OF_SPEND: lower 0.1 to 0 / remove the gate: `near-miss-pct` goes RED.
