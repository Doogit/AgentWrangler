# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/Doogit/AgentWrangler/releases/tag/v0.1.0
