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

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { safeResolve } from "../../src/daemon/static.js";

// Lets tests below spy on individual fs functions (e.g. createReadStream)
// while every other fs call in this file keeps its real implementation.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));
afterEach(() => {
  vi.restoreAllMocks();
});

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

/** Like `get`, but also returns response headers and body (for ETag/MIME tests). */
function requestFull(
  port: number,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "GET",
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
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
    // safeResolve returns the canonical path; tmpdir may sit under a symlink (macOS /var).
    expect(result).toBe(fs.realpathSync(legitFile));
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
    expect(result?.startsWith(fs.realpathSync(root) + path.sep)).toBe(true);
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

// ── P0-U1: per-request stat/stream serving ────────────────────────────────────

describe("createStaticHandler — per-request serving (P0-U1)", () => {
  let uiRoot: string;
  let server: http.Server;
  let port: number;
  let db: Database.Database;

  beforeAll(() => {
    uiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-static-serve-"));
    fs.writeFileSync(path.join(uiRoot, "index.html"), "<html>root</html>");
    fs.mkdirSync(path.join(uiRoot, "assets"));
    fs.writeFileSync(path.join(uiRoot, "assets", "app-abc123.js"), "console.log(1);");
    db = new Database(":memory:");
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

  it("serves a new asset written after the handler was built (200, correct MIME)", async () => {
    fs.writeFileSync(path.join(uiRoot, "assets", "new-deadbeef.js"), "console.log(2);");
    const res = await requestFull(port, "/assets/new-deadbeef.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
  });

  it("returns 404 (never the index.html fallback) for a missing extensioned asset", async () => {
    const res = await requestFull(port, "/assets/does-not-exist.js");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).not.toMatch(/html/);
  });

  it("serves index.html via the SPA fallback for an extensionless route", async () => {
    const res = await requestFull(port, "/sessions/abc-123");
    expect(res.status).toBe(200);
    expect(res.body).toContain("<html>root</html>");
  });

  it("304s on a matching If-None-Match, then 200s with a fresh ETag after a modification", async () => {
    const first = await requestFull(port, "/assets/app-abc123.js");
    expect(first.status).toBe(200);
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();

    const cached = await requestFull(port, "/assets/app-abc123.js", {
      "if-none-match": etag as string,
    });
    expect(cached.status).toBe(304);

    fs.writeFileSync(path.join(uiRoot, "assets", "app-abc123.js"), "console.log(1); // changed");
    const second = await requestFull(port, "/assets/app-abc123.js");
    expect(second.status).toBe(200);
    expect(second.headers.etag).not.toBe(etag);
  });
});

// ── P0-U1: uiRoot/index.html appearing after the handler was built ───────────

describe("createStaticHandler — asset set built after the handler (P0-U1)", () => {
  let parent: string;
  let uiRoot: string;
  let server: http.Server;
  let port: number;
  let db: Database.Database;

  beforeAll(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), "aw-static-late-"));
    uiRoot = path.join(parent, "dist"); // does not exist yet
    db = new Database(":memory:");
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
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("answers 503 (never throws) while the UI directory has not been built yet", async () => {
    const res = await requestFull(port, "/");
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
  });

  it("still answers 503 once the directory exists but index.html hasn't been written", async () => {
    fs.mkdirSync(uiRoot, { recursive: true });
    const res = await requestFull(port, "/");
    expect(res.status).toBe(503);
  });

  it("serves 200 once index.html exists — no daemon restart needed", async () => {
    fs.writeFileSync(path.join(uiRoot, "index.html"), "<html>built</html>");
    const res = await requestFull(port, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("built");
  });
});

// ── P0-U1: no crash on mid-flight asset deletion (real child process) ────────

describe("createStaticHandler — no crash on asset deletion (child process)", () => {
  // cwd-independent: resolved from this test file's own location, not
  // process.cwd() (which varies by how the test runner was invoked).
  const FIXTURE = fileURLToPath(new URL("./static-child-fixture.ts", import.meta.url));
  let uiRoot: string;
  let child: ReturnType<typeof spawn>;
  let port = -1;

  beforeAll(() => {
    uiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-static-child-"));
    fs.writeFileSync(path.join(uiRoot, "index.html"), "<html>ok</html>");
    fs.writeFileSync(path.join(uiRoot, "doomed.js"), "console.log('doomed');");
  });

  afterAll(() => {
    fs.rmSync(uiRoot, { recursive: true, force: true });
  });

  beforeEach(
    () =>
      new Promise<void>((resolve, reject) => {
        port = -1;
        child = spawn(process.execPath, ["--import", "tsx/esm", FIXTURE, uiRoot], {
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          windowsHide: true,
        });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        const timer = setTimeout(
          () => reject(new Error(`child fixture did not report a port: ${stderr}`)),
          10_000,
        );
        child.once("message", (message: unknown) => {
          clearTimeout(timer);
          port = (message as { port: number }).port;
          resolve();
        });
        child.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.once("exit", (code) => {
          if (port === -1) {
            clearTimeout(timer);
            reject(new Error(`child exited early (${code}): ${stderr}`));
          }
        });
      }),
  );

  afterEach(() => {
    child.kill();
  });

  it("404s a deleted asset without crashing the process, and keeps serving after", async () => {
    fs.rmSync(path.join(uiRoot, "doomed.js"));

    const first = await requestFull(port, "/doomed.js");
    expect(first.status).toBe(404);
    expect(child.exitCode).toBeNull();

    const second = await requestFull(port, "/index.html");
    expect(second.status).toBe(200);
  });
});

// ── P0-U1: sendFile's own stream.on("error") branches ────────────────────────
//
// The child-process test above deletes the asset before the request is ever
// sent, so it 404s from the earlier fs.stat(safe, ...) check and never
// reaches sendFile's stream error handler (static.ts, the stream.on("error")
// below the fs.createReadStream call). These two tests force fs.stat to
// succeed and then fail the read stream itself, exercising both of that
// handler's branches directly: 404 when headers are not sent yet, and
// res.destroy() (never a second writeHead) once they are.

describe('createStaticHandler — sendFile stream.on("error") branches (P0-U1)', () => {
  let uiRoot: string;
  let server: http.Server;
  let port: number;
  let db: Database.Database;

  beforeAll(() => {
    uiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-static-streamerr-"));
    fs.writeFileSync(path.join(uiRoot, "asset.js"), "console.log(1);");
    db = new Database(":memory:");
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

  /** A stream double that never actually reads a file; the caller drives it via `emitOpen`/`emitError`. */
  function fakeReadStream(): EventEmitter & { pipe: () => void } {
    const fake = new EventEmitter() as EventEmitter & { pipe: () => void };
    fake.pipe = () => undefined;
    return fake;
  }

  it("404s (never crashes) when the stream errors before opening — the stat-then-vanish race", async () => {
    vi.spyOn(fs, "createReadStream").mockImplementationOnce(() => {
      const fake = fakeReadStream();
      queueMicrotask(() => fake.emit("error", new Error("simulated ENOENT on open")));
      return fake as unknown as fs.ReadStream;
    });

    const res = await requestFull(port, "/asset.js");
    expect(res.status).toBe(404);
  });

  it("destroys the response, with no second writeHead, when the stream errors after headers are sent", async () => {
    const destroySpy = vi.spyOn(http.ServerResponse.prototype, "destroy");
    const writeHeadSpy = vi.spyOn(http.ServerResponse.prototype, "writeHead");
    vi.spyOn(fs, "createReadStream").mockImplementationOnce(() => {
      const fake = fakeReadStream();
      queueMicrotask(() => {
        fake.emit("open");
        queueMicrotask(() => fake.emit("error", new Error("simulated mid-stream failure")));
      });
      return fake as unknown as fs.ReadStream;
    });

    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/asset.js",
          method: "GET",
          headers: { host: `127.0.0.1:${port}` },
        },
        (res) => {
          res.resume();
          res.on("close", () => resolve());
        },
      );
      req.on("error", () => resolve());
      req.end();
    });

    // Headers were flushed exactly once (the initial 200) — a regression that
    // dropped/inverted the headersSent guard, or tried a second writeHead
    // (e.g. a 404) after headers were sent, would either fail this count or
    // throw ERR_HTTP_HEADERS_SENT.
    expect(writeHeadSpy).toHaveBeenCalledTimes(1);
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });
});
