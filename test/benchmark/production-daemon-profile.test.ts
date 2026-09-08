import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isExpectedControlledExit,
  isolatedEnvironment,
} from "../../scripts/benchmark/production-daemon-profile.js";

const roots: string[] = [];

function fixture(): { root: string; dbPath: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wrangler-production-profile-"));
  roots.push(root);
  const dbPath = path.join(root, "synthetic.sqlite");
  fs.writeFileSync(dbPath, "");
  return { root, dbPath, env: isolatedEnvironment(root, dbPath) };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("synthetic production-daemon boundary", () => {
  it("accepts only an explicitly requested SIGTERM with its Windows null exit code", () => {
    expect(isExpectedControlledExit(0, null, false)).toBe(true);
    expect(isExpectedControlledExit(null, "SIGTERM", true)).toBe(true);
    expect(isExpectedControlledExit(null, "SIGTERM", false)).toBe(false);
    expect(isExpectedControlledExit(null, null, true)).toBe(false);
    expect(isExpectedControlledExit(1, null, true)).toBe(false);
  });

  it("builds a minimal environment with all writable identity paths isolated", () => {
    const { root, env } = fixture();
    for (const name of [
      "AW_DB_PATH",
      "AW_SCAN_ROOT",
      "AW_UI_ROOT",
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "TEMP",
      "TMP",
    ]) {
      expect(path.relative(root, env[name] as string)).not.toMatch(/^\.\.(?:[\\/]|$)/);
    }
    expect(env.AW_PORT).toBe("0");
    expect(env.AW_NO_OPEN).toBe("1");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it("blocks process and external-network surfaces while allowing loopback listen", async () => {
    const { env } = fixture();
    const guard = path.resolve("scripts/benchmark/production-daemon-guard.cjs");
    const code = `
      const cp = require("node:child_process");
      const net = require("node:net");
      try { cp.spawnSync("git", ["--version"]); } catch {}
      try { net.connect({ host: "example.com", port: 443 }); } catch {}
      fetch("https://example.com").catch(() => {});
      setInterval(() => {}, 600000);
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        process.send({ done: true });
        server.close(() => setTimeout(() => process.exit(0), 25));
      });
    `;
    const child = spawn(process.execPath, ["--require", guard, "--eval", code], {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    const messages: Array<Record<string, unknown>> = [];
    let stderr = "";
    const childStderr = child.stderr;
    if (!childStderr) throw new Error("guard test child requires piped stderr");
    childStderr.setEncoding("utf8");
    childStderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("message", (message: unknown) => messages.push(message as Record<string, unknown>));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`guard child timed out: ${stderr}`));
      }, 5_000);
      child.on("error", reject);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(exitCode).toBe(0);
    expect(messages).toContainEqual(expect.objectContaining({ event: "guard-ready" }));
    expect(messages).toContainEqual(expect.objectContaining({ event: "server-listening" }));
    expect(messages).toContainEqual(
      expect.objectContaining({ event: "timer-registered", originalDelayMs: 600_000 }),
    );
    expect(messages.filter((message) => message.event === "boundary-blocked")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: "child_process.spawnSync" }),
        expect.objectContaining({ surface: "net.connect" }),
        expect.objectContaining({ surface: "fetch" }),
      ]),
    );
    expect(messages).toContainEqual({ done: true });
  });
});
