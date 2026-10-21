# B4 fixtures

Positive: golden `gs-b4-prefix` (unchanged). Card clauses met: B1 collapse (creation 29000 >= 0.5 * 31200; reads 100 < 0.5 * 25000; later context >= 0.9 * prev); gap 2 min in [0, 5 min] and <= 5m-tier TTL; creation 29000 > 20000 and > 2 * 4000.

Near miss: constant `RAPID_CREATION_THRESHOLD` (20000, operator `creation > value`).
Positive later-turn creation = 29000; near miss = exactly 20000 (not strictly more). Compensation to keep it a valid B1 collapse (shrink guard 0.9): prev-turn cache reads lowered 25000 -> 18000. Ratio clause still holds (20000 > 2 * 4000), so only the creation threshold fails.
