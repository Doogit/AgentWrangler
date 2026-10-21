/**
 * src/ingest/secrets-filter.ts — SEC-101 W-C: user-side secrets filter.
 *
 * Applied at RETENTION TIME (before a W-A content slice enters the DB) so the
 * retained store never becomes a credential honeypot. Redaction is destructive
 * at capture: the matched span is replaced with a fixed placeholder; the DB
 * never holds the secret. Lengths survive only as part of the placeholder.
 *
 * Shares its high-entropy definition with the distribution-boundary scanner
 * `scripts/hooks/content-signatures.mjs` (that scanner guards commits/exports;
 * this guards local retention). The two are kept in sync by intent — this file
 * is the daemon-side copy so the shipped runtime does not import a hooks script.
 */

/** Fixed placeholders — stable so consumers (C5/D7) can still match repeats. */
const PLACEHOLDER = {
  key: "[REDACTED:key]",
  token: "[REDACTED:token]",
  pem: "[REDACTED:pem]",
  entropy: "[REDACTED:secret]",
} as const;

/**
 * Provider key prefixes and PEM blocks. Ordered most-specific first; each match
 * is replaced by a typed placeholder. Patterns are deliberately narrow to avoid
 * redacting ordinary command text.
 */
const KEY_PATTERNS: Array<[RegExp, string]> = [
  // PEM private-key blocks (any label), including the body.
  [
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/g,
    PLACEHOLDER.pem,
  ],
  // OpenAI-style keys: sk- / sk-proj- followed by a long token body.
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, PLACEHOLDER.key],
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ + 36 base62.
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, PLACEHOLDER.key],
  // AWS access key ids.
  [/\bAKIA[0-9A-Z]{16}\b/g, PLACEHOLDER.key],
  // Slack tokens.
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, PLACEHOLDER.key],
  // Underscore-prefixed provider keys (Stripe sk_live_/rk_live_/pk_test_, …).
  // Typed coverage so a short/low-entropy variant is caught without relying on
  // the entropy backstop.
  [/\b[a-z]{2}_(?:live|test)_[A-Za-z0-9]{10,}\b/g, PLACEHOLDER.key],
  // Bearer / Authorization header values.
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g, PLACEHOLDER.token],
  [/\b[Aa]uthorization:\s*[A-Za-z0-9._~+/-]{16,}=*/g, PLACEHOLDER.token],
  // Credentials embedded in a URL's userinfo ("user:pass@" before the host). Keep the
  // scheme+user+host structure for C5/D7; drop only the password span.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi, `$1:${PLACEHOLDER.token}@`],
  // Secret-named assignments / headers (PASSWORD=, PGPASSWORD=, API_KEY=,
  // X-Api-Key:, TOKEN:, …). These carry short / punctuation-delimited /
  // low-entropy values that the >=24-char entropy backstop cannot see. The key
  // name and delimiter are preserved; only the value is replaced.
  // Runs after the typed provider patterns; the (?!\[REDACTED) guard keeps it
  // from re-typing a placeholder they already inserted (e.g. token=sk-… → key).
  [
    /\b([\w-]*(?:passwd|password|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token))(\s*[:=]\s*)['"]?(?!\[REDACTED)[^\s'"]+/gi,
    `$1$2${PLACEHOLDER.token}`,
  ],
];

/** Shannon entropy in bits/char of a string. */
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

/** A base64/hex-ish token of a length that could carry a credential. */
const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9+/=_-]{24,}/g;
/** Bits/char above which a long base64/hex token is treated as secret material. */
const ENTROPY_THRESHOLD = 3.5;
/** A path segment made of words (`recommendations`, `RecCard`, `p3-1-t8-detectors`), not random base64. */
const PATH_SEGMENT = /^(?:[A-Z]?[a-z]+[0-9]*|[0-9]+)(?:[_-]?(?:[A-Z]?[a-z]+[0-9]*|[0-9]+))*$/;

/** A slash-separated token whose every segment is word-like is a file path, not a secret. */
function looksLikePath(token: string): boolean {
  return (
    token.includes("/") &&
    token.split("/").every((segment) => segment === "" || PATH_SEGMENT.test(segment))
  );
}

/**
 * Redact obvious secrets from a retention slice. Returns the input unchanged
 * when nothing matches. Safe to call on null/empty.
 */
export function redactSecrets(input: string): string {
  let out = input;
  for (const [re, placeholder] of KEY_PATTERNS) {
    out = out.replace(re, placeholder);
  }
  // Generic high-entropy tokens (catches unlabelled credential material). Runs
  // after the typed patterns so their placeholders are not re-scanned.
  out = out.replace(HIGH_ENTROPY_TOKEN, (m) =>
    shannonEntropy(m) >= ENTROPY_THRESHOLD && !looksLikePath(m) ? PLACEHOLDER.entropy : m,
  );
  return out;
}
