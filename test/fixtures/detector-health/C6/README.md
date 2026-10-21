# C6 fixtures

Generator: scratch `gen.ts` using synth.ts builders. One session, one file `/fake/src/widget.ts`, a typed prompt, three main-chain assistant turns (settled), 2 Edit calls (one per turn, both successful), then a final text turn.

Positive: Edit 1 `alpha` -> `beta`; Edit 2 `beta` -> `alpha`. Card clauses met: same session, same file, main-chain settled turns, Edit 2's new text equals Edit 1's old text AND Edit 2's old text equals Edit 1's new text (a true A to B then B to A swap); both inside the 7-day window; 1 reversing edit meets "at least 1".

Near miss: constant "minimum reversal pairs" (1, at least 1). Positive = 1 reversing edit; near miss = 0 (one unit below). Only parameter changed: Edit 2's new text `alpha` -> `gamma` (B to C, not a revert). Everything else (file, turns, timestamps, Edit 1, Edit 2's old text) is identical.

The second threshold (wasted-turn avoidance 0.5) is ASSUMED and only scales $; it gates nothing, so no near miss.
