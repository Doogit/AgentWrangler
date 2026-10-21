// SEC-101 raw-CONTENT signatures (distribution-boundary control, ADR-112).
// Complements leak-signatures.mjs (which matches PATH names): this matches the
// TEXT of staged/exported content for developer transcript material that must
// never reach a commit or the public export.
//
// This file SHIPS with the export (scripts/ is public), so it holds NO owner or
// project names — those stay inline in scripts/launch/export.mjs, which never
// ships. Detectors here are content-shape only.
//
// Coverage is deliberately layered and its LIMITS are documented (ADR-112,
// spec-sec101-rescope.md "Known limits"): transcript detection at the boundary is
// heuristic; the credential guarantees are the PEM check here plus trufflehog
// (fail-closed at export). This is a tripwire against the common leak shapes, not
// a proof of absence — human review + the synthetic-fixture process rule remain
// load-bearing.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

// A transcript-shaped JSON line is a hit at ANY length outside the sanctioned
// example/fixture roots (docs/, test/fixtures/), where illustrative and synthetic
// transcript JSON legitimately lives. Inside those roots only an oversized one is
// flagged (a real captured turn sneaked into a fixture is large / secret-bearing
// and still trips the length, entropy, or PEM checks below).
export const TRANSCRIPT_LINE_MIN = 1000;
// Any single line this long is a flat content dump regardless of shape
// (the 5001-line stderr dump of commit 6998f78 was one such line class).
export const OVERSIZED_LINE = 5000;
// A base64/hex run this long is embedded content or secret material.
export const ENTROPY_RUN = 512;

const B64_RUN = new RegExp(`[A-Za-z0-9+/=]{${ENTROPY_RUN},}`);
const HEX_RUN = new RegExp(`[0-9a-fA-F]{${ENTROPY_RUN},}`);
// A PEM private-key block header — the clearest irreversible secret, near-zero
// false-positive. Covers unlabeled/RSA/EC/OpenSSH/DSA/encrypted PKCS#8 keys and a
// PGP "PRIVATE KEY BLOCK". Broader token patterns are left to trufflehog (which has
// its own verification/allow-listing) to avoid false positives on redaction fixtures.
const PEM_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/;

// Roots where transcript-shaped JSON legitimately appears (doc examples, synthetic
// ingest and detector-health fixtures). Kept as narrow as the tree requires so the
// strict any-length rule applies as widely as possible. POSIX-normalized prefix
// match, slash-anchored.
// NOTE (accepted residual, ADR-112): inside these roots the short-transcript hole
// re-opens; the synthetic-provenance backstop for the fixture roots is the W-A
// SHA manifest (assert-ingest-fixtures.mjs). See spec-sec101-rescope.md "W-B known limits".
export function isExampleOrFixturePath(relPath) {
  const p = relPath.replaceAll("\\", "/");
  return (
    p.startsWith("test/fixtures/ingest/") ||
    p.startsWith("test/fixtures/detector-health/") ||
    p.startsWith("docs/")
  );
}

// Decode a file buffer to text for scanning. UTF-16 (BOM-detected) is decoded so a
// transcript saved as UTF-16 cannot evade the scan via its interleaved null bytes;
// a genuinely binary file (null bytes, no UTF-16 BOM) returns null and is skipped.
export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return Buffer.from(buf).subarray(buf.length % 2 === 0 ? 0 : 1).swap16().toString("utf16le");
  }
  if (buf.includes(0)) return null; // genuine binary
  return buf.toString("utf8");
}

// Does a single line JSON-parse to a Claude-transcript-shaped object?
function looksLikeTranscriptObject(line) {
  const t = line.trim();
  if (t.length < 2 || t[0] !== "{") return false;
  let obj;
  try {
    obj = JSON.parse(t);
  } catch {
    return false;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return false;
  const has = (k) => Object.prototype.hasOwnProperty.call(obj, k);
  return (
    (has("role") && has("content")) ||
    has("tool_use_id") ||
    has("cache_read_input_tokens") ||
    has("stop_reason") ||
    (has("message") && has("usage")) ||
    (has("type") && has("message") && has("sessionId"))
  );
}

// Reasons a single line looks like raw transcript/agent content (empty = clean).
// `relPath` (when known) enables the example/fixture carve-out for the transcript
// shape rule; when null the strict (non-carved) rule applies.
export function lineReasons(line, relPath = null) {
  const reasons = [];
  if (line.length >= OVERSIZED_LINE) {
    reasons.push(`oversized line (${line.length} chars) — looks like a flat content dump`);
  }
  if (looksLikeTranscriptObject(line)) {
    const carved = relPath !== null && isExampleOrFixturePath(relPath);
    if (!carved) {
      reasons.push(`transcript-shaped JSON content line (${line.length} chars)`);
    } else if (line.length >= TRANSCRIPT_LINE_MIN) {
      reasons.push(
        `oversized transcript-shaped line in an example/fixture path (${line.length} chars)`,
      );
    }
  }
  if (B64_RUN.test(line) || HEX_RUN.test(line)) {
    reasons.push(`high-entropy blob (>=${ENTROPY_RUN}-char base64/hex run) — embedded content`);
  }
  if (PEM_KEY.test(line)) {
    reasons.push("PEM private-key block — a secret must never be committed");
  }
  return reasons;
}

// Reasons a multi-line text blob carries raw content, as {line, reason} entries
// (1-based line numbers). Empty array = clean.
export function rawContentReasons(text, relPath = null) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const reason of lineReasons(lines[i], relPath)) {
      hits.push({ line: i + 1, reason });
    }
  }
  return hits;
}

// Recursively scan every text file under `dir` for raw content. Returns
// {file, line, reason} entries with POSIX-relative paths; binary files skipped.
// Shared by the export gate so it and the tests exercise the same traversal.
export function scanDirectory(dir) {
  const hits = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = relative(dir, p).split(sep).join("/");
      const text = decodeText(readFileSync(p));
      if (text === null) continue; // binary
      for (const { line, reason } of rawContentReasons(text, rel)) {
        hits.push({ file: rel, line, reason });
      }
    }
  };
  walk(dir);
  return hits;
}
