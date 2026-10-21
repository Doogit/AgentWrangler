# D5 fixtures

Rows-only cases (no transcripts): snapshot path of the card (limit_snapshots). Authored by hand as JSON; no generator script.
A `user_config` row `dh_anchor` (updated_at = anchor) carries the harness time shift, so the newest snapshot can sit 48 h old.
Shift = 0: anchor 2027-01-07T00:00Z = NOW - 1 day. NOW = 2027-01-08T00:00Z.

Positive (`positive.rows.json`), card clauses all met at the boundary:
- latest reading 2027-01-06T00:00Z, used 40, reset 2027-01-08T12:00Z (future), age exactly 48 h (not > 48 h, so usable);
- reference reading exactly 24 h earlier (the pace window, PACE_WINDOW_MS), same reset week, used 22, so pace = 0.75 %/h;
- projection = 40 + 0.75 x 60 h (hours from the reading to the reset, as the detector reports) = 85 = WARN_PROJECTED_PCT (>= 85 fires).
Result: ACTIVE, 1 finding ("projected at 85%").

Near misses:
- `near-miss-warn` / WARN_PROJECTED_PCT: reference used 22 -> 22.4, pace 0.7333 %/h, projection 84, one unit below 85. Silent (INACTIVE).
- `near-miss-age` / SNAPSHOT_MAX_AGE_MS: both readings shifted 1 s earlier, age 48 h + 1 s (> 48 h), no usable snapshot, no token limit, no turns -> BLOCKED. Inverse direction (operator `>` disables): the positive sits AT 48 h.
- `near-miss-gap` / PACE_WINDOW_MS (REL-FIX pace; this was the old positive): a 3 h burst, 37.75 -> 40. The day's start is read between the reset (0 %) and the 21:00 reading by time (no turns): 37.75 x 84/105 = 30.2, pace 9.8 / 24 h, projection ~64.5, silent. The old 3 h-minimum-gap rule read the burst as the day's pace and fired at 85.

## Mutants (not run)
- WARN_PROJECTED_PCT 85 -> 85.01 (or `>=` to `>`): positive RED. 85 -> 84: near-miss-warn RED.
- SNAPSHOT_MAX_AGE 48 h `>` -> `>=`: positive RED. Limit raised to 49 h: near-miss-age RED.
- PACE_WINDOW 24 h -> 3 h: near-miss-gap RED.

## Read list
dh-contracts.md (Index, D5 card), harness.ts, manifest.ts, D10/manifest.json, D10/positive.rows.json, B1/README.md, migrations 042 and 001 (DDL grep).

## Not covered (named, with reason)
- MIN_ELAPSED_FOR_AVERAGE_MS, the local-burn split of the pace start, EXCEED_PROJECTED_PCT, token-limit and degraded paths: one positive can sit at only one of MIN/MAX gap; the rest need separate positives (manifest allows one).
