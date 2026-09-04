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

/** Inline loading page served while the daemon's initial back-scan is running. */
const LOADING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentWrangler — Starting up</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0b0f17;color:#c9d1d9;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
.wrap{padding:2rem}
h1{font-size:1.5rem;font-weight:700;color:#f0f6fc;letter-spacing:.05em}
h2{font-size:1rem;font-weight:400;color:#38bdf8;margin:.75rem 0 .5rem}
p{font-size:.875rem;color:#8b949e;max-width:36ch;margin:0 auto 2rem}
.spinner{width:40px;height:40px;border:3px solid #1e293b;border-top-color:#38bdf8;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto}
.count{font-variant-numeric:tabular-nums;color:#8b949e;font-size:.875rem;margin:1.25rem auto 0;min-height:1.2em}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="wrap">
  <h1>AgentWrangler</h1>
  <h2>Starting up…</h2>
  <p>Scanning your Claude Code transcripts — this can take a few minutes on first run; later loads are instant.</p>
  <div class="spinner"></div>
  <p class="count" id="count" aria-live="polite"></p>
</div>
<script>
(function poll(){
  fetch('/api/ready')
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.ready){location.reload();return;}
      // Reuse the first-run onboarding counter so a large first scan shows live
      // progress instead of a bare spinner. Cadence unchanged (1s).
      fetch('/api/status')
        .then(function(r){return r.json();})
        .then(function(s){
          if(s&&typeof s.files_seen==='number'&&s.files_seen>0){
            document.getElementById('count').textContent=
              'Scanning transcripts — '+s.files_parsed+' of '+s.files_seen+' files';
          }
        })
        .catch(function(){})
        .then(function(){setTimeout(poll,1000);});
    })
    .catch(function(){setTimeout(poll,1000);});
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
