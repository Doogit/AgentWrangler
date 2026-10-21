# Claude Code prefix canary

This orchestrator-only probe measures spec C1 (a): the real first assistant turn prefix for a short Claude Code session and the change after loading a 300-line `MEMORY.md`. It reports the input, cache-read, and cache-creation token counts as one prefix. The subagent's memory delta compares a subagent run with the sentinel against one without it (a subagent has its own system prompt and tools, so it is never compared with the main-thread baseline).

`bytes4EstimateWithCap` and `bytes4EstimateWithoutCap` are rough file-size estimates, **not expected Claude token counts**. `expectedDelta` and `subagentCarriesMemory` remain `null`: a single before/after prefix difference cannot isolate source tokenization from other prompt changes. Establish an expected count with a model-specific count of the actual loaded message structure, then check repeated controlled pairs against that count before claiming C1(c) passes. Anthropic's [token counting API](https://platform.claude.com/docs/en/build-with-claude/token-counting) accepts structured messages, but sending private user files to it would change AgentWrangler's local-only product path; use synthetic content only for external research. Anthropic's [archived local tokenizer](https://github.com/anthropics/anthropic-tokenizer-typescript) explicitly says it is inaccurate for Claude 3 and newer models.

Run from the repository root:

```sh
node scripts/parity/canary.mjs --dry-run
node scripts/parity/canary.mjs
node scripts/parity/canary.mjs --claude <path-to-claude-binary> --out path/to/canary.json
```

Pass `--claude` when more than one Claude Code install is on the machine: on Windows a non-shell spawn of `claude` can pick up a different `claude.exe` than your shell does. Check that `claudeVersion` in the output is the version you actually use.

The real run costs four short `claude -p` sessions and writes session records under `~/.claude/projects/`. It removes its temporary project and sentinel memory directory, while leaving session records. Re-run when the installed Claude Code version changes. The default result is `.claude/audits/certification/canary-<version>.json`.

For C1(d), scope the baseline to the measured Claude Code version **and** session tool configuration. The D1 contract source for the measured value is **CANARY**. A single global baseline can false-fail sessions run with fewer tool schemas: in the P1 evidence, the default-config adjusted baseline was 37,766 and the `--strict-mcp-config` adjusted baseline was 35,582. Never choose a baseline by looking at a session's observed prefix.

Create a local, uncommitted `cohorts.json` from independent launch/configuration records and matching canary measurements. List only sessions whose Claude Code version and effective tool configuration are known. The values below are a schema example, not current certification evidence:

```json
{
  "cohorts": [
    {
      "claudeVersion": "<measured version>",
      "toolConfig": "<exact configuration label>",
      "baseline": 35582,
      "sessions": ["<locally verified session id>"]
    }
  ]
}
```

Run `prefix-oracle.ts --db <db> --d-evidence <cohorts.json> --since <ISO> --measured <source-pairs.json>`. Duplicate or malformed cohort assignments are rejected. Sessions without a verified assignment report C1(d) `UNPROVEN` and make the CLI exit 3 when no check fails; they are never implicitly assigned the smallest known baseline. Keep session IDs and local configuration records out of commits.

The old `--baseline <tokens>` CLI argument is retired. It cannot establish a session's version or tool configuration and is rejected by the CLI. Migrate existing commands to `--d-evidence`; omitting it leaves C1(d) unproven.

For certification after a source edit: re-measure the loaded sources with the matching Claude Code version/model, restart the daemon so its boot probe records the new counts, then run the oracle on fresh first turns with verified cohort assignments. A prior measurement or a healthy running daemon alone does not establish freshness.

## Controlled source pairs (C1 token counts)

`source-pairs.mjs` measures synthetic sources with an A/A control: each content once as the prompt message (content-only Claude tokens), as project `CLAUDE.md`, and as `MEMORY.md`. It uses `--no-session-persistence`, so it leaves no session records, and removes its temporary project and memory directory. It costs 18 short `claude -p` sessions.

```sh
node scripts/parity/source-pairs.mjs --dry-run
node scripts/parity/source-pairs.mjs --out .claude/audits/certification/p1f/source-pairs-<version>.json
```

Pass the result to `prefix-oracle.ts --measured <file>`. C1(b) then compares a claim with the measured count for the same loaded content (matched by SHA-1). Without a measured count, bytes/4 agreement is only a consistency check: the oracle reports `UNPROVEN` and exits 3, never 0. Only synthetic content has measured counts; this tool has no mode for real user files.
