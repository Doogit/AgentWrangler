# AgentWrangler

Local, privacy-preserving observability for Claude Code token spend and session outcomes.
A daemon on `127.0.0.1` → a browser dashboard. No cloud, no telemetry; nothing leaves your machine
by default except your own `claude` CLI's `/usage` (turn off in Settings > Usage limits from Claude
Code, or `AW_USAGE_CLI=off`). GitHub sync, Judge me and bytes-to-token calibration are opt-in.

`src/` is the product: `daemon/` (HTTP server on `127.0.0.1:2929`), `ui/` (React dashboard —
overview, workspaces, sessions, rate my setup, usage patterns, recommendations, settings, help,
glossary), `detector/`, `evidence/`, `ingest/`, `outcomes/`, `query/`, `apply/` (Open in Claude Code
terminal launcher), `oauth/`, `judge/`, `hook/`, `cli/`, `db/`. Live DB: `~/.agentwrangler/db.sqlite`.

## Doc index

| Path | Purpose |
|---|---|
| `docs/getting-started.md` | Install paths, optional setup, configuration, troubleshooting |
| `docs/dashboard-tour.md` | Every dashboard tab in depth + metric vocabulary |
| `docs/privacy.md` | Privacy model — what's stored, what never is, opt-in exceptions |
| `docs/adr/` | Accepted architecture decisions (stack, parser, live-tail, outcome linkage, attribution, forecasting, calibration, privacy boundary, scheduling) |
| `CHANGELOG.md` | What changed in each release |
| `docs/releases/0.2.0.md` | 0.2.0 release notes |
| `docs/help/guide.md` | The in-app Help topics as one page |
| `.github/CONTRIBUTING.md` | Dev setup, checks, PR expectations |
| `docs/how-it-works.md` | Architecture: background jobs, ingest, storage, detectors, API, privacy boundary |
| `docs/planning/AgentWrangler_Data_Model_and_Metrics_v2.md` | SQLite schema + metric definitions |
| `docs/planning/AgentWrangler_Ingestion_and_Findings_Spec_v1.md` | Ingestion + findings spec |
| `docs/planning/AgentWrangler_Recommendations_Engine_Spec_v1.md` | Recommendations engine spec |

## Running the dashboard

Launch via the **`dashboard` skill** (`.claude/skills/dashboard/SKILL.md`): it rebuilds the UI,
restarts a stale daemon, and opens the browser. Or manually from the repo root:

```
npm run build:ui && npm run daemon
```

**Stale-daemon rule:** the daemon `tsx`-loads source once at boot and never hot-reloads, so a
long-lived daemon serves stale code (old routes, old UI) even while it still answers `200`. After
editing `src/`, always restart the daemon — the `dashboard` skill does this for you.

## Gate (run before committing)

```
npm run typecheck   # tsc --noEmit over the node + ui tsconfigs
npm run lint        # biome check src test
npm test            # vitest run (node) && vitest run --config vitest.ui.config.ts (ui)
npm run smoke       # boots the daemon headless (--smoke --no-open)
npm run build:ui    # vite build
```

The two vitest suites are the node config (`vitest.config.ts`) and the UI config
(`vitest.ui.config.ts`); UI tests live under `test/ui/`.

## Privacy invariant

A distribution-boundary control: no developer transcript or PR content in any committed file or the
published export — enforced at the boundary (pre-commit content scan, CI content gate, export gate).
AgentWrangler is local-only, so inside the app there is no content restriction: the daemon's own DB,
API and UI (which share a trust boundary with `~/.claude` on your machine) may store and show
transcript content wherever it makes a recommendation useful, and by default nothing leaves your
machine except your own `claude` CLI's `/usage`.
Any share, sync, backup, cloud or telemetry feature re-opens this decision (ADR-112, amended
2026-09-25).
