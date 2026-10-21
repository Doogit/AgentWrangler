/**
 * src/daemon/static.ts — hardened static file serving for the built SPA.
 *
 * Security properties:
 *
 * 1. safeResolve(root, input): the single choke-point for any request-derived
 *    filesystem path. Defends against:
 *    - Path traversal (../../, URL-encoded, double-encoded).
 *    - Null-byte injection.
 *    - Absolute paths (Unix / and Windows drive letters).
 *    - UNC paths (\\server\share, //server/share).
 *    - Symlinks that escape root (checked via realpathSync).
 *    - Sibling-prefix attacks (<root>-evil/...) — blocked by the `root + sep`
 *      prefix check after realpathSync.
 *
 * 2. A dotfile segment check (before safeResolve) blocks .env and other
 *    hidden files.
 *
 * 3. Existence is decided per request via fs.stat, never at construction
 *    time: the handler serves whatever is on disk right now, so a daemon
 *    started before the first `build:ui` starts serving as soon as `dist/`
 *    appears, and a `vite build` that briefly empties `dist` mid-rebuild
 *    answers 503 (Retry-After: 1) instead of a stale or crashed response.
 *
 * File serving (sendFile): a per-request stat + stream, replacing sirv's
 * prebuilt file-list mode. Weak ETag (size-mtime), Cache-Control: no-cache
 * for index.html, immutable for everything else (asset filenames are
 * content-hashed). A stream error after the stat succeeded (e.g. the file
 * was deleted in the race between stat and open) 404s if headers haven't
 * been sent yet, else destroys the response — never an uncaught exception.
 */

import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";

/**
 * Resolve `input` (from a request URL segment) safely within `root`.
 *
 * Returns the absolute, real path if it is within `root`, or `null` if:
 * - `input` contains a null byte.
 * - `input` is or resolves to an absolute path.
 * - `input` is a UNC path.
 * - The real path after symlink resolution escapes `root`.
 *
 * The URL-decode loop handles single-, double-, and triple-encoded sequences.
 */
export function safeResolve(root: string, input: string): string | null {
  // 1. URL-decode loop until stable (handles %25-encoding, etc.).
  let decoded = input;
  for (let i = 0; i < 16; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      // Malformed percent-encoding — reject.
      return null;
    }
    if (next === decoded) break;
    decoded = next;
  }

  // 2. Reject null bytes (bypass attempts via null-byte injection).
  if (decoded.includes("\0")) return null;

  // 3. Reject UNC paths (\\server\share or //server/share).
  if (decoded.startsWith("\\\\") || decoded.startsWith("//")) return null;

  // 4. Reject Windows drive letters (C:\, D:/, etc.).
  if (/^[a-zA-Z]:/.test(decoded)) return null;

  // 5. Reject absolute Unix paths.
  if (path.isAbsolute(decoded)) return null;

  // 6. Resolve relative to root.
  const resolved = path.resolve(root, decoded);

  // 7. Get the canonical root path (once; callers may cache this).
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }

  // 8. RealpathSync: follow symlinks and get the canonical path.
  //    For non-existent paths (ENOENT/ENOTDIR), resolve against the canonical
  //    root so the prefix check compares canonical to canonical (the root may
  //    sit under a symlink, e.g. macOS /var -> /private/var).
  //    This lets createStaticHandler pass unknown paths to sirv's single:true
  //    SPA fallback (serving index.html) rather than returning a spurious 404.
  let realResolved: string;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      // Inaccessible for reasons other than "doesn't exist" — reject.
      return null;
    }
    // File does not exist; use the lexical path under the canonical root.
    realResolved = path.resolve(realRoot, decoded);
  }

  // 9. Guard: real path must be root itself or begin with root + separator.
  //    The `+ sep` prevents sibling-prefix attacks: /var/www/app vs /var/www/app-evil.
  if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
    return null;
  }

  return realResolved;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function mimeFor(absPath: string): string {
  return MIME_TYPES[path.extname(absPath).toLowerCase()] ?? "application/octet-stream";
}

function send404(res: http.ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404 Not Found");
}

function send503(res: http.ServerResponse): void {
  // The UI directory exists but index.html doesn't (mid `vite build`, which
  // empties dist/ before writing) — or the daemon started before the first
  // `build:ui` ran at all. Both are transient; ask the client to retry.
  res.writeHead(503, { "Content-Type": "text/plain", "Retry-After": "1" });
  res.end("503 Service Unavailable — UI rebuilding");
}

/**
 * Stream `absPath` (already stat'd as `stat`) to `res`.
 *
 * Weak ETag `size-mtime`; Cache-Control is `no-cache` for index.html (so a
 * rebuild is picked up on next navigation) and `immutable` for everything
 * else (asset filenames are content-hashed by the bundler).
 *
 * `stream.on("error")` covers the race between the stat above and the actual
 * file open/read (e.g. the file was deleted in between): 404 if headers
 * haven't been sent yet, else destroy the response — never an uncaught
 * exception that could crash the daemon.
 */
function sendFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  absPath: string,
  stat: fs.Stats,
  isIndex: boolean,
): void {
  const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
  const cacheControl = isIndex ? "no-cache" : "public, max-age=31536000, immutable";

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": cacheControl });
    res.end();
    return;
  }

  const stream = fs.createReadStream(absPath);
  stream.once("open", () => {
    res.writeHead(200, {
      ETag: etag,
      "Cache-Control": cacheControl,
      "Content-Type": mimeFor(absPath),
      "Content-Length": String(stat.size),
    });
  });
  stream.on("error", () => {
    if (!res.headersSent) send404(res);
    else res.destroy();
  });
  stream.pipe(res);
}

/** SPA fallback target for an extensionless route: serve uiRoot/index.html. */
function serveIndexFallback(
  uiRoot: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const indexPath = path.join(uiRoot, "index.html");
  fs.stat(indexPath, (err, stat) => {
    if (err) {
      send503(res);
      return;
    }
    sendFile(req, res, indexPath, stat, true);
  });
}

/**
 * Create a static file handler for `uiRoot`.
 *
 * Per-request stat and stream (no prebuilt file list, no construction-time
 * existence check) — see the file-level doc comment. The returned function
 * is a Node HTTP middleware: (req, res, next) => void; `next` is unused
 * (the handler always resolves the response itself) but kept for the
 * call shape in http.ts.
 */
export function createStaticHandler(
  uiRoot: string,
): (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void {
  return (req, res, _next) => {
    const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
    // Strip leading slash for safeResolve (it expects a relative input).
    const relative = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;

    if (relative.length > 0) {
      // Block dotfiles explicitly (the SPA fallback would otherwise serve
      // index.html instead of 404 for paths like /.env).
      const segments = relative.split(/[/\\]/);
      if (segments.some((seg) => seg.length > 0 && seg.startsWith("."))) {
        send404(res);
        return;
      }
    }

    // Only an extensionless path (e.g. an SPA route like /sessions/abc) may
    // fall back to index.html; a missing /assets/x.js must 404, never serve
    // HTML back for a JS request.
    const hasExt = path.extname(relative) !== "";

    fs.stat(uiRoot, (rootErr) => {
      if (rootErr) {
        // UI not built yet (dist/ doesn't exist). Per-request stat means
        // this resolves itself the moment build:ui creates it — no restart.
        if (hasExt) send404(res);
        else send503(res);
        return;
      }

      const safe = safeResolve(uiRoot, relative);
      if (safe === null) {
        send404(res);
        return;
      }

      fs.stat(safe, (err, stat) => {
        if (err || !stat.isFile()) {
          if (hasExt) send404(res);
          else serveIndexFallback(uiRoot, req, res);
          return;
        }
        sendFile(req, res, safe, stat, relative === "" || relative === "index.html");
      });
    });
  };
}
