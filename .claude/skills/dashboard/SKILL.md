---
name: dashboard
description: Launch the AgentWrangler dashboard in one step — guarantees the daemon is running the CURRENT code on disk (rebuilds + restarts it when the running daemon is stale), then opens the browser. Use when the user asks to "launch the dashboard", "open the dashboard", "start the dashboard", "show me the dashboard", or "restart the dashboard".
allowed-tools: Bash(curl *), Bash(git rev-parse *), Bash(npm run *), Bash(node scripts/daemon/restart-detached.mjs*), Bash(start *), Bash(open *), Bash(xdg-open *), Bash(seq *), Bash(sleep *)
---

# Launch the AgentWrangler dashboard

Goal: when this finishes, the browser shows a dashboard backed by a daemon running the **current** code on disk, not a stale long-lived daemon.

Port **2929** (this skill assumes the default port) · URL **http://127.0.0.1:2929** · run from the repository root · DB `~/.agentwrangler/db.sqlite`.

**Do not start the daemon as a background task of a Claude Code session.** `scripts/daemon/restart-detached.mjs`
starts the daemon as a detached process that no terminal or session owns, logging to
`~/.agentwrangler/daemon.log`. If a session owns the daemon as a background task, it gets a "failed"
notification whenever the daemon is replaced. In a normal terminal, `npm run daemon` is fine.

**Why "is it up?" is not enough:** the daemon runs via `tsx`, which loads the source once at boot and never hot-reloads. A daemon that started before your latest edit serves old routes and an old UI, even though it still answers `200`. Check whether it started *after* the newest source change.

**The repo root must be on `main`.** Both this skill and the daemon build and serve whatever the repo root has checked out. If the root is on an old branch, you serve stale code and the freshness check in Step 1 is useless, because that branch's `src` never changes. Live DB data still updates, so it looks like your changes "don't show up".

## Step 0 — confirm the repo root is on `main`

PowerShell (Windows):

```powershell
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') {
  "ABORT: repo root is on '$branch', not 'main'. You would build/serve stale code."
  "Fix first: 'git checkout main' at the repo root (if main is checked out in a worktree, remove that worktree first)."
  return
}
"root is on main @ $(git rev-parse --short HEAD)"
```

bash (macOS/Linux):

```bash
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "ABORT: repo root is on '$branch', not 'main'. You would build/serve stale code."
  echo "Fix first: 'git checkout main' at the repo root."
else
  echo "root is on main @ $(git rev-parse --short HEAD)"
fi
```

Go on only if the root is on `main`.

## Step 1 — check whether the daemon is current

PowerShell (Windows):

```powershell
$conn = Get-NetTCPConnection -LocalPort 2929 -State Listen -ErrorAction SilentlyContinue
if (-not $conn) { 'DOWN'; return }
$p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
$newest = (Get-ChildItem -Recurse -File -Path src,package.json -ErrorAction SilentlyContinue |
  Measure-Object -Property LastWriteTime -Maximum).Maximum
if ($p.StartTime -lt $newest) { "STALE pid=$($p.Id) started=$($p.StartTime) newestSrc=$newest" }
else { "CURRENT pid=$($p.Id)" }
```

bash (macOS/Linux):

```bash
pid=$(lsof -ti tcp:2929 -sTCP:LISTEN | head -1)
if [ -z "$pid" ]; then echo DOWN; else
  started=$(date -d "$(ps -o lstart= -p "$pid")" +%s 2>/dev/null || date -j -f "%a %b %e %T %Y" "$(ps -o lstart= -p "$pid")" +%s)
  newest=$(find src package.json -type f -exec stat -c %Y {} + 2>/dev/null | sort -n | tail -1)
  [ -z "$newest" ] && newest=$(find src package.json -type f -exec stat -f %m {} + | sort -n | tail -1)
  if [ "$started" -lt "$newest" ]; then echo "STALE pid=$pid"; else echo "CURRENT pid=$pid"; fi
fi
```

- **CURRENT** — the daemon already loaded the latest code. Go to Step 3.
- **STALE** or **DOWN** — run Step 2. Don't stop the old daemon yourself; the script does it.

## Step 2 — rebuild and restart, detached (for STALE or DOWN)

From the repo root, run in the **foreground**:

```
node scripts/daemon/restart-detached.mjs
```

It builds the UI, stops the old daemon on port 2929, starts the new one detached, and returns once the port answers (boot can take a minute or two on a large database). Exit 0 means it is up; the loading page reloads itself to the full UI once `/api/ready` reports `{ ready: true }`. If another restart is already in progress (`~/.agentwrangler/daemon-restart.lock`), the script waits for it instead of starting another. Exit 1 means it failed: read the tail of `~/.agentwrangler/daemon.log`, report the error, and stop.

## Step 3 — open the browser

| OS | Command |
|---|---|
| Windows | `start http://127.0.0.1:2929` |
| macOS | `open http://127.0.0.1:2929` |
| Linux | `xdg-open http://127.0.0.1:2929` |

## Step 4 — report

Print the URL and which path ran, so the user knows whether the daemon was reused or replaced:

```
Dashboard: http://127.0.0.1:2929  — <already current | restarted (was stale) | started (was down)>
```

## Seed mode — demo data instead of your live DB

To try the dashboard on deterministic demo data, or for any manual check that must match the test fixtures, run:

```
npm run dashboard:seed
```

This builds the UI, rebuilds the shared seed into `.verify-seed/seed.sqlite` (the same data `npm run verify:app` and the tests use), and starts a separate daemon on port **47822** (`AW_SEED_PORT` overrides, or the next free port) with an empty scan root. It never scans your transcripts and never touches the daemon on 2929 or `~/.agentwrangler/db.sqlite`. It waits for readiness, opens the browser, prints the URL and pid, and leaves the daemon running.

The seed is small (three ingest fixtures), so it shows few or no recommendations. It is good for layout and smoke checks, not for judging how useful the recommendations are.

Use **live mode** (Steps 0–4) when you want your real spend. Don't click recommendation action buttons on a live dashboard during automation.

Stop the seed daemon when done.

PowerShell (Windows):

```powershell
Get-NetTCPConnection -LocalPort 47822 | %{ Stop-Process -Id $_.OwningProcess -Force }
```

bash (macOS/Linux):

```bash
lsof -ti :47822 | xargs kill
```
