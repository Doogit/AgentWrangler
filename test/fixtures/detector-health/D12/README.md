# D12 fixtures (SUBAGENT_OVERSPAWN) — positive does NOT pass; blocked on harness

Generator (synth.ts builders, scratchpad `gen.ts`): per session `<ws>/<session>.jsonl` = typed prompt, main turn 0 (cache write 5000, one `Agent` tool_use), its tool_result, 10 later main turns (output 200, cache reads 6000..15000) for parent-chain carry. Plus `<session>/subagents/agent-<id>.jsonl` with two sidechain turns (last turn output = `subOutput`) and `agent-<id>.meta.json` (`toolUseId` = the Agent call id). Parameters: `sessions`, `subOutput`. Workspace = dir name.

Positive: 3 sessions, `subOutput` 5000 tokens (above 10240 bytes at any bytes-per-token >= 2.05), main-thread Agent call with linked subagent, 3 sessions >= D12_MIN_SIDECHAIN_SESSIONS.

Near miss `D12_MIN_SIDECHAIN_SESSIONS` (3, >=): 2 sessions instead of 3, nothing else changed.

Skipped (not built): `D12_MIN_RETURN_BYTES` (needs the estimator bytes-per-token default, which the card does not state; cannot place a return exactly at 10240) and `D12_MIN_PCT_OF_SPEND` (cannot be sized without the carry price formula; unreachable until the positive fires).

## Result: positive FAILS

`D12 positive: expected fires, got status=INACTIVE fired=0 note=no workspace met the sidechain return-volume, session-count and spend-share thresholds`. The near miss passes (silent) but is vacuous while the positive is red.

Cause (suspected, not proven): the card says the Agent call is linked to its subagent through `subagent_meta`. That table is filled from `agent-<id>.meta.json`, but the harness (`shiftCorpus`) copies only `*.jsonl`, and the `rows` mechanism does not allow `subagent_meta`. So no link can reach the DB. A `toolUseResult.agentId` hedge on the tool_result did not help. Fix needed in the harness (copy `*.meta.json`, or add `subagent_meta` to ROW_TABLES), then re-run unchanged.

Mutants (not run):
- D12_MIN_SIDECHAIN_SESSIONS 3 -> 2 (>= 2): `near-miss-sessions` should go RED (only once the positive fires).
- D12_MIN_SIDECHAIN_SESSIONS 3 -> 4: `positive` should go RED.
- D12_MIN_RETURN_BYTES 10240 -> 30000 bytes: `positive` should go RED.
