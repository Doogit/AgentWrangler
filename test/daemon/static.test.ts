/**
 * test/daemon/static.test.ts — path traversal safety tests.
 *
 * Covers:
 *   1. safeResolve unit tests: traversal vectors → null; in-root path → real path.
 *   2. HTTP integration: requests against the static handler → 404 for attacks;
 *      200 for a known legitimate file.
 *
 * Traversal matrix (must all yield null from safeResolve / 404 from HTTP):
 *   ../../etc/passwd
 *   ..\..\\Windows\\win.ini   (Windows backslash traversal)
 *   ..%2F..%2Fetc%2Fpasswd    (URL-encoded slash)
 *   ..%252F..%252Fetc%252Fpasswd  (double-encoded slash)
 *   valid%00../               (null-byte injection)
 *   /etc/passwd               (absolute path)
 *   C:\Windows\win.ini        (Windows drive letter)
 *   \\server\share            (UNC path)
 *   ../<root>-evil/secret     (sibling-prefix attack)
 *   /.env                     (dotfile via HTTP)
 *
 * Positive control:
 *   index.html → 200 (legitimate file)
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { safeResolve } from "../../src/daemon/static.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function get(port: number, urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "GET",
        headers: { host: `127.0.0.1:${port}` },
      },
      (res) => {
        res.resume(); // consume body
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ── safeResolve unit tests ─────────────────────────────────────────────────────

describe("safeResolve", () => {
  let root: string;
  let legitFile: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-static-root-"));
    legitFile = path.join(root, "index.html");
    fs.writeFileSync(legitFile, "<html>ok</html>");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ── Traversal vectors → null ──────────────────────────────────────────────

  it("rejects ../../etc/passwd", () => {
    expect(safeResolve(root, "../../etc/passwd")).toBeNull();
  });

  it("rejects ..%2F..%2Fetc%2Fpasswd (URL-encoded slash)", () => {
    expect(safeResolve(root, "..%2F..%2Fetc%2Fpasswd")).toBeNull();
  });

  it("rejects ..%252F..%252Fetc%252Fpasswd (double-encoded slash)", () => {
    expect(safeResolve(root, "..%252F..%252Fetc%252Fpasswd")).toBeNull();
  });

  it("rejects null-byte injection: valid%00../", () => {
    expect(safeResolve(root, "valid\0../")).toBeNull();
  });

  it("rejects null-byte via URL encoding: valid%00../", () => {
    expect(safeResolve(root, "valid%00../")).toBeNull();
  });

  it("rejects absolute Unix path /etc/passwd", () => {
    expect(safeResolve(root, "/etc/passwd")).toBeNull();
  });

  it("rejects Windows drive letter C:\\Windows\\win.ini", () => {
    expect(safeResolve(root, "C:\\Windows\\win.ini")).toBeNull();
  });

  it("rejects Windows UNC path \\\\server\\share", () => {
    expect(safeResolve(root, "\\\\server\\share")).toBeNull();
  });

  it("rejects UNC path //server/share", () => {
    expect(safeResolve(root, "//server/share")).toBeNull();
  });

  it("rejects sibling-prefix attack (parent + root-evil)", () => {
    // Create the sibling directory so realpathSync can resolve it.
    const sibling = `${root}-evil`;
    const siblingFile = path.join(sibling, "secret.txt");
    try {
      fs.mkdirSync(sibling, { recursive: true });
      fs.writeFileSync(siblingFile, "secret");

      // The traversal: go up one level then into the sibling.
      const attack = path.join("..", `${path.basename(root)}-evil`, "secret.txt");
      expect(safeResolve(root, attack)).toBeNull();
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlink that points outside root (Unix only — Windows requires admin for symlinks)",
    () => {
      // Create a symlink inside root pointing to a file outside root.
      const linkPath = path.join(root, "link-outside");
      const outsideFile = path.join(os.tmpdir(), "aw-outside-target.txt");
      fs.writeFileSync(outsideFile, "outside");
      try {
        // Remove stale link if present.
        try {
          fs.unlinkSync(linkPath);
        } catch {}
        fs.symlinkSync(outsideFile, linkPath);
        expect(safeResolve(root, "link-outside")).toBeNull();
      } finally {
        try {
          fs.unlinkSync(linkPath);
        } catch {}
        fs.rmSync(outsideFile, { force: true });
      }
    },
  );

  // ── Positive control ──────────────────────────────────────────────────────

  it("allows a legitimate in-root file (positive control)", () => {
    const result = safeResolve(root, "index.html");
    expect(result).not.toBeNull();
    expect(result).toBe(legitFile);
  });

  it("allows the root itself (empty relative path)", () => {
    const result = safeResolve(root, ".");
    expect(result).not.toBeNull();
  });

  it("returns a non-null path for a non-existent but in-root path (ENOENT SPA fallback)", () => {
    // safeResolve must NOT return null for an in-root non-existent path, so
    // createStaticHandler can pass it to sirv's single:true SPA fallback.
    const result = safeResolve(root, "sessions/abc-123");
    expect(result).not.toBeNull();
    // The returned path must still be within root.
    expect(result?.startsWith(root)).toBe(true);
  });

  it("still rejects a traversal to a non-existent out-of-root path", () => {
    // Even if the target doesn't exist, traversal must be blocked.
    expect(safeResolve(root, "../../does-not-exist-at-all")).toBeNull();
  });
});

// ── HTTP integration: static handler traversal ────────────────────────────────

describe("HTTP static handler traversal", () => {
  let uiRoot: string;
  let server: http.Server;
  let port: number;
  let db: Database.Database;

  beforeAll(() => {
    uiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-ui-root-"));
    // Create a known legitimate file.
    fs.writeFileSync(path.join(uiRoot, "index.html"), "<html>ok</html>");
    // Create a dotfile (must be blocked by sirv).
    fs.writeFileSync(path.join(uiRoot, ".env"), "SECRET=hunter2");

    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
  });

  beforeEach(
    () =>
      new Promise<void>((resolve, reject) => {
        server = createServer(db, 0, uiRoot);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as { port: number };
          port = addr.port;
          resolve();
        });
        server.on("error", reject);
      }),
  );

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  afterAll(() => {
    db.close();
    fs.rmSync(uiRoot, { recursive: true, force: true });
  });

  it("returns 200 for the legitimate index.html (positive control)", async () => {
    const status = await get(port, "/index.html");
    expect(status).toBe(200);
  });

  it("returns 404 for ../../etc/passwd", async () => {
    const status = await get(port, "/../../etc/passwd");
    expect(status).toBe(404);
  });

  it("returns 404 for ..%2F..%2Fetc%2Fpasswd (URL-encoded)", async () => {
    const status = await get(port, "/..%2F..%2Fetc%2Fpasswd");
    expect(status).toBe(404);
  });

  it("returns 404 for ..%252F..%252F double-encoded traversal", async () => {
    const status = await get(port, "/..%252F..%252Fetc%252Fpasswd");
    expect(status).toBe(404);
  });

  it("returns 404 for /.env (dotfile blocked by sirv)", async () => {
    const status = await get(port, "/.env");
    expect(status).toBe(404);
  });

  it("returns 404 for a nonexistent file", async () => {
    const status = await get(port, "/does-not-exist.txt");
    expect(status).toBe(404);
  });
});
