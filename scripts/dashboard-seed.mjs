/**
 * scripts/dashboard-seed.mjs — launch the dashboard on the SHARED SEED DB.
 *
 * Purpose: give the operator (and any agent) a one-command way to walk the UI
 * on the deterministic shared seed — the SAME data used by `npm run verify:app`
 * and the automated tests — WITHOUT touching the live daemon on 2929 or the
 * live DB at ~/.agentwrangler/db.sqlite.
 *
 * Use this for the Phase-1 walkthrough (H1) and any manual/visual check that
 * must match the test/demo fixtures. Use the `dashboard` skill (live DB, port
 * 2929) only for real-spend data.
 *
 * What it does:
 *   1. Builds the UI (via node → vite directly, so it works even when
 *      node_modules/.bin is absent).
 *   2. Rebuilds the shared seed into .verify-seed/seed.sqlite (deterministic).
 *   3. Starts a daemon on a free port (default 47822) pointed at the seed DB
 *      with an EMPTY scan root — it never scans the live transcript corpus.
 *   4. Waits for readiness, opens the browser, and LEAVES the daemon running.
 *
 * Usage:  npm run dashboard:seed    (override port: AW_SEED_PORT=NNNNN)
 *
 * Stop the seed daemon when done: it is a normal node process on the seed port
 * (Windows: `Get-NetTCPConnection -LocalPort 47822 | %{ Stop-Process -Id $_.OwningProcess -Force }`).
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED_DIR = path.join(REPO, ".verify-seed");
const SEED_DB = path.join(SEED_DIR, "seed.sqlite");
const SCAN_ROOT = path.join(SEED_DIR, "scan-root");
const DAEMON_LOG = path.join(SEED_DIR, "daemon.log");
const UI_ROOT = path.join(REPO, "dist", "ui");
const VITE_BIN = path.join(REPO, "node_modules", "vite", "bin", "vite.js");
const SEED_SCRIPT = path.join(REPO, "scripts", "build-shared-seed.ts");
const DAEMON_ENTRY = path.join(REPO, "src", "daemon", "index.ts");
const DEFAULT_PORT = Number(process.env.AW_SEED_PORT ?? 47822);

function die(msg) {
  process.stderr.write(`dashboard:seed — ${msg}\n`);
  process.exit(1);
}

/** True if something is already listening on 127.0.0.1:port. */
async function portInUse(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(true));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, "127.0.0.1");
  });
}

/** First free port at or above `start`. */
async function freePortFrom(start) {
  for (let p = start; p < start + 50; p++) {
    if (!(await portInUse(p))) return p;
  }
  die(`no free port in [${start}, ${start + 50})`);
}

async function get(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ status: 0, body: "" });
    });
  });
}

// ── 1. Build UI ────────────────────────────────────────────────────────────
process.stdout.write("dashboard:seed — building UI…\n");
const build = spawnSync(process.execPath, [VITE_BIN, "build"], {
  cwd: REPO,
  encoding: "utf8",
  timeout: 180_000,
});
if (build.status !== 0) {
  die(`UI build failed (exit ${build.status})\n${(build.stderr ?? "").slice(-800)}`);
}
if (!fs.existsSync(path.join(UI_ROOT, "index.html"))) {
  die("UI build produced no dist/ui/index.html");
}

// ── 2. Rebuild shared seed ───────────────────────────────────────────────────
process.stdout.write("dashboard:seed — building shared seed…\n");
fs.mkdirSync(SCAN_ROOT, { recursive: true });
if (fs.existsSync(SEED_DB)) fs.unlinkSync(SEED_DB);
const seed = spawnSync(process.execPath, ["--import", "tsx/esm", SEED_SCRIPT, SEED_DB], {
  cwd: REPO,
  encoding: "utf8",
  timeout: 60_000,
});
if (seed.status !== 0 || !seed.stdout.includes("seed-ok")) {
  die(`seed build failed (exit ${seed.status})\n${(seed.stderr ?? "").slice(-800)}`);
}

// ── 3. Start daemon on the seed ──────────────────────────────────────────────
const port = await freePortFrom(DEFAULT_PORT);
const url = `http://127.0.0.1:${port}`;
process.stdout.write(`dashboard:seed — starting daemon on ${url} (seed DB, empty scan root)…\n`);

const logFd = fs.openSync(DAEMON_LOG, "w");
const daemon = spawn(
  process.execPath,
  ["--import", "tsx/esm", DAEMON_ENTRY, "--db-path", SEED_DB, "--port", String(port), "--no-open"],
  {
    cwd: REPO,
    env: {
      ...process.env,
      AW_DB_PATH: SEED_DB,
      AW_SCAN_ROOT: SCAN_ROOT,
      AW_PORT: String(port),
      AW_NO_OPEN: "1",
      AW_NO_GH_TOKEN: "1",
      AW_USAGE_CLI: "off",
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  },
);
daemon.unref();

// ── 4. Wait for readiness ────────────────────────────────────────────────────
const deadline = Date.now() + 30_000;
let ready = false;
while (Date.now() < deadline) {
  const { status, body } = await get(`${url}/api/ready`);
  if (status === 200) {
    try {
      if (JSON.parse(body)?.ready === true) {
        ready = true;
        break;
      }
    } catch {
      // not ready yet
    }
  }
  await new Promise((r) => setTimeout(r, 700));
}
if (!ready) {
  process.stdout.write(
    `dashboard:seed — daemon not ready after 30s; check ${DAEMON_LOG}. It may still come up; try opening ${url}.\n`,
  );
} else {
  // ── 5. Open browser ────────────────────────────────────────────────────────
  const opener =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // browser open is best-effort
  }
}

process.stdout.write(
  `\ndashboard:seed — SEED dashboard: ${url}  (pid ${daemon.pid}, daemon left running)\n` +
    `  Data: shared seed (deterministic, = verify:app / tests). Live daemon on 2929 untouched.\n` +
    `  Stop when done (Windows): Get-NetTCPConnection -LocalPort ${port} | %{ Stop-Process -Id $_.OwningProcess -Force }\n`,
);
process.exit(0);
