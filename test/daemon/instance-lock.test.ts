/**
 * test/daemon/instance-lock.test.ts — P3-U8 R-8: one daemon per DB.
 *
 * Unit: the lock file is exclusive while its owner lives, and a lock left by a dead process is
 * taken over. Spawned (like boot-order.test.ts): a second daemon on the same DB exits with a clear
 * message before touching the DB, a second daemon on a busy port exits with a clear message, and
 * the first daemon keeps answering throughout.
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isolatedEnvironment } from "../../scripts/benchmark/production-daemon-profile.js";
import { acquireInstanceLock } from "../../src/daemon/instance-lock.js";

const roots: string[] = [];
const children: childProcess.ChildProcess[] = [];
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-instance-lock-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(5_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("acquireInstanceLock", () => {
  it("is exclusive while held and free again after release", () => {
    const dbPath = path.join(tmpRoot(), "db.sqlite");
    const first = acquireInstanceLock(dbPath);
    expect(first.ok).toBe(true);
    const second = acquireInstanceLock(dbPath);
    expect(second).toEqual({ ok: false, pid: process.pid });
    if (first.ok) first.release();
    const third = acquireInstanceLock(dbPath);
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
  });

  it("creates a missing DB directory (first run on a fresh machine)", () => {
    const dbPath = path.join(tmpRoot(), "not-yet", "db.sqlite");
    const lock = acquireInstanceLock(dbPath);
    expect(lock.ok).toBe(true);
    if (lock.ok) lock.release();
  });

  it("takes over a lock left by a process that has exited", () => {
    const dbPath = path.join(tmpRoot(), "db.sqlite");
    const dead = childProcess.spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid))"],
      {
        encoding: "utf8",
      },
    );
    fs.writeFileSync(`${dbPath}.lock`, dead.stdout);
    const lock = acquireInstanceLock(dbPath);
    expect(lock.ok).toBe(true);
    expect(fs.readFileSync(`${dbPath}.lock`, "utf8")).toBe(String(process.pid));
    if (lock.ok) lock.release();
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function status(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/api/status", timeout: 10_000 },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

const ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/daemon/index.ts",
);

function spawnDaemon(root: string, dbPath: string, port: number) {
  const child = childProcess.spawn(process.execPath, ["--import", "tsx/esm", ENTRY], {
    env: { ...isolatedEnvironment(root, dbPath), AW_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  let out = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => {
    out += c;
  });
  child.stderr?.on("data", (c: string) => {
    out += c;
  });
  const exit = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return { child, exit, output: () => out };
}

async function waitFor(pred: () => boolean, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

describe("spawned daemons — P3-U8 R-8", () => {
  it("a second daemon on the same DB exits with a message; one on a busy port too; the first is unaffected", async () => {
    const root = tmpRoot();
    const dbPath = path.join(root, "db.sqlite");
    const portA = await freePort();
    const a = spawnDaemon(root, dbPath, portA);
    await waitFor(() => a.output().includes("Listening on"), `first daemon: ${a.output()}`);

    // Same DB, different port: refused by the lock before migrations run.
    const b = spawnDaemon(root, dbPath, await freePort());
    expect(await Promise.race([b.exit, delay(30_000).then(() => "hung")])).toBe(1);
    expect(b.output()).toMatch(/already running.*pid \d+/i);
    expect(b.output()).not.toMatch(/Migrations/);

    // Different DB, same port: a clear message, not an unhandled EADDRINUSE stack.
    const other = path.join(tmpRoot(), "other.sqlite");
    const c = spawnDaemon(path.dirname(other), other, portA);
    expect(await Promise.race([c.exit, delay(30_000).then(() => "hung")])).toBe(1);
    expect(c.output()).toMatch(new RegExp(`port ${portA} is already in use`, "i"));
    expect(c.output()).not.toMatch(/Unhandled 'error' event/);

    expect(await status(portA)).toBe(200);
    expect(a.child.exitCode).toBeNull();
  }, 90_000);
});
