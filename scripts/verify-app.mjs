/**
 * scripts/verify-app.mjs — mechanical smoke gate for AgentWrangler.
 *
 * Checks:
 *   (a) dist/ui exists; hashed JS asset extracted from index.html.
 *   (b) Seed sqlite built; empty scan-root created.
 *   (c) Daemon spawned on a free port; /api/ready=true within 30 s.
 *   (d) Each read-only API endpoint → 200 + parseable JSON.
 *   (e) Served index.html references same hashed asset as on-disk build;
 *       hashed asset itself → 200.
 *   (f) Headless Chrome CDP: each hash route loads with real content and
 *       zero app-origin console errors.  Skipped (TODO) when Chrome is absent.
 *       P1-U5: waits ≤10 s for #main-content to leave its skeletons and
 *       pending sections, fails on any widget/section error state, and checks
 *       the #/overview KPI text against SQL on the seed DB (M5 oracle).
 *   (g) Route latency budgets (src/daemon/route-budgets.ts, P3-U1): ENFORCING.
 *       Run from step (h) while the scan-root backfill is ingesting; each budgeted
 *       GET sampled 50x, median of 3 attempts' p95 <= budget, /api/perf loop p99 <= 50 ms.
 *   (h) Scan-root mode (P2-U1): a second daemon on a fresh DB over a small
 *       generated corpus really backfills at boot; asserts shipped behavior only.
 *
 * Usage:
 *   npm run verify:app
 *
 * Exit 0 when all checks pass; non-zero on first fatal error or any FAIL.
 */

import { execSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY_DIR = path.join(REPO, ".verify");
const DB_PATH = path.join(VERIFY_DIR, "verify.sqlite");
const SCAN_ROOT = path.join(VERIFY_DIR, "scan-root");
const UI_ROOT = path.join(REPO, "dist", "ui");
const SEED_SCRIPT = path.join(REPO, "scripts", "build-shared-seed.ts");
const DAEMON_ENTRY = path.join(REPO, "src", "daemon", "index.ts");

// Step (f) waits this long for a route to leave its skeletons (P1-U5, review M10).
const SETTLE_TIMEOUT_MS = 10_000;
const SETTLE_POLL_MS = 250;
const DAY_MS = 86_400_000;
/** Earliest window end a memoized Overview section can carry (the KPI oracle's candidates). */
const VERIFY_STARTED_MS = Date.now();

// Hash-route smoke checks (step f).
const HASH_ROUTES = [
  "#/overview",
  "#/recommendations",
  "#/sessions",
  "#/workspaces",
  "#/settings",
  "#/judge-setup",
  "#/diagnostics",
  "#/glossary",
];

// Read-only API endpoints (step d).
const API_ENDPOINTS = [
  "/api/ready",
  "/api/status",
  "/api/version",
  "/api/overview",
  "/api/overview-view",
  "/api/workspaces",
  "/api/delivery",
  "/api/cost-per-success",
  "/api/practices",
  "/api/efficiency-headroom",
  "/api/live",
  "/api/hot-sessions",
  "/api/recommendations",
  "/api/recommendation-queue",
  "/api/judge-setup",
  "/api/diagnostics",
  "/api/reports",
  "/api/self-percentiles/weekly",
];

// ── State ────────────────────────────────────────────────────────────────────

/** @type {{ id: string; pass: boolean; detail: string }[]} */
const results = [];
/** @type {import("node:child_process").ChildProcess | null} */
let daemonProc = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function record(id, pass, detail = "") {
  results.push({ id, pass, detail });
  const sym = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  const suffix = detail ? `  ${detail}` : "";
  process.stdout.write(`  [${sym}] ${id}${suffix}\n`);
}

function killDaemon() {
  if (!daemonProc || daemonProc.exitCode !== null || daemonProc.killed) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /T /F /PID ${daemonProc.pid}`, { stdio: "ignore" });
    } else {
      process.kill(-daemonProc.pid, "SIGTERM");
    }
  } catch {
    // Best-effort.
  }
  daemonProc = null;
}

function cleanup() {
  killDaemon();
  try {
    fs.rmSync(VERIFY_DIR, { recursive: true, force: true });
  } catch {
    // Non-fatal.
  }
}

/** Reserve a free TCP port via a temporary server. */
async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** GET <url> → { status, body: string }. Resolves even on HTTP errors. */
async function get(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Poll GET url until predicate(body) is true, or timeout. */
async function pollUntil(url, pred, timeoutMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastBody = "";
  while (Date.now() < deadline) {
    try {
      const { status, body } = await get(url, intervalMs);
      lastBody = body;
      if (status === 200 && pred(body)) return { ok: true, body };
    } catch {
      // Daemon may not be listening yet.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, body: lastBody };
}

// ── (a) Build check ────────────────────────────────────────────────────────────

process.stdout.write("\nverify:app — mechanical smoke gate\n\n");
process.stdout.write("(a) dist/ui check\n");

if (!fs.existsSync(path.join(UI_ROOT, "index.html"))) {
  process.stdout.write(
    "  dist/ui/index.html not found — run `npm run build:ui` then re-run verify:app\n",
  );
  process.exit(1);
}
record("dist/ui exists", true);

const indexHtmlDisk = fs.readFileSync(path.join(UI_ROOT, "index.html"), "utf8");
// Extract hashed JS asset: e.g. /assets/index-AbCdEfGh.js
const assetMatch = indexHtmlDisk.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
if (!assetMatch) {
  record("hashed JS asset", false, "could not find /assets/index-*.js in dist/ui/index.html");
  cleanup();
  process.exit(1);
}
const hashedAsset = `/assets/${assetMatch[1]}`;
record("hashed JS asset", true, hashedAsset);

// ── (b) Seed ──────────────────────────────────────────────────────────────────

process.stdout.write("\n(b) seed DB\n");

try {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  fs.mkdirSync(SCAN_ROOT, { recursive: true });
  // Remove stale DB if present.
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
} catch (e) {
  record("create verify dirs", false, String(e));
  process.exit(1);
}
record("verify dirs created", true);

const seedResult = spawnSync(
  process.execPath,
  ["--import", "tsx/esm", SEED_SCRIPT, DB_PATH],
  { cwd: REPO, encoding: "utf8", timeout: 60_000 },
);
if (seedResult.status !== 0 || !seedResult.stdout.includes("seed-ok")) {
  record(
    "seed DB",
    false,
    `exit ${seedResult.status} — ${seedResult.stderr.slice(-500)}`,
  );
  cleanup();
  process.exit(1);
}
record("seed DB", true, "real-fixture seed complete");

// ── (c) Daemon ─────────────────────────────────────────────────────────────────

process.stdout.write("\n(c) daemon\n");

let port;
try {
  port = await findFreePort();
} catch (e) {
  record("find free port", false, String(e));
  process.exit(1);
}

daemonProc = spawn(
  process.execPath,
  ["--import", "tsx/esm", DAEMON_ENTRY, "--no-open"],
  {
    cwd: REPO,
    env: {
      ...process.env,
      AW_DB_PATH: DB_PATH,
      AW_UI_ROOT: UI_ROOT,
      AW_SCAN_ROOT: SCAN_ROOT,
      AW_PORT: String(port),
      AW_NO_OPEN: "1",
      // Suppress any OAuth/GH token prompt that could hang.
      AW_NO_GH_TOKEN: "1",
      // USAGE-CLI: never spend the user's /usage budget from a test daemon.
      AW_USAGE_CLI: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  },
);

daemonProc.once("error", (err) => {
  record("daemon spawn", false, err.message);
});
daemonProc.once("exit", (code) => {
  if (daemonProc !== null) {
    // Exited unexpectedly.
    daemonProc = null;
  }
});

const BASE = `http://127.0.0.1:${port}`;
const readyUrl = `${BASE}/api/ready`;

const { ok: isReady, body: lastReadyBody } = await pollUntil(
  readyUrl,
  (b) => {
    try {
      return JSON.parse(b)?.ready === true;
    } catch {
      return false;
    }
  },
  30_000,
);

if (!isReady) {
  record("daemon ready", false, `last /api/ready body: ${lastReadyBody.slice(0, 200)}`);
  cleanup();
  process.exit(1);
}
record("daemon ready", true, `port ${port}`);

// ── (d) API endpoints ─────────────────────────────────────────────────────────

process.stdout.write("\n(d) API endpoints\n");

let apiFailures = 0;
for (const ep of API_ENDPOINTS) {
  try {
    const { status, body } = await get(`${BASE}${ep}`, 10_000);
    if (status !== 200) {
      record(`GET ${ep}`, false, `HTTP ${status}`);
      apiFailures++;
      continue;
    }
    try {
      JSON.parse(body);
    } catch {
      record(`GET ${ep}`, false, "not parseable JSON");
      apiFailures++;
      continue;
    }
    // Reject explicit 500 error bodies (e.g. { error: "Internal error" }).
    const parsed = JSON.parse(body);
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof parsed.error === "string" &&
      parsed.error.toLowerCase().includes("internal")
    ) {
      record(`GET ${ep}`, false, `500-level body: ${body.slice(0, 120)}`);
      apiFailures++;
      continue;
    }
    record(`GET ${ep}`, true);
  } catch (e) {
    record(`GET ${ep}`, false, String(e).slice(0, 120));
    apiFailures++;
  }
}

// ── (e) Served bundle hash check ─────────────────────────────────────────────

process.stdout.write("\n(e) served bundle hash\n");

let bundleCheckFailed = false;
try {
  const { status: rootStatus, body: servedIndex } = await get(`${BASE}/`, 8_000);
  if (rootStatus !== 200) {
    record("served index.html", false, `HTTP ${rootStatus}`);
    bundleCheckFailed = true;
  } else {
    const servedMatch = servedIndex.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
    if (!servedMatch) {
      record("served index.html", false, "no hashed JS asset in served index.html");
      bundleCheckFailed = true;
    } else {
      const servedAsset = `/assets/${servedMatch[1]}`;
      if (servedAsset !== hashedAsset) {
        record(
          "served bundle == build",
          false,
          `served=${servedAsset} disk=${hashedAsset} — STALE SERVE`,
        );
        bundleCheckFailed = true;
      } else {
        record("served bundle == build", true, servedAsset);
      }
    }
  }
} catch (e) {
  record("served index.html", false, String(e).slice(0, 120));
  bundleCheckFailed = true;
}

// Fetch the hashed JS asset.
try {
  const assetUrl = `${BASE}${hashedAsset}`;
  const { status: assetStatus } = await get(assetUrl, 8_000);
  if (assetStatus !== 200) {
    record(`GET ${hashedAsset}`, false, `HTTP ${assetStatus}`);
    bundleCheckFailed = true;
  } else {
    record(`GET ${hashedAsset}`, true);
  }
} catch (e) {
  record(`GET ${hashedAsset}`, false, String(e).slice(0, 120));
  bundleCheckFailed = true;
}

// ── (f) Headless page loads ────────────────────────────────────────────────────

process.stdout.write("\n(f) headless page loads\n");

/** The Overview's money format (OverviewPage.tsx fmtUsd0), so the oracle compares text to text. */
function fmtUsd0(usd) {
  const digits = usd >= 1000 ? 0 : 2;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/**
 * M5 oracle (P1-U5): the Overview's 7d "Spend-equivalent" and "Sessions" KPI text must equal
 * values computed here, by SQL on the seed DB, independent of the daemon's query code.
 * The page's window is [end - 7 d, end) for an `end` the daemon picked at request time (or
 * when a memoized section was built), so a match at any of the candidate ends passes.
 * Returns null on a match, else a failure detail.
 */
function overviewKpiMismatch(kpis, candidateEndsMs) {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const stmt = db.prepare(
      `SELECT COALESCE(SUM(cost_equiv_u), 0) AS cost_u, COUNT(DISTINCT session_id) AS sessions
         FROM turns WHERE provisional = 0 AND ts >= ? AND ts < ?`,
    );
    const expected = candidateEndsMs.map((end) => {
      const row = stmt.get(new Date(end - 7 * DAY_MS).toISOString(), new Date(end).toISOString());
      return { spend: fmtUsd0(row.cost_u / 1_000_000), sessions: row.sessions.toLocaleString("en-US") };
    });
    const page = { spend: kpis["spend.equiv"], sessions: kpis["sessions.count"] };
    if (expected.some((e) => e.spend === page.spend && e.sessions === page.sessions)) return null;
    return `KPI text differs from seed SQL: page ${JSON.stringify(page)}, SQL ${JSON.stringify(expected[expected.length - 1])}`;
  } finally {
    db.close();
  }
}

/** SessionDetailPage / WorkspaceDetailPage money format (2 decimals, en-US grouping). */
function fmtUsd2(u) {
  return `$${(u / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * P1-U6a test 8: assembled-app interaction checks on the shared seed (non-rec triggers).
 *
 * Enforcing: the target content (not a skeleton) appears, its text equals seed SQL computed
 * here, no widget-error node renders, and each click makes the expected requests (0 for the
 * reads a hover prefetched), and M17 timing (click → first paint of the seeded header /
 * content, and the longest renderer long task): median of 3 attempts, all printed.
 * Returns the number of failed checks.
 */
async function interactionChecks({ cdp, on, sessionId }) {
  process.stdout.write("\n(f2) interaction checks (P1-U6a test 8; M17 timing)\n");
  let failed = 0;
  const fail = (id, detail) => {
    record(id, false, detail);
    failed++;
  };
  const evalJs = async (expression, awaitPromise = false) =>
    (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, sessionId))
      ?.result?.value;

  // Every /api request the page sends, with whether it finished.
  await cdp("Network.enable", {}, sessionId);
  /** @type {Array<{ id: string; url: string; finished: boolean }>} */
  const requests = [];
  const offSent = on("Network.requestWillBeSent", (p) => {
    const url = String(p.request?.url ?? "");
    if (url.startsWith(`${BASE}/api/`)) requests.push({ id: p.requestId, url: url.slice(BASE.length), finished: false });
  });
  const offDone = on("Network.loadingFinished", (p) => {
    const r = requests.find((x) => x.id === p.requestId);
    if (r) r.finished = true;
  });

  const SETTLED = `(() => {
    const m = document.getElementById('main-content');
    return !!m && m.querySelector('h1') != null && m.querySelectorAll('.skeleton').length === 0 &&
      m.querySelectorAll('[data-section-status="pending"]').length === 0;
  })()`;
  const ERRORS = `(() => { const m = document.getElementById('main-content');
    return m ? m.querySelectorAll('[data-section-status="error"], .async-error-state').length : 0; })()`;
  const kpi = (label) => `([...(document.getElementById('main-content')?.querySelectorAll('.kpi') ?? [])]
    .find((k) => (k.querySelector('.lbl')?.textContent ?? '').trim().startsWith(${JSON.stringify(label)}))
    ?.querySelector('.v')?.textContent ?? null)`;

  const waitFor = async (expression, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await evalJs(expression)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
    }
  };
  const loaded = () =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("load timeout")), 20_000);
      const off = on("Page.loadEventFired", () => {
        clearTimeout(t);
        off();
        resolve();
      });
    });
  /** A fresh page load of `route`, settled. Returns the navigation time. */
  const freshLoad = async (route) => {
    let fired = loaded();
    await cdp("Page.navigate", { url: "about:blank" }, sessionId);
    await fired;
    fired = loaded();
    const at = Date.now();
    await cdp("Page.navigate", { url: `${BASE}/${route}` }, sessionId);
    await fired;
    if (!(await waitFor(SETTLED, SETTLE_TIMEOUT_MS))) throw new Error(`${route} did not settle`);
    return at;
  };
  /** Click in the page and time (rAF) the first paint of `firstExpr` and of `readyExpr`. */
  const measureClick = (selector, firstExpr, readyExpr) =>
    evalJs(
      `new Promise((resolve) => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return resolve({ error: 'trigger not found' });
        let longest = 0;
        let obs = null;
        try {
          obs = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) longest = Math.max(longest, e.duration);
          });
          obs.observe({ type: 'longtask' });
        } catch {}
        const t0 = performance.now();
        let first = null;
        el.click();
        const tick = () => {
          const now = performance.now() - t0;
          if (first === null && (${firstExpr})) first = now;
          if (${readyExpr}) { obs?.disconnect(); return resolve({ firstMs: first, contentMs: now, longTaskMs: longest }); }
          if (now > 10000) { obs?.disconnect(); return resolve({ firstMs: first, contentMs: null, longTaskMs: longest }); }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })`,
      true,
    );
  const hover = async (selector) => {
    const pt = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!pt) return false;
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 }, sessionId);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y }, sessionId);
    return true;
  };
  // M17: the verdict is the median of the 3 attempts for each measure (not the min); all 3
  // attempts are printed. Enforcing since the M17 UI unit (was warn-only under P3-U1).
  const checkTiming = (id, attempts, budgetMs) => {
    const line = attempts
      .map((a) => `${a.firstMs === null ? "—" : a.firstMs.toFixed(0)}/${a.contentMs === null ? "—" : a.contentMs.toFixed(0)} ms (long task ${a.longTaskMs.toFixed(0)})`)
      .join(", ");
    const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const first = med(attempts.map((a) => a.firstMs ?? Number.POSITIVE_INFINITY));
    const content = med(attempts.map((a) => a.contentMs ?? Number.POSITIVE_INFINITY));
    const longTask = med(attempts.map((a) => a.longTaskMs));
    const over = first > 100 || content > budgetMs || longTask > 50;
    const detail = `attempts first/content ${line}; median ${first.toFixed(0)}/${content.toFixed(0)} ms, long task ${longTask.toFixed(0)} (bar: first ≤ 100, content ≤ ${budgetMs}, long task ≤ 50)`;
    if (over) fail(`M17 ${id}`, detail);
    else record(`M17 ${id}`, true, detail);
  };

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const { ROUTE_BUDGETS } = await import(
      pathToFileURL(path.join(REPO, "src", "daemon", "route-budgets.ts")).href
    );

    // ── 1. Sessions row → session detail: prefetched branch ──
    {
      const id = "interaction sessions row → detail (prefetched)";
      const attempts = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        await freshLoad("#/sessions");
        const sel = 'a.live-session-link[aria-label^="Open session "]';
        const sid = await evalJs(`document.querySelector(${JSON.stringify(sel)})?.getAttribute('aria-label')?.slice(13) ?? null`);
        if (!sid) { fail(id, "no Sessions row on the seed"); break; }
        const enc = encodeURIComponent(sid);
        const prefetched = (r) => r.url === `/api/sessions/${enc}` || r.url.startsWith(`/api/sessions/${enc}/turns?`);
        const before = requests.length;
        await hover(sel);
        await new Promise((r) => setTimeout(r, 120)); // past the 80 ms hover delay
        const deadline = Date.now() + 5_000;
        while (requests.slice(before).filter((r) => prefetched(r) && r.finished).length < 2 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const done = requests.slice(before).filter((r) => prefetched(r) && r.finished).length;
        if (done < 2) { fail(id, `hover prefetched ${done}/2 reads within 5 s (paused by status?)`); break; }
        const atClick = requests.length;
        const m = await measureClick(sel, `${kpi("Turns")} !== null`, `${SETTLED} && ${kpi("Turns")} !== null`);
        if (m?.error || m?.contentMs === null) { fail(id, m?.error ?? "content did not appear in 10 s"); break; }
        attempts.push(m);
        const again = requests.slice(atClick).filter(prefetched).length;
        const errors = await evalJs(ERRORS);
        const row = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(cost_equiv_u), 0) AS u FROM turns WHERE session_id = ?").get(sid);
        const page = { turns: await evalJs(kpi("Turns")), cost: await evalJs(kpi("Estimated cost")) };
        const sql = { turns: row.n.toLocaleString("en-US"), cost: fmtUsd2(row.u) };
        if (again !== 0) { fail(id, `${again} request(s) for prefetched reads on the click`); break; }
        if (errors > 0) { fail(id, `${errors} widget error state(s)`); break; }
        if (page.turns !== sql.turns || page.cost !== sql.cost) {
          fail(id, `header differs from seed SQL: page ${JSON.stringify(page)}, SQL ${JSON.stringify(sql)}`);
          break;
        }
        if (attempt === 2) record(id, true, `0 requests on click; Turns ${page.turns}, cost ${page.cost} = seed SQL`);
      }
      // The prefetched header is the ≤ 100 ms "first" paint; the rest of the page (panels that
      // are not prefetched) is held to the session route's budget + 50 ms.
      if (attempts.length === 3) checkTiming(id, attempts, (ROUTE_BUDGETS["/api/sessions/:id"]?.p95_ms ?? 250) + 50);
    }

    // ── 2. Workspaces row → workspace detail: seeded header, then content ──
    {
      const id = "interaction workspaces row → detail (seeded)";
      const attempts = [];
      const budget = Math.max(
        ...["/api/workspaces/:id/sessions", "/api/workspaces/:id/cost-per-success", "/api/workspaces/:id/delivery"].map(
          (r) => ROUTE_BUDGETS[r]?.p95_ms ?? 250,
        ),
      ) + 50;
      for (let attempt = 0; attempt < 3; attempt++) {
        const navAt = await freshLoad("#/workspaces");
        const sel = "a.workspace-row-link";
        // The seed's workspaces have no repo owner/name, so they list as transient (hidden).
        await evalJs(`(() => { const box = document.querySelector('.sec-h-toggle input[type="checkbox"]');
          if (box && !box.checked) box.click(); })()`);
        await waitFor(`document.querySelector(${JSON.stringify(sel)}) !== null`, SETTLE_TIMEOUT_MS);
        const href = await evalJs(`document.querySelector(${JSON.stringify(sel)})?.getAttribute('href') ?? null`);
        if (!href) {
          const text = await evalJs("(document.getElementById('main-content')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 160)");
          fail(id, `no Workspaces row link; page shows: ${text}`);
          break;
        }
        const enc = href.split("?")[0].slice("#/workspaces/".length);
        const wid = decodeURIComponent(enc);
        const scope = new URLSearchParams(href.split("?")[1] ?? "").get("window") ?? "all";
        const atClick = requests.length;
        const spendLabel = `Spend (${scope})`;
        const m = await measureClick(sel, `${kpi(spendLabel)} !== null`, `${SETTLED} && ${kpi(spendLabel)} !== null`);
        if (m?.error || m?.contentMs === null) { fail(id, m?.error ?? "content did not appear in 10 s"); break; }
        attempts.push(m);
        const sent = requests.slice(atClick);
        const count = (suffix) => sent.filter((r) => r.url.startsWith(`/api/workspaces/${enc}/${suffix}?`)).length;
        const counts = { sessions: count("sessions"), "cost-per-success": count("cost-per-success"), delivery: count("delivery") };
        const errors = await evalJs(ERRORS);
        const days = { "24h": 1, "7d": 7, "30d": 30 }[scope];
        const ends = [VERIFY_STARTED_MS, navAt, Date.now()];
        const expected = ends.map((end) => {
          const from = days === undefined ? "1970-01-01T00:00:00.000Z" : new Date(end - days * DAY_MS).toISOString();
          const row = db
            .prepare("SELECT COALESCE(SUM(cost_equiv_u), 0) AS u FROM turns WHERE workspace_id = ? AND provisional = 0 AND ts >= ? AND ts < ?")
            .get(wid, from, new Date(end).toISOString());
          return fmtUsd2(row.u);
        });
        const spend = await evalJs(kpi(spendLabel));
        if (Object.values(counts).some((n) => n !== 1)) { fail(id, `dependent requests per click ${JSON.stringify(counts)} (expected 1 each)`); break; }
        if (errors > 0) { fail(id, `${errors} widget error state(s)`); break; }
        if (!expected.includes(spend)) { fail(id, `Spend ${spend} differs from seed SQL ${expected.at(-1)}`); break; }
        if (attempt === 2) record(id, true, `1 request each for sessions/cost-per-success/delivery; ${spendLabel} ${spend} = seed SQL`);
      }
      if (attempts.length === 3) checkTiming(id, attempts, budget);
    }

    // ── 3. Anchor deep link: one turns request ──
    {
      const id = "interaction session anchor deep link";
      const top = db
        .prepare("SELECT session_id, COUNT(*) AS n FROM turns GROUP BY session_id ORDER BY n DESC, session_id LIMIT 1")
        .get();
      const anchor = db
        .prepare("SELECT message_id FROM turns WHERE session_id = ? ORDER BY ts DESC, message_id DESC LIMIT 1")
        .get(top.session_id).message_id;
      const enc = encodeURIComponent(top.session_id);
      const before = requests.length;
      try {
        await freshLoad(`#/sessions/${enc}?anchor=${encodeURIComponent(anchor)}`);
        const turnsReqs = requests.slice(before).filter((r) => r.url.startsWith(`/api/sessions/${enc}/turns?`));
        const anchored = await waitFor(`document.querySelector('[data-diagnostic-anchor="true"]') !== null`, 5_000);
        if (turnsReqs.length !== 1 || !turnsReqs[0].url.includes("anchor=")) {
          fail(id, `turns requests: ${JSON.stringify(turnsReqs.map((r) => r.url))} (expected one ?anchor=)`);
        } else if (!anchored) {
          fail(id, "anchored turn row not shown");
        } else {
          record(id, true, `1 turns request (?anchor=), anchored row shown (${top.n} turns)`);
        }
      } catch (e) {
        fail(id, String(e).slice(0, 160));
      }
    }

    // ── 4. "Load more" triggers: only when the seed has a second page ──
    {
      const maxTurns = db.prepare("SELECT MAX(n) AS n FROM (SELECT COUNT(*) AS n FROM turns GROUP BY session_id)").get().n;
      const sessions30d = db
        .prepare("SELECT COUNT(DISTINCT session_id) AS n FROM turns WHERE ts >= ?")
        .get(new Date(Date.now() - 30 * DAY_MS).toISOString()).n;
      process.stdout.write(
        `  [SKIP] interaction "Load more" (turn timeline, Sessions): the seed has no second page ` +
          `(largest session ${maxTurns} turns, first page 50; ${sessions30d} sessions in 30 d, page size 50). ` +
          "Covered by test/ui/prefetch.test.ts and the session/hot-sessions pagination tests.\n",
      );
    }
  } finally {
    db.close();
    offSent();
    offDone();
  }
  return failed;
}

/**
 * Find an installed Chrome/Chromium executable.
 * @returns {string | undefined}
 */
function findChrome() {
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env["LOCALAPPDATA"] ?? "";
  const candidates = [
    process.env["CHROME_PATH"],
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((c) => c !== undefined && c.length > 0);
  return candidates.find((c) => fs.existsSync(c));
}

const chromeExe = findChrome();

if (!chromeExe) {
  // TODO (f): headless Chrome not found — skip route load checks.
  // To enable: install Google Chrome (or set CHROME_PATH env var).
  //
  // Implementation approach (mirrors scripts/benchmark/browser-measure.ts):
  //   1. Launch Chrome: --headless=new --remote-debugging-port=0
  //   2. Wait for "DevTools listening on ws://..." in stderr
  //   3. Connect WebSocket (Node v22 built-in WebSocket)
  //   4. Target.createTarget({ url: "about:blank" })
  //   5. Target.attachToTarget({ flatten: true })
  //   6. Enable Page, Runtime, Log, Console domains
  //   7. For each hash route: Page.navigate, wait Page.loadEventFired,
  //      Runtime.evaluate to assert root.childElementCount > 0 and no
  //      "Starting up" title; filter console errors to app origin (BASE).
  //
  // This block is a SKIP — not a hard failure — so overall exit code is
  // determined only by (a)-(e) checks above.
  process.stdout.write("  [SKIP] headless route loads — Chrome not found (TODO: set CHROME_PATH)\n");
} else {
  // Chrome found — run CDP smoke checks.
  const chromeProfileDir = path.join(VERIFY_DIR, "chrome-profile");
  fs.mkdirSync(chromeProfileDir, { recursive: true });

  /** @type {import("node:child_process").ChildProcess | null} */
  let chromeProc = null;
  let headlessFailed = 0;

  try {
    // Launch Chrome headless.
    chromeProc = spawn(
      chromeExe,
      [
        "--headless=new",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${chromeProfileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-gpu",
        "--disable-extensions",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );

    // Wait for DevTools URL in stderr.
    const wsUrl = await new Promise((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(
        () => reject(new Error("Chrome DevTools URL not found in 15 s")),
        15_000,
      );
      chromeProc.stderr.setEncoding("utf8");
      chromeProc.stderr.on("data", (chunk) => {
        stderr += chunk;
        const m = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
        if (m?.[1]) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      chromeProc.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      chromeProc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Chrome exited ${code} before DevTools URL`));
      });
    });

    // Connect CDP WebSocket (Node v22+ built-in WebSocket).
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP WebSocket timed out")), 8_000);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("CDP WS error")); }, { once: true });
    });

    // Minimal CDP client.
    let nextId = 1;
    /** @type {Map<number, { resolve: Function; reject: Function }>} */
    const pending = new Map();
    /** @type {Map<string, Function[]>} */
    const listeners = new Map();

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== undefined) {
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
            else p.resolve(msg.result);
          }
          return;
        }
        if (msg.method) {
          for (const fn of listeners.get(msg.method) ?? []) fn(msg.params ?? {});
        }
      } catch {
        // ignore malformed CDP message
      }
    });

    const cdp = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    const on = (method, fn) => {
      listeners.set(method, [...(listeners.get(method) ?? []), fn]);
      return () =>
        listeners.set(
          method,
          (listeners.get(method) ?? []).filter((x) => x !== fn),
        );
    };

    // Create a reusable page target.
    const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp("Target.attachToTarget", {
      targetId,
      flatten: true,
    });

    await cdp("Page.enable", {}, sessionId);
    await cdp("Runtime.enable", {}, sessionId);
    await cdp("Log.enable", {}, sessionId);
    await cdp("Console.enable", {}, sessionId);

    for (const route of HASH_ROUTES) {
      const pageUrl = `${BASE}/${route}`;

      /** @type {string[]} */
      const consoleErrors = [];
      const removeLog = on("Log.entryAdded", ({ entry }) => {
        if (
          entry?.level === "error" &&
          typeof entry?.url === "string" &&
          entry.url.startsWith(BASE)
        ) {
          consoleErrors.push(String(entry.text ?? "").slice(0, 200));
        }
      });
      const removeConsole = on("Runtime.consoleAPICalled", (params) => {
        if (
          params.type === "error" &&
          Array.isArray(params.stackTrace?.callFrames) &&
          params.stackTrace.callFrames.some(
            (f) => typeof f.url === "string" && f.url.startsWith(BASE),
          )
        ) {
          const msg = params.args
            ?.map((a) => String(a.value ?? a.description ?? ""))
            .join(" ")
            .slice(0, 200);
          if (msg) consoleErrors.push(msg);
        }
      });

      try {
        // Each route must be a FRESH page load — hash changes on the same page
        // don't fire Page.loadEventFired. Navigate to about:blank first to
        // detach the previous React tree, then to the actual route URL.
        const blankFired = new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("about:blank timeout")), 8_000);
          const off = on("Page.loadEventFired", () => { clearTimeout(t); off(); resolve(); });
        });
        await cdp("Page.navigate", { url: "about:blank" }, sessionId);
        await blankFired;

        const loadFired = new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Page.loadEventFired timeout for ${route}`)),
            20_000,
          );
          // Flat-mode: Page.loadEventFired arrives on the main connection with
          // no params (or an empty params object). We have one page so any fire resolves.
          const off = on("Page.loadEventFired", () => {
            clearTimeout(timer);
            off();
            resolve();
          });
        });

        const navigatedAtMs = Date.now();
        await cdp("Page.navigate", { url: pageUrl }, sessionId);
        await loadFired;

        // P1-U5: the SPA mounts before its data, so a 1 s sleep would pass a page stuck on
        // skeletons. Poll until #main-content has no skeleton and no pending/error section.
        const probe = `(() => {
          const main = document.getElementById('main-content');
          return {
            childCount: document.getElementById('root')?.childElementCount ?? 0,
            hasStartingUp: document.title.includes('Starting up'),
            hasErrorBoundary: document.body?.textContent?.includes('Something went wrong') ?? false,
            hasMain: main !== null,
            // The lazy page chunk has mounted (the shell topline alone has no skeleton).
            hasHeading: main?.querySelector('h1') != null,
            skeletons: main ? main.querySelectorAll('.skeleton').length : 0,
            pending: main ? main.querySelectorAll('[data-section-status="pending"]').length : 0,
            errors: main
              ? main.querySelectorAll('[data-section-status="error"], .async-error-state').length
              : 0,
            unreachable: document.querySelector('.daemon-unreachable') !== null,
            kpis: Object.fromEntries(
              ['spend.equiv', 'sessions.count'].map((m) => [
                m,
                main?.querySelector('[data-metric="' + m + '"] .v')?.textContent ?? null,
              ]),
            ),
          };
        })()`;
        const settleDeadline = Date.now() + SETTLE_TIMEOUT_MS;
        let val;
        for (;;) {
          const evaluation = await cdp(
            "Runtime.evaluate",
            { expression: probe, returnByValue: true },
            sessionId,
          );
          val = evaluation?.result?.value;
          const settled =
            val &&
            val.hasMain &&
            val.hasHeading &&
            val.skeletons === 0 &&
            val.pending === 0 &&
            val.childCount > 0 &&
            (route !== "#/overview" || val.kpis["spend.equiv"] !== null);
          if (settled || !val || val.errors > 0 || Date.now() >= settleDeadline) break;
          await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
        }

        const kpiMismatch =
          route === "#/overview" && val
            ? overviewKpiMismatch(val.kpis, [VERIFY_STARTED_MS, navigatedAtMs, Date.now()])
            : null;
        if (!val) {
          record(`headless ${route}`, false, "Runtime.evaluate returned no value");
          headlessFailed++;
        } else if (val.hasStartingUp) {
          record(`headless ${route}`, false, "loading screen still shown (not ready)");
          headlessFailed++;
        } else if (val.hasErrorBoundary) {
          record(`headless ${route}`, false, "error boundary rendered");
          headlessFailed++;
        } else if (val.childCount === 0) {
          record(`headless ${route}`, false, "#root is empty");
          headlessFailed++;
        } else if (val.unreachable) {
          record(`headless ${route}`, false, "daemon-unreachable card rendered");
          headlessFailed++;
        } else if (val.errors > 0) {
          record(`headless ${route}`, false, `${val.errors} widget/section error state(s) rendered`);
          headlessFailed++;
        } else if (val.skeletons > 0 || val.pending > 0 || !val.hasHeading) {
          record(
            `headless ${route}`,
            false,
            `still loading after ${SETTLE_TIMEOUT_MS / 1000} s (${val.skeletons} skeleton(s), ${val.pending} pending section(s))`,
          );
          headlessFailed++;
        } else if (kpiMismatch !== null) {
          record(`headless ${route}`, false, kpiMismatch);
          headlessFailed++;
        } else if (consoleErrors.length > 0) {
          record(
            `headless ${route}`,
            false,
            `${consoleErrors.length} app-origin console error(s): ${consoleErrors[0]}`,
          );
          headlessFailed++;
        } else {
          record(
            `headless ${route}`,
            true,
            route === "#/overview"
              ? `KPIs = seed SQL (${val.kpis["spend.equiv"]}, ${val.kpis["sessions.count"]} sessions)`
              : `root.children=${val.childCount}`,
          );
        }
      } catch (e) {
        record(`headless ${route}`, false, String(e).slice(0, 200));
        headlessFailed++;
      } finally {
        removeLog();
        removeConsole();
      }
    }

    headlessFailed += await interactionChecks({ cdp, on, sessionId });
  } catch (e) {
    record("headless setup", false, String(e).slice(0, 200));
    headlessFailed++;
  } finally {
    if (chromeProc && chromeProc.exitCode === null) {
      try {
        if (process.platform === "win32") {
          execSync(`taskkill /T /F /PID ${chromeProc.pid}`, { stdio: "ignore" });
        } else {
          chromeProc.kill();
        }
      } catch {
        // Best-effort.
      }
    }
  }
}

// ── (g) Route latency budgets — ENFORCING (P3-U1) ─────────────────────────────
// Runs from step (h) while the scan-root backfill is active, so budgets are measured during
// ingest, not on an idle daemon. Every budgeted GET is sampled >= 50 times per attempt; the
// verdict is the median of 3 attempts' p95 (all printed), plus the /api/perf loop p99 <= 50 ms.

/**
 * @param {string} base  the backfilling daemon's origin
 * @param {string} dbPath  that daemon's DB (read-only, for the seed ids)
 * @param {() => string | null} getPhase  the pipeline phase the (h) poll loop last saw
 */
async function routeBudgetGate(base, dbPath, getPhase) {
  process.stdout.write("\n(g) route budgets (enforcing, during scan-root backfill)\n");
  try {
    return await routeBudgetGateInner(base, dbPath, getPhase);
  } catch (e) {
    record("route budgets: gate ran", false, String(e).slice(0, 200));
    return null;
  }
}

async function routeBudgetGateInner(base, dbPath, getPhase) {
  // Import the registry itself (erasable-syntax TS, Node 24 type stripping): no line-scraping.
  const { ROUTE_BUDGETS } = await import(
    pathToFileURL(path.join(REPO, "src", "daemon", "route-budgets.ts")).href
  );
  const { runBudgetGate } = await import(
    pathToFileURL(path.join(REPO, "scripts", "lib", "perf-budget-gate.mts")).href
  );
  // P1-U6a test 7 / M16: the Appendix A reads are sampled with the params the UI sends (a seed
  // session, a seed workspace, a turns anchor), like the page GETs.
  const seedDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  const seedSession = seedDb
    .prepare("SELECT session_id, COUNT(*) AS n FROM turns GROUP BY session_id ORDER BY n DESC, session_id LIMIT 1")
    .get()?.session_id;
  const seedWorkspace = seedDb
    .prepare("SELECT workspace_id FROM turns GROUP BY workspace_id ORDER BY COUNT(*) DESC, workspace_id LIMIT 1")
    .get()?.workspace_id;
  const seedAnchor =
    seedSession === undefined
      ? undefined
      : seedDb
          .prepare("SELECT message_id FROM turns WHERE session_id = ? ORDER BY ts DESC LIMIT 1")
          .get(seedSession)?.message_id;
  seedDb.close();
  const withSeedId = (route) => {
    if (/^\/api\/(sessions\/:id|esf\/session-observations\/:id)/.test(route) && seedSession)
      return route.replace(":id", encodeURIComponent(seedSession));
    if (route.startsWith("/api/workspaces/:id") && seedWorkspace)
      return route.replace(":id", encodeURIComponent(seedWorkspace));
    return null;
  };
  const entries = Object.entries(ROUTE_BUDGETS).map(([route, b]) => ({
    route,
    url: route.includes(":id") ? withSeedId(route) : route,
    budget: b.p95_ms,
    stream: b.source === "stream",
    untimed: b.untimed,
  }));
  if (seedSession && seedAnchor) {
    const turns = entries.find((e) => e.route === "/api/sessions/:id/turns");
    if (turns)
      entries.push({
        ...turns,
        route: "/api/sessions/:id/turns?anchor=",
        url: `/api/sessions/${encodeURIComponent(seedSession)}/turns?anchor=${encodeURIComponent(seedAnchor)}`,
      });
  }
  if (entries.length === 0) throw new Error("route budget registry is empty");
  const timedEntries = [];
  // Probe all routes concurrently: the probe must not eat the short ingest window the gate samples in.
  const probed = await Promise.all(
    entries.map(async (e) => {
      if (e.stream || e.untimed || e.url === null) return { e };
      try {
        return { e, status: (await get(`${base}${e.url}`, 20_000)).status };
      } catch (err) {
        return { e, err };
      }
    }),
  );
  for (const { e, status, err } of probed) {
    const skip = (why) => process.stdout.write(`  [SKIP] ${e.route}  ${why}\n`);
    if (e.stream) continue; // streams are excluded from latency checks
    if (e.untimed) skip(`untimed: ${e.untimed}`);
    else if (e.url === null) skip("needs an id the seed smoke cannot resolve");
    else if (err) record(`route budget: ${e.route}`, false, `probe failed: ${String(err).slice(0, 80)}`);
    // Routes that answer 400/503 on the seed (they need params or state) are skipped.
    else if (status === 400 || status === 503) skip(`HTTP ${status} (needs params or state)`);
    else timedEntries.push({ route: e.route, url: e.url, budget: e.budget });
  }
  const phaseAtStart = getPhase();
  const t0 = Date.now();
  // How much of the sampling really ran while the pipeline was still ingesting (phase != done).
  // Cheapest budgets first: attempt 1 packs the most requests into the short ingest window.
  timedEntries.sort((a, b) => a.budget - b.budget);
  const reqs = [0, 0, 0];
  const reqsIngesting = [0, 0, 0];
  // Every timed budgeted route is sampled in this ONE gated pass; an attempt that overlapped ingest is gated alone.
  const gate = await runBudgetGate({
    base,
    entries: timedEntries,
    samples: 50,
    attempts: 3,
    isIngesting: () => getPhase() !== "done",
    log: (l) => process.stdout.write(`${l}\n`),
    onSample: (a) => {
      reqs[a] += 1;
      if (getPhase() !== "done") reqsIngesting[a] += 1;
    },
  });
  const phaseAtEnd = getPhase();
  process.stdout.write(
    `  ${timedEntries.length} routes x 50 samples x 3 attempts in ${((Date.now() - t0) / 1000).toFixed(0)} s; backfill phase ${phaseAtStart} -> ${phaseAtEnd}\n`,
  );
  const totalReqs = reqs[0] + reqs[1] + reqs[2];
  const totalIng = reqsIngesting[0] + reqsIngesting[1] + reqsIngesting[2];
  process.stdout.write(
    `  sampling overlap: ${totalIng} of ${totalReqs} requests (${((100 * totalIng) / Math.max(1, totalReqs)).toFixed(1)}%) sent with pipeline != done; per attempt ${reqsIngesting.map((n, i) => `${n}/${reqs[i]}`).join(" ")}\n`,
  );
  for (const f of gate.failures) record("route budgets", false, f);
  record("route budgets: median of 3 attempts within every budget, loop p99 <= 50 ms", gate.ok, `${timedEntries.length} routes`);
  return { phaseAtStart, phaseAtEnd };
}

// ── (h) Scan-root mode: boot really backfills (P2-U1) ──────────────────────────
// The shared seed above never ingests (empty scan root). Here a second daemon boots
// on a fresh DB over a small R-3 corpus generated now (mtimes over 4 weeks, so turn
// timestamps never age out of the 7d/30d windows). It asserts only what has shipped:
// ready flips, the pipeline's weeks_done never goes down, the pipeline reaches done,
// and every generated turn is in the DB. P2-U4: W0 is complete at ready and slice
// coverage climbs to every week. P2-U2 adds push events and KPI growth here.

process.stdout.write("\n(h) scan-root mode (boot backfill)\n");

killDaemon();
{
  const backfillRoot = path.join(VERIFY_DIR, "scan-root-backfill");
  const backfillDb = path.join(VERIFY_DIR, "backfill.sqlite");
  // A DB left by an earlier run (cleanup can fail on Windows) would carry turns of an old corpus.
  for (const ext of ["", "-wal", "-shm", ".lock"]) fs.rmSync(`${backfillDb}${ext}`, { force: true });
  const gen = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", path.join(REPO, "scripts", "benchmark", "backfill-corpus.mts"), "gen", backfillRoot, "11", "400", "280000000", "4"],
    { cwd: REPO, encoding: "utf8", timeout: 120_000 },
  );
  let corpus = null;
  try {
    corpus = JSON.parse(gen.stdout.trim().split("\n").at(-1));
  } catch {
    // reported below
  }
  if (gen.status !== 0 || corpus === null) {
    record("scan-root corpus", false, `exit ${gen.status} — ${String(gen.stderr).slice(-300)}`);
  } else {
    record("scan-root corpus", corpus.mtimeWeeks >= 3, `${corpus.files} files, ${corpus.turns} turns, ${corpus.mtimeWeeks} mtime weeks`);
    const bfPort = await findFreePort();
    daemonProc = spawn(process.execPath, ["--import", "tsx/esm", DAEMON_ENTRY, "--no-open"], {
      cwd: REPO,
      env: {
        ...process.env,
        AW_DB_PATH: backfillDb,
        AW_UI_ROOT: UI_ROOT,
        AW_SCAN_ROOT: backfillRoot,
        AW_PORT: String(bfPort),
        AW_NO_OPEN: "1",
        AW_NO_GH_TOKEN: "1",
        AW_USAGE_CLI: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const BF = `http://127.0.0.1:${bfPort}`;
    const ready = await pollUntil(`${BF}/api/ready`, (b) => JSON.parse(b)?.ready === true, 60_000, 250);
    record("scan-root: /api/ready flips", ready.ok);
    if (ready.ok) {
      const weeks = [];
      // P2-U4: slice coverage (history_coverage.weeks_done), sampled from ready on.
      const covered = [];
      let lastCoverage = null;
      let phase = null;
      // (g) P3-U1: the budget gate samples while the pipeline polled below is still ingesting.
      const gatePromise = routeBudgetGate(BF, backfillDb, () => phase);
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        try {
          const { status, body } = await get(`${BF}/api/status`, 5_000);
          const parsed = status === 200 ? JSON.parse(body) : undefined;
          if (parsed?.history_coverage) {
            lastCoverage = parsed.history_coverage;
            covered.push(lastCoverage.weeks_done);
          }
          const p = parsed?.pipeline;
          if (p) {
            weeks.push(p.weeks_done);
            phase = p.phase;
            if (phase === "done") break;
          }
        } catch {
          // keep polling
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      record("scan-root: pipeline reaches done", phase === "done", `last phase ${phase}`);
      const monotonic = weeks.every((w, i) => i === 0 || w >= weeks[i - 1]);
      record("scan-root: weeks_done monotonic", weeks.length > 0 && monotonic, `${weeks.length} samples, last ${weeks.at(-1)}`);
      record(
        "scan-root: W0 complete at ready, slice coverage monotonic to all weeks",
        covered.length > 0 &&
          covered[0] >= 1 &&
          covered.every((w, i) => i === 0 || w >= covered[i - 1]) &&
          lastCoverage?.weeks_done === lastCoverage?.weeks_total &&
          lastCoverage?.partial_week === false,
        `${covered.length} samples, first ${covered[0]}, last ${lastCoverage?.weeks_done}/${lastCoverage?.weeks_total}`,
      );
      await gatePromise;
      // read before the daemon is killed (reading after gives SQLITE_IOERR_TRUNCATE)
      try {
        const db = new Database(backfillDb, { readonly: true, fileMustExist: true });
        const n = db.prepare("SELECT COUNT(*) AS n FROM turns").get().n;
        db.close();
        record("scan-root: every generated turn ingested", n === corpus.turns, `${n} in DB vs ${corpus.turns} generated`);
      } catch (e) {
        record("scan-root: every generated turn ingested", false, String(e).slice(0, 120));
      }
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

cleanup();

process.stdout.write("\n─────────────────────────────────────────\n");
const failed = results.filter((r) => !r.pass);
const passed = results.filter((r) => r.pass);
process.stdout.write(
  `verify:app  ${passed.length} passed  ${failed.length} failed  (${results.length} total)\n`,
);

if (failed.length > 0) {
  process.stdout.write("\nFailed checks:\n");
  for (const r of failed) {
    process.stdout.write(`  ✗ ${r.id}: ${r.detail}\n`);
  }
  process.stdout.write("\n");
  process.exit(1);
} else {
  process.stdout.write("All checks passed.\n\n");
  process.exit(0);
}
