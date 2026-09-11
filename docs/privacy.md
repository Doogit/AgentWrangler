# Privacy model

AgentWrangler keeps its dashboard data local. Most stored data is aggregates and structural metadata, but the database is not a sanitized export: it still contains filesystem paths and sensitive local metadata, and pre-upgrade databases and backups can contain local command text. The direct-install PreCompact hook can additionally copy full raw transcripts as described below.

## Local-only service boundary

- The daemon binds to **`127.0.0.1`** only. The dashboard talks exclusively to that loopback address. There is no cloud backend, telemetry, or account.
- Dashboard data lives in local SQLite at `~/.agentwrangler/db.sqlite`. Removing that file (or the `~/.agentwrangler/` directory) removes the database and its local settings.
- The daemon reads the transcripts Claude Code already writes to `~/.claude/projects`; it adds no network instrumentation to sessions.

## What SQLite and the dashboard store

SQLite stores aggregate token counts by flavor and model, timestamps, session and workspace ids, turn counts, detector measurements (byte counts, event counts, shares), PR and commit identifiers and states, and file-position anchors used to resume ingestion. The dashboard renders that local aggregate data.

Ingestion also retains filesystem paths and local command markers. Command marker rows retain only exact `/compact`, exact `/clear`, or an unclassified event with no command text; any other command and all arguments are discarded before storage, and a database migration clears legacy raw values and blocks new ones. Limits of that guarantee: it is logical sanitation, not physical erasure — old values may persist in databases or backups made before the upgrade, in WAL frames or free pages, and in raw transcripts or checkpoint copies; and the stable command-derived event IDs are unkeyed, so a party who knows the session and time can test guessed commands against them. The `input_hash` column name does not mean every value is hashed. Treat the database and backups as sensitive local data, and do not share raw dumps. Calibration samples are separately held in memory and discarded after the request. The optional GitHub token is read at use time from the environment or Windows Credential Manager; it is not logged or written to SQLite. Screenshots and the demo GIF in this repository use sanitized fixtures, never live data.

## Raw transcript checkpoint copies

The **PreCompact checkpoint hook** is an optional exception. It is installed only by Settings' **Install directly** action (the copied install prompt does not add it). On Claude Code's `PreCompact` event, it copies the referenced local JSONL transcript to `~/.agentwrangler/checkpoints/`. Set `AW_CHECKPOINT_DIR` to choose another local directory.

Each checkpoint filename contains an encoded session id and timestamp. The hook attempts local owner-only permissions (`0600`; Windows access is governed by the user's ACL), does not display the copied content, and does not send it over the network. It retains at most 20 checkpoint files and 500 MiB in that directory, pruning files after a new copy when either cap is exceeded. Delete the checkpoint files or `~/.agentwrangler/` to remove them. A manual `/compact` may not emit this hook event, so it is not a guarantee that every compaction has a checkpoint.

## Network integrations and their triggers

The product has no cloud service, but these optional or credential-backed features can make outbound requests:

| Integration | When it can make a request | Boundary and control |
|---|---|---|
| Claude usage reader | Dashboard rate-limit refreshes, installed burn-alert hook checks, and **Calibrate from usage** | Calls Anthropic's OAuth usage endpoint with the existing local Claude Code sign-in. It reads usage; it does not upload transcript text. |
| GitHub outcomes sync | At daemon startup and then on its scheduled outcomes pass | It is disabled with no GitHub token, making zero GitHub requests. With `AW_GITHUB_TOKEN` or the Windows credential present, it reads GitHub PR, commit, check, and diff metadata. |
| Bytes-to-token calibration | When `bytes_per_token_calibration_enabled` is enabled and the ratio is absent or at least 30 days old | The daemon attempts it after boot and weekly; a manual calibration can also start it. It sends sampled tool-output text to Anthropic's token-count endpoint. Samples are held in memory; only the numeric ratio and provenance are stored locally. |
| G2 deferral judge | Only when running `npm run evidence:judge-g2 -- --execute` with `g2_claude_judge_opt_in` enabled and a valid seed | Sends the blinded evidence packet to Claude using an API key when configured, otherwise Claude Code OAuth. An invalid seed sends nothing; judge rationale text is not persisted. |

## In-session guardrails

Direct install writes all five hooks to `~/.claude/settings.json`: context-budget, loop guard, burn alert, dangerous-command guard, and PreCompact checkpoint. It backs up an existing settings file alongside it and retains up to five backups; a first install without a settings file has nothing to back up. The copied install prompt writes only the three `PreToolUse` hooks: context-budget, loop guard, and burn alert.

Context-budget and burn alerts use `allow` while warning. The loop guard warns first and can return `deny` for repeated identical failures. The dangerous-command guard, scoped to Bash, can return `ask` for risky commands and `deny` for a small catastrophe list. The direct uninstall removes every AgentWrangler hook; the copied uninstall prompt removes only its three hooks.

## Threat model and reporting

The daemon is reachable from other machines only if you deliberately expose the port (tunnel or reverse proxy). Do not expose it. For the full threat model and private reporting instructions, see [SECURITY.md](../.github/SECURITY.md).
