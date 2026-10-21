# AgentWrangler Help

Generated from `src/ui/help/topics.ts`. Regenerate with `node --import tsx/esm scripts/generate-help.mjs`; add `--check` to verify parity. This file is generated from the in-app Help and matches this version.

Dashboard routes below are for the running app. Installation and recovery text remains readable here when the daemon is stopped.

[Start here](#getting-started) · [Overview](#overview) · [Workspaces](#workspaces) · [Sessions](#sessions) · [Rate my setup](#judge-setup) · [Recommendations](#recommendations) · [Usage patterns](#diagnostics) · [Settings](#settings) · [Follow a walkthrough](#walkthroughs) · [Troubleshooting](#troubleshooting) · [Optional setup and privacy](#setup)

<a id="getting-started"></a>

## Start here

Find your first useful insight, with no optional setup required.

<a id="getting-started-first-visit"></a>

### Your first visit

You need a running daemon and local Claude Code history. You can finish this path without a GitHub token, calibration, guards or a tracked recommendation.

1. Open Overview and check the scan state. A running scan means totals can still change; it is separate from the first-ingest checklist.
2. Choose a date window with activity. Read the evidence labels alongside the totals before comparing spend.
3. Open Workspaces or Sessions and choose an entry. The detail view helps explain which activity contributed to the total.
4. Return to Overview. If a recommendation is available, review its evidence; otherwise, exploring your history is a complete first visit.

- Open Overview: dashboard route `#/overview`
- Open Workspaces: dashboard route `#/workspaces`
- Open Sessions: dashboard route `#/sessions`

<a id="getting-started-no-history"></a>

### If there is nothing to explore

A completed scan with no history is different from a failed request. Check the date window and scan roots before changing settings. An unavailable page should show its error or retry guidance; an empty list alone does not prove ingestion failed.

- [Fix missing data](#troubleshooting)

<a id="getting-started-labels"></a>

### Read the labels with the numbers

Cost equivalents and projected opportunities are not a bill or a promise of savings. Use the existing metric reference for definitions, units and evidence labels.

- How to read this dashboard: dashboard route `#/glossary`

<a id="overview"></a>

## Overview

Check ingestion, spend and where to investigate next.

<a id="overview-read"></a>

### Read the overview

Start with some ingested activity. Usage and forecast panels have additional prerequisites and may be unavailable even when session history is present. The usage limits card needs claude on your PATH and new enough to support /usage; the reader can also be turned off in Settings.

1. Check the scan state to see whether the initial background scan is still running.
2. Choose the date window and compare the totals with their labels. The expensive-session list uses a fixed seven-day window and shows up to five sessions.
3. Open a costly session to inspect its drivers. Quantified recommendations are a separate panel, with up to three cards.
4. Read any usage or forecast unavailable reason before opting into setup. For usage limits the reason is usually that claude is not on PATH, is too old for /usage, or the reader is off in Settings.

- Open Overview: dashboard route `#/overview`
- [Inspect an expensive session](#walkthroughs)

<a id="overview-unavailable"></a>

### Empty or unavailable panels

No recommendations can be a valid result. A scan in progress, no qualifying activity, missing usage data and a failed request need different responses. Check the panel message rather than treating every blank value as zero.

- [Troubleshooting](#troubleshooting)
- Metric reference: dashboard route `#/glossary`

<a id="workspaces"></a>

## Workspaces

Compare projects, then inspect the sessions behind them.

<a id="workspaces-compare"></a>

### Compare workspace activity

You need activity associated with a workspace in the selected window. Transient workspaces can represent temporary checkouts; review the identity before assuming they are separate long-lived projects.

1. Open Workspaces and choose a date window with activity.
2. Compare spend and Premium %. Premium includes Opus, Fable and Mythos; it is not an Opus-only share.
3. Choose a workspace to inspect its detail and sessions.
4. Open a session to investigate a contributor. Treat missing outcome data as unavailable evidence, not proof of no useful work.

- Open Workspaces: dashboard route `#/workspaces`
- [Sessions guide](#sessions)

<a id="workspaces-empty"></a>

### No matching workspaces

Widen the date window and check scan roots if history is missing. GitHub outcomes are optional and require separate setup; workspace spend does not require them.

- [Optional setup and privacy](#setup)
- [Troubleshooting](#troubleshooting)

<a id="sessions"></a>

## Sessions

Find costly activity and inspect its timeline and cost drivers.

<a id="sessions-inspect"></a>

### Inspect a session

Start with ingested sessions in the selected window. Live and partial evidence can change as ingestion completes.

1. Open Sessions and use the available date and filter controls to find the activity you want.
2. Compare cache hit, peak context, subagent cost and cost/turn alongside duration, models, turns and issues.
3. Choose a session to see its timeline and cost drivers. Friction information belongs to the detail view.
4. Follow an available diagnostic turn link to inspect the affected turn; a turn link is only present when an anchor is available.

- Open Sessions: dashboard route `#/sessions`
- Open Usage patterns: dashboard route `#/diagnostics`

<a id="sessions-interpret"></a>

### Interpret the evidence

Affected-turn cost describes observed activity. It does not tell you how much a future change will save. Empty results may reflect the window or filters; failed requests need the page's retry path.

- Metric reference: dashboard route `#/glossary`
- [Fix missing data](#troubleshooting)

<a id="judge-setup"></a>

## Rate my setup

Grade your Claude Code configuration and habits, and see what to fix next.

<a id="judge-setup-grade"></a>

### Read your setup grade

The grade combines your settings with what your recent sessions show. A check without enough data is left out of the score; it is not counted as a failure.

1. Open Rate my setup from the sidebar, or from the Rate my setup card on Overview, which shows the same score, tier and next step. Read the tier and overall score at the top.
2. If a cap or gate holds the tier down, read its reason first; the score before the cap is shown beside it.
3. Open a category's checks to see each result, what it needs, and a link to the fix or the cited doc.
4. Dollar figures appear only where a recommendation prices the gap. The next-tier total says when it counts measured items only.

- Open Rate my setup: dashboard route `#/judge-setup`
- Overview: dashboard route `#/overview`
- [Evaluate a recommendation](#recommendations)

<a id="judge-setup-ai-review"></a>

### Get an AI review (optional)

Judge me asks Claude to read a summary of your setup and say what the checks miss. It runs one request through your own claude CLI and login, and counts toward your plan's usage. Nothing is sent until you approve.

1. Click Judge me under Written review.
2. Read the consent screen. It shows the exact text that will be sent, with your user and git names, email addresses, URLs and host names redacted. Add names to remove or untick repos, then click Update preview.
3. Click Send to Claude, or Cancel to send nothing. While it runs you can cancel the review.
4. Read the result as AI opinion (unverified). It never changes your score or tier; where it disagrees with a check, the check row says so.

- Open Rate my setup: dashboard route `#/judge-setup`

<a id="judge-setup-missing"></a>

### When there is no tier or no score

A fresh install usually has no tier yet because too little of the rubric has data. The page lists what it needs. Copy summary puts text on your clipboard with your tier and scores, never paths, workspace names or config text.

- Metric reference: dashboard route `#/glossary`

<a id="recommendations"></a>

## Recommendations

Separate a suggestion, a completed change and an observed effect.

<a id="recommendations-review"></a>

### Review before changing anything

Recommendations require qualifying evidence. The dollar figure on each card is an estimate, or reads Not estimated; it does not promise a result. Ranking considers measured effects, usage estimates and safety risk.

1. Open Recommendations and read the card's scope, evidence window and caveats.
2. Follow linked sessions. Where a full session count is available, the links show at most five examples. An unavailable count remains unknown.
3. Inspect the action and any preview. Copy prompt copies instructions; it does not apply a change. Open in Claude Code (shown only after Settings > Advanced > Experimental actions is turned on) starts your own claude in a terminal; review what it will do before you run it. AgentWrangler applies nothing for you.
4. If the card offers Track, complete the real change and its confirmation flow. Manual-evidence paths can require a separate attestation. Controls vary with validation and tracking eligibility.

- Open Recommendations: dashboard route `#/recommendations`
- Metric reference: dashboard route `#/glossary`

<a id="recommendations-measurement"></a>

### Return to inspect measurement

Open the Impact ledger within Recommendations on a later visit. The observation window is 14 days; elapsed time alone does not guarantee enough comparable data. Pending, inconclusive or unsupported results are not measured savings.

Shell-error guidance is scoped to a workspace. Its measurement combines Bash and PowerShell calls so a shell switch can be observed. Same-error-loop measurement counts loops per 100 eligible sessions; its advisory cost context must not be added to other savings totals.

Stop measurement stops tracking. Manual-revert attestation records that you reverted a change yourself; neither control automatically restores files. Review your own diff or backup to reverse a change safely.

- Open Recommendations and Impact ledger: dashboard route `#/recommendations`

<a id="recommendations-unavailable"></a>

### No recommendation or action

No card may mean no detector met its evidence threshold. An available method alone does not make every card trackable: source identity, a supported target metric and validation still matter. Missing Copy prompt or Track controls are not instructions to bypass validation.

Compare each card's assumptions and exposure. There is no universal cache-miss-versus-memory-trim savings ratio. Source-file token quantities may be estimates.

- [Troubleshooting](#troubleshooting)

<a id="diagnostics"></a>

## Usage patterns

See what is costing you, why it happens, and which causes have a fix.

<a id="diagnostics-investigate"></a>

### Follow a pattern to its evidence

Usage patterns needs parsed activity in the selected scope. It helps locate a pattern, not establish that every affected turn was avoidable.

1. Open Usage patterns and pick a window (7d, 14d or 30d). Read the tiles, then the Avoidable spend and Reliability causes.
2. Expand a cause to see when it happens, an example and its affected sessions, then open an affected session.
3. Follow a turn anchor when available to inspect the contributing activity.
4. Check the surrounding context before choosing a repair. A denial can reflect an intended guard.

- Open Usage patterns: dashboard route `#/diagnostics`
- [Investigation walkthroughs](#walkthroughs)

<a id="diagnostics-caveats"></a>

### No findings and cost caveats

No findings can be valid for the selected activity. Missing parser coverage is a separate concern. Affected-turn cost is observed context, not forecast savings. Inspect retained command/error text locally; avoid copying it into reports.

- Open Parser Health: dashboard route `#/settings?section=parser-health`
- [Privacy and setup](#setup)

<a id="settings"></a>

## Settings

Understand essentials, guards, integrations and advanced diagnostics.

<a id="settings-configure"></a>

### Choose a setting deliberately

Opening Settings does not require you to enable optional features. Reading Help never saves settings or installs hooks.

1. Check scan roots under Essentials if data is missing. Save intended roots and restart the daemon for them to take effect.
2. Review calibration only if you want to provide its additional usage inputs. Bytes calibration uses your effective configured scan roots, including defaults; an explicitly saved empty list stays empty. Insufficient samples can still occur.
3. Open In-session guards to review installation and removal controls before changing Claude Code hooks.
4. Read Outcomes sync status under integrations. Advanced and diagnostics contains Parser Health and Parse Failures.

- Open Settings: dashboard route `#/settings`
- Scan roots: dashboard route `#/settings?section=scan-roots`
- Usage calibration: dashboard route `#/settings?section=calibration`
- In-session guards: dashboard route `#/settings?section=in-session-guards`
- Outcomes sync: dashboard route `#/settings?section=outcomes-sync`
- Parser Health: dashboard route `#/settings?section=parser-health`

<a id="settings-limits"></a>

### Known limitations

Token presence is not proof of connectivity. Settings offers external credential setup guidance, local status refresh, an explicit connection test and sync retry. Sync history covers only this daemon run; a prior success does not certify the current credential. Parser Health reports counts: no parser data, quarantined lines detected, or no quarantined lines. A quarantine rate is unavailable because files and lines are different units.

- [Setup and privacy](#setup)
- [Troubleshooting](#troubleshooting)

<a id="walkthroughs"></a>

## Follow a walkthrough

Self-paced steps using your chosen activity; no automatic changes.

<a id="walkthroughs-expensive-session"></a>

### Inspect an expensive session

Prerequisite: at least one ingested session. This ends with an explanation, not a required optimization.

1. Open Sessions and choose a window with activity; locate a high-cost session.
2. Choose it and compare its timeline, peak context and subagent contribution. Identify which driver explains the total.
3. Read the evidence label and metric reference. Record a question to investigate, or stop if the activity was expected.

- Open Sessions: dashboard route `#/sessions`
- Metric reference: dashboard route `#/glossary`

<a id="walkthroughs-diagnostic-pattern"></a>

### Investigate a recurring problem

Prerequisite: a diagnostic finding. If none is present, there is no task to complete here.

1. Open Usage patterns and expand the relevant cause under Avoidable spend or Reliability.
2. Open an affected session and follow an available turn link. You should arrive at the relevant activity, or at session detail if no anchor exists.
3. Check whether the pattern reflects a problem or an intended guard. Decide on a repair only after reviewing context.

- Open Usage patterns: dashboard route `#/diagnostics`

<a id="walkthroughs-tracked-change"></a>

### Make a supported change, then return

Prerequisite: a recommendation with a validated action and eligible tracking. You can review a card without adopting it.

1. Open Recommendations, inspect evidence and preview the proposed action. Confirm it fits the selected workspace.
2. Copy the prompt (or use Open in Claude Code if you turned it on), make the change yourself, and verify the actual change. Copying alone is not completion.
3. Use Track and complete the confirmation or manual attestation offered by that card. If unavailable, do not invent a tracking path.
4. Return later to the Impact ledger in Recommendations. Read observation and comparability reasons; the 14-day window may still produce an inconclusive result.

- Open Recommendations: dashboard route `#/recommendations`
- [Measurement and reversal caveats](#recommendations)

<a id="troubleshooting"></a>

## Troubleshooting

Distinguish missing history, valid empty results and failed requests.

<a id="troubleshooting-missing-data"></a>

### Missing or incomplete history

Scan still running: check Overview's scan state and allow the background scan to finish. Totals can change during ingestion. The dismissible pipeline banner is not a permanent last-ingest record.

Scan complete, no history: check the selected dates, filters and saved scan roots. Confirm the directory contains the Claude Code history you intended to scan; save corrected roots and restart.

Parse problems: open Parser Health and inspect quarantine counts and Parse Failures. The count-based status does not estimate a quarantine percentage or establish that every record parsed correctly. A request error requires recovery through the page's error/retry guidance, not interpretation as an empty dataset.

- Open Overview: dashboard route `#/overview`
- Scan roots: dashboard route `#/settings?section=scan-roots`
- Parser Health: dashboard route `#/settings?section=parser-health`

<a id="troubleshooting-optional-data"></a>

### Missing recommendations, outcomes or forecast

No recommendations: inspect scope and evidence availability. Detectors can legitimately have no qualifying findings. You do not need to enable integrations to finish your first visit.

Missing GitHub outcomes: configured means a token is present, not that it is valid or authorized for a repository. The daemon also needs gh. Use the explicit connection test or sync retry in Settings. A test proves only its read-only calls against a locally known repository, not every sync capability. With no eligible repository, access remains untested. A successful sync can legitimately find no matching outcomes.

Credential status unavailable: use Retry status. After changing or removing the Windows credential, use the local credential recheck to clear the local cache. Restart after changing the daemon environment. Local refresh does not contact GitHub or certify access.

Usage or forecast unavailable: read the panel's prerequisite message and, if appropriate, review usage calibration. For usage limits, claude must be on your PATH and new enough to support /usage, and the Read usage via Claude Code /usage checkbox must not be turned off in Settings (Settings > Usage limits from Claude Code). The statusline is an alternative source. Historical spend alone does not establish current account usage. Insufficient calibration samples can be a valid result.

- Outcomes sync: dashboard route `#/settings?section=outcomes-sync`
- Usage calibration: dashboard route `#/settings?section=calibration`

<a id="troubleshooting-daemon"></a>

### Daemon unavailable, update or port conflict

If this page is already loaded it can remain readable after an analytics failure. A stopped daemon cannot serve a fresh dashboard page. Once the shell loads, the status chip at the top of each page shows startup progress; if the dashboard is not ready after 30 seconds, its popover shows recovery steps. Keep the repository's Getting Started guide or the generated Help Markdown available outside the dashboard.

For an installed package, start agentwrangler (or npx agentwrangler@latest). For a source checkout with dependencies installed, use npm run daemon. The default address is http://127.0.0.1:2929.

Stop the existing daemon before updating or restarting. Do not start a second instance on the same port. For a source UI change run npm run build:ui before restarting; use npm run build for daemon and UI changes. Reopen the dashboard and use Retry connection if shown.

If the port is occupied, identify its owner first. Reuse or stop your existing instance, or configure AW_PORT for a separate instance. Do not terminate an unrelated process. Node must satisfy the package engine range, currently >=22 <25.

- [Getting Started (external)](https://github.com/Doogit/AgentWrangler/blob/main/docs/getting-started.md)

<a id="setup"></a>

## Optional setup and privacy

Know what is stored and which integrations you are enabling.

<a id="setup-optional"></a>

### Optional setup

Scan roots are restart-loaded. Weekly calibration and optional bytes calibration have their own inputs and sample requirements; neither is required to browse history. Bytes calibration shares the effective scan roots used by Settings and ingestion; explicit empty roots do not fall back to broader defaults.

Guards modify Claude Code hook configuration when installed. Review the available direct installation or copied-prompt flow and its removal instructions. Direct installation covers five hooks; the prompt flow covers three. Do not assume the two flows install identical coverage.

On macOS, Open in Claude Code opens Terminal.app through osascript, so macOS asks once for Automation permission. The sign-in check (GET /api/oauth/status) reads the Claude Code login only to report signed-in and plan tier, and macOS may show a Keychain access prompt for it; the token is never returned, logged, stored or sent. ANTHROPIC_API_KEY is removed from every claude AgentWrangler starts, so those runs use your Claude subscription login.

- Scan roots: dashboard route `#/settings?section=scan-roots`
- Usage calibration: dashboard route `#/settings?section=calibration`
- In-session guards: dashboard route `#/settings?section=in-session-guards`

<a id="setup-github"></a>

### GitHub outcomes prerequisites

Provision an appropriate token externally as AW_GITHUB_TOKEN in the environment of the daemon process. On Windows, the fallback is Generic Credential AgentWrangler-GithubToken; other platforms do not have that native credential-store fallback. The environment takes precedence. The daemon uses gh with this token; gh auth login alone does not replace this path.

Settings guides setup, replacement and removal in Windows Credential Manager; it never accepts or stores a secret itself. Canceling that external workflow leaves configuration unchanged. Use the local credential recheck after changing the Windows credential; AW_GITHUB_TOKEN still takes precedence, so deleting the OS credential may leave outcomes configured. Removing a credential does not erase historical outcomes. Never paste a token into an issue or screenshot.

Fine-grained access depends on each endpoint: pull-request reads and check-run reads use different permissions, and GraphQL access depends on the requested resources. See https://github.com/Doogit/AgentWrangler/blob/main/docs/help/github-permissions.md for the official endpoint inventory. Organization policy or token approval may also limit access. A forbidden or not-found response does not establish a single cause.

- Outcomes sync status: dashboard route `#/settings?section=outcomes-sync`

<a id="setup-privacy"></a>

### Local does not mean content-free

The dashboard binds to loopback and uses local storage. By default the only outbound call is your own claude CLI's /usage, run in the background only while the dashboard is open (at most every 5 minutes when you are active, hourly when idle). AgentWrangler never reads your Claude login for it. You can turn it off in Settings or use the Claude Code statusline instead. Optional GitHub outcomes, the Rate my setup AI review and bytes calibration are opt-in and also involve outbound requests. Review the privacy guide before enabling an integration.

Ingestion can retain filtered shell-command and errored-tool-result slices, capped at 4,000 characters each. Filtering is best effort and cannot guarantee removal of secrets. Treat the local database as sensitive.

Optional PreCompact checkpoint copies contain raw transcript data and have separate retention and cleanup. Uninstalling hooks or the package does not by itself remove those copies. Do not share transcripts, database dumps, local paths or raw command/error evidence in a bug report.

- [Privacy (external)](https://github.com/Doogit/AgentWrangler/blob/main/docs/privacy.md)

## More help

- [Getting Started (external)](https://github.com/Doogit/AgentWrangler/blob/main/docs/getting-started.md)
- [Dashboard Tour (external)](https://github.com/Doogit/AgentWrangler/blob/main/docs/dashboard-tour.md)
- [Privacy (external)](https://github.com/Doogit/AgentWrangler/blob/main/docs/privacy.md)
- [Report an issue (external)](https://github.com/Doogit/AgentWrangler/issues)
