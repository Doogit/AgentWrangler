# B2 fixtures

Positive: golden `gs-b2-ttlgap` (unchanged). Card clauses met: collapse (creation 40000 >= 0.5 * 32500; reads 200 < 0.5 * 30000; later context >= 0.9 * prev); gap 2h05 > thread TTL 60 min (own 1h tier); avoidable = creation 40000 - base prefix (first-turn context, 32500) > 0.

Near miss: constant `D8_TTL_1H_GAP_MIN` (60 min, B2 fires only when `gap > TTL`).
Positive gap = 2h05m; near miss gap = exactly 60 min (2nd turn at 15:00:00, was 16:05:00). Gap equal to TTL is B1's, not B2's. Nothing else changed.
