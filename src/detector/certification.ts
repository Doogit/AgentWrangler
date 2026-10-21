import { existsSync } from "node:fs";
import { join } from "node:path";

export type CertEntry =
  | { status: "UNVERIFIED" }
  | {
      status: "CERTIFIED";
      evidence: {
        c1: string;
        c2: string;
        c4: string;
        c5a: string;
        liveRunDate: string;
        sha: string;
        operatorSignOff: string;
        claudeCodeVersionRange: string;
        /** Certified with C1 ESTIMATED (no quantity oracle, Light tier): cards read "Estimated". */
        c1Estimated?: true;
      };
    };

export const CERTIFICATION: Record<string, CertEntry> = {
  A1: { status: "UNVERIFIED" },
  A2: { status: "UNVERIFIED" },
  B1: { status: "UNVERIFIED" },
  B2: { status: "UNVERIFIED" },
  B3: { status: "UNVERIFIED" },
  B4: { status: "UNVERIFIED" },
  C1: { status: "UNVERIFIED" },
  C2: { status: "UNVERIFIED" },
  C3: { status: "UNVERIFIED" },
  C4: { status: "UNVERIFIED" },
  C5: { status: "UNVERIFIED" },
  C6: { status: "UNVERIFIED" },
  C7: { status: "UNVERIFIED" },
  C9: { status: "UNVERIFIED" },
  C11: { status: "UNVERIFIED" },
  E1: { status: "UNVERIFIED" },
  E2: { status: "UNVERIFIED" },
  D1: {
    status: "CERTIFIED",
    evidence: {
      c1: ".claude/audits/certification/d1/2026-09-25-c1-recheck.md",
      c2: ".claude/audits/certification/d1/2026-09-26-certify.json",
      c4: ".claude/audits/certification/d1/2026-09-26-certify.json",
      c5a: ".claude/audits/certification/d1/2026-09-25-c5a.md",
      liveRunDate: "2026-09-25",
      sha: "abf9cb6",
      operatorSignOff: "2026-09-25",
      claudeCodeVersionRange: "2.1.280",
    },
  },
  D2: { status: "UNVERIFIED" },
  D4: { status: "UNVERIFIED" },
  D5: { status: "UNVERIFIED" },
  D6: { status: "UNVERIFIED" },
  D7: { status: "UNVERIFIED" },
  D8: { status: "UNVERIFIED" },
  D9: { status: "UNVERIFIED" },
  D10: { status: "UNVERIFIED" },
  D11: { status: "UNVERIFIED" },
  D12: { status: "UNVERIFIED" },
  D14: { status: "UNVERIFIED" },
  G11: { status: "UNVERIFIED" },
  H1: { status: "UNVERIFIED" },
};

export function validateCertEntry(id: string, entry: CertEntry, repoRoot: string): string[] {
  if (entry.status === "UNVERIFIED") return [];

  const problems: string[] = [];
  const evidence = entry.evidence;
  for (const field of [
    "c1",
    "c2",
    "c4",
    "c5a",
    "liveRunDate",
    "sha",
    "operatorSignOff",
    "claudeCodeVersionRange",
  ] as const) {
    const value = evidence[field];
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`${id}: ${field} must be a non-empty string`);
    }
  }

  for (const field of ["c1", "c2", "c4", "c5a"] as const) {
    const artifactPath = evidence[field];
    if (
      typeof artifactPath === "string" &&
      artifactPath.trim() !== "" &&
      !existsSync(join(repoRoot, artifactPath))
    ) {
      problems.push(`${id}: ${field} artifact does not exist`);
    }
  }

  return problems;
}
