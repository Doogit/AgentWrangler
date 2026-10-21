import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CERTIFICATION,
  type CertEntry,
  validateCertEntry,
} from "../../src/detector/certification.js";
import { DETECTORS } from "../../src/detector/registry.js";

const repoRoot = process.cwd();

// Independent copy to catch a regression that drops a required evidence check.
function localValidateCertEntry(id: string, entry: CertEntry, root: string): string[] {
  if (entry.status === "UNVERIFIED") return [];

  const problems: string[] = [];
  const requiredFields = [
    "c1",
    "c2",
    "c4",
    "c5a",
    "liveRunDate",
    "sha",
    "operatorSignOff",
    "claudeCodeVersionRange",
  ] as const;
  for (const field of requiredFields) {
    if (!entry.evidence[field].trim()) problems.push(`${id}: ${field} is empty`);
  }

  for (const field of ["c1", "c2", "c4", "c5a"] as const) {
    if (entry.evidence[field].trim() && !existsSync(join(root, entry.evidence[field]))) {
      problems.push(`${id}: ${field} is missing`);
    }
  }
  return problems;
}

describe("detector certification registry", () => {
  it("matches the registered detector IDs exactly", () => {
    expect(Object.keys(CERTIFICATION).sort()).toEqual(
      DETECTORS.map((detector) => detector.id).sort(),
    );
  });

  // Certification artifacts live under private paths (.claude/audits), absent from the public export.
  it.skipIf(!existsSync(join(repoRoot, ".claude/audits")))("contains only valid entries", () => {
    for (const [id, entry] of Object.entries(CERTIFICATION)) {
      expect(validateCertEntry(id, entry, repoRoot)).toEqual([]);
    }
  });

  it("requires sign-off and existing artifacts for certified entries", () => {
    const unsigned: CertEntry = {
      status: "CERTIFIED",
      evidence: {
        c1: "package.json",
        c2: "package.json",
        c4: "package.json",
        c5a: "package.json",
        liveRunDate: "2026-01-01",
        sha: "synthetic-sha",
        operatorSignOff: "",
        claudeCodeVersionRange: "synthetic-version",
      },
    };

    expect(localValidateCertEntry("TEST", unsigned, repoRoot)).toContain(
      "TEST: operatorSignOff is empty",
    );
    expect(validateCertEntry("TEST", unsigned, repoRoot)).toContain(
      "TEST: operatorSignOff must be a non-empty string",
    );

    const signed: CertEntry = {
      ...unsigned,
      evidence: { ...unsigned.evidence, operatorSignOff: "synthetic-operator" },
    };
    expect(localValidateCertEntry("TEST", signed, repoRoot)).toEqual([]);
    expect(validateCertEntry("TEST", signed, repoRoot)).toEqual([]);

    const missingArtifact: CertEntry = {
      ...signed,
      evidence: { ...signed.evidence, c4: "missing-certification-artifact.txt" },
    };
    expect(localValidateCertEntry("TEST", missingArtifact, repoRoot)).toContain(
      "TEST: c4 is missing",
    );
    expect(validateCertEntry("TEST", missingArtifact, repoRoot)).toContain(
      "TEST: c4 artifact does not exist",
    );
  });
});
