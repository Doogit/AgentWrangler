import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCommonFlagArray,
  defaultApprovalManifestPath,
  defaultLiveDbPath,
  defaultScratchBaseDir,
  formatNpmCommand,
  scratchPaths,
  scratchRunId,
} from "../../../scripts/evidence/lib/flags.js";
import { buildD7Flags, parseB6Args } from "../../../scripts/evidence/prepare-b6.js";
import {
  buildPacketFlags,
  buildPrepareFlags,
  parseG2Args,
} from "../../../scripts/evidence/prepare-g2.js";

// ── buildCommonFlagArray ──────────────────────────────────────────────────────

describe("buildCommonFlagArray", () => {
  const fixture = {
    approvalManifest: "/home/x/approval.json",
    approvalSha256: "a".repeat(64),
    scratchPreparationManifest: "/home/x/state/preparation-manifest.json",
    scratchPreparationSha256: "b".repeat(64),
    scratchDb: "/home/x/scratch.sqlite",
    approvedScratchDbSha256: "c".repeat(64),
    repoMap: "/home/x/state/repo-map.json",
    repoMapSha256: "d".repeat(64),
    scratchState: "/home/x/state",
    scratchVerification: "/home/x/state/verify-prepare",
    liveDb: "/home/y/db.sqlite",
  };

  it("produces exactly 22 items (11 flag-value pairs)", () => {
    const result = buildCommonFlagArray(fixture);
    expect(result).toHaveLength(22);
  });

  it("all odd-indexed items are --flag names", () => {
    const result = buildCommonFlagArray(fixture);
    for (let i = 0; i < result.length; i += 2) {
      expect(result[i]).toMatch(/^--/u);
    }
  });

  it("values are preserved exactly", () => {
    const result = buildCommonFlagArray(fixture);
    expect(result[1]).toBe(fixture.approvalManifest);
    expect(result[3]).toBe(fixture.approvalSha256);
    expect(result[5]).toBe(fixture.scratchPreparationManifest);
    expect(result[7]).toBe(fixture.scratchPreparationSha256);
    expect(result[9]).toBe(fixture.scratchDb);
    expect(result[11]).toBe(fixture.approvedScratchDbSha256);
    expect(result[13]).toBe(fixture.repoMap);
    expect(result[15]).toBe(fixture.repoMapSha256);
    expect(result[17]).toBe(fixture.scratchState);
    expect(result[19]).toBe(fixture.scratchVerification);
    expect(result[21]).toBe(fixture.liveDb);
  });

  it("contains all 11 required flag names", () => {
    const result = buildCommonFlagArray(fixture);
    const flagNames = result.filter((_, i) => i % 2 === 0);
    expect(flagNames).toContain("--approval-manifest");
    expect(flagNames).toContain("--approval-sha256");
    expect(flagNames).toContain("--scratch-preparation-manifest");
    expect(flagNames).toContain("--scratch-preparation-sha256");
    expect(flagNames).toContain("--scratch-db");
    expect(flagNames).toContain("--approved-scratch-db-sha256");
    expect(flagNames).toContain("--repo-map");
    expect(flagNames).toContain("--repo-map-sha256");
    expect(flagNames).toContain("--scratch-state");
    expect(flagNames).toContain("--scratch-verification");
    expect(flagNames).toContain("--live-db");
    expect(flagNames).toHaveLength(11);
  });
});

// ── scratchRunId ──────────────────────────────────────────────────────────────

describe("scratchRunId", () => {
  it("produces the expected format from a fixed date", () => {
    const fixed = new Date("2026-09-01T12:34:56.000Z");
    expect(scratchRunId("g2", fixed)).toBe("g2-20260901-123456");
    expect(scratchRunId("b6", fixed)).toBe("b6-20260901-123456");
  });

  it("uses the prefix exactly", () => {
    const id = scratchRunId("test-prefix", new Date("2026-01-02T03:04:05.000Z"));
    expect(id.startsWith("test-prefix-")).toBe(true);
  });
});

// ── scratchPaths ──────────────────────────────────────────────────────────────

describe("scratchPaths", () => {
  const base = "/evidence";
  const runId = "g2-20260901-120000";
  const paths = scratchPaths(base, runId);

  it("runDir is baseDir/runId", () => {
    expect(paths.runDir).toBe(path.join(base, runId));
  });

  it("scratchDb is inside runDir", () => {
    expect(paths.scratchDb.startsWith(paths.runDir)).toBe(true);
    expect(path.basename(paths.scratchDb)).toBe("scratch.sqlite");
  });

  it("scratchState is inside runDir", () => {
    expect(paths.scratchState.startsWith(paths.runDir)).toBe(true);
  });

  it("preparationManifest and repoMap are inside scratchState", () => {
    expect(path.dirname(paths.preparationManifest)).toBe(paths.scratchState);
    expect(path.basename(paths.preparationManifest)).toBe("preparation-manifest.json");
    expect(path.dirname(paths.repoMap)).toBe(paths.scratchState);
    expect(path.basename(paths.repoMap)).toBe("repo-map.json");
  });

  it("all verify paths are inside scratchState and have distinct names", () => {
    const verifyNames = [
      paths.verifyPrepare,
      paths.verifyPacket,
      paths.verifyScore,
      paths.verifyD7,
    ];
    for (const v of verifyNames) {
      expect(path.dirname(v)).toBe(paths.scratchState);
    }
    const basenames = verifyNames.map((v) => path.basename(v));
    expect(new Set(basenames).size).toBe(4); // all distinct
  });
});

// ── default paths ─────────────────────────────────────────────────────────────

describe("default paths", () => {
  it("defaultLiveDbPath ends with .agentwrangler/db.sqlite", () => {
    const p = defaultLiveDbPath();
    expect(p.endsWith(path.join(".agentwrangler", "db.sqlite"))).toBe(true);
    expect(p.startsWith(os.homedir())).toBe(true);
  });

  it("defaultApprovalManifestPath contains the O1 manifest filename", () => {
    const p = defaultApprovalManifestPath();
    expect(path.basename(p)).toBe("wave2-approval-v3-b96fcb40.json");
    expect(p.startsWith(os.homedir())).toBe(true);
  });

  it("defaultScratchBaseDir is under ~/.agentwrangler/evidence", () => {
    const p = defaultScratchBaseDir();
    expect(p.endsWith(path.join(".agentwrangler", "evidence"))).toBe(true);
    expect(p.startsWith(os.homedir())).toBe(true);
  });
});

// ── formatNpmCommand ──────────────────────────────────────────────────────────

describe("formatNpmCommand", () => {
  it("produces the right header with subcommand", () => {
    const cmd = formatNpmCommand("evidence:cond1", "prepare", []);
    expect(cmd).toBe("npm run evidence:cond1 -- prepare");
  });

  it("produces the right header without subcommand", () => {
    const cmd = formatNpmCommand("evidence:d7-coverage", null, []);
    expect(cmd).toBe("npm run evidence:d7-coverage");
  });

  it("splits flags onto separate lines with continuation backslash", () => {
    const cmd = formatNpmCommand("evidence:cond1", "prepare", [
      "--live-db",
      "/path/to/db",
      "--approval-manifest",
      "/path/to/manifest",
    ]);
    const lines = cmd.split("\n");
    expect(lines[0]).toContain("evidence:cond1 -- prepare");
    expect(lines.length).toBeGreaterThan(1);
    // non-final lines end with backslash (from " \\\n")
    for (let i = 0; i < lines.length - 1; i++) {
      expect(lines[i]?.trimEnd().endsWith("\\")).toBe(true);
    }
  });
});

// ── buildPrepareFlags ─────────────────────────────────────────────────────────

describe("buildPrepareFlags", () => {
  const common = ["--live-db", "/db"];
  const flags = buildPrepareFlags({
    common,
    manifestOut: "/state/manifest.json",
    preparedOut: "/state/prepared.json",
    extractorCommit: "a".repeat(40),
    findingsModuleSha256: "b".repeat(64),
    asOf: "2026-09-01T00:00:00.000Z",
  });

  it("starts with common flags", () => {
    expect(flags.slice(0, 2)).toEqual(common);
  });

  it("includes --corpus full-merged", () => {
    const idx = flags.indexOf("--corpus");
    expect(idx).toBeGreaterThan(-1);
    expect(flags[idx + 1]).toBe("full-merged");
  });

  it("includes all prepare-specific flags", () => {
    const flagNames = flags.filter((_, i) => i % 2 === 0);
    expect(flagNames).toContain("--manifest-out");
    expect(flagNames).toContain("--prepared-out");
    expect(flagNames).toContain("--extractor-commit");
    expect(flagNames).toContain("--findings-module-sha256");
    expect(flagNames).toContain("--as-of");
    expect(flagNames).toContain("--corpus");
  });
});

// ── buildPacketFlags ──────────────────────────────────────────────────────────

describe("buildPacketFlags", () => {
  const common = ["--live-db", "/db"];
  const flags = buildPacketFlags({
    common,
    manifestPath: "/state/manifest.json",
    manifestSha256: "a".repeat(64),
    preparedPath: "/state/prepared.json",
    preparedSha256: "b".repeat(64),
    packetOut: "/state/packet.json",
    keyOut: "/state/key.json",
  });

  it("starts with common flags", () => {
    expect(flags.slice(0, 2)).toEqual(common);
  });

  it("includes all packet-specific flags", () => {
    const flagNames = flags.filter((_, i) => i % 2 === 0);
    expect(flagNames).toContain("--manifest");
    expect(flagNames).toContain("--manifest-sha256");
    expect(flagNames).toContain("--prepared");
    expect(flagNames).toContain("--prepared-sha256");
    expect(flagNames).toContain("--packet-out");
    expect(flagNames).toContain("--key-out");
  });
});

// ── buildD7Flags ──────────────────────────────────────────────────────────────

describe("buildD7Flags", () => {
  const common = ["--live-db", "/db"];
  const flags = buildD7Flags({
    common,
    repositoryRoot: "/repo",
    sourceCommit: "c".repeat(40),
    asOf: "2026-09-01T00:00:00.000Z",
    out: "/state/report.json",
  });

  it("starts with common flags", () => {
    expect(flags.slice(0, 2)).toEqual(common);
  });

  it("includes --window-days 30", () => {
    const idx = flags.indexOf("--window-days");
    expect(idx).toBeGreaterThan(-1);
    expect(flags[idx + 1]).toBe("30");
  });

  it("includes all d7-specific flags", () => {
    const flagNames = flags.filter((_, i) => i % 2 === 0);
    expect(flagNames).toContain("--repository-root");
    expect(flagNames).toContain("--source-commit");
    expect(flagNames).toContain("--as-of");
    expect(flagNames).toContain("--window-days");
    expect(flagNames).toContain("--out");
  });
});

// ── parseG2Args ───────────────────────────────────────────────────────────────

describe("parseG2Args", () => {
  it("applies defaults when no args given", () => {
    const args = parseG2Args([]);
    expect(args.liveDb).toBe(defaultLiveDbPath());
    expect(args.approvalManifest).toBe(defaultApprovalManifestPath());
    expect(args.scratchBase).toBe(defaultScratchBaseDir());
    expect(args.execute).toBe(false);
  });

  it("accepts --execute flag", () => {
    const args = parseG2Args(["--execute"]);
    expect(args.execute).toBe(true);
  });

  it("accepts overrides", () => {
    const args = parseG2Args(["--live-db", "/my/db", "--approval-manifest", "/my/manifest"]);
    expect(args.liveDb).toBe("/my/db");
    expect(args.approvalManifest).toBe("/my/manifest");
    expect(args.execute).toBe(false);
  });
});

// ── parseB6Args ───────────────────────────────────────────────────────────────

describe("parseB6Args", () => {
  it("applies defaults when no args given", () => {
    const args = parseB6Args([]);
    expect(args.liveDb).toBe(defaultLiveDbPath());
    expect(args.approvalManifest).toBe(defaultApprovalManifestPath());
    expect(args.execute).toBe(false);
  });

  it("accepts --execute flag", () => {
    const args = parseB6Args(["--execute"]);
    expect(args.execute).toBe(true);
  });
});
