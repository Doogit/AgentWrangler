# AgentWrangler

Local, privacy-preserving observability for Claude Code token spend and session outcomes.
A daemon on `127.0.0.1` → a browser dashboard. No cloud, no telemetry, no data leaves your machine.

`src/` is the product: `daemon/` (HTTP server on `127.0.0.1:47821`), `ui/` (React dashboard —
overview, recommendations, sessions, workspaces, settings), `detector/`, `evidence/`, `ingest/`,
`outcomes/`, `query/`, `apply/`, `oauth/`, `db/`. Live DB: `~/.agentwrangler/db.sqlite`.

## Doc index

| Path | Purpose |
|---|---|
| `docs/adr/` | Accepted architecture decisions (stack, parser, live-tail, outcome linkage, attribution, forecasting) |
| `docs/planning/AgentWrangler_PRD_v0_7_0.md` | Product requirements |
| `docs/planning/AgentWrangler_Technical_Architecture_v4_5_0.md` | Architecture |
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

## Privacy invariant (SEC-101)

No raw transcript or PR content in any committed file, DB row, or UI — only aggregates, ids,
counts, and structural anchors.
