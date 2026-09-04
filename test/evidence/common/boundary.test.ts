import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EvidenceBoundaryError,
  assertScratchBoundary,
} from "../../../src/evidence/common/boundary.js";

let root: string;
let repositoryRoot: string;
let sourceDbPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-evidence-boundary-"));
  repositoryRoot = path.join(root, "repository");
  sourceDbPath = path.join(root, "source.sqlite");
  fs.mkdirSync(repositoryRoot);
  fs.writeFileSync(sourceDbPath, "source", "utf8");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function boundary(overrides: Partial<Parameters<typeof assertScratchBoundary>[0]> = {}) {
  return assertScratchBoundary({
    sourceDbPath,
    scratchDbPath: path.join(root, "approved", "scratch.sqlite"),
    scratchStatePath: path.join(root, "approved", "state"),
    repositoryRoot,
    ...overrides,
  });
}

describe("scratch filesystem boundary", () => {
  it("resolves approved future paths outside the repository", () => {
    const result = boundary();
    expect(result.sourceDbPath).toBe(fs.realpathSync.native(sourceDbPath));
    expect(result.scratchDbPath).toBe(path.join(root, "approved", "scratch.sqlite"));
    expect(result.scratchStatePath).toBe(path.join(root, "approved", "state"));
  });

  it("refuses missing source, existing outputs, aliases, and repository outputs", () => {
    expect(() => boundary({ sourceDbPath: path.join(root, "missing.sqlite") })).toThrow(
      "source_missing",
    );
    expect(() => boundary({ scratchDbPath: sourceDbPath })).toThrow("scratch_aliases_source");
    expect(() =>
      boundary({ scratchDbPath: path.join(repositoryRoot, "private", "scratch.sqlite") }),
    ).toThrow("output_inside_repository");

    const existingScratch = path.join(root, "existing.sqlite");
    fs.writeFileSync(existingScratch, "other", "utf8");
    expect(() => boundary({ scratchDbPath: existingScratch })).toThrow("scratch_already_exists");
    const existingState = path.join(root, "existing-state");
    fs.mkdirSync(existingState);
    expect(() => boundary({ scratchStatePath: existingState })).toThrow(
      "scratch_state_already_exists",
    );

    const scratchParent = path.join(root, "scratch-file");
    expect(() =>
      boundary({
        scratchDbPath: scratchParent,
        scratchStatePath: path.join(scratchParent, "state"),
      }),
    ).toThrow("overlapping_output_paths");
  });

  it("refuses a hard-link alias when the filesystem supports hard links", ({ skip }) => {
    const hardLink = path.join(root, "source-hardlink.sqlite");
    try {
      fs.linkSync(sourceDbPath, hardLink);
    } catch {
      skip();
      return;
    }
    expect(() => boundary({ scratchDbPath: hardLink })).toThrowError(
      new EvidenceBoundaryError("scratch_aliases_source"),
    );
  });
});
