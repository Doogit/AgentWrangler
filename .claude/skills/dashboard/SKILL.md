---
name: dashboard
description: Launch the AgentWrangler dashboard in one step — guarantees the daemon is running the CURRENT code on disk (rebuilds + restarts it when the running daemon is stale), then opens the browser. Use when the user asks to "launch the dashboard", "open the dashboard", "start the dashboard", "show me the dashboard", or "restart the dashboard".
allowed-tools: Bash(curl *), Bash(npm run *), Bash(start *), Bash(seq *), Bash(sleep *)
---

# Launch the AgentWrangler dashboard

Goal: when this finishes, the browser shows a dashboard backed by a daemon running the **current** code on disk — not a stale long-lived daemon.

Port **47821** · URL **http://127.0.0.1:47821** · repo root: the repository root · DB `~/.agentwrangler/db.sqlite`.

> **Platform:** the assessment/stop commands below are Windows PowerShell. On macOS/Linux, skip the
> PowerShell probe and just run `npm run build:ui && npm run daemon` from the repo root (stop any old
> daemon first with `pkill -f 'tsx.*daemon'` or by freeing port 47821), then open the URL.

**Key trap (why a plain "is it up?" check is wrong):** the daemon runs via `tsx`, which loads the source **once at boot and never hot-reloads**. A daemon that started before the latest edit serves stale code — old backend routes and an old UI — even though it still answers `200`. So "a daemon is listening" is NOT sufficient; you must check whether it started *after* the newest source change.

## Step 1 — assess daemon state

Run this (PowerShell) from the repo root:

```powershell
$conn = Get-NetTCPConnection -LocalPort 47821 -State Listen -ErrorAction SilentlyContinue
if (-not $conn) { 'DOWN'; return }
$p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
$newest = (Get-ChildItem -Recurse -File -Path src,package.json -ErrorAction SilentlyContinue |
  Measure-Object -Property LastWriteTime -Maximum).Maximum
if ($p.StartTime -lt $newest) { "STALE pid=$($p.Id) started=$($p.StartTime) newestSrc=$newest" }
else { "CURRENT pid=$($p.Id)" }
```

Branch on the result:

- **CURRENT** — the running daemon already loaded the latest code. Skip to Step 3 (just open the browser).
- **STALE** — the running daemon predates a source change. Stop it, then rebuild + relaunch (Step 2):
  ```powershell
  Stop-Process -Id <pid> -Force
  ```
  Then confirm port 47821 is free before continuing (re-run the `Get-NetTCPConnection` line; expect no output).
- **DOWN** — nothing is running. Rebuild + launch (Step 2).

## Step 2 — build the UI and start the daemon (for STALE-after-stop or DOWN)

From the repo root:

```
npm run build:ui
```

Then start the daemon **in the background** (do not block the turn on it):

```
npm run daemon
```

The daemon binds the port **immediately** and serves a loading page while it back-scans the
transcript corpus in the background (the scan yields between file batches), so it becomes reachable
within a second or two. Poll the readiness probe until it answers:

```
curl -s -m 3 http://127.0.0.1:47821/api/ready -o /dev/null -w "%{http_code}"
```

Keep polling at ~1 s intervals until the output is `200` (a couple of tries is normal). That means
the port is bound and the loading page is up — the dashboard is safe to open now; the loading page
reloads itself to the full UI once `/api/ready` reports `{ ready: true }`. If the port never binds,
read the daemon's background log, report the error, and stop.

## Step 3 — open the browser

```
start http://127.0.0.1:47821
```

## Step 4 — report

Print the URL and which path ran, so the user knows whether the daemon was reused or replaced:

```
Dashboard: http://127.0.0.1:47821  — <already current | restarted (was stale) | started (was down)>
```

> **Never** run `npm run daemon` while a daemon is already listening on 47821 — it fails with `EADDRINUSE` and causes a transient database lock. Only Step 2 starts a daemon, and it is reached only after Step 1 returned DOWN, or STALE and you stopped the old process.
