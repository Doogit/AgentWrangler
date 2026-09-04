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
  KeychainCredentialSource,
  fileCredentialSource,
  getOAuthStatus,
} from "../src/oauth/credentials.js";

vi.mock("node:fs");

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
  it("returns authenticated:false with reason when credential is missing", () => {
    const stub = { read: () => ({ ok: false as const, reason: "no file" }) };
    const status = getOAuthStatus(stub);
    expect(status.authenticated).toBe(false);
    expect(status.tier).toBeNull();
    expect(status.reason).toBe("no file");
  });

  it("returns authenticated:true with tier when credential is valid", () => {
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
    const status = getOAuthStatus(stub);
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
  it("short-circuits on non-darwin without invoking `security`", () => {
    let called = false;
    const src = new KeychainCredentialSource(() => {
      called = true;
      return VALID_BLOB;
    }, "win32");
    const result = src.read();
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/only applies on darwin/i);
  });

  it("returns ok:true when the Keychain holds a valid blob (darwin)", () => {
    const src = new KeychainCredentialSource(() => VALID_BLOB, "darwin");
    const result = src.read();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.credential.rateLimitTier).toBe("max_5x");
    expect(result.credential.accessToken.length).toBeGreaterThan(0);
  });

  it("returns ok:false with a Keychain-specific reason when the entry is absent (darwin)", () => {
    const src = new KeychainCredentialSource(() => null, "darwin");
    const result = src.read();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/keychain lookup failed/i);
    expect(result.reason).toMatch(/re-login/i);
  });

  it("returns ok:false with a parse reason when the Keychain output is garbage (darwin)", () => {
    const src = new KeychainCredentialSource(() => "not-json{", "darwin");
    const result = src.read();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/keychain credential is not valid json/i);
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
  it("returns the first source that succeeds and does not consult later ones", () => {
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
    const result = chain.read();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.credential.rateLimitTier).toBe("max_5x");
    expect(secondCalled).toBe(false);
  });

  it("falls through to a later source when an earlier one fails", () => {
    const chain = new ChainedCredentialSource([failSource("no file"), okSource("max")]);
    const result = chain.read();
    expect(result.ok).toBe(true);
  });

  it("names every gap when all sources fail", () => {
    const chain = new ChainedCredentialSource([
      failSource("Credentials file not found — re-login to Claude Code."),
      failSource("Keychain lookup failed — re-login to Claude Code."),
    ]);
    const result = chain.read();
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
