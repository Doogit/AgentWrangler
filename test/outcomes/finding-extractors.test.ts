import { describe, expect, it } from "vitest";
import {
  EXTRACTOR_VERSIONS,
  extractDeferralFindings,
  extractDiffMarkerFindings,
  projectDiffMarkerCandidates,
  projectReviewThreadFindings,
} from "../../src/outcomes/finding-extractors.js";

describe("pure finding extractors", () => {
  it("freezes the reviewed extractor versions", () => {
    expect(EXTRACTOR_VERSIONS).toEqual({
      E1: "unresolved-thread-v1",
      E2: "deferral-section-v1",
      E3: "diff-marker-v1",
    });
  });

  it("projects current E1 state without claiming historical state at merge", () => {
    expect(
      projectReviewThreadFindings("gh:acme/repo#1", [
        { id: "thread-open", isResolved: false },
        { id: "thread-closed", isResolved: true },
      ]),
    ).toEqual([
      {
        sourceFindingId: "e1:gh:acme/repo#1:thread-open",
        evidenceRef: "thread-open",
        status: "DEFERRED",
        evidence: { stateAtRelevantTime: "UNRESOLVED", temporalBasis: "CURRENT_STATE_ONLY" },
      },
      {
        sourceFindingId: "e1:gh:acme/repo#1:thread-closed",
        evidenceRef: "thread-closed",
        status: "ADDRESSED",
        evidence: { stateAtRelevantTime: "RESOLVED", temporalBasis: "CURRENT_STATE_ONLY" },
      },
    ]);
  });

  it("preserves E2 structural IDs while exposing only in-memory matched evidence", () => {
    const findings = extractDeferralFindings(
      "## Deferred\n- first\n* second\n## Complete\n- ignored\n## Follow up\n- third",
      "gh:acme/repo#2",
    );

    expect(
      findings.map(({ sourceFindingId, evidenceRef, status }) => ({
        sourceFindingId,
        evidenceRef,
        status,
      })),
    ).toEqual([
      {
        sourceFindingId: "e2:gh:acme/repo#2:0",
        evidenceRef: "gh:acme/repo#2:e2:deferred:0",
        status: "DEFERRED",
      },
      {
        sourceFindingId: "e2:gh:acme/repo#2:1",
        evidenceRef: "gh:acme/repo#2:e2:deferred:1",
        status: "DEFERRED",
      },
      {
        sourceFindingId: "e2:gh:acme/repo#2:2",
        evidenceRef: "gh:acme/repo#2:e2:follow-ups:0",
        status: "DEFERRED",
      },
    ]);
    expect(findings.map((finding) => finding.evidenceText)).toEqual([
      "- first",
      "* second",
      "- third",
    ]);
  });

  it("preserves E3 IDs, locations, and exclusions", () => {
    const diff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -5,1 +5,3 @@",
      " context",
      "+// TODO: retained",
      "+++ b/package-lock.json",
      "@@ -1,0 +1,1 @@",
      "+FIXME excluded",
    ].join("\n");

    const candidates = projectDiffMarkerCandidates(diff);
    expect(candidates).toEqual([
      { evidenceText: "// TODO: retained", filePath: "src/a.ts", lineNumber: 6 },
    ]);
    expect(extractDiffMarkerFindings(diff, "abcdef123", "gh:acme/repo#3")).toEqual([
      {
        sourceFindingId: "e3:gh:acme/repo#3:0",
        evidenceRef: "src/a.ts:6@abcdef1",
        status: "UNKNOWN",
        evidenceText: "// TODO: retained",
        filePath: "src/a.ts",
        lineNumber: 6,
      },
    ]);
    expect(extractDiffMarkerFindings(diff, "abcdef123", "gh:acme/repo#3")).toEqual(
      candidates.map((candidate, index) => ({
        sourceFindingId: `e3:gh:acme/repo#3:${index}`,
        evidenceRef: `${candidate.filePath}:${candidate.lineNumber}@abcdef1`,
        status: "UNKNOWN",
        ...candidate,
      })),
    );
  });
});
