# ADR-100: MVP implementation stack

Date / Spike / Status: 2026-08-21 / S0 / **accepted** (shell fork resolved by external research + human sign-off — see Decision)

## Question

Confirm or refute the presumptive MVP stack from Architecture v4.5.0 §16 / AD-110 —
**TypeScript/Node daemon + better-sqlite3 + a lightweight desktop shell (Tauri preferred,
Electron acceptable)** — and pin the major versions Session 2 will scaffold against. This is
a 1-day decision from the stated drivers, not new research.

## Options considered

The stated MVP drivers (§16): JSONL streaming, incremental file tailing, GitHub REST/GraphQL,
tokenizer availability, desktop-shell footprint, reuse of the operator's proven Node analysis
scripts (`token-usage-*.mjs`), and single-binary-ish distribution.

**Language + runtime + DB layer** — not genuinely contested:

- **(a) TypeScript/Node 22 LTS + better-sqlite3.** Directly reuses the proven `.mjs` scripts
  (the S1 reproduction target is already Node); first-class JSONL streaming (`readline`/byte
  offsets); mature GitHub SDKs (Octokit REST + GraphQL); tokenizers available
  (`@anthropic-ai/tokenizer`, `tiktoken`, `gpt-tokenizer`); better-sqlite3 is synchronous,
  fast, and covers every v2 DDL need (WAL, `foreign_keys=ON`, INTEGER micro-USD, TEXT+CHECK
  enums, JSON-in-TEXT columns, byte-offset persistence for the tailer). Prebuilt binaries for
  Node 22/24 remove the native-build tax on the common path.
- **(c) A credible alternative (Rust or Go daemon).** Explicitly ruled obsolete for MVP by
  AD-110 and §16: the Rust-vs-Go rule was driven by Cedar embedding + nono FFI, both deferred
  to P1. No MVP driver fails under (a). Rejected without relitigation (per Session 1 constraint).

No driver fails under (a); (a) is confirmed for language/runtime/DB.

**Desktop shell** — the one real fork. The §2 process topology already fixes that the **daemon
is a standalone Node process**, separate from the UI, talking over loopback/local IPC. So the
shell is a *thin client* (window + renderer + IPC bridge to the daemon) in either option, and the
choice is footprint-and-toolchain, not architecture:

- **(a) Tauri v2.** ~3–10 MB shell on the OS system webview; the stated preference (§16). Cost:
  a second build toolchain (Rust) and, for a *packaged* app, the daemon must ship as a Tauri
  sidecar binary (`externalBin`) — i.e. the Node daemon compiled via Node SEA / `pkg`. The custom
  Rust surface is near-zero (window + a loopback fetch bridge), but the Rust toolchain and sidecar
  packaging are real setup.
- **(b) Electron.** ~150 MB (bundles its own Chromium + Node). Single toolchain (Node only); the
  daemon can be a `child_process` or run in the main process; packaging is one ecosystem. Fastest
  to a shippable build; heaviest footprint — which is pointed for a product whose entire thesis is
  reducing waste.

## Evidence (spike repo, corpus results, benchmarks, pinned versions)

- **Reuse driver, measured:** the S1 reproduction target and the three reusable analysis scripts
  are already Node ESM (`docs/planning/token-usage-scripts/*.mjs`); they stream
  `~/.claude/projects/**/*.jsonl`, dedupe by `message.id`, and apply the pricing table — exactly
  the daemon's ingestion core. Choosing Node makes S1 a promotion, not a rewrite.
- **DB fit, checked against the DDL:** Data Model v2 §1 needs only WAL, FK enforcement, INTEGER
  micro-USD, TEXT+CHECK enums, JSON stored as TEXT, and byte-offset columns for the tailer — all
  native to better-sqlite3. No feature gap.
- **Topology, from §2:** daemon-as-separate-process is already decided, so the shell never embeds
  the daemon; this is what collapses the Tauri "you must write Rust" objection to near-zero custom
  Rust.
- **Phase-0 scope:** the S0 exit criterion is only *hello-world daemon + UI shell builds* — dev
  mode, not a packaged installer. Sidecar packaging (the main Tauri risk) is not on the Phase-0
  critical path and can be proven in a Phase-1 packaging spike.

**Pinned majors for Session 2** (majors, not exact patches — Session 2 records the resolved
lockfile):

| Component | Pin | Notes |
|---|---|---|
| Node.js | **22 LTS** (`>=22 <25`) | Active LTS through late 2026; better-sqlite3 prebuilds exist |
| TypeScript | **5.x** | strict mode on |
| better-sqlite3 | **12.x** | synchronous; WAL + FK; prebuilt binary for Node 22 (native module is a non-issue when run from `node_modules` — see Decision) |
| UI delivery | **localhost HTTP** (no native shell) | daemon serves the SPA on `127.0.0.1`, auto-opened in the browser (Prometheus/Grafana/pgweb pattern) |
| HTTP server | Node `http` or a minimal router (e.g. Hono/Fastify) | serves the LocalQueryAPI (already loopback per Architecture §2) + static UI assets |
| UI build | **Vite 6.x** | framework-agnostic; builds the static SPA the daemon serves |
| UI framework | React 18.x + TypeScript | standard web charting/table libs; specific chart lib deferred to Session 11 |
| Test | **Vitest 2.x** | daemon + parser unit/fixture tests (Architecture §14 corpus) |
| Lint/format | **Biome 1.x** | single tool (lint + format); keeps CI + CLAUDE.md footprint small |
| GitHub client | Octokit (REST + GraphQL) | GraphQL needed for review-thread resolution (S3); note: the outcomes transport uses the `gh` CLI instead (see ADR-103 addendum) |
| Tokenizer | deferred to ADR-105 | ADR-105 selects by measured agreement on the corpus; do not pin here |

## Decision

**Confirm option (a) for language/runtime/DB: TypeScript on Node 22 LTS + better-sqlite3, one
daemon process, direct SQL, no workers** (carries AD-107). The SQLite schema and LocalQueryAPI
are the stable seams; a P1 governance daemon may later be a different process/language behind
those seams without disturbing the MVP (AD-110) — so no stack choice here is load-bearing beyond
Phase 0/1.

**Desktop shell — DEVIATE from §16: no native shell for the MVP.** The daemon serves the SPA on
`127.0.0.1` and auto-opens the browser (the Prometheus/Grafana/Jaeger/pgweb pattern). This was
decided by external research (2026-08-21, `docs/adr/ADR-100-shell-research-2026-08-21.md`) and human
sign-off. Rationale: because §2 already makes the daemon a *separate* process, a native window buys
almost nothing for a **developer** tool in the MVP; the localhost path adds zero shell toolchain,
sidesteps the native-module single-binary packaging problem entirely (better-sqlite3 loads fine
from `node_modules` when there is nothing to bundle it *into*), and its footprint is a browser tab —
which is exactly what a waste-reduction product should model. The research found the specific
**Tauri v2 + Node sidecar + native better-sqlite3** combination to be the trap (underdocumented
`pkg`/SEA + `bindings` packaging edge; first-run `.node` extraction from AppData trips Windows AV);
**Electron** is the pre-approved fallback if a native window is later required (well-trodden
`@electron/rebuild` + `asarUnpack` path, at a ~130 MB footprint cost).

The native-shell choice (Tauri vs Electron) and the single-binary distribution story are **deferred
to a Phase-1 packaging spike**, which at that point also evaluates Node 22+'s built-in `node:sqlite`
(no native addon) — adopting it would make single-binary packaging trivial and *re-open* Tauri. We
keep better-sqlite3 now (it matches every planning doc and has no packaging cost under the localhost
path); switching is a Phase-1 decision, not an MVP one.

## Consequences (what P0 now builds / does not build; new risks; test obligations)

- **Session 2 builds:** a Node/TS daemon entrypoint that prints its version, opens an in-memory
  better-sqlite3 DB, and serves a hello-page on `127.0.0.1` (proving the localhost delivery path);
  CI running Biome lint + a daemon smoke test + `vitest` (empty suite ok). `src/` stays empty
  otherwise until the Phase-1 gate.
- **Serves, not embeds:** the browser talks to the daemon over loopback HTTP; the daemon is runnable
  and testable headless with no browser present (keeps the CI smoke test UI-free and preserves the
  §2 topology). No Rust, no Electron, no native-module bundling in Phase 0.
- **New risk (localhost path):** no native menus/tray/file-association in MVP; if later required,
  retrofit Electron (or Tauri, if `node:sqlite` is adopted). Loopback bind only — no auth surface,
  but the daemon must refuse non-loopback origins.
- **Test obligation:** the daemon smoke test must run **without** a browser (headless) — hit the
  loopback endpoint programmatically — so ingestion/parser correctness (Architecture §14) is never
  coupled to UI delivery.
- **Not built:** no native shell (deferred to a Phase-1 packaging spike); no Rust/Go daemon; no
  tokenizer pin (S5 owns it); no chart-library choice yet (Session 11 owns it); no packaged
  installer in Phase 0.

## Revisit trigger (what observed fact would reopen this)

- A native window becomes an MVP requirement (tray, global hotkey, file-association, or "localhost
  in a browser" tests badly with users) → adopt **Electron** (pre-approved fallback; record the flip
  in this ADR's status). Reconsider Tauri only alongside a `node:sqlite` switch that removes the
  native-addon packaging blocker.
- better-sqlite3 cannot meet the §15 dashboard p95 (≤250 ms) or back-scan (NFR-104) targets at
  measured corpus scale → reopen the DB-driver choice (not the language). `node:sqlite` is the first
  alternative to evaluate (also unblocks single-binary packaging).
- A P1 governance-daemon requirement (Cedar/nono, promoted from v4.4.3) needs in-process FFI the
  Node daemon can't provide → that P1 daemon may be re-languaged behind the SQLite/LocalQueryAPI
  seams; the MVP stack is unaffected (AD-110).

## Phase-1e packaging spike addendum (2026-08-27)

The bounded O8 spike ran against local `main` at `6af2e1d8a8ece1c69a8fbc7e57e2722b2dc34549`
on Windows x64 with Node `v24.14.0` and npm `11.9.0`. It measured the localhost/folder
control, Node SEA, and maintained `@yao-pkg/pkg` with both `better-sqlite3` and `node:sqlite`
against a synthetic CommonJS HTTP probe. Each of seven candidates ran five isolated trials;
all 35 trials passed the database/API/UI contract and child/database/native cleanup checks.
The corrected v2 measurement reports are validated by `aggregate.cjs` before the aggregate is
written to `spikes/phase-1e-packaging/results.json`; methodology and limits are in `FINDINGS.md`.

### Findings

- `node:sqlite` passed the synthetic migration, prepared-binding, integer, WAL/FK,
  query-only, online-backup, and static-serving checks. It has no serialize/deserialize
  surface, so replacing the production driver would require an explicit adapter and
  migration design.
- `better-sqlite3` passed the core contract and native-addon loading check. Its
  `serialize()` round-trip failed for the WAL fixture with `unable to open database file`
  but passed in a no-WAL control; this is a compatibility limitation to preserve or redesign
  deliberately, not evidence to change the current production driver.
- SEA worked for both drivers. The better-sqlite3 candidate required extraction of the native
  addon to a real filesystem path, a matching target ABI, and parent-side cleanup after child
  exit on Windows.
- `@yao-pkg/pkg` `6.22.0` worked with embedded UI assets. Its Node 24 target resolved to
  `24.18.1` and required a writable `PKG_NATIVE_CACHE_PATH` for better-sqlite3; its Node 22
  target resolved to `22.23.2` and could not load the locally installed Node 24 addon.
  The single-file candidates measured 93,471,232 bytes for SEA, 107,158,890 bytes for the
  Node 24 package, and 72,741,282 bytes for the Node 22 package.

### Decision

Retain localhost/folder distribution with `better-sqlite3` for the MVP. This spike does not
adopt SEA, `@yao-pkg/pkg`, `node:sqlite`, Tauri, Electron, or a production migration. A later
single-binary prototype remains possible, but any native package must pin and rebuild the
addon for its target ABI and provide a writable extraction/cache location. A future
`node:sqlite` migration must first provide an explicit adapter for the missing
serialize/deserialize surface and receive fresh production-scale validation; only then should
the single-binary and Tauri questions be reopened.

### Evidence limits

The startup p95 values are synthetic process-to-ready measurements, not the NFR-102
install-to-populated-dashboard requirement. The spike did not measure clean-machine install,
real transcript back-scan, antivirus behavior, installer UX, or production-scale NFR-105
queries. No production source, operator data, credentials, browser, daemon, or port `47821`
was used.

## Change log

- 2026-08-21 (Session 12): Fixed stale cross-reference: tokenizer-pin note updated from "S5" to "ADR-105" (the actual decision record for the tokenizer selection) — source: SG-S5-05
