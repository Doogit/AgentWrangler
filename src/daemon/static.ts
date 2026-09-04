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
 * 2. sirv with dotfiles:false blocks .env and other dotfiles.
 *
 * 3. The static handler is only mounted when uiRoot exists; it is not exposed
 *    unless the SPA has been built.
 */

import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";
import sirv from "sirv";

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

  // 7. RealpathSync: follow symlinks and get the canonical path.
  //    For non-existent paths (ENOENT/ENOTDIR), no symlink can exist, so
  //    the path.resolve result is already canonical — fall through with it.
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
    // File does not exist; use the path.resolve result for the prefix check.
    realResolved = resolved;
  }

  // 8. Get the canonical root path (once; callers may cache this).
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }

  // 9. Guard: real path must be root itself or begin with root + separator.
  //    The `+ sep` prevents sibling-prefix attacks: /var/www/app vs /var/www/app-evil.
  if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
    return null;
  }

  return realResolved;
}

/**
 * Create a sirv-based static file handler for `uiRoot`.
 *
 * sirv is configured with:
 *   - dotfiles: false — blocks .env and other hidden files.
 *   - dev: false — production mode (ETags, caching headers).
 *   - single: true — falls back to index.html for SPA client-side routing.
 *
 * The returned function is a Node HTTP middleware: (req, res, next) => void.
 * Call `next()` when sirv cannot serve the path (404 fallback in http.ts).
 */
export function createStaticHandler(
  uiRoot: string,
): (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void {
  // Verify root exists before constructing the handler.
  if (!fs.existsSync(uiRoot)) {
    // Return a no-op that always calls next — UI not built yet.
    return (_req, _res, next) => next();
  }

  const serve = sirv(uiRoot, {
    dotfiles: false,
    dev: false,
    single: true, // SPA: fall back to index.html on 404.
    etag: true,
  });

  return (req, res, next) => {
    // Intercept the path for an extra safety check before handing off to sirv.
    const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
    // Strip leading slash for safeResolve (it expects a relative input).
    const relative = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;

    if (relative.length > 0) {
      // Block dotfiles explicitly (sirv's single: true would otherwise fall
      // back to index.html instead of 404 for paths like /.env).
      const segments = relative.split(/[/\\]/);
      if (segments.some((seg) => seg.length > 0 && seg.startsWith("."))) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
        return;
      }

      const safe = safeResolve(uiRoot, relative);
      if (safe === null) {
        // Traversal or other rejection — short-circuit with 404.
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
        return;
      }
    }

    // Path is within root — hand off to sirv.
    serve(req, res, next);
  };
}
