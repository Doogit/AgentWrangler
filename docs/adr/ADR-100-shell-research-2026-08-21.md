# ADR-100 supporting research — desktop shell / UI delivery (2026-08-21)

External research backing the ADR-100 decision to **serve a localhost web UI (no native shell) for
the MVP** and defer the native-shell choice to a Phase-1 packaging spike. Conducted by a research
subagent; sources are 2025–2026.

## Situation that shaped the answer
The backend is a **standalone Node/TS daemon** (better-sqlite3, a native C++ addon) that runs as its
own process and talks to the UI over loopback (Architecture §2). The "shell" is therefore only a
window + fetch bridge — the daemon runs separately regardless. Platform priority: Windows 11.

## Evidence table

| Option | Key facts | Sources |
|---|---|---|
| **Tauri v2 + Node sidecar** | v2 stable (Oct 2024), 2.11.x by mid-2026, security-audited; WebView2 preinstalled on Win11; installer <10 MB, ~30–40 MB RAM. **But** packaging a Node daemon with a native addon via `pkg`/SEA extracts `.node` to `%LOCALAPPDATA%` on first run (not self-contained); `better-sqlite3` uses `bindings` dynamic path detection that `pkg` can miss → manual asset config; no official Tauri example covers native-addon sidecars. | v2.tauri.app/learn/sidecar-nodejs, yao-pkg native-addons guide, Tauri 2.0 release, WebView2 reference |
| **Electron + better-sqlite3** | `@electron/rebuild` + electron-builder + `asarUnpack` for `.node` is the well-trodden path; MSVC build tools required at dev time; installer 100–150 MB, RAM 150–300 MB. electron-builder 25.x had Windows native-rebuild regressions → pin 24.13.3. | electron-builder #5317, better-sqlite3 #1111, node-gyp rebuild blog (Jan 2026) |
| **Browser localhost (no shell)** | Daemon serves `127.0.0.1:<port>`, user opens in browser. Zero shell toolchain, zero native-addon packaging concern, loopback-only bind = no auth/CORS risk. Production pattern for Prometheus, Grafana, Jaeger, pgweb. Trade-off: no tray/menubar/file-assoc; daemon auto-opens browser on start. | pgweb usage, localhost-dashboard pattern |
| **Node SEA** (packaging alt) | Stable since Node 22; `--build-sea` one-step in Node 25.5 (Jan 2026). Native addons still can't be embedded in the blob — same extraction-to-disk limit as `pkg`. | Node SEA docs, Joyee Cheung blog (Jan 2026) |
| **`node:sqlite` (escape hatch)** | Node 22+ ships built-in SQLite — no native addon, no `.node`, no extraction. Would make SEA/`pkg`/Tauri-sidecar packaging trivial. Worth evaluating in the Phase-1 packaging spike if single-binary distribution is wanted. | nodejs.org sqlite docs, node built-in sqlite 2026 guide |

## Risk that would sink each option
- **Tauri + Node sidecar:** Windows Defender/enterprise AV flags first-run extraction + `dlopen` of a native `.node` from AppData (known `pkg` issue); plus cross-compiling `better-sqlite3` prebuilds per platform triple on top of the Rust toolchain.
- **Electron:** ~130 MB footprint on a waste-reduction product; recurring electron-builder Windows native-rebuild regressions need version pinning.
- **Browser localhost:** retrofit needed if tray/hotkey/file-drop ever required; no single-binary story for the daemon (CLI/startup script) — fine for a developer audience.

## Recommendation (accepted)
1st: **Browser localhost, no native shell** for the MVP. Deciding factor: the backend is already a
separate process and the audience is developers — a native window adds ~nothing in MVP while adding
toolchain + packaging cost.
Fallback: **Electron** if a native window becomes required.
Avoid: **Tauri v2 + Node sidecar + native better-sqlite3** for the MVP — the underdocumented rough
edge. (Tauri itself is fine for self-contained Rust+webview apps.)

## One-line answer
Is the Tauri Node-sidecar-with-native-module path proven enough to bet an MVP on? **No — that's the
trap;** take the Electron path or skip the shell entirely.
