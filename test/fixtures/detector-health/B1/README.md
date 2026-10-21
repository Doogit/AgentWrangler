# B1 fixtures

Positive: golden `gs-b1-severe` (unchanged). Card clauses all met: prev reads 40000 > 0; creation 40000 >= 0.5 * prev context; reads 50 < 0.5 * 40000; later context >= 0.9 * prev; gap 30 s <= TTL (60 min, own 1h tier).

Near miss: constant `COLLAPSE_READ_FALL_SHARE` (0.5, operator `current reads < 0.5 * previous reads`).
Positive later-turn reads = 50; near miss = 20000 (exactly 0.5 * 40000, not strictly below). Only that value changed; every other collapse clause still holds.
