/**
 * test/hooks/ingest-fixture-provenance.test.ts — SEC-101 W-A backstop (NEW-1).
 *
 * The ingest carve-out (test/fixtures/ingest/) is provenance-gated by a reviewed
 * manifest of git blob SHAs. A new or edited fixture (e.g. a pasted transcript)
 * changes its blob SHA and fails until a reviewer updates the manifest.
 */

import { describe, expect, it } from "vitest";
import { manifestViolations } from "../../scripts/hooks/assert-ingest-fixtures.mjs";

const manifest = {
  "test/fixtures/ingest/proj-a/s.jsonl": "aaaa1111",
  "test/fixtures/ingest/proj-b/s.jsonl": "bbbb2222",
};

describe("SEC-101 W-A ingest-fixture provenance backstop", () => {
  it("passes when committed blobs match the manifest", () => {
    const entries = [
      { file: "test/fixtures/ingest/proj-a/s.jsonl", sha: "aaaa1111" },
      { file: "test/fixtures/ingest/proj-b/s.jsonl", sha: "bbbb2222" },
    ];
    expect(manifestViolations(entries, manifest)).toEqual([]);
  });

  it("rejects an edited fixture (blob SHA changed)", () => {
    const entries = [
      { file: "test/fixtures/ingest/proj-a/s.jsonl", sha: "deadbeef" },
      { file: "test/fixtures/ingest/proj-b/s.jsonl", sha: "bbbb2222" },
    ];
    const v = manifestViolations(entries, manifest);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("content changed");
  });

  it("rejects an unregistered new fixture", () => {
    const entries = [
      { file: "test/fixtures/ingest/proj-a/s.jsonl", sha: "aaaa1111" },
      { file: "test/fixtures/ingest/proj-b/s.jsonl", sha: "bbbb2222" },
      { file: "test/fixtures/ingest/proj-c/pasted.jsonl", sha: "cccc3333" },
    ];
    const v = manifestViolations(entries, manifest);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("unregistered");
  });

  it("rejects a stale manifest entry with no committed fixture", () => {
    const entries = [{ file: "test/fixtures/ingest/proj-a/s.jsonl", sha: "aaaa1111" }];
    const v = manifestViolations(entries, manifest);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("stale");
  });
});
