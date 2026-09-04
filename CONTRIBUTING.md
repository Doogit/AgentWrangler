# Contributing to AgentWrangler

Thanks for your interest. AgentWrangler is a local-only observability tool for Claude Code token
spend and session outcomes — a daemon on `127.0.0.1` plus a browser UI. No data leaves your machine.

## Development setup

Requirements: **Node `>=22 <25`** and npm.

```sh
npm ci                # install dependencies
npm run build:ui      # build the dashboard (dist/ui)
npm run daemon        # start the daemon on 127.0.0.1:47821 and open the browser
```

Or, from a clean clone, `npx agentwrangler` does the build-if-needed + launch in one step.

The daemon `tsx`-loads source at boot and does **not** hot-reload — restart it after editing
backend code, and re-run `npm run build:ui` after editing the UI.

## Checks (run before opening a PR)

CI runs all of these; run them locally first:

```sh
npm run lint          # Biome (lint + format check) over src/ and test/
npm run typecheck     # tsc --noEmit for both the node and UI tsconfigs
npm test              # both vitest suites: node (vitest run) + UI (vitest run --config vitest.ui.config.ts)
npm run smoke         # boots the daemon and asserts the DB schema (19/19 tables)
```

There are **two** vitest projects: the default node suite and the UI suite
(`vitest.ui.config.ts`). `npm test` runs both; run them individually while iterating.

## Pull request expectations

- **Keep changes surgical.** Touch only what the change requires; don't refactor or reformat
  adjacent code. Match the existing style.
- **Tests.** Add or update tests for behavior you change; don't weaken or delete existing tests to
  make a check pass. All checks above must be green.
- **Privacy invariant (SEC-101).** No raw transcript or PR content in any committed file, DB row, or
  UI — only aggregates, ids, counts, and structural anchors. Never commit machine-specific absolute
  paths or personal identifiers; use `os.tmpdir()` / fixture-relative paths in tests.
- **Commits.** Clear, present-tense messages that explain the *why*. Conventional-commit prefixes
  (`feat:`, `fix:`, `docs:`, …) are appreciated but not required.

## Reporting bugs and requesting features

Use the issue templates under **New issue**. For security reports, see [SECURITY.md](SECURITY.md).
