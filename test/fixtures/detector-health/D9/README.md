# D9 fixtures (FORK_SUBAGENT)

STATUS: positive FAILS in the harness (finding below). Near-miss passes only vacuously (silent for the wrong reason).

Generator: scratch `gen.ts` (synth.ts builders). One parent session `d9-parent` (2 main turns: input 1000, output 10000, cw5m 2000, sonnet-4-6) plus one subagent file `d9-parent/subagents/agent-d9fork.jsonl` (1 sidechain turn, input 10, output 10, cache read N) and `agent-d9fork.meta.json` `{"agentType":"fork","description":"synthetic fork"}`.

Positive: N = 2682 cache-read tokens. Card clauses: type exactly "fork"; fork has an in-window turn (count > 0); fork count >= 1; estimate = 2682 x cache-read price (~$0.0008) = 0.250x% of workspace window spend (~$0.322).
Near miss: constant `D9_MIN_PCT_OF_SPEND` (0.25, estimate pct >= 0.25 passes). Only N changed, 2682 -> 2681 (one token below). Boundary found by direct ingest + evaluate bisection (2681 silent, 2682 fires; spend includes the fork's own turn).

## Finding
D9 · positive · INACTIVE fired=0 note "no fork subagents in the time window" · the harness copies only `*.jsonl` (`scripts/lib/shift-corpus.ts` listJsonl), so `agent-d9fork.meta.json` (the only source of `subagent_meta.agent_type` I could find; `.meta.jsonl`, a parent Task tool_use `subagent_type`, and agentType/agentId fields on the subagent line were each tried and did NOT populate subagent_meta) never reaches ingest. Without the meta file no fork exists. With the meta file present (direct runBackscan on the unshifted dir) the positive fires ACTIVE with 1 finding, and the near miss is silent. Needs a harness change (copy `*.meta.json` in shiftCorpus) or a `subagent_meta` rows table; both outside my blast radius.

## Mutants (not run)
- D9_MIN_PCT_OF_SPEND 0.25: `>=` -> `>`; no case goes RED (neither sits exactly at 0.25%). Shift 0.25 -> 0.26: positive goes RED.
- D9_MIN_PCT_OF_SPEND 0.25 -> 0.24: near-miss goes RED.
- fork count >= 1 -> >= 2: positive goes RED.
