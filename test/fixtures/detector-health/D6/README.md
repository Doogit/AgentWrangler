# D6 fixtures

Generator: one synthetic session per file (synth.ts builders): a typed prompt, turn 0 (cache write 5000, one `Read` tool_use), its tool_result of `resultBytes` ASCII bytes, then 20 later turns (output 200, cache reads 5500..15000). The tool_result belongs to an identified owner turn (turn 0) and has 20 later turns of carry, no compaction. All sessions of a case share one workspace (the dir name).
Parameters: `sessions`, `resultBytes`, `heavyOutput` (extra output tokens on one turn, spend padding). Every case differs from `positive` in exactly ONE parameter.

Positive: 3 sessions, 20000-byte results. Card clauses met: result_bytes 0 < 20000 <= 25600 (not A1), Read tool (not TaskOutput), owner turn present, excess 20000 - 10240 > 0 so it is priced and counts; 3 carrying sessions >= D6_MIN_SESSIONS; carry cost is well above 1% of the small workspace spend.

Near misses:
- `D6_EXCESS_FLOOR_BYTES` (10240, only bytes above it priced): resultBytes 10240 instead of 20000, i.e. exactly at the floor, zero excess, no session carries, so fewer than 3 carrying sessions. (The positive sits well past the floor, not 1 byte, so the 1% spend gate also holds there.)
- `D6_MIN_SESSIONS` (3, count >= 3): 2 sessions instead of 3, one below the gate. Per-result size and spend share unchanged.
- `A1_RESULT_BYTES_THRESHOLD` (25600, result_bytes <= 25600): resultBytes 25601 instead of 20000, one byte above the upper bound (belongs to A1), so nothing is bloated.
- `D6_MIN_PCT_OF_SPEND` (1%, carry pct >= 1): one turn of session 0 gets 600000 output tokens (about 9 USD at sonnet-4-6 output price) instead of 200, which pushes the carry cost (about 0.09 USD over 3 sessions) to roughly 1% of workspace spend. The exact pct was not read from the detector; the size was estimated from list prices, so it sits near, not provably at, the threshold. 3 carrying sessions still hold.

Skipped: the `result_bytes > 0` lower bound (a 0-byte result cannot be told apart from a missing result by transcript ingest) and `TaskOutput` 10240 (A2 split; needs a TaskOutput tool name, not targeted here).
