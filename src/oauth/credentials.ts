/**
 * src/oauth/credentials.ts — OAuth credential source for the usage reader.
 *
 * Defines a CredentialSource interface and the v1 file-based implementation
 * that reads ~/.claude/.credentials.json → claudeAiOauth.
 *
 * NOTE: macOS Keychain source ("Claude Code-credentials") is a documented
 * follow-on. Implement a KeychainCredentialSource behind this same interface
 * using the Security framework via a native addon or `security` CLI.
 *
 * SEC-101: token VALUES are NEVER logged; only key names when tracing.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface OAuthCredential {
  accessToken: string;
  /** ms-epoch timestamp when the token expires */
  expiresAt: number;
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

export type CredentialResult =
  | { ok: true; credential: OAuthCredential }
  | { ok: false; reason: string };

/**
 * A CredentialSource reads the local OAuth credential.
 * Returns the credential or a human-readable reason why it is unavailable.
 * Always fail-closed: when in doubt, return ok:false.
 */
export interface CredentialSource {
  read(): CredentialResult;
}

// ---------------------------------------------------------------------------
// OAuth status (no token value — safe for the Settings UI endpoint)
// ---------------------------------------------------------------------------

export interface OAuthStatus {
  authenticated: boolean;
  /** e.g. "max_5x", "max", "build" — null when not authenticated */
  tier: string | null;
  /** Human-readable reason; present when not authenticated */
  reason?: string;
}

/**
 * Derive the public auth status from a credential source without exposing the token.
 * Safe to send to the browser.
 */
export function getOAuthStatus(source: CredentialSource = fileCredentialSource): OAuthStatus {
  const result = source.read();
  if (!result.ok) {
    return { authenticated: false, tier: null, reason: result.reason };
  }
  return { authenticated: true, tier: result.credential.rateLimitTier };
}

// ---------------------------------------------------------------------------
// File-based source (~/.claude/.credentials.json)
// ---------------------------------------------------------------------------

/** Default credentials file path used by Claude Code. */
export const DEFAULT_CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");

interface ClaudeAiOauthRaw {
  accessToken?: unknown;
  expiresAt?: unknown;
  subscriptionType?: unknown;
  rateLimitTier?: unknown;
}

/**
 * Parse a raw `{claudeAiOauth:{…}}` JSON blob (the shape Claude Code stores in
 * both the credentials file and the macOS Keychain) into a CredentialResult.
 * `noun` names the source in failure reasons so each source stays honest about
 * where the gap is; the file source passes "Credentials file" to preserve its
 * exact historical strings (Windows byte-identical guarantee).
 */
function parseOAuthBlob(raw: string, noun: string): CredentialResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${noun} is not valid JSON — re-login to Claude Code.` };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: `${noun} has unexpected shape — re-login to Claude Code.` };
  }

  const top = parsed as { claudeAiOauth?: unknown };
  const oauth = top.claudeAiOauth as ClaudeAiOauthRaw | undefined;
  if (typeof oauth !== "object" || oauth === null || oauth === undefined) {
    return { ok: false, reason: `${noun} is missing claudeAiOauth — re-login to Claude Code.` };
  }

  const { accessToken, expiresAt, subscriptionType, rateLimitTier } = oauth;

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return { ok: false, reason: `${noun} has no accessToken — re-login to Claude Code.` };
  }

  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return { ok: false, reason: `${noun} has invalid expiresAt — re-login to Claude Code.` };
  }

  if (Date.now() >= expiresAt) {
    return { ok: false, reason: "OAuth token has expired — re-login to Claude Code." };
  }

  return {
    ok: true,
    credential: {
      accessToken,
      expiresAt,
      subscriptionType: typeof subscriptionType === "string" ? subscriptionType : null,
      rateLimitTier: typeof rateLimitTier === "string" ? rateLimitTier : null,
    },
  };
}

export class FileCredentialSource implements CredentialSource {
  private readonly filePath: string;

  constructor(filePath: string = DEFAULT_CREDENTIALS_PATH) {
    this.filePath = filePath;
  }

  read(): CredentialResult {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch {
      return {
        ok: false,
        reason: "Credentials file not found — re-login to Claude Code.",
      };
    }
    return parseOAuthBlob(raw, "Credentials file");
  }
}

// ---------------------------------------------------------------------------
// macOS Keychain source (NU6) — darwin-only, ordered AFTER the file source
// ---------------------------------------------------------------------------

/** The Keychain service Claude Code stores its OAuth credential under (macOS). */
export const KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Injectable exec type — returns the Keychain password blob, or null on any failure. */
export type SecurityExec = () => string | null;

/**
 * Read the credential blob from the login Keychain via the `security` CLI.
 * `-w` prints only the password (the JSON blob) on stdout; a missing entry
 * exits non-zero. Never throws; never logs the secret (SEC-101).
 */
function defaultSecurityExec(): string | null {
  try {
    const result = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error !== undefined || result.status !== 0) return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export class KeychainCredentialSource implements CredentialSource {
  private readonly exec: SecurityExec;
  private readonly platform: string;

  constructor(exec: SecurityExec = defaultSecurityExec, platform: string = os.platform()) {
    this.exec = exec;
    this.platform = platform;
  }

  read(): CredentialResult {
    if (this.platform !== "darwin") {
      return { ok: false, reason: "macOS Keychain source only applies on darwin." };
    }
    const raw = this.exec();
    if (raw === null) {
      return { ok: false, reason: "Keychain lookup failed — re-login to Claude Code." };
    }
    return parseOAuthBlob(raw, "Keychain credential");
  }
}

// ---------------------------------------------------------------------------
// Chained source — first ok wins; on total failure the reason names every gap
// ---------------------------------------------------------------------------

export class ChainedCredentialSource implements CredentialSource {
  private readonly sources: CredentialSource[];

  constructor(sources: CredentialSource[]) {
    this.sources = sources;
  }

  read(): CredentialResult {
    const reasons: string[] = [];
    for (const source of this.sources) {
      const result = source.read();
      if (result.ok) return result;
      reasons.push(result.reason);
    }
    return {
      ok: false,
      reason: reasons.join(" ") || "No credential source available.",
    };
  }
}

/**
 * Production credential source (singleton) used as the default by every
 * consumer (oauth/usage.ts, oauth/count-tokens.ts, oauth/judge-g2-client.ts,
 * getOAuthStatus). On macOS it chains the file source then the Keychain so a
 * Keychain-only login (no ~/.claude/.credentials.json) still authenticates;
 * elsewhere it is exactly a FileCredentialSource, so Windows/Linux behavior is
 * byte-identical to before NU6. The `fileCredentialSource` name is retained
 * because the RI-Track-1-owned usage.ts imports it verbatim.
 */
export const fileCredentialSource: CredentialSource =
  os.platform() === "darwin"
    ? new ChainedCredentialSource([new FileCredentialSource(), new KeychainCredentialSource()])
    : new FileCredentialSource();
