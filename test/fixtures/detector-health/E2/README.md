# E2 fixtures

Generator: one session `e2-run`, N main-thread turns on `claude-opus-4-6` (strong model), 60 s apart, each with one tool call (Bash, Read, Grep, Glob in rotation) plus its tool result, input 100, cache read 150000. Output tokens per turn is the parameter list.

Positive: outputs `[299, 299, 299]`. Card clauses met: 3 consecutive strong main turns (>= 3), every turn has a mechanical call, every output 299 < 300, all spend sits in the run so the net saving (run cost minus modelled Sonnet subagent cost on 30k base) is well over 1% of workspace spend.

Near miss `E2_MIN_RUN_TURNS` (3, `>=`): outputs `[299, 299]`. Only the run length changed (one turn removed); one unit below the minimum.

Near miss `E2_MAX_OUTPUT_TOKENS` (300, operator `output < 300`): outputs `[299, 299, 300]`. Only the third turn's output changed, 299 to exactly 300 (at the value, not below), so it ends the run and the run is 2 turns. Note this near miss is also short of E2_MIN_RUN_TURNS as a consequence; a run of 3 cannot be kept without a fourth turn, which would let the 4th-turn variant still fire.

Not covered: `E2_MIN_PCT_OF_SPEND` (1%). Sitting exactly at 1% needs added non-mechanical spend tuned to the modelled saving, which changes other clauses; skipped.
