<p align="center">
  <img src="https://raw.githubusercontent.com/Doogit/AgentWrangler/main/docs/assets/logo.png" alt="AgentWrangler logo" width="200">
</p>

# AgentWrangler

See where your Claude Code tokens go, inspect costly sessions, and track whether a change helped.
AgentWrangler reads local Claude Code transcripts and serves a dashboard on your machine.
No account or cloud backend is required.

## Quick start

Requires **Node 22-24 and npm**, plus Claude Code transcripts for populated charts.

```sh
npx agentwrangler@latest
```

Open **http://127.0.0.1:2929** if the browser does not open automatically. Keep the terminal
running; press **Ctrl+C** to stop. The first scan runs in the background. An empty history is
valid: use Claude Code, then return after ingestion. If a daemon is already running, stop it
before starting another on the same port.

[Install from source, configure scan roots, or troubleshoot](https://github.com/Doogit/AgentWrangler/blob/main/docs/getting-started.md).

## Your first five minutes

1. **Check the scan.** In Overview, read the onboarding status. A completed scan with no
   recommendations is a valid result. For an unexpected empty history, inspect scan roots
   and parser health in Settings; saved scan-root changes require a daemon restart.
2. **Find one expensive session.** Select a date window, open Workspaces, choose a workspace,
   then open one of its sessions. Compare context, cache writes, and output before deciding
   what to change.
3. **Inspect one recommendation.** Open Recommendations and **Show details** on an instance.
   Read its evidence and caveats. A modeled amount is a projection; directional advice may
   have no dollar estimate. If nothing fires, there is nothing to adopt just to finish setup.
4. **Make one deliberate change.** A copied prompt is an artifact to review and run yourself.
   It does not edit files. **Open in Claude Code** (Settings > Advanced > Experimental actions,
   off by default) starts your own `claude` in a terminal; nothing is applied for you. After
   completing a supported change, use **I completed the change** when offered, then **Track**
   to record a baseline.
5. **Return to the Impact ledger.** Tracking starts observation, not a savings claim. Eligible
   signals use a 14-day observation window and may finish inconclusive. You can finish this
   first visit without a GitHub token, calibration, or installed hooks.

Dollar figures are **list-price equivalents**, not your subscription bill. Modeled savings
are not achieved savings, and observed improvement does not prove the change caused it.
GitHub linkage adds outcome metadata; calibration enables the burn forecast. Local spend,
session inspection, and supported recommendation tracking work without either.

[Worked example: trim always-loaded context and inspect its effect](https://github.com/Doogit/AgentWrangler/blob/main/docs/getting-started.md#example-trim-always-loaded-context).

## Dashboard preview

![Synthetic Overview: usage limits read through Claude Code /usage, spend for the selected window, and the top recommendations](https://raw.githubusercontent.com/Doogit/AgentWrangler/main/docs/assets/overview.png)

This static preview uses synthetic data. [The dashboard tour](https://github.com/Doogit/AgentWrangler/blob/main/docs/dashboard-tour.md)
contains the other views and an optional animated preview.

## Pick a question

| I want to... | Start here |
|---|---|
| Find where my tokens went | [Workspaces and Sessions](https://github.com/Doogit/AgentWrangler/blob/main/docs/dashboard-tour.md#workspaces) |
| Turn a recommendation into a change | [Worked example](https://github.com/Doogit/AgentWrangler/blob/main/docs/getting-started.md#example-trim-always-loaded-context) |
| Understand the dollars and verdicts | [Metric vocabulary](https://github.com/Doogit/AgentWrangler/blob/main/docs/dashboard-tour.md#glossary-how-to-read-this-dashboard) |
| Fix an empty dashboard | [First launch](https://github.com/Doogit/AgentWrangler/blob/main/docs/getting-started.md#first-launch) |
| Connect GitHub or calibrate limits | [Optional setup](https://github.com/Doogit/AgentWrangler/blob/main/docs/getting-started.md#optional-setup) |
| Grade my Claude Code setup | [Rate my setup](https://github.com/Doogit/AgentWrangler/blob/main/docs/dashboard-tour.md#rate-my-setup): a score and tier against a cited rubric, what the next tier needs, and an optional AI review |

## Installable guardrails — local checks inside Claude Code, before the waste

Hooks are optional and require an explicit install. Settings **Install directly** installs
five hooks; **Copy install prompt** prepares instructions for three. Copying alone installs nothing.

| Hook | Behavior | Install path |
|---|---|---|
| Context-budget | Warns when context crosses configured thresholds | Direct or copied prompt |
| Loop guard | Warns, then can deny repeated identical failures | Direct or copied prompt |
| Burn alert | Warns about session budget consumption | Direct or copied prompt |
| Dangerous-command | Can ask or deny risky commands | Direct only |
| PreCompact checkpoint | Copies raw transcripts locally, with retention limits | Direct only |

[Installation, removal, and the checkpoint privacy details](https://github.com/Doogit/AgentWrangler/blob/main/docs/getting-started.md#in-session-guardrails).

## Usage limits — read from Claude Code

By default AgentWrangler runs your own `claude -p /usage` in the background, only while the
dashboard is open: at most every 5 minutes when you have been active, hourly when idle, and not
while the statusline reading is fresh. It runs your own `claude` CLI and never reads your Claude
login. It stores only percentages, reset times and model labels in
`~/.agentwrangler/usage-cli.json`. Turn it off with the Settings checkbox **Read usage via Claude
Code /usage** or `AW_USAGE_CLI=off`.

The Claude Code statusline is the optional alternative: it updates on every turn and makes no
background calls. Settings **Install statusline** points Claude Code's `statusLine` at
`agentwrangler statusline`, after showing the exact before/after of `~/.claude/settings.json` and
saving a timestamped backup. It prints a one-line status (model, repo, branch, context, 5h/7d
limits, session cost) and saves only the two limit percentages and reset times to
`~/.agentwrangler/statusline-limits.json`. An existing statusline keeps running and displaying
(`--wrap "<your command>"`); Uninstall restores it. The 5-hour and weekly figures come from
whichever reading is newer; per-model weekly rows come only from `/usage`.

## Privacy and limits

- The daemon binds to **127.0.0.1**. There is no telemetry or hosted product backend. By default
  the only outbound call is your own `claude` CLI's `/usage` call for Usage limits; GitHub sync,
  Judge me and calibration are opt-in.
- SQLite holds token counts and structural data, filesystem paths, and some transcript
  content: the shell command text of tool calls and short error excerpts from failed tool
  results, after a best-effort secrets filter. Recommendation cards also read the calls behind
  a finding back from your transcripts to show what ran. All of it stays on your machine.
  Treat the database and any backups as sensitive. The optional PreCompact hook makes separate
  raw transcript copies on your machine.
- Rate my setup's optional **Judge me** review sends a redacted summary of your setup to Claude
  through your own `claude` CLI, only after you approve the exact payload. GitHub outcomes sync
  requires a configured token. [Privacy details](https://github.com/Doogit/AgentWrangler/blob/main/docs/privacy.md).
- Claude Code format changes can require parser updates. This is a single-user tool.
- Windows local validation and Linux/macOS CI smoke coverage do not establish full native
  accessibility or credential-store compatibility on every platform. The macOS Keychain and
  Terminal.app Automation prompts have not been tested on a real Mac in 0.2.0.

## How it works

![How data moves through AgentWrangler: logs are read and priced, detectors find waste, and the dashboard serves recommendations](https://raw.githubusercontent.com/Doogit/AgentWrangler/main/docs/assets/how-it-works.png)

AgentWrangler is one local Node process. It tails Claude Code's log files (new lines every 2 s,
new files every 30 s), stores what it needs in SQLite at `~/.agentwrangler/db.sqlite`, and runs
detectors over the data to build recommendations. Long passes run in worker threads so the
dashboard stays responsive. The browser UI talks to the daemon at `127.0.0.1:2929`. There is no
separate service or scheduled task: stop the daemon and its background work stops.

[Background jobs, ingest, storage, detectors, API, and the privacy boundary](https://github.com/Doogit/AgentWrangler/blob/main/docs/how-it-works.md).

## Deeper documentation

[What's new](https://github.com/Doogit/AgentWrangler/blob/main/CHANGELOG.md) |
[In-app Help guide](https://github.com/Doogit/AgentWrangler/blob/main/docs/help/guide.md) |
[Configuration](https://github.com/Doogit/AgentWrangler/blob/main/docs/getting-started.md#configuration) |
[Architecture](https://github.com/Doogit/AgentWrangler/blob/main/docs/how-it-works.md) |
[Data model and metrics](https://github.com/Doogit/AgentWrangler/blob/main/docs/planning/AgentWrangler_Data_Model_and_Metrics_v2.md) |
[Contributing](https://github.com/Doogit/AgentWrangler/blob/main/.github/CONTRIBUTING.md) |
[Security policy](https://github.com/Doogit/AgentWrangler/blob/main/.github/SECURITY.md)

[Apache 2.0](https://github.com/Doogit/AgentWrangler/blob/main/LICENSE).
