// Rebuilds the UI and restarts the live daemon (port 2929) as a DETACHED process that no
// terminal or Claude session owns, so replacing it never notifies anyone.
//
//   node scripts/daemon/restart-detached.mjs               # foreground: returns once the daemon answers
//   node scripts/daemon/restart-detached.mjs --background  # returns at once (used by the post-merge hook)
//
// Always builds and serves the MAIN checkout (first entry of `git worktree list`), never a worktree.
// A lock (~/.agentwrangler/daemon-restart.lock) makes a concurrent second run wait instead of racing.
// Every step is logged to ~/.agentwrangler/daemon.log, together with the daemon's own output.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 2929;
// Previous default port: a daemon still listening there holds the DB lock, so it is stopped too.
const LEGACY_PORT = 47821;
const LOCK_FRESH_MS = 15 * 60 * 1000; // a live holder older than this is treated as hung
const PORT_FREE_TIMEOUT_MS = 15_000;
// Boot work before listen() (weekly report, context probe) takes minutes on a large live DB.
const READY_TIMEOUT_MS = 5 * 60 * 1000;
const IS_WIN = process.platform === "win32";
// Paths whose change means the daemon runs different code. Same filter as scripts/hooks/post-merge.
const DAEMON_CODE = /^(src\/|package\.json$|package-lock\.json$)/m;

// A git hook exports GIT_DIR/GIT_INDEX_FILE etc.; the build and the daemon must not inherit them.
for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];

const awDir = join(homedir(), ".agentwrangler");
mkdirSync(awDir, { recursive: true });
const lockPath = join(awDir, "daemon-restart.lock");
const logFd = openSync(join(awDir, "daemon.log"), "a");

const log = (msg) =>
  writeSync(logFd, `[${new Date().toISOString()}] restart(${process.pid}): ${msg}\n`);
const say = (msg) => {
  log(msg);
  console.log(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function listenerPid(port = PORT) {
  if (IS_WIN) {
    const out =
      spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true }).stdout ??
      "";
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] === "LISTENING" && cols[1]?.endsWith(`:${port}`)) return Number(cols[4]);
    }
    return null;
  }
  const out =
    spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      windowsHide: true,
    }).stdout ?? "";
  return Number(out.trim().split("\n")[0]) || null;
}

function killTree(pid) {
  if (IS_WIN) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  else process.kill(pid, "SIGTERM");
}

async function readyState() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/ready`, {
      signal: AbortSignal.timeout(2000),
    });
    return (await res.json()).ready ? "ready" : "bound";
  } catch {
    return "down";
  }
}

// Waits for the port to answer. "bound" (loading page up, back-scan still running) is success too.
async function waitReady(childPid) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let state = "down";
  while (Date.now() < deadline) {
    state = await readyState();
    if (state !== "down") return state;
    if (childPid && !alive(childPid)) {
      // Our child exited (e.g. EADDRINUSE). Fine only if some other daemon now serves the port.
      await sleep(1000);
      return await readyState();
    }
    await sleep(1000);
  }
  return state;
}

function takeLock() {
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    closeSync(fd);
    return null;
  } catch {
    let held = {};
    try {
      held = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch {}
    if (Date.now() - held.ts < LOCK_FRESH_MS && alive(held.pid)) return held;
    rmSync(lockPath, { force: true }); // stale: holder died or is too old
    return takeLock();
  }
}

// Main checkout = first worktree listed. Builds and serves only there.
const here = fileURLToPath(new URL(".", import.meta.url));
const root = git(here, "worktree", "list", "--porcelain")
  .split(/\r?\n/)[0]
  .replace(/^worktree /, "");

if (process.argv.includes("--background")) {
  spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  }).unref();
  log("spawned detached restart");
  process.exit(0);
}

const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") {
  say(`ABORT: main checkout ${root} is on '${branch}', not 'main'; would serve stale code`);
  process.exit(1);
}

const held = takeLock();
if (held) {
  say(`restart already in progress (pid ${held.pid}); waiting for it instead of starting another`);
  // The old daemon may still answer while the holder builds: wait for the holder to finish first.
  while (existsSync(lockPath) && alive(held.pid)) await sleep(1000);
  const state = await waitReady(null);
  say(`daemon on :${PORT} is ${state}`);
  process.exit(state === "down" ? 1 : 0);
}

let code = 1;
try {
  // Loop once more if a merge that changed daemon code landed mid-restart (docs-only moves don't count).
  for (
    let head = null;
    head === null || DAEMON_CODE.test(git(root, "diff", "--name-only", head, "HEAD"));
  ) {
    head = git(root, "rev-parse", "HEAD");
    say(`building UI at ${root} @ ${head.slice(0, 8)}`);
    const build = spawnSync("npm run build:ui", {
      cwd: root,
      shell: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    if (build.status !== 0)
      throw new Error(`build:ui failed (exit ${build.status}); old daemon left running`);

    const legacy = listenerPid(LEGACY_PORT);
    if (legacy) {
      log(`stopping old-port daemon tree pid ${legacy} on :${LEGACY_PORT}`);
      killTree(legacy);
      const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
      while (alive(legacy) && Date.now() < deadline) await sleep(250);
      if (alive(legacy)) throw new Error(`pid ${legacy} on :${LEGACY_PORT} still running after stop`);
    }

    const old = listenerPid();
    if (old) {
      log(`stopping old daemon tree pid ${old}`);
      killTree(old);
      const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
      // Wait for the process too, not just the port: the new daemon exits while the old pid holds <db>.lock.
      while ((listenerPid() || alive(old)) && Date.now() < deadline) await sleep(250);
      if (listenerPid()) throw new Error(`port ${PORT} still held after stopping pid ${old}`);
      if (alive(old)) throw new Error(`pid ${old} still running after stop; it holds the DB lock`);
    }

    const child = spawn(process.execPath, ["--import", "tsx/esm", "src/daemon/index.ts"], {
      cwd: root,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    child.unref();
    log(`started daemon pid ${child.pid}`);

    const state = await waitReady(child.pid);
    if (state === "down")
      throw new Error(`daemon never answered on :${PORT}; see ${join(awDir, "daemon.log")}`);
    say(
      `daemon on :${PORT} is ${state === "ready" ? "ready" : "up (back-scan still running)"}, pid ${listenerPid()}`,
    );
  }
  code = 0;
} catch (e) {
  say(`FAILED: ${e.message}`);
} finally {
  rmSync(lockPath, { force: true });
}
process.exit(code);
