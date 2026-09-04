export const EVIDENCE_EXCERPT_MAX_BYTES = 512 as const;

const REPLACEMENTS: readonly [RegExp, string][] = [
  [/\b(?:https?|ftp):\/\/[^\s<>"'`]+/giu, "[REDACTED:URL]"],
  [/\bwww\.[^\s<>"'`]+/giu, "[REDACTED:URL]"],
  [
    /"(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.{1,2}[\\/]|[A-Za-z0-9._~-]+[\\/])[^"\r\n]+"/gu,
    "[REDACTED:PATH]",
  ],
  [
    /'(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.{1,2}[\\/]|[A-Za-z0-9._~-]+[\\/])[^'\r\n]+'/gu,
    "[REDACTED:PATH]",
  ],
  [
    /`(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.{1,2}[\\/]|[A-Za-z0-9._~-]+[\\/])[^`\r\n]+`/gu,
    "[REDACTED:PATH]",
  ],
  [
    /(^|[\s"'`()\[\]{}<>=:,;])(?:[A-Za-z]:[\\/]|\\\\)[^\s<>"'`()\[\]{}=,;]*/gmu,
    "$1[REDACTED:PATH]",
  ],
  [
    /(^|[\s"'`()\[\]{}<>=:,;])(?:~[\\/]|\.{1,2}[\\/]|\/)[^\s<>"'`()\[\]{}=,;]*/gmu,
    "$1[REDACTED:PATH]",
  ],
  [/\brefs\/(?:heads|remotes|tags)\/[A-Za-z0-9._~/-]+/gu, "[REDACTED:REF]"],
  [/\b(?:origin|upstream)\/[A-Za-z0-9._~/-]+/gu, "[REDACTED:REF]"],
  [
    /\b(?:feat(?:ure)?|fix|bugfix|hotfix|release|chore|docs|test|refactor|dependabot|renovate)\/[A-Za-z0-9._~/-]+/giu,
    "[REDACTED:REF]",
  ],
  [
    /\b(?:branch|ref|head\.ref)\s*(?::|=|\bis\b)?\s*["'`]?[A-Za-z0-9._~/-]+["'`]?/giu,
    "[REDACTED:REF]",
  ],
  [/\b[A-Za-z0-9._~-]+(?:[\\/][A-Za-z0-9._~/-]+)+/gu, "[REDACTED:PATH]"],
  [/\bBearer\s+[^\s,;]+/giu, "[REDACTED:CREDENTIAL]"],
  [
    /\b(?:token|password|passwd|secret|api[_-]?key|authorization)\s*(?::|=|\bis\b)?\s*"[^"\r\n]+"/giu,
    "[REDACTED:CREDENTIAL]",
  ],
  [
    /\b(?:token|password|passwd|secret|api[_-]?key|authorization)\s*(?::|=|\bis\b)?\s*'[^'\r\n]+'/giu,
    "[REDACTED:CREDENTIAL]",
  ],
  [
    /\b(?:token|password|passwd|secret|api[_-]?key|authorization)\s*(?::|=|\bis\b)?\s*`[^`\r\n]+`/giu,
    "[REDACTED:CREDENTIAL]",
  ],
  [
    /\b(?:token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/giu,
    "[REDACTED:CREDENTIAL]",
  ],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu, "[REDACTED:CREDENTIAL]"],
  [
    /\b(?:glpat-|npm_|sk_(?:test|live)_|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/gu,
    "[REDACTED:CREDENTIAL]",
  ],
  [/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED:CREDENTIAL]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED:CREDENTIAL]"],
  [/\b[A-Za-z0-9._%+-]+:[^\s/@]+@/gu, "[REDACTED:CREDENTIAL]@"],
  [/\b(?:password|passwd|pwd)\s+(?:is\s+)?["'`]?[^\s,;"'`]+["'`]?/giu, "[REDACTED:CREDENTIAL]"],
  [/\b(?:[0-9a-f]{64}|[0-9a-f]{40})\b/giu, "[REDACTED:COMMIT]"],
  [/\b(?:commit|sha|revision)\s*(?::|=|\bis\b)?\s*[0-9a-f]{7,39}\b/giu, "[REDACTED:COMMIT]"],
  [/\b[0-9a-f]{7,39}\b/giu, "[REDACTED:COMMIT]"],
];

const UNSAFE_PATTERNS: readonly RegExp[] = REPLACEMENTS.map(([pattern]) => pattern);

/**
 * Separator homoglyphs that render as ASCII "/" or "\". Normalized to their ASCII
 * form BEFORE any path/gate matching so a no-space path written with confusable
 * slashes cannot slip past the ASCII-only path detectors. Over-normalization is
 * acceptable (fail-closed): worst case a benign glyph becomes a redactable token.
 */
const SEPARATOR_HOMOGLYPHS: readonly [RegExp, string][] = [
  // U+2044 fraction, U+2215 division, U+29F8 big solidus, U+FF0F fullwidth solidus
  [/[⁄∕⧸／]/gu, "/"],
  // U+2216 set minus, U+29F9 big reverse solidus, U+FE68 small reverse solidus, U+FF3C fullwidth reverse solidus
  [/[∖⧹﹨＼]/gu, "\\"],
];

function normalizeSeparators(value: string): string {
  let output = value;
  for (const [pattern, replacement] of SEPARATOR_HOMOGLYPHS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/**
 * Fail-closed backstop for separator confusables the enumerated normalization does
 * not cover. A non-ASCII codepoint wedged directly between two ASCII path-word
 * characters — with no space — is a separator/segment joiner the ASCII-only path
 * detectors cannot see: slash look-alikes (box-drawing `╱`, math diagonals, …),
 * ideographic strokes (`丿`, `ノ`), or mixed-script segment joiners. Latin letters
 * and combining marks are exempted so accented prose (café, naïve, café) is
 * preserved; everything else in that position drops the excerpt. This makes safety
 * class-based rather than dependent on an ever-drifting codepoint allowlist.
 */
function hasNonAsciiSeparatorWedge(value: string): boolean {
  return /[A-Za-z0-9._~-](?![\p{Script=Latin}\p{M}])[^\p{ASCII}][A-Za-z0-9._~-]/u.test(value);
}

/**
 * A run of one or more CASED letters from a non-Latin alphabet (Cyrillic, Greek,
 * Armenian, Cherokee, …). These render as ASCII look-alikes but are not Latin
 * script, so the ASCII-anchored path/ref rules never match them. Caseless scripts
 * (`\p{Lo}`: CJK, most emoji) and Latin script (accented prose, and fullwidth Latin
 * once NFKC-folded to ASCII) are excluded so bilingual prose survives.
 */
const CONFUSABLE_CASED_RUN = "(?:(?![\\p{Script=Latin}\\p{ASCII}])[\\p{Lu}\\p{Ll}\\p{Lt}\\p{M}])+";

/**
 * Fail-closed backstop for the ADV-3 residual: a run of confusable cased letters
 * ("оре" reads as "ope"). When such a run sits at a segment boundary it is NOT wedged
 * between two ASCII word chars, so `hasNonAsciiSeparatorWedge` misses it — the ASCII
 * portion of the segment gets absorbed into a `[REDACTED:…]` marker while the
 * confusable prefix/suffix survives (`оре[REDACTED:PATH]`). Detecting the run directly
 * against a marker (optionally across one residual path slash, with no separating
 * space) proves it is the non-ASCII remnant of a redacted sensitive segment, so drop
 * the excerpt.
 */
function hasConfusableRedactionAdjacency(value: string): boolean {
  const marker = "\\[REDACTED:[A-Z]+\\]";
  const beforeMarker = new RegExp(`${CONFUSABLE_CASED_RUN}[\\\\/]?${marker}`, "u");
  const afterMarker = new RegExp(`${marker}@?[\\\\/]?${CONFUSABLE_CASED_RUN}`, "u");
  return beforeMarker.test(value) || afterMarker.test(value);
}

/**
 * Marker-independent companion to `hasConfusableRedactionAdjacency` (ADV-3, class A).
 * A path built entirely from confusable letters (`оре/секрет`) — or an ASCII segment
 * joined to a confusable one (`home/секрет`, `секрет/home`) — produces NO
 * `[REDACTED:…]` marker at all, because every path/ref rule is ASCII-anchored, so the
 * marker-adjacency check never fires and `hasNonAsciiSeparatorWedge` misses (a separator
 * flanked by two non-ASCII letters is outside its ASCII word-char triple). Keying off
 * the raw join instead: a confusable cased run sitting FLUSH (no separating space)
 * against a path separator is a path shape whose confusable segment a human reads as
 * ASCII — drop it. Two separator kinds are treated as path joins:
 *   1. an ASCII `/` or `\`;
 *   2. a single NON-ASCII, non-whitespace char (a slash/separator look-alike that is
 *      neither NFKC-folded nor in SEPARATOR_HOMOGLYPHS: box-drawing `╱`, ideographic
 *      stroke `丿`, katakana `ノ`, modifier `ː`, …) joining a confusable run to another
 *      confusable run or to an ASCII path-word char.
 * ASCII punctuation other than `/`/`\` is deliberately NOT a join here: only `/` and
 * `\` are path separators in this module (ASCII `foo.bar`/`foo-bar` are left
 * unredacted), so a confusable run around an ASCII `.` `-` `:` stays prose — Russian
 * `из-за`, `т.е.`, `т.к.` are preserved. Fail-closed: like the ASCII path rule that
 * redacts `and/or`, this drops confusable `word/word` flush to a separator (Cyrillic
 * `и/или`). Space-separated prose (`проект uses /home`, `修复 …`) is not flush — and
 * caseless CJK/emoji are outside the run class — so both survive.
 *
 * The joiner is a single char that is a SEPARATOR look-alike: non-ASCII, non-whitespace,
 * not run material (a cased letter or combining mark), and not ordinary in-word
 * punctuation (dashes `\p{Pd}`, quotes/apostrophes `\p{Pf}`/`\p{Pi}`/U+02BC, middle dots
 * U+00B7/U+0387). What remains matches the caseless slash look-alikes (`╱` symbol,
 * `丿`/`ノ` letter-other, `ː` modifier letter) that sit BETWEEN confusable segments,
 * while a confusable run's own letters can never serve as the joiner (that would split
 * any long Cyrillic word `прое·к·т` and nuke all prose). Excluding in-word punctuation
 * keeps common non-Latin prose alive — Ukrainian apostrophe words (`п’ять`, `об’єкт`,
 * U+2019 and U+02BC), typographic-dash compounds (`кто‐то`, `да—нет`), and middle-dot
 * text — mirroring how the module leaves ASCII `foo-bar`/`foo.bar` unredacted (only
 * `/` and `\` are separators). Requiring a confusable run on at least one side, joined
 * to another run OR to an ASCII path-word char, keeps ordinary ASCII+Cyrillic adjacency
 * (`homeоре`) and ASCII-hyphenated Cyrillic (`из-за`) alive. Fail-closed: like the ASCII
 * path rule that redacts `and/or`, this drops confusable `word/word` flush to a
 * separator (`и/или`); space-separated prose (`проект uses /home`) is preserved.
 */
function hasConfusablePathSeparatorAdjacency(value: string): boolean {
  const run = CONFUSABLE_CASED_RUN;
  // A separator look-alike: non-ASCII, non-whitespace, not run material (cased letter /
  // mark), and not ordinary in-word punctuation (dashes, quotes/apostrophes, middle dots).
  const joiner =
    "[^\\p{ASCII}\\s\\p{Lu}\\p{Ll}\\p{Lt}\\p{M}\\p{Pd}\\p{Pf}\\p{Pi}\\u{02BC}\\u{00B7}\\u{0387}]";
  const word = "[A-Za-z0-9._~-]";
  return (
    new RegExp(`${run}[\\\\/]`, "u").test(value) ||
    new RegExp(`[\\\\/]${run}`, "u").test(value) ||
    new RegExp(`${run}${joiner}+${run}`, "u").test(value) ||
    new RegExp(`${word}${joiner}+${run}`, "u").test(value) ||
    new RegExp(`${run}${joiner}+${word}`, "u").test(value)
  );
}

const REDACTION_MARKER_FRAME = /\[REDACTED:[^\]\r\n]+\]/gu;

/**
 * Marker-spoof guard (SEC-3). A genuine marker is an ASCII `[REDACTED:…]` token this
 * module emits. SEC-2's NFKC fold opened a spoof surface: compatibility characters —
 * fullwidth brackets/colon (`［REDACTED:PATH］`, U+FF3B/U+FF3D/U+FF1A) or a compat char
 * wedged inside an ASCII frame (`[REDACTED:㍱]` U+3371 → `[REDACTED:hPa]`) — fold to a
 * literal `[REDACTED:…]` token the module never produced. Detect that whole class by
 * frame identity: a genuine marker is pure ASCII and NFKC-stable, so it appears
 * byte-identically in the raw input. Any `[REDACTED:…]`-framed token in the folded form
 * whose exact text is NOT a substring of the raw input was created or altered by the
 * fold → forged. Fail-closed: drop the excerpt.
 *
 * Scope note: this deliberately does NOT drop an ASCII `[REDACTED:…]` already present
 * verbatim in the raw input (it is a substring of raw → kept). That token is
 * indistinguishable from the output of a prior redaction pass, and dropping it would
 * break idempotency — the redactor's own output must re-redact to itself (see
 * `parseCond1Prepared`, which re-runs this on stored excerpts and requires identity).
 * The "raw input already contains a literal ASCII marker" case predates SEC-2 and can
 * only be closed by a private-use sentinel scheme (rejected as over-engineering for a
 * low-severity, no-data-leak integrity nit); it is left open.
 */
function hasFoldSynthesizedRedactionMarker(raw: string, folded: string): boolean {
  const frames = folded.match(REDACTION_MARKER_FRAME);
  if (frames === null) return false;
  return frames.some((frame) => !raw.includes(frame));
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasDisallowedControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code !== undefined &&
      (code <= 0x08 ||
        code === 0x0b ||
        code === 0x0c ||
        (code >= 0x0e && code <= 0x1f) ||
        code === 0x7f)
    ) {
      return true;
    }
  }
  return false;
}

function containsUnsafe(value: string): boolean {
  for (const pattern of UNSAFE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return true;
  }
  return false;
}

function hasWindowsRelativePathShape(value: string): boolean {
  if (/(?:^|[^\p{L}\p{N}._~-])[A-Za-z]:(?![\\/])(?=\S)/u.test(value)) {
    return true;
  }
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "\\" || value[index + 1] === "\\") continue;
    const previous = value[index - 1];
    if (previous !== undefined && /[\p{L}\p{N}._~-]/u.test(previous)) continue;
    const drive = value[index - 2];
    const driveBoundary = value[index - 3];
    const isDriveAbsolute =
      previous === ":" &&
      drive !== undefined &&
      /[A-Za-z]/u.test(drive) &&
      (driveBoundary === undefined || !/[\p{L}\p{N}._~-]/u.test(driveBoundary));
    if (isDriveAbsolute) continue;
    const next = value[index + 1];
    if (next !== undefined && !/\s/u.test(next)) return true;
  }
  return false;
}

function hasResidualSensitivePrefix(value: string): boolean {
  return (
    /(?:^|[^\p{L}\p{N}._~-])(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|\/)/u.test(value) ||
    hasWindowsRelativePathShape(value)
  );
}

function hasAmbiguousUnquotedSpacedPath(value: string): boolean {
  const probe = value
    .replace(/\b(?:https?|ftp):\/\/[^\s<>"'`]+/giu, "[MASKED]")
    .replace(/["'`][^"'`\r\n]*[\\/][^"'`\r\n]*["'`]/gu, "[MASKED]")
    .replace(/\brefs\/(?:heads|remotes|tags)\/[A-Za-z0-9._~/-]+/gu, "[MASKED]")
    .replace(/\b(?:origin|upstream)\/[A-Za-z0-9._~/-]+/gu, "[MASKED]")
    .replace(
      /\b(?:feat(?:ure)?|fix|bugfix|hotfix|release|chore|docs|test|refactor|dependabot|renovate)\/[A-Za-z0-9._~/-]+/giu,
      "[MASKED]",
    );
  return (
    /(^|[\s"'`()\[\]{}<>=:,;])(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.{1,2}[\\/])[^\s"'`()\[\]{}<>]*\s+[^\s\r\n]/mu.test(
      probe,
    ) ||
    /(^|[\s"'`()\[\]{}<>=:,;])[A-Za-z._~-][A-Za-z0-9._~-]*[\\/][^\s"'`()\[\]{}<>]*\s+[^\s\r\n]/mu.test(
      probe,
    )
  );
}

function truncateUtf8(value: string): string {
  let bytes = 0;
  let output = "";
  for (const codePoint of value) {
    const width = Buffer.byteLength(codePoint, "utf8");
    if (bytes + width > EVIDENCE_EXCERPT_MAX_BYTES) break;
    output += codePoint;
    bytes += width;
  }
  return output;
}

/** Deterministically redact one bounded excerpt, or drop it when it cannot be proven safe. */
export function redactEvidenceExcerpt(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !validUnicode(value) ||
    hasDisallowedControl(value) ||
    /\p{Cf}/u.test(value)
  ) {
    return null;
  }
  // NFKC-fold first so compatibility homographs (fullwidth Latin ｈｏｍｅ → home,
  // fullwidth solidus ／ → /, ligatures, …) collapse to their ASCII skeleton and the
  // ASCII-anchored detectors below can see them. NFKC leaves Cyrillic/Greek and
  // canonical accented Latin unchanged, so it does not affect those paths.
  const folded = value.normalize("NFKC");
  // Then normalize separator homoglyphs to ASCII before any path/gate matching so
  // confusable slashes cannot bypass the ASCII-only path detectors below.
  const normalized = normalizeSeparators(folded);
  if (
    hasFoldSynthesizedRedactionMarker(value, normalized) ||
    hasWindowsRelativePathShape(normalized) ||
    hasAmbiguousUnquotedSpacedPath(normalized) ||
    hasNonAsciiSeparatorWedge(normalized) ||
    hasConfusablePathSeparatorAdjacency(normalized)
  ) {
    return null;
  }
  let redacted = normalized;
  for (const [pattern, replacement] of REPLACEMENTS)
    redacted = redacted.replace(pattern, replacement);
  if (hasResidualSensitivePrefix(redacted) || hasConfusableRedactionAdjacency(redacted))
    return null;
  const bounded = truncateUtf8(redacted);
  if (!validUnicode(bounded) || containsUnsafe(bounded) || hasResidualSensitivePrefix(bounded)) {
    return null;
  }
  return bounded;
}
