import { describe, expect, it } from "vitest";
import {
  EVIDENCE_EXCERPT_MAX_BYTES,
  redactEvidenceExcerpt,
} from "../../../src/evidence/common/redaction.js";

const PROHIBITED = [
  /https?:\/\//iu,
  /C:\\/u,
  /\/Users\//u,
  /refs\/heads\//u,
  /feature\//iu,
  /src\//iu,
  /Bearer\s/u,
  /password\s/iu,
  /abc1234/iu,
  /hunter2/iu,
  /customer-private/iu,
  /two word private/iu,
  /ghp_[A-Za-z0-9_]+/u,
  /\b[0-9a-f]{40}\b/iu,
  /\b[0-9a-f]{64}\b/iu,
];

function recursiveStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(recursiveStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(recursiveStrings);
  }
  return [];
}

describe("deterministic evidence redaction", () => {
  it("redacts URLs, paths, refs, credentials, and commit identifiers", () => {
    const fixtures = {
      url: "See https://private.example.test/pulls/1?token=secret",
      windowsPath: "Open C:\\Users\\Operator\\private\\transcript.jsonl",
      posixPath: "Open /Users/operator/private/transcript.jsonl",
      relativePath: "Inspect src/evidence/private-input.ts",
      quotedPaths:
        "Open \"C:\\Users\\Operator Name\\private file.jsonl\" and '/Users/operator name/private file'",
      ref: "Compare refs/heads/private-work and feature/private-work",
      contextualRef: "The branch private-customer-work used commit abc123def",
      credentials: "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      password: "password is correct-horse-private-battery",
      quotedPassword: 'password: "two word private"',
      commits: `objects ${"a".repeat(40)} and ${"b".repeat(64)}`,
    };
    const redacted = Object.fromEntries(
      Object.entries(fixtures).map(([key, value]) => [key, redactEvidenceExcerpt(value)]),
    );
    expect(redacted.url).toContain("[REDACTED:URL]");
    expect(redacted.windowsPath).toContain("[REDACTED:PATH]");
    expect(redacted.posixPath).toContain("[REDACTED:PATH]");
    expect(redacted.relativePath).toContain("[REDACTED:PATH]");
    expect(redacted.quotedPaths).toContain("[REDACTED:PATH]");
    expect(redacted.ref).toContain("[REDACTED:REF]");
    expect(redacted.contextualRef).toContain("[REDACTED:REF]");
    expect(redacted.contextualRef).toContain("[REDACTED:COMMIT]");
    expect(redacted.credentials).toContain("[REDACTED:CREDENTIAL]");
    expect(redacted.password).toContain("[REDACTED:CREDENTIAL]");
    expect(redacted.quotedPassword).toContain("[REDACTED:CREDENTIAL]");
    expect(redacted.commits).toContain("[REDACTED:COMMIT]");
    for (const text of recursiveStrings(redacted)) {
      expect(text).not.toContain("$1");
      for (const prohibited of PROHIBITED) expect(text).not.toMatch(prohibited);
    }
  });

  it("caps UTF-8 bytes without splitting a multibyte code point", () => {
    const redacted = redactEvidenceExcerpt("🙂".repeat(200));
    expect(redacted).not.toBeNull();
    if (redacted === null) throw new Error("fixture_redaction_dropped");
    expect(Buffer.byteLength(redacted, "utf8")).toBe(EVIDENCE_EXCERPT_MAX_BYTES);
    expect([...redacted]).toHaveLength(EVIDENCE_EXCERPT_MAX_BYTES / 4);
    expect(redacted.endsWith("🙂")).toBe(true);
  });

  it("is deterministic and preserves safe text", () => {
    const input = `Safe context then https://example.test and ${"c".repeat(40)}`;
    expect(redactEvidenceExcerpt(input)).toBe(redactEvidenceExcerpt(input));
    expect(redactEvidenceExcerpt("plain evidence line\nsecond line")).toBe(
      "plain evidence line\nsecond line",
    );
  });

  it("drops invalid or unsafe values closed", () => {
    expect(redactEvidenceExcerpt(undefined)).toBeNull();
    expect(redactEvidenceExcerpt("bad\u0000value")).toBeNull();
    expect(redactEvidenceExcerpt("unpaired \ud800 surrogate")).toBeNull();
    expect(redactEvidenceExcerpt("left-to-right\u202eoverride")).toBeNull();
    expect(redactEvidenceExcerpt("zero\u200bwidth")).toBeNull();
    expect(redactEvidenceExcerpt("Open C:\\Private Folder\\secret.txt")).toBeNull();
    expect(redactEvidenceExcerpt("Open src/private folder/secret.txt")).toBeNull();
    expect(redactEvidenceExcerpt("C:Alpha Secret Omega\\file.txt")).toBeNull();
    expect(redactEvidenceExcerpt("\\Alpha Secret Omega\\file.txt")).toBeNull();
    expect(redactEvidenceExcerpt("C:Alpha\\file.txt")).toBeNull();
    expect(redactEvidenceExcerpt("\\Alpha\\file.txt")).toBeNull();
    expect(redactEvidenceExcerpt("C:Alpha Secret Omega")).toBeNull();
    expect(redactEvidenceExcerpt("\\Alpha Secret Omega")).toBeNull();
    expect(redactEvidenceExcerpt("C:file.txt")).toBeNull();
    expect(redactEvidenceExcerpt("\\secret.txt")).toBeNull();
    expect(redactEvidenceExcerpt("path=C:file.txt")).toBeNull();
    expect(redactEvidenceExcerpt("path:\\secret.txt")).toBeNull();
  });

  it("never leaves absolute prefixes after common non-whitespace delimiters", () => {
    const probes = [
      "path=C:\\Users\\Private\\secret.txt",
      "path:/Users/private/secret.txt",
      "[C:\\Private\\secret.txt]",
      "{/private/secret.txt}",
      "<C:\\Private\\secret.txt>",
    ];
    const residualSensitivePrefix =
      /(?:^|[^\p{L}\p{N}._~-])(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|\/)/u;
    for (const probe of probes) {
      const redacted = redactEvidenceExcerpt(probe);
      expect(redacted).not.toBeNull();
      expect(redacted).toContain("[REDACTED:PATH]");
      expect(redacted).not.toMatch(residualSensitivePrefix);
    }
    expect(redactEvidenceExcerpt("value→/private/secret.txt")).toBeNull();
  });

  it("does not leak no-space paths joined by Unicode slash homoglyphs", () => {
    // U+FF0F ／, U+2215 ∕, U+FF3C ＼ used as separators in place of ASCII / and \.
    const homoglyphProbes = [
      "Open \u{FF0F}Users\u{FF0F}operator\u{FF0F}private\u{FF0F}transcript.jsonl",
      "Open C:\u{FF3C}Users\u{FF3C}operator\u{FF3C}private\u{FF3C}secret.txt",
      "See src\u{2215}evidence\u{2215}operator-private.ts",
      "mixed \u{FF0F}Users\u{FF3C}operator\u{2215}private path",
    ];
    for (const probe of homoglyphProbes) {
      const redacted = redactEvidenceExcerpt(probe);
      // Fail-closed: either dropped (null) or the sensitive segment is gone.
      expect(redacted === null || !redacted.includes("operator")).toBe(true);
      expect(redacted === null || !redacted.includes("private")).toBe(true);
    }
  });

  it("does not leak paths joined by slash-confusables outside the normalization set", () => {
    // Codepoints that render as / or \ but are NOT enumerated separators:
    // box-drawing U+2571 ╱ / U+2572 ╲, math diagonals U+27CB ⟋ / U+27CD ⟍,
    // katakana U+30CE ノ, CJK U+4E3F 丿, Lisu U+A4F7 ꓷ. Fail-closed: drop or fully redact.
    const gapSeparators = [
      "\u{2571}",
      "\u{2572}",
      "\u{27CB}",
      "\u{27CD}",
      "\u{27C7}",
      "\u{30CE}",
      "\u{2F03}",
      "\u{4E3F}",
      "\u{31D3}",
      "\u{1735}",
      "\u{2CBA}",
      "\u{2AFD}",
      "\u{29F6}",
      "\u{A4F7}",
    ];
    for (const sep of gapSeparators) {
      const multi = redactEvidenceExcerpt(`Open ${sep}Users${sep}operator${sep}private${sep}x.txt`);
      expect(multi === null || (!multi.includes("operator") && !multi.includes("private"))).toBe(
        true,
      );
      // single-separator segment leak (ADV-2)
      const single = redactEvidenceExcerpt(`customer-private${sep}operator`);
      expect(single === null || (!single.includes("operator") && !single.includes("private"))).toBe(
        true,
      );
    }
  });

  it("does not leak the mixed-script prefix of a homograph path segment (ADV-3)", () => {
    // A username written in consecutive Cyrillic look-alikes sits at a segment
    // boundary (not wedged between ASCII word chars), so the SEC-1 wedge backstop
    // does not fire. The ASCII path tail redacts but the confusable prefix must not
    // survive — a human would read the whole path.
    const cyrillicPrefix = "\u{043E}\u{0440}\u{0435}"; // о р е — looks like "ope"
    const partialLeak = `${cyrillicPrefix}rator/private/secret`;
    const redactedPartial = redactEvidenceExcerpt(partialLeak);
    expect(redactedPartial === null || !redactedPartial.includes(cyrillicPrefix)).toBe(true);

    // Fully-homograph leading segment (every letter confusable): the worst case,
    // where the entire username would leak in front of the redacted tail.
    const cyrillicUser = "\u{0441}\u{043E}\u{0440}\u{0440}\u{0430}"; // с о р р а — "coppa"
    const fullLeak = `${cyrillicUser}/private/secret`;
    const redactedFull = redactEvidenceExcerpt(fullLeak);
    expect(redactedFull === null || !redactedFull.includes(cyrillicUser)).toBe(true);
  });

  it("does not leak confusable paths that produce no redaction marker (ADV-3 class A)", () => {
    // All-confusable or ASCII+confusable path segments joined by a real/normalized
    // slash produce NO [REDACTED:…] marker (every path rule is ASCII-anchored), so
    // the marker-adjacency backstop cannot fire. The raw-separator gate must drop them.
    const probes = [
      "\u{043E}\u{0440}\u{0435}/\u{0441}\u{0435}\u{043A}\u{0440}\u{0435}\u{0442}", // оре/секрет (ASCII slash)
      "home/\u{0441}\u{0435}\u{043A}\u{0440}\u{0435}\u{0442}", // home/секрет
      "\u{0441}\u{0435}\u{043A}\u{0440}\u{0435}\u{0442}/home", // секрет/home
      "\u{03BF}\u{03C1}\u{03B1}/\u{03BD}\u{03BF}", // Greek ορα/νο
      // ADV-3 class A': joined by a non-ASCII slash-confusable that is neither
      // NFKC-folded nor in SEPARATOR_HOMOGLYPHS — box-drawing ╱, ideographic stroke
      // 丿, katakana ノ, modifier colon ː — plus the ASCII-segment and double-joiner cases.
      "\u{043E}\u{0440}\u{0435}\u{2571}\u{0441}\u{0435}\u{043A}", // оре╱сек
      "\u{043E}\u{0440}\u{0435}\u{4E3F}\u{0441}\u{0435}\u{043A}", // оре丿сек
      "\u{043E}\u{0440}\u{0435}\u{30CE}\u{0441}\u{0435}\u{043A}", // ореノсек
      "\u{043E}\u{0440}\u{0435}\u{02D0}\u{0441}\u{0435}\u{043A}", // ореːсек
      "\u{043E}\u{0440}\u{0435}\u{2571}\u{2571}\u{0441}\u{0435}\u{043A}", // оре╱╱сек (double)
      "home\u{2571}\u{0441}\u{0435}\u{043A}", // home╱сек (ASCII segment + box slash)
      "home\u{4E3F}\u{0441}\u{0435}\u{043A}", // home丿сек (ASCII segment + stroke)
    ];
    for (const probe of probes) {
      expect(redactEvidenceExcerpt(probe)).toBeNull();
    }
    // Preserved (must NOT over-drop): space-separated non-Latin prose next to a
    // redacted path; ASCII-hyphenated Cyrillic (из-за); plain ASCII+Cyrillic
    // adjacency with no separator (homeоре).
    const prose = redactEvidenceExcerpt(
      "\u{043F}\u{0440}\u{043E}\u{0435}\u{043A}\u{0442} uses /home/user",
    );
    expect(prose).not.toBeNull();
    expect(prose).toContain("[REDACTED:PATH]");
    expect(
      redactEvidenceExcerpt(
        "\u{0438}\u{0437}-\u{0437}\u{0430} \u{043E}\u{0448}\u{0438}\u{0431}\u{043A}\u{0438}",
      ),
    ).not.toBeNull(); // из-за ошибки
    expect(redactEvidenceExcerpt("home\u{043E}\u{0440}\u{0435}")).not.toBeNull(); // homeоре
    // Non-Latin prose with in-word typographic punctuation must survive (the joiner
    // excludes dashes/quotes/apostrophes/middle dots, only slash look-alikes join).
    expect(redactEvidenceExcerpt("\u{043F}\u{2019}\u{044F}\u{0442}\u{044C}")).not.toBeNull(); // п’ять (U+2019)
    expect(
      redactEvidenceExcerpt("\u{0434}\u{0430}\u{2014}\u{043D}\u{0435}\u{0442}"),
    ).not.toBeNull(); // да—нет (U+2014)
  });

  it("does not leak fullwidth-Latin homograph paths (ADV-3 class B, via NFKC)", () => {
    // Fullwidth Latin is Script=Latin (a pure ASCII homograph). NFKC folds it to ASCII
    // so the normal path rules redact it rather than exempting it as "Latin prose".
    const home = "\u{FF48}\u{FF4F}\u{FF4D}\u{FF45}"; // ｈｏｍｅ
    const user = "\u{FF55}\u{FF53}\u{FF45}\u{FF52}"; // ｕｓｅｒ
    for (const probe of [
      `${home}/${user}`,
      `${home}\u{FF0F}${user}`, // fullwidth solidus
      `${home}/home/user`,
    ]) {
      const redacted = redactEvidenceExcerpt(probe);
      expect(redacted === null || redacted.includes("[REDACTED:PATH]")).toBe(true);
      const homographGone =
        redacted === null || (!redacted.includes(home) && !redacted.includes(user));
      expect(homographGone).toBe(true);
    }
  });

  it("drops fold-synthesized spoofed redaction markers, preserving idempotency (SEC-3)", () => {
    // SEC-2's NFKC fold lets fullwidth brackets/colon (U+FF3B/U+FF3D/U+FF1A) — and any
    // other compatibility character — collapse to a literal ASCII `[REDACTED:…]` the
    // module never emitted. That forged marker is dropped fail-closed.
    const foldSpoofs = [
      "\u{FF3B}REDACTED:PATH\u{FF3D}", // ［REDACTED:PATH］ fullwidth brackets
      "\u{FF3B}REDACTED\u{FF1A}PATH\u{FF3D}", // ［REDACTED：PATH］ fullwidth colon too
      "harmless prefix \u{FF3B}REDACTED:COMMIT\u{FF3D} suffix", // embedded in benign text
      // Compat char wedged inside a typed ASCII frame folds to a non-CAPS pseudo-field
      // that the fold still synthesized — frame-identity catches it (raw has U+3371,
      // not the folded "hPa"), where a CAPS-only check would have missed it.
      "[REDACTED:\u{3371}]", // → [REDACTED:hPa]
      "[REDACTED:PAT\u{FB01}]", // fi-ligature → [REDACTED:PATfi]
    ];
    for (const spoof of foldSpoofs) {
      expect(redactEvidenceExcerpt(spoof)).toBeNull();
    }
    // Idempotency (hard invariant, see parseCond1Prepared): a genuine ASCII marker is
    // present pre-fold, so re-redacting the module's own output is a no-op — not a drop.
    // This also means the pre-existing "raw input already contains an ASCII marker"
    // sibling is intentionally left open (only a sentinel scheme could close it).
    for (const genuine of [
      "[REDACTED:PATH]",
      "[REDACTED:CREDENTIAL]",
      "safe [REDACTED:URL] tail",
    ]) {
      expect(redactEvidenceExcerpt(genuine)).toBe(genuine);
    }
    // A genuine ASCII marker alongside a fold-synthesized one still drops (the fold
    // added a marker beyond what was present as ASCII in the raw input).
    expect(redactEvidenceExcerpt("[REDACTED:PATH] and \u{FF3B}REDACTED:URL\u{FF3D}")).toBeNull();
    // Must NOT over-drop: prose mentioning the word, or a bracketed note that is not the
    // exact `[REDACTED:<CAPS>]` shape, survives.
    expect(redactEvidenceExcerpt("this line mentions REDACTED but is not a marker")).not.toBeNull();
    expect(redactEvidenceExcerpt("see the [note] and the [redacted] lowercase tag")).not.toBeNull();
    expect(
      redactEvidenceExcerpt("[REDACTED] with no field is not the marker shape"),
    ).not.toBeNull();
  });

  it("preserves accented prose and spaced emoji (backstop does not over-drop letters)", () => {
    // Latin letters (incl. wedged diacritics) and non-wedged symbols are kept.
    expect(redactEvidenceExcerpt("naïve café résumé Zürich")).not.toBeNull();
    expect(redactEvidenceExcerpt("emoji 🙂 between words 🚀 here")).not.toBeNull();
    expect(redactEvidenceExcerpt("prose with a spaced — dash and … ellipsis")).not.toBeNull();
  });

  it("does not leak bare partial commit SHAs (7-39 hex)", () => {
    const shaProbes = [
      "Reverted in a1b2c3d4e5",
      "See 0fd8d5f for the change",
      `deep hex ${"a".repeat(7)}`,
      `deep hex ${"f".repeat(39)}`,
    ];
    for (const probe of shaProbes) {
      const redacted = redactEvidenceExcerpt(probe);
      expect(redacted).not.toBeNull();
      if (redacted === null) throw new Error("fixture_redaction_dropped");
      expect(redacted).toContain("[REDACTED:COMMIT]");
      expect(redacted).not.toMatch(/\b[0-9a-f]{7,39}\b/iu);
    }
  });

  it("recursively scans every fixture output for prohibited material", () => {
    const outputs = {
      packet: [
        redactEvidenceExcerpt("https://secret.invalid/private"),
        { excerpt: redactEvidenceExcerpt("C:\\secret\\file refs/heads/private") },
      ],
      nested: { token: redactEvidenceExcerpt("Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890") },
      deeper: {
        values: [
          { path: redactEvidenceExcerpt('"C:\\Users\\Private Name\\secret.txt"') },
          { ref: redactEvidenceExcerpt("branch customer-private") },
          { commit: redactEvidenceExcerpt("revision abc1234") },
          { password: redactEvidenceExcerpt("password hunter2-private") },
        ],
      },
    };
    const strings = recursiveStrings(outputs);
    expect(strings.length).toBeGreaterThan(0);
    for (const text of strings) {
      for (const prohibited of PROHIBITED) expect(text).not.toMatch(prohibited);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(EVIDENCE_EXCERPT_MAX_BYTES);
    }
  });
});
