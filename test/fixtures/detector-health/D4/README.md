# D4 fixtures

Generator: synthetic, `assistant()` from `test/ingest/synth.ts` (scratch script, not committed). All turns are main-thread, no tool calls (so no Edit/Write: main-thread Opus turns are in scope). Opus model `claude-opus-4-6`. Parameters:
- A = Opus turns in session `d4-a`: the first 4 are lookup-shaped (input 1, cache read 49999 so context 50000, output 500), turns 5+ are not (context 10000, output 100). `t4Ctx` / `t4Out` set the context / output of the 4th shaped turn.
- B = non-lookup Opus turns in session `d4-b` (context 50000, output 501).
- F = output tokens of one Sonnet turn in session `d4-f` (spend dilution), 0 = none.
One turn per minute.

Positive: A=5, t4Ctx=50000, t4Out=500, B=0, F=0. Card clauses met: 5 in-scope Opus turns (>= D4_OPUS_MIN_TURNS 5, exactly at); session `d4-a` is an agent with 4 of 5 turns lookup-shaped, share 0.8 (>= D4_LOOKUP_TURN_SHARE, exactly at); shaped turns have context exactly 50000 (>= 50000) and output exactly 500 (<= 500); all 5 turns are in a lookup agent so fraction 1.0 (>= 0.4); Opus prices above Sonnet-5 so the saving is positive; all spend is these turns so the saving is far above 0.25% of spend.

Near misses, each changes ONE parameter from the positive:
- `D4_OPUS_MIN_TURNS` (5, `total >= 5`): A=4 (the non-shaped turn is dropped; the 4 shaped turns remain). Total 4, one below.
- `D4_MISMATCH_MIN_FRACTION` (0.4, `share >= 0.4`): B=8. Lookup turns 5 of 13 = 0.385, just under 0.4 (B=7 gives 0.417 and would pass). Agent B is not lookup-shaped (output 501).
- `D4_MISMATCH_MIN_CONTEXT_TOKENS` (50000, `context >= 50000`): t4Ctx=49999. The 4th turn stops being lookup-shaped, share 3/5 = 0.6 < 0.8, so agent A is no longer a lookup agent.
- `D4_MISMATCH_MAX_OUTPUT_TOKENS` (500, `output <= 500`): t4Out=501. Same effect: 3 of 5 shaped, agent A not a lookup agent.
- `D4_LOOKUP_TURN_SHARE` (0.8, `share >= 0.8`): A=6 (one more non-shaped turn). 4/6 = 0.667 < 0.8. Total Opus turns 6 >= 5 so the turn gate still passes.
- `D4_MIN_PCT_OF_SPEND` (0.25%): F=3,000,000 Sonnet output tokens added. The Opus saving is unchanged but falls below 0.25% of workspace 7-day spend. Calibrated by trial: F=1,000,000 still fires, F=3,000,000 is silent; the exact boundary was not located (needs a price table), so this one is "below", not "one unit".

Skipped: `D4_REALIZABLE_AVOIDANCE_FRACTION`, `D4_REDUCTION_FRACTION` (ASSUMED values, not gates). The positivity gate (Opus price above Sonnet) depends on prices, not on transcript parameters, so there is no near miss for it.

Note: the context and output near misses isolate their constant only through the share gate (a turn that stops being lookup-shaped drops the agent below 0.8); a mutant on either constant turns them RED.
