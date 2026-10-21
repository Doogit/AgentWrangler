import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENTROPY_RUN,
  TRANSCRIPT_LINE_MIN,
  decodeText,
  lineReasons,
  rawContentReasons,
} from "../../scripts/hooks/content-signatures.mjs";

// A real captured assistant turn: transcript-shaped AND long. Spaced prose so the
// length comes from words, not a single alnum run (which would also trip entropy).
const transcriptLine = JSON.stringify({
  type: "assistant",
  sessionId: "sess",
  message: {
    role: "assistant",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
    content: [{ type: "text", text: "analysis ".repeat(TRANSCRIPT_LINE_MIN / 4) }],
  },
});

// A short but genuine transcript line — real developer content, under the length gate.
const shortTranscriptLine = JSON.stringify({
  role: "user",
  content: "how do I fix the auth bug in payment.ts",
});

describe("SEC-101 content signatures", () => {
  it("flags a long transcript-shaped JSON line", () => {
    expect(transcriptLine.length).toBeGreaterThanOrEqual(TRANSCRIPT_LINE_MIN);
    expect(lineReasons(transcriptLine).join()).toMatch(/transcript-shaped/);
  });

  it("flags a SHORT transcript line outside example/fixture paths (any length)", () => {
    expect(shortTranscriptLine.length).toBeLessThan(TRANSCRIPT_LINE_MIN);
    expect(lineReasons(shortTranscriptLine, "src/leaked.ts").join()).toMatch(/transcript-shaped/);
    // default (unknown path) is strict — treated as sensitive
    expect(lineReasons(shortTranscriptLine).join()).toMatch(/transcript-shaped/);
  });

  it("allows a short synthetic transcript line under test/fixtures/", () => {
    expect(lineReasons(shortTranscriptLine, "test/fixtures/ingest/session-a.jsonl")).toEqual([]);
    expect(
      lineReasons(shortTranscriptLine, "test/fixtures/detector-health/B1/near-miss/x.jsonl"),
    ).toEqual([]);
    // other fixture roots stay strict
    expect(lineReasons(shortTranscriptLine, "test/fixtures/other/x.jsonl").join()).toMatch(
      /transcript-shaped/,
    );
  });

  it("allows a short transcript-shaped example under docs/", () => {
    expect(lineReasons(shortTranscriptLine, "docs/research/catalog.md")).toEqual([]);
  });

  it("STILL flags an oversized transcript line even under a carve-out path", () => {
    expect(lineReasons(transcriptLine, "test/fixtures/ingest/session-a.jsonl").join()).toMatch(
      /oversized transcript-shaped/,
    );
  });

  it("flags PEM private-key headers (incl. encrypted PKCS#8 and PGP) at any path", () => {
    // Built at runtime so this test file itself does not carry the literal header
    // (which the whole-tree content gate would otherwise flag).
    const K = "PRIVATE";
    for (const header of [
      `-----BEGIN OPENSSH ${K} KEY-----`,
      `-----BEGIN ${K} KEY-----`,
      `-----BEGIN ENCRYPTED ${K} KEY-----`,
      `-----BEGIN PGP ${K} KEY BLOCK-----`,
    ]) {
      expect(lineReasons(header, "docs/anything.md").join(), header).toMatch(/PEM private-key/);
      expect(lineReasons(header, "src/config.ts").join(), header).toMatch(/PEM private-key/);
    }
  });

  it("applies the STRICT rule to test/fixtures paths outside ingest/ (carve-out is narrow)", () => {
    expect(
      lineReasons(shortTranscriptLine, "test/fixtures/outcomes/pr-link-sample.jsonl").join(),
    ).toMatch(/transcript-shaped/);
  });

  it("flags a high-entropy base64/hex run", () => {
    const blob = `KEY=${"A1b2C3d4".repeat(ENTROPY_RUN / 4)}`;
    expect(lineReasons(blob).join()).toMatch(/high-entropy/);
  });

  it("flags an oversized flat-dump line regardless of shape", () => {
    expect(lineReasons("z".repeat(6000)).join()).toMatch(/oversized line/);
  });

  it("is clean on ordinary source and prose", () => {
    expect(rawContentReasons("const x = 1;\n// a normal comment\nexport { x };")).toEqual([]);
    expect(rawContentReasons("# Heading\n\nA paragraph of documentation text.")).toEqual([]);
  });

  it("reports 1-based line numbers", () => {
    const text = `clean line\n${transcriptLine}`;
    const hits = rawContentReasons(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
  });

  it("decodeText decodes UTF-16 so it cannot evade via null bytes", () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(shortTranscriptLine, "utf16le"),
    ]);
    expect(utf16.includes(0)).toBe(true); // would be skipped by a naive binary check
    const text = decodeText(utf16);
    expect(text).not.toBeNull();
    const reasons = rawContentReasons(text as string, "src/leaked.log").map((h) => h.reason);
    expect(reasons.join()).toMatch(/transcript-shaped/);
  });

  it("decodeText returns null for genuine binary", () => {
    expect(decodeText(Buffer.from([0x00, 0x01, 0x02, 0xfa, 0x00]))).toBeNull();
  });

  // Grounding oracle: the actual committed synthetic ingest fixtures must scan clean
  // under their real paths, or the gate would break every commit touching them.
  it("passes the real committed synthetic ingest fixtures", () => {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
    const fixtures = execFileSync("git", ["ls-files", "test/fixtures/ingest"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => f.endsWith(".jsonl"));
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      const text = fs.readFileSync(path.join(root, f), "utf8");
      expect(rawContentReasons(text, f), `${f} should scan clean`).toEqual([]);
    }
  });
});
