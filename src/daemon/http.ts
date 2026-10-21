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
import { awaitDbWriteGate, dbWriteGate } from "../db/write-gate.js";
import {
  type DiagnosticsSnapshotService,
  createDiagnosticsSnapshotService,
  createHandoffSource,
} from "./diagnostics-snapshot.js";
import {
  type HeadroomSnapshotService,
  createHeadroomSnapshotService,
} from "./headroom-snapshot.js";
import type { OutcomesControlService } from "./outcomes-control.js";
import { markRequestStart } from "./perf-monitor.js";
import { type RecsSnapshotService, createRecsSnapshotService } from "./recs-snapshot.js";
import { type RouteSnapshotService, buildRouteSnapshot } from "./route-snapshot.js";
import { handleApiRequest } from "./router.js";
import { createStaticHandler } from "./static.js";

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

/**
 * Create the Node HTTP request handler for the daemon.
 *
 * @param db            Open SQLite database.
 * @param port          The port the server is bound to (used for CSRF Origin checks).
 * @param uiRoot        Path to the built SPA assets directory. May be null in test/CI.
 * @param sessionToken  In-memory CSRF session token (crypto.randomUUID() at startup).
 *                      When provided, GET /api/token returns it and every write
 *                      (POST/PUT/PATCH/DELETE) requires it in X-AgentWrangler-Token. When null/
 *                      undefined, the token gate is inactive (legacy/test mode).
 */
export function createHandler(
  db: Db,
  port: number,
  uiRoot: string | null,
  sessionToken?: string | null,
  kickBootScan?: (() => void) | null,
  outcomesControl?: OutcomesControlService | null,
  recsSnapshot?: RecsSnapshotService,
  diagnosticsSnapshot?: DiagnosticsSnapshotService,
  routeSnapshot?: RouteSnapshotService,
  headroomSnapshot?: HeadroomSnapshotService,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const staticHandler = uiRoot ? createStaticHandler(uiRoot) : null;
  const recommendations = recsSnapshot ?? createRecsSnapshotService();
  // Without a service (tests, scripts), headroom builds in-process.
  const headroom = headroomSnapshot ?? createHeadroomSnapshotService({ db, recs: recommendations });
  const diagnostics = diagnosticsSnapshot ?? createDiagnosticsSnapshotService();
  // Without a service (tests, scripts), P1-U8 routes build in-process on every request, uncached.
  const routes: RouteSnapshotService = routeSnapshot ?? {
    get: async (_key, spec) => buildRouteSnapshot(db, spec(new Date())),
    stop() {},
  };
  const diagnosticsHandoffs = createHandoffSource(recommendations, db);

  return function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
    const method = (req.method ?? "GET").toUpperCase();
    const url = req.url ?? "/";
    const pathname = url.split("?")[0] ?? url;
    // P0-U2: mark the request start; router.ts's sendJson reads this to set
    // Server-Timing and record the route's duration. No-op for requests that
    // never reach sendJson (static/SPA/rejected) — the WeakMap entry is simply
    // never read and is GC'd with `res`.
    markRequestStart(res, pathname);

    // ── 0. Anti-framing + nosniff on every response (RB6: no clickjacking of writes) ──
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");

    // ── 1. Host guard ────────────────────────────────────────────────────────
    const host = req.headers.host ?? "";
    if (!isLoopbackHost(host)) {
      res.writeHead(421, { "Content-Type": "text/plain" });
      res.end("421 Misdirected Request — loopback only");
      return;
    }

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

      // ── 4. Session-token gate: every write, default-deny (P3-U8 S-1), when token active ─────
      if (sessionToken != null) {
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

    const isHtmlNavigation =
      method === "GET" &&
      (pathname === "/" ||
        (!pathname.startsWith("/api/") && (req.headers.accept ?? "").includes("text/html")));
    if (isHtmlNavigation) {
      // Kick boot work from the first SPA navigation; the static handler serves index.html.
      kickBootScan?.();
    }

    // ── API routes (/api/*) ──────────────────────────────────────────────────
    if (url.startsWith("/api/")) {
      const dispatch = (): void =>
        handleApiRequest(
          db,
          req,
          res,
          method,
          url,
          outcomesControl,
          recommendations,
          diagnostics,
          diagnosticsHandoffs,
          routes,
          headroom,
        );
      // A write route waits out an in-flight WAL checkpoint (src/db/write-gate.ts); reads never wait.
      if (WRITE_METHODS.has(method) && dbWriteGate() !== null)
        void awaitDbWriteGate().then(dispatch);
      else dispatch();
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
  outcomesControl?: OutcomesControlService | null,
  recsSnapshot?: RecsSnapshotService,
  diagnosticsSnapshot?: DiagnosticsSnapshotService,
  routeSnapshot?: RouteSnapshotService,
  headroomSnapshot?: HeadroomSnapshotService,
): http.Server {
  const handler = createHandler(
    db,
    port,
    uiRoot,
    sessionToken,
    kickBootScan,
    outcomesControl,
    recsSnapshot,
    diagnosticsSnapshot,
    routeSnapshot,
    headroomSnapshot,
  );
  return http.createServer(handler);
}
