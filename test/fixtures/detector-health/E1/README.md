# E1 fixtures

Generator: scratch `gen.ts` using `test/ingest/synth.ts` builders. One session file per session; each session is one typed prompt, N `Read` turns (pre-edit), then one `Edit` turn (first edit). All turns main-thread, sonnet, identical tokens (in 100 / out 200 / cache read 5000), so each turn costs the same. Parameter: the list of pre-edit turn counts.

Positive: counts `[1,1,1,1,1,1,1,2]`. Card clauses met: 8 editing sessions >= E1_MIN_EDITING_SESSIONS (8); first edits fall inside the 7d window; p50 = 4th smallest = 1, p75 = 6th smallest = 1; the count-2 session is strictly above p75 so it is long; excess = 2 - p50 = 1 turn, about 1 of ~24 turns of workspace spend (~4%, >= 1%).

Near miss `E1_MIN_EDITING_SESSIONS` (8, operator `>=`): counts `[1,1,1,1,1,1,2]` (7 sessions, one below). Only the number of short sessions changed. p75 = 6th smallest = 1 so the count-2 session is still long and the cost share is still well over 1%, so only the session-count gate stops it.

Near miss `p75 pre-edit count` (operator `>`): counts `[1,1,1,1,1,1,1,1]`. Only the last session's count changed 2 -> 1, exactly equal to p75, so it is not strictly above and there are no long sessions. 8 sessions still hold.

Skipped: `E1_MIN_PCT_OF_SPEND` (1%). The share depends on computed turn cost, which this fixture cannot tune to exactly 1% without changing other clauses.
