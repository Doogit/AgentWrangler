# B3 fixtures

Generator: scratchpad `gen.ts` (synth.ts `assistant()` builders). Every case = workspace of 3 sessions, 5 turns, all `claude-sonnet-4-6`, 1h-tier writes only:
- Z (earlier session): first turn writes 5000; last turn reads 5000. Gives the base prefix a second small first-turn context.
- P (previous session): first turn writes `X`; last turn reads `R` (context = R, no writes, no input).
- N (new session): one turn at P-last + `gapMs`, writes `C`, reads `newReads`.

Positive: `X=5000 R=20001 C=20001 newReads=10000 gapMs=3600000`. Card clauses met: N first turn directly follows P last (consecutive in workspace); ratio C/R = 1.0 in [0.8, 1.25]; reads 10000 <= 0.5 * 20001 (10000.5); C 20001 > 20000; gap 60 min = TTL (P wrote none, so N's 1h tier -> 60 min), `gap <= TTL`; base prefix = median first-turn context of (Z 5000, P 5000, N 30001) = 5000, avoidable 15001 > 0; N is the newest turn (1 day before NOW, in window); event floor: unknown/negligible other spend, the event dominates window spend. Z->P is not an event (P's creation 5000 <= 20000).

Near misses (each changes ONE parameter from the positive unless noted):
- `near-miss-creation` (`B3_CACHE_CREATION_THRESHOLD`, creation > 20000): C=20000, exactly AT the value. R also set to 20000 so the ratio stays 1.0 (the ratio is the clause that would otherwise break). newReads 10000 still <= 0.5*20000.
- `near-miss-ratio-low` (`RESUME_CONTEXT_MATCH` low, share >= 0.8): R=25002 -> 20001/25002 = 0.79998. R=25001 would still give 0.80002, so 25002 is the first value below.
- `near-miss-ratio-high` (`RESUME_CONTEXT_MATCH` high, share <= 1.25): R=16000 -> 20001/16000 = 1.25006. R=16001 would give 1.24998, so 16000 is the first value above. (Only R changes; C is held so the 20000 threshold is untouched.)
- `near-miss-read-fall` (`COLLAPSE_READ_FALL_SHARE`, reads <= 0.5 * prev, inclusive): newReads=10001 > 10000.5, one unit above. Positive sits at 10000, one unit inside.
- `near-miss-ttl` (previous session TTL 60 min, gap <= TTL): gapMs=3600001, 1 ms past. Positive is exactly at 3600000 (inclusive).
- `near-miss-avoidable` (avoidable tokens > 0): X=20001 makes the median first-turn context (5000, 20001, 30001) = 20001 = C, so avoidable = 0 (strict). Z->P is still not an event (ratio 20001/5000 = 4).

Not covered:
- Gap lower bound (gap >= 0): a negative gap contradicts adjacency (new session would start before the previous one ended), so it cannot be built without changing the adjacency clause.
- EVENT_FLOOR_PCT (0.1 percent): would need an extra high-spend turn and the exact pricing to sit one unit below the floor; skipped as not constructible exactly without reading the detector/pricing code.
- B3_AVOIDANCE_FRACTION: $ only, not a trigger.

## Results (gate: `can-fire.test.ts -t "B3 "`)
7 passed (positive + 6 near misses silent). No findings.

## Mutants (not run)
- `B3_CACHE_CREATION_THRESHOLD` 20000: flip `>` to `>=` -> `near-miss-creation` goes RED. Shift to 20001 (`> 20001`) -> `positive` goes RED.
- `RESUME_CONTEXT_MATCH` low 0.8: shift to 0.79999 or flip to a looser bound -> `near-miss-ratio-low` goes RED. Tighten to `> 0.8`: no case at exactly 0.8, so not caught.
- `RESUME_CONTEXT_MATCH` high 1.25: shift to 1.2501 -> `near-miss-ratio-high` goes RED.
- `COLLAPSE_READ_FALL_SHARE` 0.5: flip `<=` to `<`: no case exactly at the bound (10000.5); shift to 0.5001 -> `near-miss-read-fall` RED (10001/20001 = 0.50002 <= 0.5001).
- Gap/TTL: flip `gap <= TTL` to `gap < TTL` -> `positive` goes RED; shift TTL +1 ms -> `near-miss-ttl` goes RED.
- Avoidable: flip `> 0` to `>= 0` -> `near-miss-avoidable` goes RED.

## Read list
docs/plans/dh-contracts.md (Index, B3 card); test/ingest/synth.ts; test/detector-health/{manifest,harness,can-fire.test}.ts; test/fixtures/detector-health/B1/{README.md,manifest.json}. Max JSONL line length < 1000 (checked).
