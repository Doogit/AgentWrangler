/**
 * test/outcomes/credential.test.ts — runPowerShell hard-timeout guard.
 *
 * Regression for the "never-settles" defect: if the underlying PowerShell exec
 * never calls back (Windows: execFile's timeout kill fails to reap a grandchild
 * csc.exe holding the stdout pipe), the returned Promise must STILL settle
 * within the hard bound — otherwise the daemon's `outcomesRunning` flag sticks
 * `true` forever and all future outcomes polls are silently skipped.
 *
 * Also covers the never-throws / clean-degradation contract of readGithubToken.
 */

import * as os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getGithubTokenStatus,
  readGithubToken,
  runPowerShell,
} from "../../src/outcomes/github/credential.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("runPowerShell hard-timeout guard", () => {
  it("rejects within the hard bound when the underlying command never settles", async () => {
    vi.useFakeTimers();
    // A raw exec that NEVER resolves or rejects — simulates the hung child tree.
    const neverSettles = () => new Promise<string>(() => {});
    const p = runPowerShell("whatever", neverSettles);
    const assertion = expect(p).rejects.toThrow(/hard-timeout/);
    // Fast-forward past the hard bound (20s); the guard timer must fire.
    await vi.advanceTimersByTimeAsync(25_000);
    await assertion;
  });

  it("resolves with trimmed output when the raw exec resolves", async () => {
    await expect(runPowerShell("x", async () => "  token-ish  ")).resolves.toBe("  token-ish  ");
  });

  it("propagates a raw exec rejection (does not swallow real errors)", async () => {
    await expect(
      runPowerShell("x", async () => {
        throw new Error("powershell exit 1: boom");
      }),
    ).rejects.toThrow(/boom/);
  });
});

describe("readGithubToken clean degradation", () => {
  it("reads a token from AW_GITHUB_TOKEN on every platform", async () => {
    vi.stubEnv("AW_GITHUB_TOKEN", "ghp_fromenv");

    await expect(readGithubToken()).resolves.toEqual({ ok: true, data: "ghp_fromenv" });
  });

  it("trims a token from AW_GITHUB_TOKEN", async () => {
    vi.stubEnv("AW_GITHUB_TOKEN", "  ghp_padded  ");

    await expect(readGithubToken()).resolves.toEqual({ ok: true, data: "ghp_padded" });
  });

  it("skips a whitespace-only AW_GITHUB_TOKEN", async () => {
    vi.stubEnv("AW_GITHUB_TOKEN", "   ");

    const result = await readGithubToken();
    if (os.platform() !== "win32") {
      expect(result).toEqual({ ok: false, reason: "non-windows-platform" });
    } else {
      expect(result).not.toEqual({ ok: true, data: "   " });
    }
  });

  it("prefers AW_GITHUB_TOKEN over the platform credential path", async () => {
    vi.stubEnv("AW_GITHUB_TOKEN", "ghp_env");

    await expect(readGithubToken()).resolves.toEqual({ ok: true, data: "ghp_env" });
  });

  it("delegates to an injected reader and never throws", async () => {
    await expect(readGithubToken(async () => ({ ok: false, reason: "stub" }))).resolves.toEqual({
      ok: false,
      reason: "stub",
    });
  });
});

describe("getGithubTokenStatus (non-secret Settings status)", () => {
  it("reports source 'env' when AW_GITHUB_TOKEN is set (no token value)", async () => {
    vi.stubEnv("AW_GITHUB_TOKEN", "ghp_secret");

    const status = await getGithubTokenStatus();
    expect(status).toEqual({ configured: true, source: "env" });
    // The token value must never leak into the status object.
    expect(JSON.stringify(status)).not.toContain("ghp_secret");
  });

  it("reports source 'credential-manager' when the platform reader yields a token", async () => {
    const status = await getGithubTokenStatus(async () => ({ ok: true, data: "ghp_fromcred" }));
    expect(status).toEqual({ configured: true, source: "credential-manager" });
    expect(JSON.stringify(status)).not.toContain("ghp_fromcred");
  });

  it("reports not-configured with an AW_GITHUB_TOKEN remedy when no token is available", async () => {
    const status = await getGithubTokenStatus(async () => ({ ok: false, reason: "none" }));
    expect(status.configured).toBe(false);
    expect(status.source).toBeNull();
    expect(status.reason).toMatch(/AW_GITHUB_TOKEN/);
  });
});
