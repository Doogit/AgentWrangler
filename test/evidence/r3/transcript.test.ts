import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FrozenTranscriptEntry,
  harvestFrozenTranscript,
} from "../../../src/evidence/r3/transcript.js";
import { fingerprintBranchRef } from "../../../src/outcomes/branch-key.js";

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentwrangler-r3-transcript-"));
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { force: true, recursive: true });
});

function freeze(filePath: string, sessionId = "fixture-session"): FrozenTranscriptEntry {
  const stat = fs.statSync(filePath, { bigint: true });
  return {
    sessionId,
    path: filePath,
    identity: {
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      size: stat.size.toString(),
    },
    sha256: createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
  };
}

describe("harvestFrozenTranscript", () => {
  it("returns only attested bounded structural projections and counts malformed lines", async () => {
    const filePath = path.join(fixtureRoot, "success.jsonl");
    const rawRef = "private/operator-branch";
    fs.writeFileSync(
      filePath,
      `${[
        JSON.stringify({ gitBranch: rawRef, secret: "discard-me" }),
        "not-json",
        JSON.stringify({ type: "pr-link", prNumber: 42, prRepository: "acme/repo" }),
        JSON.stringify(["not", "a", "record"]),
      ].join("\n")}\n`,
    );

    const result = await harvestFrozenTranscript(freeze(filePath));

    expect(result).toEqual({
      ok: true,
      projection: {
        links: [{ prNumber: 42, prRepository: "acme/repo" }],
        branchKeys: new Set([fingerprintBranchRef(rawRef)]),
        malformedLines: 2,
      },
    });
    expect(JSON.stringify(result)).not.toContain(rawRef);
    expect(JSON.stringify(result)).not.toContain(filePath);
    expect(JSON.stringify(result)).not.toContain("discard-me");
  });

  it("classifies a missing frozen file without returning its path", async () => {
    const filePath = path.join(fixtureRoot, "missing.jsonl");
    const result = await harvestFrozenTranscript({
      path: filePath,
      sessionId: "missing-session",
      identity: { device: "1", inode: "2", size: "3" },
      sha256: "0".repeat(64),
    });
    expect(result).toEqual({ ok: false, reason: "MISSING" });
    expect(JSON.stringify(result)).not.toContain(filePath);
  });

  it("classifies a non-file corpus entry as unreadable", async () => {
    const stat = fs.statSync(fixtureRoot, { bigint: true });
    const result = await harvestFrozenTranscript({
      sessionId: "directory-session",
      path: fixtureRoot,
      identity: {
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
        size: stat.size.toString(),
      },
      sha256: "0".repeat(64),
    });
    expect(result).toEqual({ ok: false, reason: "UNREADABLE" });
  });

  it("classifies a pathname replacement before reading", async () => {
    const filePath = path.join(fixtureRoot, "replaced.jsonl");
    fs.writeFileSync(filePath, "{}\n");
    const entry = freeze(filePath);
    fs.renameSync(filePath, path.join(fixtureRoot, "original.jsonl"));
    fs.writeFileSync(filePath, "{}\n");

    expect(await harvestFrozenTranscript(entry)).toEqual({ ok: false, reason: "REPLACED" });
  });

  it("classifies an in-place content change with stable identity and size", async () => {
    const filePath = path.join(fixtureRoot, "changed.jsonl");
    fs.writeFileSync(filePath, '{"a":1}\n');
    const entry = freeze(filePath);
    fs.writeFileSync(filePath, '{"a":2}\n');

    expect(await harvestFrozenTranscript(entry)).toEqual({ ok: false, reason: "CHANGED" });
  });

  it("fails closed when a valid PR-link appears beyond the bounded projection", async () => {
    const filePath = path.join(fixtureRoot, "overflow.jsonl");
    const records = Array.from({ length: 64 }, (_, index) =>
      JSON.stringify({
        type: "pr-link",
        prNumber: index + 1,
        prRepository: "other/repo",
      }),
    );
    records.push(JSON.stringify({ type: "pr-link", prNumber: 999, prRepository: "acme/approved" }));
    fs.writeFileSync(filePath, `${records.join("\n")}\n`);

    expect(await harvestFrozenTranscript(freeze(filePath))).toEqual({
      ok: false,
      reason: "LIMIT_EXCEEDED",
    });
  });
});
