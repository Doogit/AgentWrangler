# D8 fixtures

- Positive: golden `gs-d8-churn5m` (3 turns each writing 60000 5m-tier tokens after a 10 min gap, reads 5000 < 0.2 x creation). Meets the card: gap > 5 min, read ratio < 0.2, count trigger D8_MIN_EVENTS 3.
- Near miss: same file, gaps changed 10 min to exactly 5 min. Constant `D8_TTL_5M_GAP_MIN` (gap > 5): positive gap 10, near miss gap 5 (exactly at the threshold, so no churn event).
