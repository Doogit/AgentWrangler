/**
 * test/oauth-credentials.test.ts — FileCredentialSource unit tests.
 *
 * All file I/O is stubbed; no real ~/.claude/.credentials.json is read.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChainedCredentialSource,
  type CredentialResult,
  FileCredentialSource,
  KEYCHAIN_CACHE_TTL_MS,
  KEYCHAIN_TIMEOUT_MS,
  KeychainCredentialSource,
  defaultSecurityExec,
  fileCredentialSource,
  getOAuthStatus,
} from "../src/oauth/credentials.js";

vi.mock("node:fs");
// Never run the real `security` CLI: the async Keychain spawn is stubbed per test.
// Shape: execFile(file, args, options, callback(err, stdout, stderr)).
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
function execFileYields(err: Error | null, stdout: string, stderr = ""): void {
  execFileMock.mockImplementation((_f: string, _a: string[], _o: unknown, cb: ExecCb) => {
    cb(err, stdout, stderr);
    return {};
  });
}

const VALID_EXPIRY = Date.now() + 3_600_000; // 1 hour from now

function writeCredFile(content: unknown): void {
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(content));
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("FileCredentialSource — missing file", () => {
  it("returns ok:false when the file does not exist", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const src = new FileCredentialSource("/nonexistent/.credentials.json");
    const result = src.read();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/not found/i);
    expect(result.reason).toMatch(/re-login/i);
  });
});

describe("FileCredentialSource — invalid JSON", () => {
  it("returns ok:false when the file is not valid JSON", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("{ bad json");
    const src = new FileCredentialSource("/any");
    const result = src.read();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/not valid json/i);
  });
});

describe("FileCredentialSource — missing claudeAiOauth", () => {
  it("returns ok:false when claudeAiOauth key is absent", () => {
    writeCredFile({ somethingElse: {} });
    const src = new FileCredentialSource("/any");
    const result = src.read();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/claudeAiOauth/);
  });
});

describe("FileCredentialSource — expired token", () => {
  it("returns ok:false with re-login reason when token is expired", () => {
    writeCredFile({
      claudeAiOauth: {
        accessToken: "tok_expired",
        expiresAt: Date.now() - 1000,
        subscriptionType: "max",
        rateLimitTier: "max_5x",
      },
    });
    const src = new FileCredentialSource("/any");
    const result = src.read();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/expired/i);
    expect(result.reason).toMatch(/re-login/i);
  });
});

describe("FileCredentialSource — valid credential", () => {
  it("returns ok:true with credential fields (never leaks the token in the test assertion)", () => {
    writeCredFile({
      claudeAiOauth: {
        accessToken: "tok_valid",
        expiresAt: VALID_EXPIRY,
        subscriptionType: "max",
        rateLimitTier: "max_5x",
      },
    });
    const src = new FileCredentialSource("/any");
    const result = src.read();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.credential.expiresAt).toBe(VALID_EXPIRY);
    expect(result.credential.subscriptionType).toBe("max");
    expect(result.credential.rateLimitTier).toBe("max_5x");
    // accessToken is present (truthy) but we don't log its value in assertions
    expect(result.credential.accessToken.length).toBeGreaterThan(0);
  });

  it("returns null fields for absent subscriptionType / rateLimitTier", () => {
    writeCredFile({
      claudeAiOauth: {
        accessToken: "tok_valid",
        expiresAt: VALID_EXPIRY,
      },
    });
    const src = new FileCredentialSource("/any");
    const result = src.read();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.credential.subscriptionType).toBeNull();
    expect(result.credential.rateLimitTier).toBeNull();
  });
});

describe("getOAuthStatus", () => {
  it("returns authenticated:false with reason when credential is missing", async () => {
    const stub = { read: () => ({ ok: false as const, reason: "no file" }) };
    const status = await getOAuthStatus(stub);
    expect(status.authenticated).toBe(false);
    expect(status.tier).toBeNull();
    expect(status.reason).toBe("no file");
  });

  it("returns authenticated:true with tier when credential is valid", async () => {
    const stub = {
      read: () => ({
        ok: true as const,
        credential: {
          accessToken: "tok",
          expiresAt: VALID_EXPIRY,
          subscriptionType: "max",
          rateLimitTier: "max_5x",
        },
      }),
    };
    const status = await getOAuthStatus(stub);
    expect(status.authenticated).toBe(true);
    expect(status.tier).toBe("max_5x");
    expect(status.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// KeychainCredentialSource (NU6) — stubbed `security` exec
// ---------------------------------------------------------------------------

const VALID_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: "tok_keychain",
    expiresAt: VALID_EXPIRY,
    subscriptionType: "max",
    rateLimitTier: "max_5x",
  },
});

describe("KeychainCredentialSource", () => {
  it("short-circuits on non-darwin without invoking `security`", async () => {
    let called = false;
    const src = new KeychainCredentialSource(async () => {
      called = true;
      return VALID_BLOB;
    }, "win32");
    const result = await src.read();
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/only applies on darwin/i);
  });

  it("returns ok:true when the Keychain holds a valid blob (darwin)", async () => {
    const src = new KeychainCredentialSource(async () => VALID_BLOB, "darwin");
    const result = await src.read();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.credential.rateLimitTier).toBe("max_5x");
    expect(result.credential.accessToken.length).toBeGreaterThan(0);
  });

  it("returns ok:false with a Keychain-specific reason when the entry is absent (darwin)", async () => {
    const src = new KeychainCredentialSource(async () => null, "darwin");
    const result = await src.read();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/keychain lookup failed/i);
    expect(result.reason).toMatch(/re-login/i);
  });

  it("returns ok:false with a parse reason when the Keychain output is garbage (darwin)", async () => {
    const src = new KeychainCredentialSource(async () => "not-json{", "darwin");
    const result = await src.read();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/keychain credential is not valid json/i);
  });

  it("D1: read() returns a pending Promise at once while `security` is still running", () => {
    // A hung `security` (locked keychain, "allow access" dialog) must not block the caller.
    const src = new KeychainCredentialSource(() => new Promise<string | null>(() => {}), "darwin");
    const pending = src.read();
    expect(pending).toBeInstanceOf(Promise);
  });

  it("D1: caches the Keychain blob, so repeat and concurrent reads spawn `security` once", async () => {
    let calls = 0;
    let now = 1_000;
    const src = new KeychainCredentialSource(
      async () => {
        calls += 1;
        return VALID_BLOB;
      },
      "darwin",
      () => now,
    );
    const [a, b] = await Promise.all([src.read(), src.read()]);
    expect(a.ok && b.ok).toBe(true);
    expect(calls).toBe(1);
    now += KEYCHAIN_CACHE_TTL_MS - 1;
    expect((await src.read()).ok).toBe(true);
    expect(calls).toBe(1);
    now += 2; // past the TTL: re-reads so a re-login or logout shows up
    expect((await src.read()).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("D1: caches a failed lookup too, so a locked keychain is not re-prompted every request", async () => {
    let calls = 0;
    const src = new KeychainCredentialSource(
      async () => {
        calls += 1;
        return null;
      },
      "darwin",
      () => 0,
    );
    await src.read();
    await src.read();
    expect(calls).toBe(1);
  });

  it("D1: re-checks expiry on every read even when the blob is cached", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      const shortLived = JSON.stringify({
        claudeAiOauth: { accessToken: "tok_short", expiresAt: 1_000_010 },
      });
      const src = new KeychainCredentialSource(
        async () => shortLived,
        "darwin",
        () => 0,
      );
      expect((await src.read()).ok).toBe(true);
      vi.setSystemTime(1_000_020);
      const result = await src.read();
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.reason).toMatch(/expired/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("defaultSecurityExec (D1: async, bounded Keychain spawn)", () => {
  it("is async, passes a hard timeout of a few seconds and a SIGKILL kill signal", async () => {
    execFileYields(null, `${VALID_BLOB}\n`);
    const pending = defaultSecurityExec();
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toBe(VALID_BLOB);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[0]).toBe("security");
    const options = execFileMock.mock.calls[0]?.[2] as { timeout?: number; killSignal?: string };
    expect(options.timeout).toBe(KEYCHAIN_TIMEOUT_MS);
    expect(KEYCHAIN_TIMEOUT_MS).toBeGreaterThan(0);
    expect(KEYCHAIN_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(options.killSignal).toBe("SIGKILL");
  });

  it("returns the no-credential result when the spawn times out (darwin), never throws", async () => {
    // execFile's shape on timeout: an error with killed:true and the kill signal.
    const timedOut = Object.assign(new Error("Command failed: security"), {
      killed: true,
      signal: "SIGKILL",
    });
    execFileYields(timedOut, "");
    const src = new KeychainCredentialSource(defaultSecurityExec, "darwin");
    await expect(src.read()).resolves.toEqual({
      ok: false,
      reason: "Keychain lookup failed — re-login to Claude Code.",
    });
  });

  it("returns the no-credential result when the spawn itself throws (darwin)", async () => {
    execFileMock.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const src = new KeychainCredentialSource(defaultSecurityExec, "darwin");
    await expect(src.read()).resolves.toEqual({
      ok: false,
      reason: "Keychain lookup failed — re-login to Claude Code.",
    });
  });

  it("never logs the secret on the success or failure path (SEC-101)", async () => {
    const secret = "tok_SUPER_SECRET_keychain_value";
    const blob = JSON.stringify({
      claudeAiOauth: { accessToken: secret, expiresAt: VALID_EXPIRY },
    });
    const sinks = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "debug").mockImplementation(() => {}),
      vi.spyOn(process.stdout, "write").mockImplementation(() => true),
      vi.spyOn(process.stderr, "write").mockImplementation(() => true),
    ];
    try {
      execFileYields(null, blob);
      expect(
        (await getOAuthStatus(new KeychainCredentialSource(defaultSecurityExec, "darwin")))
          .authenticated,
      ).toBe(true);
      execFileYields(Object.assign(new Error(`failed ${secret}`), { code: 1 }), blob, secret);
      expect(
        (await getOAuthStatus(new KeychainCredentialSource(defaultSecurityExec, "darwin")))
          .authenticated,
      ).toBe(false);
      for (const sink of sinks) {
        expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
      }
    } finally {
      for (const sink of sinks) sink.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// ChainedCredentialSource (NU6)
// ---------------------------------------------------------------------------

const okSource = (tier: string) => ({
  read: (): CredentialResult => ({
    ok: true,
    credential: {
      accessToken: "tok",
      expiresAt: VALID_EXPIRY,
      subscriptionType: "max",
      rateLimitTier: tier,
    },
  }),
});
const failSource = (reason: string) => ({ read: (): CredentialResult => ({ ok: false, reason }) });

describe("ChainedCredentialSource", () => {
  it("returns the first source that succeeds and does not consult later ones", async () => {
    let secondCalled = false;
    const chain = new ChainedCredentialSource([
      okSource("max_5x"),
      {
        read: (): CredentialResult => {
          secondCalled = true;
          return { ok: false, reason: "should not run" };
        },
      },
    ]);
    const result = await chain.read();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.credential.rateLimitTier).toBe("max_5x");
    expect(secondCalled).toBe(false);
  });

  it("falls through to a later source when an earlier one fails", async () => {
    const chain = new ChainedCredentialSource([failSource("no file"), okSource("max")]);
    const result = await chain.read();
    expect(result.ok).toBe(true);
  });

  it("D1: awaits an async (Keychain) source after a sync (file) source", async () => {
    const chain = new ChainedCredentialSource([
      failSource("no file"),
      new KeychainCredentialSource(async () => VALID_BLOB, "darwin"),
    ]);
    const result = await chain.read();
    expect(result.ok).toBe(true);
  });

  it("names every gap when all sources fail", async () => {
    const chain = new ChainedCredentialSource([
      failSource("Credentials file not found — re-login to Claude Code."),
      failSource("Keychain lookup failed — re-login to Claude Code."),
    ]);
    const result = await chain.read();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/credentials file not found/i);
    expect(result.reason).toMatch(/keychain lookup failed/i);
  });
});

describe("default fileCredentialSource wiring", () => {
  it("is a plain file source on non-darwin (Windows/Linux byte-identical)", () => {
    if (os.platform() === "darwin") return; // darwin chains; asserted structurally elsewhere
    expect(fileCredentialSource).toBeInstanceOf(FileCredentialSource);
  });
});
