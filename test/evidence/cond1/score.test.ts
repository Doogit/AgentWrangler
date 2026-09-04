import { describe, expect, it, vi } from "vitest";
import {
  canonicalAnswerKeySha256,
  canonicalSha256,
  scoreCond1,
} from "../../../src/evidence/cond1/score.js";
import type {
  Cond1CorpusManifest,
  Cond1HumanVerdict,
  Cond1SealedAnswer,
  ExtractorId,
  FrozenCond1Identity,
  ScoreCond1Input,
} from "../../../src/evidence/cond1/types.js";
import { EXTRACTOR_VERSIONS } from "../../../src/outcomes/finding-extractors.js";

const EXTRACTORS: readonly ExtractorId[] = ["E1", "E2", "E3"];

function answers(counts: Record<ExtractorId, number>): Cond1SealedAnswer[] {
  return EXTRACTORS.flatMap((extractor) =>
    Array.from({ length: counts[extractor] }, (_, index) => ({
      findingAlias: `${extractor.toLowerCase()}-alias-${index}`,
      extractor,
      extractorVersion: EXTRACTOR_VERSIONS[extractor],
      sourceFindingId: `${extractor.toLowerCase()}:private-work-item:${index}`,
      corpusPrKey: `private-pr-${index % 5}`,
      evidenceSufficient: true,
      projectionFailure: null,
    })),
  );
}

function verdictsFor(
  key: readonly Cond1SealedAnswer[],
  verdictFor: (answer: Cond1SealedAnswer, index: number) => Cond1HumanVerdict["verdict"] = () =>
    "TRUE_POSITIVE",
): Cond1HumanVerdict[] {
  return key.map((answer, index) => ({
    findingAlias: answer.findingAlias,
    verdict: verdictFor(answer, index),
    adjudicatorAlias: "reviewer-a",
    reasonCode: "EVIDENCE_SUPPORTS",
  }));
}

function inputFor(
  counts: Record<ExtractorId, number> = { E1: 20, E2: 20, E3: 20 },
): ScoreCond1Input {
  const key = answers(counts);
  const manifest: Cond1CorpusManifest = {
    version: "cond1-corpus-manifest-v1",
    campaignId: "campaign-opaque",
    identity: {
      sourceCommit: "a".repeat(40),
      runnerVersion: "cond1-runner-v1",
      findingsModuleSha256: "b".repeat(64),
      extractorVersions: EXTRACTOR_VERSIONS,
      packetVersion: "cond1-blinded-v1",
      scorerVersion: "cond1-precision-v1",
      asOf: "2026-08-26T00:00:00.000Z",
    },
    scratchDbSha256: "c".repeat(64),
    repoMapSha256: "d".repeat(64),
    eligiblePrN: 5,
    readCompletion: {
      E1: { requiredN: 5, succeededN: 5, failedN: 0 },
      E2: { requiredN: 5, succeededN: 5, failedN: 0 },
      E3: { requiredN: 5, succeededN: 5, failedN: 0 },
    },
    corpusReadSummary: { fullyReadPrN: 5, failedPrN: 0 },
    emittedFindingN: counts,
    preparedArtifactSha256: "e".repeat(64),
    answerCanonicalSha256: canonicalAnswerKeySha256(key),
  };
  return {
    manifest,
    corpusManifestFileSha256: "f".repeat(64),
    answers: key,
    verdicts: verdictsFor(key),
  };
}

describe("scoreCond1", () => {
  it("passes each extractor independently at the inclusive 0.80 threshold", () => {
    const input = inputFor();
    input.verdicts = verdictsFor(input.answers, (_answer, index) =>
      index % 20 < 16 ? "TRUE_POSITIVE" : "FALSE_POSITIVE",
    );

    const score = scoreCond1(input);
    expect(score.overallStatus).toBe("DATA_INSUFFICIENT");
    for (const extractor of ["E2", "E3"] as const) {
      expect(score.extractors[extractor]).toMatchObject({
        emittedN: 20,
        truePositiveN: 16,
        falsePositiveN: 4,
        precisionNumerator: 16,
        precisionDenominator: 20,
        precision: 0.8,
        threshold: 0.8,
        sparse: false,
        status: "PASS",
        limitation: "NONE",
      });
    }
    expect(score.extractors.E1).toMatchObject({
      precision: null,
      status: "DATA_INSUFFICIENT",
      limitation: "CURRENT_STATE_ONLY",
    });
  });

  it("does not pool a failing extractor with passing extractors", () => {
    const input = inputFor();
    input.verdicts = verdictsFor(input.answers, (answer, index) =>
      answer.extractor === "E1" && index % 20 >= 15 ? "FALSE_POSITIVE" : "TRUE_POSITIVE",
    );

    const score = scoreCond1(input);
    expect(score.extractors.E1.precision).toBeNull();
    expect(score.extractors.E1.status).toBe("DATA_INSUFFICIENT");
    expect(score.extractors.E2.status).toBe("PASS");
    expect(score.extractors.E3.status).toBe("PASS");
    expect(score.overallStatus).toBe("DATA_INSUFFICIENT");
  });

  it("reports a sparse cohort as data-insufficient while preserving arithmetic", () => {
    const input = inputFor({ E1: 20, E2: 19, E3: 20 });
    const score = scoreCond1(input);

    expect(score.extractors.E2).toMatchObject({
      emittedN: 19,
      precisionNumerator: 19,
      precisionDenominator: 19,
      precision: 1,
      sparse: true,
      status: "DATA_INSUFFICIENT",
      limitation: "SPARSE_LT_20",
    });
    expect(score.overallStatus).toBe("DATA_INSUFFICIENT");
  });

  it("fails closed on zero emissions and incomplete reads", () => {
    const zero = scoreCond1(inputFor({ E1: 0, E2: 20, E3: 20 }));
    expect(zero.extractors.E1).toMatchObject({
      precision: null,
      status: "DATA_INSUFFICIENT",
      limitation: "ZERO_EMISSIONS",
    });

    const incomplete = inputFor();
    incomplete.manifest.readCompletion.E2 = { requiredN: 5, succeededN: 4, failedN: 1 };
    incomplete.manifest.corpusReadSummary = { fullyReadPrN: 4, failedPrN: 1 };
    incomplete.corpusManifestFileSha256 = canonicalSha256(incomplete.manifest);
    const score = scoreCond1(incomplete);
    expect(score.extractors.E2).toMatchObject({
      precision: null,
      status: "DATA_INSUFFICIENT",
      limitation: "INCOMPLETE_READS",
    });
  });

  it("fails closed on missing, duplicate, unknown, and uncertain verdicts", () => {
    const missing = inputFor();
    missing.verdicts = missing.verdicts.slice(1);
    expect(scoreCond1(missing).extractors.E1).toMatchObject({
      unadjudicatedN: 1,
      limitation: "INCOMPLETE_ADJUDICATION",
      status: "DATA_INSUFFICIENT",
    });

    const duplicate = inputFor();
    duplicate.verdicts = [...duplicate.verdicts, duplicate.verdicts[0] as Cond1HumanVerdict];
    expect(scoreCond1(duplicate).extractors.E1.limitation).toBe("IDENTITY_MISMATCH");

    const unknown = inputFor();
    unknown.verdicts = [
      ...unknown.verdicts,
      {
        findingAlias: "not-in-answer-key",
        verdict: "TRUE_POSITIVE",
        adjudicatorAlias: "reviewer-a",
        reasonCode: "EVIDENCE_SUPPORTS",
      },
    ];
    expect(scoreCond1(unknown).overallStatus).toBe("DATA_INSUFFICIENT");
    expect(scoreCond1(unknown).extractors.E2.limitation).toBe("IDENTITY_MISMATCH");

    const uncertain = inputFor();
    uncertain.verdicts = verdictsFor(uncertain.answers, (_answer, index) =>
      index === 0 ? "UNCERTAIN" : "TRUE_POSITIVE",
    );
    expect(scoreCond1(uncertain).extractors.E1).toMatchObject({
      uncertainN: 1,
      precision: null,
      limitation: "UNCERTAIN_VERDICTS",
      status: "DATA_INSUFFICIENT",
    });
  });

  it("requires failed projections to be adjudicated uncertain with insufficient evidence", () => {
    const input = inputFor();
    const index = input.answers.findIndex(({ extractor }) => extractor === "E2");
    const answer = input.answers[index] as Cond1SealedAnswer;
    input.answers = input.answers.map((row, rowIndex) =>
      rowIndex === index
        ? { ...row, evidenceSufficient: false, projectionFailure: "REDACTION_FAILED" }
        : row,
    );
    input.manifest.answerCanonicalSha256 = canonicalAnswerKeySha256(input.answers);
    input.verdicts = verdictsFor(input.answers);
    expect(scoreCond1(input).extractors.E2).toMatchObject({
      precision: null,
      status: "DATA_INSUFFICIENT",
      limitation: "INCOMPLETE_ADJUDICATION",
    });

    input.verdicts = input.verdicts.map((verdict) =>
      verdict.findingAlias === answer.findingAlias
        ? { ...verdict, verdict: "UNCERTAIN", reasonCode: "INSUFFICIENT_EVIDENCE" }
        : verdict,
    );
    expect(scoreCond1(input).extractors.E2).toMatchObject({
      uncertainN: 1,
      precision: null,
      status: "DATA_INSUFFICIENT",
      limitation: "UNCERTAIN_VERDICTS",
    });
  });

  it("requires one adjudicator identity across every emitted verdict", () => {
    const mixedAdjudicators = inputFor();
    mixedAdjudicators.verdicts = mixedAdjudicators.verdicts.map((verdict, index) => ({
      ...verdict,
      adjudicatorAlias: index === 0 ? "reviewer-b" : "reviewer-a",
    }));

    const score = scoreCond1(mixedAdjudicators);
    expect(score.overallStatus).toBe("DATA_INSUFFICIENT");
    for (const extractor of EXTRACTORS) {
      expect(score.extractors[extractor].limitation).toBe("IDENTITY_MISMATCH");
    }
  });

  it("fails closed on manifest, sealed-key, extractor-version, and count mismatches", () => {
    const manifestDigest = inputFor();
    manifestDigest.corpusManifestFileSha256 = "not-a-digest";
    expect(scoreCond1(manifestDigest).extractors.E1.limitation).toBe("IDENTITY_MISMATCH");

    const sealedDigest = inputFor();
    sealedDigest.manifest.answerCanonicalSha256 = "0".repeat(64);
    sealedDigest.corpusManifestFileSha256 = canonicalSha256(sealedDigest.manifest);
    expect(scoreCond1(sealedDigest).extractors.E2.limitation).toBe("IDENTITY_MISMATCH");

    const version = inputFor();
    version.answers = version.answers.map((answer, index) =>
      index === 0 ? { ...answer, extractorVersion: "changed" } : answer,
    );
    version.manifest.answerCanonicalSha256 = canonicalAnswerKeySha256(version.answers);
    version.corpusManifestFileSha256 = canonicalSha256(version.manifest);
    expect(scoreCond1(version).extractors.E1.limitation).toBe("IDENTITY_MISMATCH");

    const count = inputFor();
    count.manifest.emittedFindingN.E3 = 21;
    count.corpusManifestFileSha256 = canonicalSha256(count.manifest);
    expect(scoreCond1(count).extractors.E3.limitation).toBe("IDENTITY_MISMATCH");

    const intersection = inputFor();
    intersection.manifest.corpusReadSummary = { fullyReadPrN: 4, failedPrN: 1 };
    expect(scoreCond1(intersection).overallStatus).toBe("DATA_INSUFFICIENT");
  });

  it("requires strict UTC RFC3339 asOf values", () => {
    for (const invalidAsOf of [
      "2026-08-26",
      "2026-08-26T00:00:00-07:00",
      "2026-02-30T00:00:00Z",
      "2026-08-26 00:00:00Z",
    ]) {
      const invalid = inputFor();
      invalid.manifest.identity.asOf = invalidAsOf;
      invalid.corpusManifestFileSha256 = canonicalSha256(invalid.manifest);
      expect(scoreCond1(invalid).extractors.E1.limitation).toBe("IDENTITY_MISMATCH");
    }

    const nanoseconds = inputFor();
    nanoseconds.manifest.identity.asOf = "2026-08-26T00:00:00.123456789Z";
    nanoseconds.corpusManifestFileSha256 = canonicalSha256(nanoseconds.manifest);
    expect(scoreCond1(nanoseconds).extractors.E2.status).toBe("PASS");
  });

  it("requires full lowercase 40- or 64-character source commit identity", () => {
    const abbreviated = inputFor();
    abbreviated.manifest.identity.sourceCommit = "abcdef1";
    abbreviated.corpusManifestFileSha256 = canonicalSha256(abbreviated.manifest);
    expect(scoreCond1(abbreviated).overallStatus).toBe("DATA_INSUFFICIENT");

    const uppercase = inputFor();
    uppercase.manifest.identity.sourceCommit = "A".repeat(40);
    uppercase.corpusManifestFileSha256 = canonicalSha256(uppercase.manifest);
    expect(scoreCond1(uppercase).overallStatus).toBe("DATA_INSUFFICIENT");

    const sha256Commit = inputFor();
    sha256Commit.manifest.identity.sourceCommit = "e".repeat(64);
    sha256Commit.corpusManifestFileSha256 = canonicalSha256(sha256Commit.manifest);
    expect(scoreCond1(sha256Commit).extractors.E2.status).toBe("PASS");
  });

  it("rejects unreviewed runner token or free-text identities without retaining them", () => {
    for (const unreviewedRunnerVersion of [
      "ghp_runner_token_should_not_persist",
      "local COND-1 runner with unreviewed notes",
    ]) {
      const input = inputFor();
      input.manifest.identity.runnerVersion = unreviewedRunnerVersion;
      input.corpusManifestFileSha256 = canonicalSha256(input.manifest);

      const score = scoreCond1(input);
      expect(score.overallStatus).toBe("DATA_INSUFFICIENT");
      expect(score.extractors.E1.limitation).toBe("IDENTITY_MISMATCH");
      expect(JSON.stringify(score)).not.toContain(unreviewedRunnerVersion);
    }
  });

  it("allowlists durable identity fields and rejects injected runtime keys without leaking them", () => {
    const injected = inputFor();
    injected.manifest.identity = {
      ...injected.manifest.identity,
      token: "ghp_should_not_be_durable",
      freeText: "unreviewed adjudicator note",
    } as FrozenCond1Identity & { token: string; freeText: string };
    injected.corpusManifestFileSha256 = canonicalSha256(injected.manifest);

    const score = scoreCond1(injected);
    const serialized = JSON.stringify(score);
    expect(score.overallStatus).toBe("DATA_INSUFFICIENT");
    expect(score.extractors.E1.limitation).toBe("IDENTITY_MISMATCH");
    expect(Object.keys(score.identity).sort()).toEqual(
      [
        "answerKeyCanonicalSha256",
        "asOf",
        "corpusManifestSha256",
        "extractorVersions",
        "findingsModuleSha256",
        "packetVersion",
        "repoMapSha256",
        "runnerVersion",
        "scorerVersion",
        "scratchDbSha256",
        "sourceCommit",
      ].sort(),
    );
    expect(serialized).not.toContain("ghp_should_not_be_durable");
    expect(serialized).not.toContain("unreviewed adjudicator note");
    expect(score.durablePrivacy).toEqual({ rawEvidenceN: 0, evidenceRefN: 0, pathN: 0, tokenN: 0 });
  });

  it("rejects duplicate answer identities and malformed corpus aliases", () => {
    const duplicateIdentity = inputFor();
    duplicateIdentity.answers = [
      ...duplicateIdentity.answers,
      {
        ...(duplicateIdentity.answers[0] as Cond1SealedAnswer),
        findingAlias: "different-alias-for-same-source",
      },
    ];
    duplicateIdentity.manifest.answerCanonicalSha256 = canonicalAnswerKeySha256(
      duplicateIdentity.answers,
    );
    duplicateIdentity.corpusManifestFileSha256 = canonicalSha256(duplicateIdentity.manifest);
    expect(scoreCond1(duplicateIdentity).overallStatus).toBe("DATA_INSUFFICIENT");
  });

  it("excludes randomized aliases and ordering from the canonical answer identity digest", () => {
    const original = answers({ E1: 2, E2: 2, E3: 2 });
    const rerandomized = [...original]
      .reverse()
      .map((answer, index) => ({ ...answer, findingAlias: `new-alias-${index}` }));

    expect(canonicalAnswerKeySha256(rerandomized)).toBe(canonicalAnswerKeySha256(original));
    expect(canonicalSha256(rerandomized)).not.toBe(canonicalSha256(original));
  });

  it("orders answer identity fields independently when values contain NUL", () => {
    const first: Cond1SealedAnswer = {
      findingAlias: "first",
      extractor: "E1",
      extractorVersion: EXTRACTOR_VERSIONS.E1,
      sourceFindingId: "b\u0000c",
      corpusPrKey: "a",
      evidenceSufficient: true,
      projectionFailure: null,
    };
    const second: Cond1SealedAnswer = {
      findingAlias: "second",
      extractor: "E1",
      extractorVersion: EXTRACTOR_VERSIONS.E1,
      sourceFindingId: "c",
      corpusPrKey: "a\u0000b",
      evidenceSufficient: true,
      projectionFailure: null,
    };

    expect(canonicalAnswerKeySha256([first, second])).toBe(
      canonicalAnswerKeySha256([second, first]),
    );
    const input = inputFor();
    input.answers = [
      { ...first, findingAlias: "first" },
      { ...second, findingAlias: "second" },
      ...input.answers.slice(2),
    ];
    input.manifest.answerCanonicalSha256 = canonicalAnswerKeySha256(input.answers);
    input.manifest.emittedFindingN.E1 = 20;
    input.corpusManifestFileSha256 = canonicalSha256(input.manifest);
    input.verdicts = verdictsFor(input.answers);
    expect(scoreCond1(input).extractors.E1.limitation).toBe("CURRENT_STATE_ONLY");
  });

  it("canonical answer ordering does not depend on localeCompare", () => {
    const key = answers({ E1: 2, E2: 2, E3: 2 }).map((answer, index) => ({
      ...answer,
      corpusPrKey: ["z", "ä", "A", "a", "é", "e"][index] as string,
    }));
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("locale-sensitive comparison invoked");
    });
    let digest: string;
    try {
      digest = canonicalAnswerKeySha256(key);
    } finally {
      localeCompare.mockRestore();
    }
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns only aggregate durable fields and approved identities", () => {
    const input = inputFor();
    const serialized = JSON.stringify(scoreCond1(input));

    expect(serialized).not.toContain("private-work-item");
    expect(serialized).not.toContain("private-pr-");
    expect(serialized).not.toContain("reviewer-a");
    expect(serialized).not.toContain("alias-");
    expect(JSON.parse(serialized).durablePrivacy).toEqual({
      rawEvidenceN: 0,
      evidenceRefN: 0,
      pathN: 0,
      tokenN: 0,
    });
  });
});
