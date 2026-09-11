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

Open **http://127.0.0.1:47821** if the browser does not open automatically. Keep the terminal
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
   It does not edit files. After completing a supported change, use **I completed the change**
   when offered, then **Track this change** to record a baseline.
5. **Return to the Impact ledger.** Tracking starts observation, not a savings claim. Eligible
   signals use a 14-day observation window and may finish inconclusive. You can finish this
   first visit without a GitHub token, calibration, or installed hooks.

Dollar figures are **list-price equivalents**, not your subscription bill. Modeled savings
are not achieved savings, and observed improvement does not prove the change caused it.
GitHub linkage adds outcome metadata; calibration enables the burn forecast. Local spend,
session inspection, and supported recommendation tracking work without either.

[Worked example: trim always-loaded context and inspect its effect](https://github.com/Doogit/AgentWrangler/blob/main/docs/getting-started.md#example-trim-always-loaded-context).

## Dashboard preview

![Synthetic Overview: spend for the selected window, model mix, and links to sessions and recommendations](https://raw.githubusercontent.com/Doogit/AgentWrangler/main/docs/assets/overview.png)

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
| Read a weekly summary | [Briefs](https://github.com/Doogit/AgentWrangler/blob/main/docs/dashboard-tour.md#briefs) |

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

## Privacy and limits

- The daemon binds to **127.0.0.1**. There is no telemetry or hosted product backend.
- SQLite contains aggregates and structural data, plus filesystem paths. Command rows keep
  only `/compact`, `/clear`, or an unclassified marker — other commands and arguments are
  discarded, though databases or backups from before the upgrade can still hold raw command
  text (sanitation is logical, not physical erasure). Treat it as sensitive. The optional
  PreCompact hook makes separate raw transcript copies on your machine.
- Usage refresh can contact Anthropic using your existing Claude Code sign-in. GitHub
  outcomes sync requires a configured token. [Privacy details](https://github.com/Doogit/AgentWrangler/blob/main/docs/privacy.md).
- Claude Code format changes can require parser updates. This is a single-user tool.
- Windows local validation and Linux/macOS CI smoke coverage do not establish full native
  accessibility or credential-store compatibility on every platform.

## Deeper documentation

[Configuration](https://github.com/Doogit/AgentWrangler/blob/main/docs/getting-started.md#configuration) |
[Architecture](https://github.com/Doogit/AgentWrangler/blob/main/docs/planning/AgentWrangler_Technical_Architecture_v4_5_0.md) |
[Data model and metrics](https://github.com/Doogit/AgentWrangler/blob/main/docs/planning/AgentWrangler_Data_Model_and_Metrics_v2.md) |
[Contributing](https://github.com/Doogit/AgentWrangler/blob/main/.github/CONTRIBUTING.md) |
[Security policy](https://github.com/Doogit/AgentWrangler/blob/main/.github/SECURITY.md)

[Apache 2.0](https://github.com/Doogit/AgentWrangler/blob/main/LICENSE).
