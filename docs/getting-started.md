# Getting started

AgentWrangler is a local daemon plus a browser dashboard. This page covers every install path,
the optional integrations, configuration, and troubleshooting.

**Requirements:** Node **`>=22 <25`** and npm. That's all for local analysis — the database is embedded SQLite. Optional GitHub outcomes sync also requires the `gh` executable on your `PATH`.

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

The npm CLI is distributed with compiled daemon/UI assets. From a source checkout, use the
commands above; `npx agentwrangler@latest` installs and runs the packaged release, while
`npm run daemon` runs the source checkout after its build.

## First launch

The daemon binds `http://127.0.0.1:47821` immediately and serves a loading page, then scans
your `~/.claude/projects/**/*.jsonl` transcripts in the background. The dashboard appears
right away and fills in as the scan completes — a large history won't block the page.

The browser opens automatically; set `AW_NO_OPEN=1` to suppress that.

An onboarding checklist on the Overview tab starts with reading an ingested session. A healthy
history with no recommendations can still complete onboarding. Calibration, GitHub outcomes,
and guard installation are optional follow-up steps.

## Optional setup

### GitHub outcomes sync

Links sessions to the pull requests and commits they produced, powering the Workspaces
outcome columns (success rate, cost-per-merged-PR).

- Create a **read-only** GitHub personal access token.
- Ensure the GitHub CLI (`gh`) is installed and available on `PATH`; AgentWrangler uses it for
  read-only `gh api` requests. You do not need to run `gh auth login`.
- Provide the token via the `AW_GITHUB_TOKEN` environment variable (all platforms), or on Windows
  store it in Credential Manager as a *Generic* credential named `AgentWrangler-GithubToken`.

PowerShell:

```powershell
$env:AW_GITHUB_TOKEN = "github_pat_REPLACE_WITH_READ_ONLY_TOKEN"
```

POSIX shells (macOS/Linux):

```sh
export AW_GITHUB_TOKEN='github_pat_REPLACE_WITH_READ_ONLY_TOKEN'
```

Without a token the feature stays inert and Settings tells you so — nothing fails silently.
The token is read locally, never logged, never written to the database; Settings shows only
whether one is present.

### Weekly limit calibration

Settings → **Calibrate from usage** derives your weekly token limit from your live Claude Code
utilization and auto-saves it — this turns on the burn forecast on the Overview tab. A manual
override field exists if calibration is unavailable. The usage reader uses your existing
Claude Code sign-in to call Anthropic's OAuth usage endpoint; Settings shows its status. It reads
usage and does not upload transcript text.

### In-session guardrails

Settings offers five local hooks (see the [README guardrails table](../README.md#installable-guardrails--local-checks-inside-claude-code-before-the-waste)).
**Install directly** writes all five to `~/.claude/settings.json`: context-budget, loop, burn,
dangerous-command, and PreCompact checkpoint. It backs up an existing settings file and keeps up to five backups. **Copy install prompt** installs only context-budget, loop, and burn. Context-budget
and burn warn; loop can deny repeated identical failures; the direct-only dangerous-command guard
can ask or deny. Direct uninstall removes all AgentWrangler hooks; the copied uninstall prompt
removes only its three hooks. The direct-only PreCompact hook can copy raw transcript JSONL to
`~/.agentwrangler/checkpoints/`; see [Privacy](privacy.md#raw-transcript-checkpoint-copies) for
its retention and cleanup.

## Configuration

All environment variables are optional; sensible defaults apply. See
[`.env.example`](../.env.example) for the authoritative list.

| Variable | Purpose | Default |
|---|---|---|
| `AW_PORT` | Daemon HTTP port | `47821` |
| `AW_DB_PATH` | SQLite database path | `~/.agentwrangler/db.sqlite` |
| `AW_SCAN_ROOT` | Transcript directory to scan | `~/.claude/projects` |
| `AW_UI_ROOT` | Directory the built UI is served from | `<package>/dist/ui` |
| `AW_GITHUB_TOKEN` | Read-only GitHub PAT for outcomes sync | *(unset)* |
| `AW_NO_OPEN` | Set to `1` to not auto-open the browser | *(unset)* |

Scan roots and the activity window are editable in Settings. Saved scan roots take effect after restarting the daemon.

## Update and restart

Stop the running daemon before updating or starting it again; do not launch a second daemon on the same port.

For an npm install, update the package and restart the daemon:

```sh
npm install -g agentwrangler@latest
agentwrangler
```

For a source checkout, pull the desired revision, reinstall/build, then restart:

```sh
git pull
npm ci
npm run build
npm run daemon
```

The daemon loads source and built UI once at boot, so editing or updating files requires a
restart. `npm run build:ui` is sufficient after UI-only edits; `npm run build` covers daemon and
UI changes.

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

- While the dashboard is running, open [Settings → In-session guards](http://127.0.0.1:47821/#/settings?section=in-session-guards) and remove installed AgentWrangler hooks (or use the copied uninstall prompt).
- Stop the daemon (`Ctrl+C`).
- Remove the package: `npm uninstall -g agentwrangler` if globally installed. For a source
  checkout, remove the checkout when it is no longer needed.
- Optionally remove local data by deleting `~/.agentwrangler/`. This includes the SQLite database
  and settings. Raw PreCompact checkpoint copies under
  `~/.agentwrangler/checkpoints/` are not removed by uninstalling. Checkpoint files remain subject to the
  [checkpoint retention policy](privacy.md#raw-transcript-checkpoint-copies).
