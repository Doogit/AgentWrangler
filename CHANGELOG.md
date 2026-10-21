# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0]

A large release: a redesigned dashboard, 31 detectors (up from 9), one ranked list of recommendations with
measured effects, and a new Rate my setup page. Usage limits are now read through your own Claude Code CLI, and
one-click apply is off. Full notes: [docs/releases/0.2.0.md](https://github.com/Doogit/AgentWrangler/blob/main/docs/releases/0.2.0.md).

### Performance
- Opens sooner on first launch (newest sessions first, the rest in the background) and stays responsive while it
  reads.
- Transcript reading runs in short time slices. History, recommendations, Usage patterns and headroom are built in
  background worker threads and served from snapshots, so page requests do not wait on them.
- Copied or renamed transcripts are not read again, warm restarts skip unchanged files, and one browser tab polls
  for status on behalf of the others.
- Measured in our release test gate while a backfill is running: daemon event-loop p99 ≤ 50 ms, and each of the 67
  budgeted API routes within its p95 latency budget (250 ms for most routes).

### UI / dashboard
- New sidebar groups, a redesigned Overview, Sessions and Workspaces, and new Usage patterns and Help pages.
- Overview: a Usage limits card, $ and Tokens spend tabs, a 12-week chart of your implied weekly limit, and your most
  expensive sessions of the last 7 days. Sessions is paged, with cache hit %, peak context and subagent cost columns.
- Usage patterns groups avoidable spend and reliability problems by root cause, with the affected sessions.
- Removed: the Briefs tab (now Rate my setup), work records, and the Overview cache-efficiency tile.

### Detectors
- 31 detectors (up from 9), each tested with a must-fire and a near-miss fixture.
- New areas include oversized tool output, cache misses and breaks, tool error rates, edits before reads, repeated
  errors, permission denials, subagent over-spawning and destructive operations.
- Dollar figures are estimates at list prices; a card says **Not estimated** when it cannot price the finding.
  Shared turns are no longer counted twice, and subagent turns are attributed and priced.

### Handlers and recommendations
- One list ranked by dollars per week; **Track** a change and AgentWrangler measures its effect over 14 days.
  Dismissals and adoptions can be undone.
- Each card shows a summary, why it matters, the evidence (sessions and turns) and its actions. A change it cannot
  measure says "Effect not measured" instead of guessing.
- Resetting recommendations keeps the ones you acted on and their measured effects.

### Judge module
- **Rate my setup** grades your Claude Code setup; optional **Judge me** asks Claude for a review after showing you
  what will be sent.
- Checks cover settings, hooks, CLAUDE.md and memory files, MCP servers, permissions, skills and agents. A snapshot
  is saved each time your grade changes.
- Judge me runs your own `claude` with no tools, no MCP servers and no saved session; secrets are blocked. Typical
  cost: $0.30–$0.40 of your Claude usage.

### Usage limits
- Read by running your own `claude -p /usage` in the background (on by default, off in Settings), or from the
  statusline. AgentWrangler no longer sends your Claude login token anywhere.
- The reader runs only while the dashboard is open: at most every 5 minutes when you are active, hourly when idle,
  and not while the statusline reading is fresh. Only percentages, reset times and model labels are kept.
- The card keeps the last good reading across restarts and marks it stale when it is old.

### Ingest and data
- Reads `/clear`, `/compact`, session titles and subagent attribution; price fixes; one daemon per database and a
  backup before each migration. Some unused API routes were removed (see the full notes).
- 38 new database migrations. A database written by a newer AgentWrangler is refused instead of damaged; the
  pre-migration backup (`.pre-migrate.bak`) is skipped above 512 MB.
- Price fixes for Opus 5.5 and Sonnet 5.5 cache reads and Haiku 5.5 tiers, with a re-price of stored history.

### CLI, install and packaging
- **The default address is now `http://127.0.0.1:2929`** (was `127.0.0.1:47821`). Set `AW_PORT` to keep the old
  port. Update bookmarks.
- New `agentwrangler statusline` (install from Settings; wraps your existing statusline command).
- New `agentwrangler audit` (experimental). The npm package now includes this changelog. Still requires Node.js 22
  to 24.

### macOS
- Non-blocking Keychain read, a checked and time-limited Terminal.app launch for Open in Claude Code, and a macOS
  first-run smoke test in CI.
- The Keychain read is limited to 3 seconds and cached; the Terminal.app launch gives up after 20 seconds.

### Security and privacy
- `ANTHROPIC_API_KEY` is never passed to a `claude` that AgentWrangler starts. Write requests need a per-run token.
- Guardrail hooks no longer skip Claude Code's permission prompt; reinstall them from Settings after upgrading.
- The local database may hold secrets-filtered transcript excerpts; nothing leaves your machine as sync, backup or
  telemetry.

### Off in 0.2.0 / known limits
- One-click apply is off (`403 APPLY_DISABLED`); use Copy prompt or Open in Claude Code (Settings > Advanced >
  Experimental actions).
- The macOS Keychain and Terminal Automation prompts are not yet tested on a real Mac.

## [0.1.0] - 2026-09-04

Initial public release.

### Added
- Local-first observability daemon (bound to `127.0.0.1:47821`) and a browser dashboard that joins
  your Claude Code token spend to the pull requests each session merged or closed — entirely on your
  machine, with no cloud backend and no telemetry.
- Installable guardrails, turn-key from the dashboard: a dangerous-command deny hook, a PreCompact
  checkpoint, and a context-budget warning.
- SQLite-backed local store (`~/.agentwrangler/db.sqlite`) that persists only aggregates, ids,
  counts, and structural anchors — never raw transcript or PR content (the SEC-101 privacy
  invariant).
- Optional GitHub token (read locally, never logged) powering the PR-outcomes feature.

[0.2.0]: https://github.com/Doogit/AgentWrangler/releases/tag/v0.2.0
[0.1.0]: https://github.com/Doogit/AgentWrangler/releases/tag/v0.1.0
