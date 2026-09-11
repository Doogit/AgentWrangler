/**
 * src/daemon/http.ts — HTTP request handler with security baseline.
 *
 * Security layers (applied in order, before any handler):
 *
 * 1. Host guard (SEC-102 / ADR-100 loopback-only):
 *    Refuse any request whose Host header doesn't resolve to a loopback address.
 *    Strips the port before checking so the guard works regardless of the
 *    ephemeral port chosen by the OS. Response: 421 Misdirected Request.
 *
 * 2. CSRF same-origin gate (POST/PUT/PATCH/DELETE only):
 *    Implements the Fetch Metadata / OWASP Fetch-site algorithm:
 *    (a) If Sec-Fetch-Site present: allow only "same-origin" or "none"; else 403.
 *    (b) Else if Origin present: allow only exact-match against
 *        {http://127.0.0.1:<port>, http://localhost:<port>, http://[::1]:<port>};
 *        reject "null" Origin and all others; → 403.
 *    (c) If neither header present: allow (legacy same-origin, no CORS context).
 *
 * 3. Content-Type gate (POST/PUT/PATCH/DELETE only):
 *    Write requests must carry Content-Type: application/json; else → 415.
 *
 * NEVER emits permissive CORS headers. The SPA is served from the same origin;
 * no cross-origin API access is needed or allowed.
 */

import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { Db } from "../db/open.js";
import { isReady } from "./readiness.js";
import { handleApiRequest } from "./router.js";
import { createStaticHandler } from "./static.js";

/**
 * Inline loading page served while the daemon's initial back-scan is running
 * (BOOT-2, Option E): docked terminal panel streaming boot_scan_events on top,
 * three live counters + a determinate progress bar below, fade into the app on
 * ready (no white-flash hard reload). Self-contained by design — the SPA's
 * assets are not servable pre-ready, so design-token VALUES are copied from
 * src/ui/styles.css (dark theme) with that file as the source of truth.
 * Falls back to the plain "Scanning transcripts — N of M files" line when the
 * BOOT-1 fields are absent (older daemon mid-upgrade).
 */
const LOADING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>AgentWrangler — Starting up</title>
<style>
/* Token values copied from src/ui/styles.css (dark theme) — keep in sync. */
:root{
  --bg:#0b0f1a;--panel:#111827;--panel2:#1a2233;--line:rgba(255,255,255,.07);
  --text:#e2e8f0;--text2:#94a3b8;--muted:#9aa9bd;
  --cyan:#22d3ee;--violet:#a78bfa;--green:#34d399;
  --sans:system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:ui-monospace,Consolas,Menlo,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--bg)}
body{
  background:var(--bg);
  color:var(--text);font-family:var(--sans);min-height:100vh;
  display:grid;place-content:center;gap:28px;padding:24px 0;
}
body.leaving .log,body.leaving .hero{opacity:0}
.log,.hero{opacity:1;transition:opacity .4s ease}
.log{
  background:#0a0e16;margin:0 auto;width:min(480px,calc(100vw - 36px));
  border:1px solid var(--line);border-radius:8px;overflow:hidden;
  display:grid;grid-template-rows:26px 1fr;height:158px;
}
.log-head{
  display:flex;align-items:center;gap:8px;padding:0 12px;
  background:var(--panel);border-bottom:1px solid var(--line);
  font-family:var(--mono);font-size:10px;color:var(--muted);
  letter-spacing:.08em;text-transform:uppercase;
}
.log-head .dot{width:7px;height:7px;border-radius:50%;background:var(--green)}
.log-body{
  padding:8px 12px;font-family:var(--mono);font-size:10.5px;line-height:1.7;
  color:var(--text2);overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;
}
.log-body .ln{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.log-body .ok{color:var(--green)}
.log-body .hl{color:var(--cyan)}
.hero{display:grid;place-content:center;gap:16px;text-align:center;padding:0 16px}
.headline{font-size:15px;font-weight:600}
.headline span{color:var(--cyan)}
.counters{display:flex;gap:34px;justify-content:center;flex-wrap:wrap}
.counter .cv{font-family:var(--mono);font-size:30px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.counter:nth-child(1) .cv{color:var(--cyan)}
.counter:nth-child(2) .cv{color:var(--violet)}
.counter:nth-child(3) .cv{color:var(--green)}
.counter .cl{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-top:2px}
.pbar{width:300px;max-width:80vw;height:6px;background:var(--panel2);border-radius:99px;overflow:hidden;margin:0 auto}
.pbar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--cyan),var(--violet));border-radius:99px;transition:width .25s ease-out}
.status{font-family:var(--mono);font-size:11.5px;color:var(--muted);min-height:1.2em;font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:reduce){
  .log,.hero,.pbar i{transition:none}
}
</style>
</head>
<body>
<div class="log" id="log" hidden>
  <div class="log-head"><span class="dot"></span>boot scan · <span id="rate">— files/s</span></div>
  <div class="log-body" id="logbody"></div>
</div>
<div class="hero">
  <div class="headline">Preparing your <span>Claude Code</span> data…</div>
  <div class="counters">
    <div class="counter"><div class="cv" id="c-files">0</div><div class="cl">files scanned</div></div>
    <div class="counter"><div class="cv" id="c-sess">0</div><div class="cl">sessions found</div></div>
    <div class="counter"><div class="cv" id="c-tok">0</div><div class="cl">tokens counted</div></div>
  </div>
  <div class="pbar"><i id="fill"></i></div>
  <div class="status" id="status" aria-live="polite">Scanning transcript roots…</div>
</div>
<script>
(function(){
  var reduced=false;
  try{reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){}
  var lastSeq=0,prevFiles=null,prevT=null,rateEma=null,leaving=false;
  function $(id){return document.getElementById(id);}
  function fmt(n){return Number(n||0).toLocaleString('en-US');}
  function fmtTok(n){
    n=Number(n||0);
    if(n>=1e9)return (n/1e9).toFixed(1)+'B';
    if(n>=1e6)return (n/1e6).toFixed(1)+'M';
    if(n>=1e3)return (n/1e3).toFixed(1)+'K';
    return String(n);
  }
  function finish(){
    if(leaving)return;
    leaving=true;
    // Fade out, then swap to the app behind the transition — no white flash.
    document.body.className='leaving';
    setTimeout(function(){location.reload();},reduced?0:450);
  }
  function renderLog(events){
    var body=$('logbody');
    for(var i=0;i<events.length;i++){
      var ev=events[i];
      if(!ev||typeof ev.seq!=='number'||ev.seq<=lastSeq)continue;
      lastSeq=ev.seq;
      var el=document.createElement('div');
      el.className='ln'+(ev.kind==='stage'?' hl':ev.kind==='root'?' ok':'');
      el.textContent=String(ev.text||'');
      body.appendChild(el);
      while(body.children.length>6)body.removeChild(body.firstChild);
    }
  }
  function render(s){
    if(!s)return;
    var files=typeof s.files_parsed==='number'?s.files_parsed:0;
    var seen=typeof s.files_seen==='number'?s.files_seen:0;
    var hasBoot=Array.isArray(s.boot_scan_events);
    // Progress denominator: discovery's up-front total. files_seen only counts
    // files visited so far, which would pin a determinate bar at ~100%.
    var total=hasBoot&&typeof s.boot_files_total==='number'&&s.boot_files_total>0?s.boot_files_total:seen;
    $('c-files').textContent=fmt(files);
    $('c-sess').textContent=fmt(typeof s.boot_sessions_found==='number'?s.boot_sessions_found:(s.sessions||0));
    $('c-tok').textContent=hasBoot?fmtTok(s.boot_tokens_counted):'—';
    var pct=total>0?Math.min(100,Math.round(100*files/total)):0;
    $('fill').style.width=pct+'%';
    // Client-side ETA from the parse-rate delta between polls (EMA-smoothed).
    var now=Date.now();
    if(prevFiles!==null&&now>prevT){
      var r=(files-prevFiles)/((now-prevT)/1000);
      if(r>0)rateEma=rateEma===null?r:(rateEma*0.7+r*0.3);
    }
    prevFiles=files;prevT=now;
    if(hasBoot){
      $('log').hidden=false;
      renderLog(s.boot_scan_events);
      var rr=typeof s.boot_files_per_sec==='number'?s.boot_files_per_sec:0;
      $('rate').textContent=(rr>0?rr:'—')+' files/s';
      if(total===0){
        $('status').textContent='Scanning transcript roots…';
      }else if(pct<100){
        var eta=rateEma&&rateEma>0?Math.max(1,Math.round((total-files)/rateEma)):null;
        $('status').textContent='Parsing sessions'+(eta!==null?' — '+eta+'s remaining':'…');
      }else{
        $('status').textContent='Opening your dashboard…';
      }
    }else if(seen>0){
      // Fallback for an older daemon without BOOT-1 fields: keep the plain
      // first-run counter line ("N of M files"), never a blank page.
      $('status').textContent='Scanning transcripts — '+files+' of '+seen+' files';
    }
  }
  (function poll(){
    fetch('/api/ready')
      .then(function(r){return r.json();})
      .then(function(d){
        if(d.ready){finish();return;}
        fetch('/api/status')
          .then(function(r){return r.json();})
          .then(render)
          .catch(function(){})
          .then(function(){setTimeout(poll,1000);});
      })
      .catch(function(){setTimeout(poll,1000);});
  })();
})();
</script>
</body>
</html>`;

/**
 * Strict allowlist for loopback Host headers.
 * Matches 127.0.0.1, localhost, [::1] — each optionally with :PORT — and
 * nothing else.  Using a full-pattern match prevents userinfo-syntax bypass
 * (e.g. "localhost:user@evil.com") that a bare lastIndexOf(':') strip allows.
 */
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** Return true if the Host header is a loopback address (with optional port). */
function isLoopbackHost(host: string): boolean {
  if (!host) return false;
  return LOOPBACK_HOST_RE.test(host);
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Apply the CSRF same-origin gate to a write request.
 * Returns null on success, or a {status, message} on failure.
 */
function csrfCheck(
  req: http.IncomingMessage,
  port: number,
): { status: number; message: string } | null {
  const sfs = req.headers["sec-fetch-site"];
  if (sfs !== undefined) {
    // Fetch Metadata present: enforce same-origin or none only.
    if (sfs === "same-origin" || sfs === "none") return null;
    return { status: 403, message: "Forbidden — cross-origin write rejected (Sec-Fetch-Site)" };
  }

  const origin = req.headers.origin;
  if (origin !== undefined) {
    // Legacy CORS check: allow only the exact loopback origins (scheme+host+port).
    const allowed = new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
    ]);
    if (origin === "null" || !allowed.has(origin)) {
      return {
        status: 403,
        message: "Forbidden — cross-origin write rejected (Origin)",
      };
    }
    return null;
  }

  // Neither Sec-Fetch-Site nor Origin — legacy same-origin request (e.g. curl).
  return null;
}

/** Return true when a write path requires X-AgentWrangler-Token. */
function requiresSessionToken(pathname: string): boolean {
  if (pathname === "/api/idle-sessions/end") return true;
  if (pathname === "/api/hook/install" || pathname === "/api/hook/uninstall") return true;
  if (pathname === "/api/recommendations/adopt" || pathname === "/api/recommendations/dismiss") {
    return true;
  }
  if (/^\/api\/recommendations\/[^/]+\/apply$/.test(pathname)) return true;
  if (/^\/api\/recommendations\/[^/]+\/open-terminal$/.test(pathname)) return true;
  if (/^\/api\/recommendations\/jobs\/[^/]+\/(confirm|rollback)$/.test(pathname)) return true;
  if (/^\/api\/esf\/effects\/(track|stop|close|rollback|attest-rollback)$/.test(pathname))
    return true;
  if (pathname === "/api/work-records" || pathname === "/api/work-records/ids") return true;
  if (
    /^\/api\/work-records\/[^/]+\/(edit|closeout|archive|reopen|sessions|contexts|delete)$/.test(
      pathname,
    )
  )
    return true;
  if (/^\/api\/work-records\/[^/]+\/(sessions|contexts)\/[^/]+\/detach$/.test(pathname))
    return true;
  if (pathname === "/api/work-records/allocations/recompute") return true;
  return false;
}

/**
 * Create the Node HTTP request handler for the daemon.
 *
 * @param db            Open SQLite database.
 * @param port          The port the server is bound to (used for CSRF Origin checks).
 * @param uiRoot        Path to the built SPA assets directory. May be null in test/CI.
 * @param sessionToken  In-memory CSRF session token (crypto.randomUUID() at startup).
 *                      When provided, GET /api/token returns it and POST write endpoints
 *                      for adopt/dismiss require it in X-AgentWrangler-Token. When null/
 *                      undefined, the token gate is inactive (legacy/test mode).
 */
export function createHandler(
  db: Db,
  port: number,
  uiRoot: string | null,
  sessionToken?: string | null,
  kickBootScan?: (() => void) | null,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const staticHandler = uiRoot ? createStaticHandler(uiRoot) : null;

  return function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
    // ── 1. Host guard ────────────────────────────────────────────────────────
    const host = req.headers.host ?? "";
    if (!isLoopbackHost(host)) {
      res.writeHead(421, { "Content-Type": "text/plain" });
      res.end("421 Misdirected Request — loopback only");
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();
    const url = req.url ?? "/";
    const pathname = url.split("?")[0] ?? url;

    // ── GET /api/token — expose session token (same-origin readable only) ────
    if (method === "GET" && pathname === "/api/token" && sessionToken != null) {
      const body = JSON.stringify({ token: sessionToken });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    // ── 2 & 3. CSRF + Content-Type gate (writes only) ────────────────────────
    if (WRITE_METHODS.has(method)) {
      const err = csrfCheck(req, port);
      if (err) {
        res.writeHead(err.status, { "Content-Type": "text/plain" });
        res.end(err.message);
        return;
      }

      const ct = req.headers["content-type"] ?? "";
      if (!ct.startsWith("application/json")) {
        res.writeHead(415, { "Content-Type": "text/plain" });
        res.end("415 Unsupported Media Type — Content-Type must be application/json");
        return;
      }

      // ── 4. Session-token gate (mutating recommendation actions, when token active) ─────
      if (sessionToken != null && requiresSessionToken(pathname)) {
        const provided = req.headers["x-agentwrangler-token"];
        const providedStr = Array.isArray(provided) ? provided[0] : provided;
        let tokenOk = false;
        if (providedStr !== undefined) {
          try {
            // Compare by bytes so a multi-byte non-ASCII header can't bypass the
            // length guard and cause timingSafeEqual to throw ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH.
            const a = Buffer.from(providedStr, "utf8");
            const b = Buffer.from(sessionToken, "utf8");
            if (a.length === b.length) {
              // Constant-time compare to prevent timing oracle on token value.
              tokenOk = timingSafeEqual(a, b);
            }
          } catch {
            // Defense-in-depth: any unexpected error → tokenOk stays false → 401.
          }
        }
        if (!tokenOk) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("401 Unauthorized — missing or invalid X-AgentWrangler-Token");
          return;
        }
      }
    }

    // ── Loading page (daemon not ready yet) ──────────────────────────────────
    // Serve while the initial back-scan is running. Only intercepts top-level
    // HTML navigations — /api/* paths (including /api/ready) pass through so
    // the polling script can detect readiness even while the loop is blocked.
    if (
      !isReady() &&
      (pathname === "/" ||
        (!pathname.startsWith("/api/") && (req.headers.accept ?? "").includes("text/html")))
    ) {
      kickBootScan?.();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(LOADING_HTML);
      return;
    }

    // ── API routes (/api/*) ──────────────────────────────────────────────────
    if (url.startsWith("/api/")) {
      handleApiRequest(db, req, res, method, url);
      return;
    }

    // ── Static SPA assets ────────────────────────────────────────────────────
    if (staticHandler) {
      staticHandler(req, res, () => {
        // sirv calls next() when the file is not found — send 404.
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
      });
      return;
    }

    // No static handler (UI not built yet).
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("AgentWrangler daemon running — build the UI with `npm run build:ui`");
  };
}

/**
 * Create and return an HTTP server using the loopback handler.
 * Pass sessionToken (generated by src/daemon/index.ts via crypto.randomUUID()) to
 * enable the X-AgentWrangler-Token gate on write endpoints. Omit in tests that
 * do not exercise the token gate.
 */
export function createServer(
  db: Db,
  port: number,
  uiRoot: string | null,
  sessionToken?: string | null,
  kickBootScan?: (() => void) | null,
): http.Server {
  const handler = createHandler(db, port, uiRoot, sessionToken, kickBootScan);
  return http.createServer(handler);
}
