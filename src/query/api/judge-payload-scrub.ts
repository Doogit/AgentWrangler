/**
 * src/query/api/judge-payload-scrub.ts — secrets detect pass + path/identity scrub for the
 * "Judge me" payload (JMS-P2 U8, ADR-112 amendment 2026-10-13).
 *
 * Two steps, in this order, on every free-text string the payload carries:
 *   1. `detectSecrets` on the RAW text. Any hit blocks the whole send; the caller shows the
 *      match class, never the match. (Redacting first would hide the hit, so AE7 needs detect.)
 *   2. `scrubIdentity` on what remains: home paths (every spelling), UNC hosts, OneDrive org
 *      names, URLs, emails, IPs, hostnames and the bare username. Loopback addresses stay.
 *
 * The typed patterns overlap `src/ingest/secrets-filter.ts` on purpose but differ: this pass
 * blocks instead of redacting, catches quoted JSON keys (`"GITHUB_TOKEN": "x"`), and exempts
 * word-like identifiers from the entropy rule so ordinary CLAUDE.md prose does not block.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SecretClass =
  | "private-key"
  | "provider-key"
  | "jwt"
  | "bearer-token"
  | "url-credential"
  | "named-secret"
  | "high-entropy";

const SECRET_PATTERNS: readonly [SecretClass, RegExp][] = [
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY/],
  ["provider-key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["provider-key", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["provider-key", /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["provider-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["provider-key", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["provider-key", /\b[a-z]{2}_(?:live|test)_[A-Za-z0-9]{10,}/],
  ["provider-key", /\bglpat-[A-Za-z0-9_-]{16,}/],
  ["provider-key", /\bnpm_[A-Za-z0-9]{20,}/],
  ["provider-key", /\bAIza[0-9A-Za-z_-]{30,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i],
  ["bearer-token", /\bAuthorization["']?\s*:\s*["']?(?!Bearer\b)[A-Za-z0-9._~+/-]{16,}/i],
  [
    "url-credential",
    /[?&](?:key|api_?key|sig|signature|auth|token|access_token|code|password|secret)=[^&\s#]+/i,
  ],
  ["url-credential", /:\/\/[^\s/:@]+:[^\s/@]+@/],
  [
    "named-secret",
    /\b[\w-]*(?:passwd|password|secret|token|api[_-]?key|access[_-]?key|credential)["']?\s*[:=]\s*["']?[^\s"',}]{3,}/i,
  ],
];

const ENTROPY_TOKEN = /[A-Za-z0-9+/=_-]{24,}/g;
const ENTROPY_THRESHOLD = 3.5;
/** Token split points: separators and lower/digit→Upper camel boundaries. */
const WORD_SPLIT = /[-_./]|(?<=[a-z0-9])(?=[A-Z])/;
/** One word piece: `Effect`, `api03`, `HTTPServer`, `API`, `v2`, the `o` of `oAuth`, `2026`. */
const WORD_PIECE =
  /^(?:[A-Z]?[a-z]{2,}[0-9]*|[A-Z]{2,}(?:[a-z]{2,})?[0-9]*|[a-z][0-9]{0,3}|[0-9]+)$/;

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Identifier or path made of real words (`useEffectCleanup`, `docs/perf-campaign-v2`). */
function isWordLike(token: string): boolean {
  return token.split(WORD_SPLIT).every((piece) => piece === "" || WORD_PIECE.test(piece));
}

/** Secret classes found in raw text, deduplicated, in pattern order. Empty = safe to scrub. */
export function detectSecrets(text: string): SecretClass[] {
  const found = new Set<SecretClass>();
  for (const [cls, re] of SECRET_PATTERNS) if (re.test(text)) found.add(cls);
  for (const m of text.matchAll(ENTROPY_TOKEN)) {
    if (shannonEntropy(m[0]) >= ENTROPY_THRESHOLD && !isWordLike(m[0])) {
      found.add("high-entropy");
      break;
    }
  }
  return [...found];
}

export interface IdentityContext {
  /** The user's home directory, any spelling. */
  home: string;
  /** Bare names to scrub: OS username, email local-parts. The home basename is added. */
  usernames: string[];
}

/** `name` and email local-part from the `[user]` section of a gitconfig file's text. */
export function gitIdentityNames(gitconfig: string): string[] {
  const names: string[] = [];
  let inUser = false;
  for (const line of gitconfig.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) {
      inUser = (section[1] ?? "").trim().toLowerCase() === "user";
      continue;
    }
    if (!inUser) continue;
    const [, key = "", raw = ""] = /^\s*(name|email)\s*=\s*(.+?)\s*$/i.exec(line) ?? [];
    if (!key) continue;
    const value = raw.replace(/^"|"$/g, "");
    names.push(key.toLowerCase() === "email" ? (value.split("@")[0] ?? "") : value);
  }
  return names.filter(Boolean);
}

/** OS username plus the git identity (name, email local-part) from `~/.gitconfig`. */
export function identityFromOs(): IdentityContext {
  const usernames: string[] = [];
  try {
    usernames.push(os.userInfo().username);
  } catch {
    // no user info: the home basename still covers it
  }
  try {
    usernames.push(
      ...gitIdentityNames(fs.readFileSync(path.join(os.homedir(), ".gitconfig"), "utf8")),
    );
  } catch {
    // no gitconfig
  }
  return { home: os.homedir(), usernames };
}

export type ScrubClass = "home-path" | "unc" | "url" | "email" | "ip" | "hostname" | "username";

const SEP = String.raw`(?:\\\\|\\|/)+`;
const HOSTNAME_TLDS =
  "com|net|org|io|dev|app|ai|co|cloud|local|lan|internal|corp|home|localdomain|intranet";

/** Loopback addresses state a security property ("binds 127.0.0.1") and identify no one. */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

const STATIC_RULES: readonly [ScrubClass, RegExp, string, ((match: string) => boolean)?][] = [
  ["url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`)\]]+/gi, "[URL]", isLoopbackUrl],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]"],
  [
    "home-path",
    new RegExp(
      String.raw`[A-Za-z]:${SEP}(?:Users|Documents and Settings)${SEP}[^\\/\s"'\`:*?<>|]+`,
      "gi",
    ),
    "~",
  ],
  ["home-path", /(?<![\w.~-])(?:\/mnt\/[a-z]|\/[a-z])?\/(?:Users|home)\/[^/\s"'`]+/gi, "~"],
  ["unc", /(?<![\w:~\\])\\\\(?:\\\\)?[^\\/\s]+(?:\\\\|\\)[^\\/\s]+/g, "[UNC]"],
  ["home-path", /OneDrive - [^\\/\r\n"]+/g, "OneDrive"],
  ["ip", /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP]", (m) => m === "127.0.0.1"],
  [
    "ip",
    /(?<![\w:])(?=[0-9a-f:]*::|(?:[0-9a-f]{1,4}:){4})[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi,
    "[IP]",
    (m) => m === "::1",
  ],
  [
    "hostname",
    // A bare host drops its path too (`github.com/<owner>/<repo>` carries the owner's handle).
    new RegExp(
      String.raw`(?<![\w.@-])(?:[a-z0-9-]+\.)+(?:${HOSTNAME_TLDS})(?![\w-]|\.\w)(?:/[^\s<>"'\`)\]]*)?`,
      "gi",
    ),
    "[HOST]",
  ],
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `C%3A%5CUsers` → `C:\Users` so the path rules see URL-encoded spellings. */
function decodePathEscapes(text: string): string {
  return text
    .replace(/%5C/gi, "\\")
    .replace(/%2F/gi, "/")
    .replace(/%3A/gi, ":")
    .replace(/%40/gi, "@");
}

export interface ScrubResult {
  text: string;
  counts: Partial<Record<ScrubClass, number>>;
}

/** Replace identity-bearing spans with fixed placeholders. Run only after `detectSecrets` is clean. */
export function scrubIdentity(text: string, ctx: IdentityContext): ScrubResult {
  const counts: Partial<Record<ScrubClass, number>> = {};
  let out = decodePathEscapes(text);
  const apply = (cls: ScrubClass, re: RegExp, repl: string, keep?: (match: string) => boolean) => {
    out = out.replace(re, (m) => {
      if (keep?.(m)) return m;
      counts[cls] = (counts[cls] ?? 0) + 1;
      return repl;
    });
  };

  const homeParts = ctx.home.split(/[\\/]+/).filter(Boolean);
  if (homeParts.length > 0) {
    const literal = homeParts.map(escapeRe).join(SEP);
    apply("home-path", new RegExp(`(?:${SEP})?${literal}`, "gi"), "~");
  }
  for (const [cls, re, repl, keep] of STATIC_RULES) apply(cls, re, repl, keep);

  const names = new Set(
    [...ctx.usernames, homeParts.at(-1) ?? ""].map((n) => n.trim()).filter((n) => n.length >= 2),
  );
  for (const n of names) {
    apply("username", new RegExp(`(?<![A-Za-z0-9])${escapeRe(n)}(?![A-Za-z0-9])`, "gi"), "[USER]");
  }
  return { text: out, counts };
}
