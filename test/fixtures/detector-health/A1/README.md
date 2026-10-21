# A1 fixtures

Generator: scratch `gen.ts` using `test/ingest/synth.ts` builders. One session, one user prompt, one assistant turn with a `Read` tool_use, one user `tool_result` of N ASCII bytes (`"x".repeat(N)`), one closing assistant turn. Parameter: N only.

Positive: N = 25601. Card clauses met: result_bytes 25,601 > 25,600 (A1_RESULT_BYTES_THRESHOLD); valid whole-number size; linked to a session in a workspace; inside the trailing 7-day window (newest line lands at NOW - 1 day). No other gate.

Near miss: constant `A1_RESULT_BYTES_THRESHOLD` (25,600, operator `result_bytes > value`).
Positive N = 25601 (one past); near miss N = 25600 (exactly at, not strictly larger). Only N changed; every other clause (tool, session, window, workspace) still holds, so only the size clause can suppress it.

Other constants (A1_AVOIDANCE_FRACTION, ESTIMATOR_BYTES_PER_TOKEN) affect $ only, never firing; no near miss targets them.
