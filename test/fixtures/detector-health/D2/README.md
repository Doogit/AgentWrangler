# D2 fixtures

Generator: synthetic, `assistant()` from `test/ingest/synth.ts`. Parameters: sessions S, main-thread turns per session N, first-turn context A. Turn i has context A + 1000*i (input 1, cache read ctx-1, output 200), one turn per minute, sessions 3 h apart, no sidechain, no tool calls.

Positive: S=3, N=151, A=110000. Card clauses met: 3 sessions >= D2_MIN_QUALIFYING_SESSIONS (3); each has 151 > 150 settled main-thread turns; mean context 185000 > 180000; context grows, so the derived reduction gives a positive net saving that is far above 1% of the window spend (nearly all spend is cache reads of these sessions).

Near misses, each changes ONE parameter from the positive:
- `D2_TURN_COUNT_THRESHOLD` (150, `turns > 150`): N=150, exactly at the threshold, so no session qualifies. Mean context is 184500, still above 180000.
- `D2_AVG_CONTEXT_THRESHOLD` (180000, `avg > 180000`): A=105000, mean exactly 180000 (A + 1000*75), not strictly above. Turn count stays 151.
- `D2_MIN_QUALIFYING_SESSIONS` (3, `count >= 3`): S=2, one below. Both sessions still qualify individually.

Skipped: `D2_MIN_PCT_OF_SPEND` (1%). The saving share is driven by the same context growth that qualifies sessions; it cannot be pushed below 1% without changing other clauses.
