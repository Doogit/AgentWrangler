# Getting started

AgentWrangler is a local daemon plus a browser dashboard. This page covers every install path,
the optional integrations, configuration, and troubleshooting.

**Requirements:** Node **`>=22 <25`** and npm. That's all — the database is embedded SQLite.

## Install

### From npm (recommended)

```sh
npx agentwrangler@latest
```

Runs the prebuilt daemon and UI straight from the registry — no clone, no build. Or install
globally:

```sh
npm install -g agentwrangler
agentwrangler
```

### From source

```sh
git clone https://github.com/Doogit/AgentWrangler && cd AgentWrangler
npm ci                 # installs deps and builds daemon + UI (prepare script)
npm run daemon         # starts the daemon and opens your browser
```

`npx agentwrangler` from inside the clone also works after `npm ci`.

## First launch

The daemon binds `http://127.0.0.1:47821` immediately and serves a loading page, then scans
your `~/.claude/projects/**/*.jsonl` transcripts in the background. The dashboard appears
right away and fills in as the scan completes — a large history won't block the page.

The browser opens automatically; set `AW_NO_OPEN=1` to suppress that.

An onboarding checklist on the Overview tab walks you through the three activation steps:
calibrate your weekly limit, add a GitHub token for outcomes, and install the context-budget
guard.

## Optional setup

### GitHub outcomes sync

Links sessions to the pull requests and commits they produced, powering the Workspaces
outcome columns (success rate, cost-per-merged-PR).

- Create a **read-only** GitHub personal access token.
- Provide it via the `AW_GITHUB_TOKEN` environment variable (all platforms), or on Windows
  store it in Credential Manager as a *Generic* credential named `AgentWrangler-GithubToken`.

Without a token the feature stays inert and Settings tells you so — nothing fails silently.
The token is read locally, never logged, never written to the database; Settings shows only
whether one is present.

### Weekly limit calibration

Settings → **Calibrate from usage** derives your weekly token limit from your live Claude Code
utilization and auto-saves it — this turns on the burn forecast on the Overview tab. A manual
override field exists if calibration is unavailable. The usage reader uses your existing
Claude Code sign-in locally; Settings shows its status.

### In-session guardrails

Five hooks that surface warnings inside Claude Code itself (see the
[README guardrails table](../README.md#installable-guardrails--warnings-inside-claude-code-before-the-waste)).
Install them from Settings → **In-session guards** — either "Install directly" (writes
`~/.claude/settings.json` for you) or "Copy install prompt" (a prompt Claude Code applies
itself). Thresholds (warn %, loop window, idle cutoff) are tunable in the same panel, and
every hook has a matching uninstall.

## Configuration

All environment variables are optional; sensible defaults apply. See
[`.env.example`](../.env.example) for the authoritative list.

| Variable | Purpose | Default |
|---|---|---|
| `AW_PORT` | Daemon HTTP port | `47821` |
| `AW_DB_PATH` | SQLite database path | `~/.agentwrangler/db.sqlite` |
| `AW_SCAN_ROOT` | Transcript corpus to scan | `~/.claude/projects` |
| `AW_UI_ROOT` | Directory the built UI is served from | `<package>/dist/ui` |
| `AW_GITHUB_TOKEN` | Read-only GitHub PAT for outcomes sync | *(unset)* |
| `AW_NO_OPEN` | Set to `1` to not auto-open the browser | *(unset)* |

Scan roots and the activity window are also editable from the Settings tab at runtime.

## Troubleshooting

- **Blank page or 503 after updating** — the daemon loads code once at boot and never
  hot-reloads. Restart it after an update (`Ctrl+C`, then relaunch).
- **Port already in use** — another daemon instance is running, or set `AW_PORT` to move.
- **"Local daemon unavailable" screen** — the UI can't reach `127.0.0.1:47821`; start the
  daemon and hit *Retry connection*.
- **Node version errors** — the engine range is `>=22 <25`; `node --version` to check.
- **Outcomes columns empty** — no GitHub token configured, or the token lacks read access to
  the repos in question. Settings → Outcomes sync shows the current status.
- **Numbers look low right after install** — the background scan may still be running; the
  footer shows last-ingest status.

## Uninstall

- Stop the daemon (`Ctrl+C`).
- Remove the data: delete `~/.agentwrangler/`.
- If you installed guardrail hooks, remove them first from Settings → In-session guards
  ("Uninstall directly"), or via `npm run uninstall-hook` from a source checkout.
- `npm uninstall -g agentwrangler` if globally installed.
