import type { EXTRACTOR_VERSIONS } from "../../outcomes/finding-extractors.js";

export type ExtractorId = "E1" | "E2" | "E3";
export type ExtractorVersionMap = typeof EXTRACTOR_VERSIONS;

export type Cond1Status = "PASS" | "FAIL" | "DATA_INSUFFICIENT";
export type Cond1Limitation =
  | "NONE"
  | "ZERO_EMISSIONS"
  | "INCOMPLETE_READS"
  | "INCOMPLETE_ADJUDICATION"
  | "UNCERTAIN_VERDICTS"
  | "SPARSE_LT_20"
  | "CURRENT_STATE_ONLY"
  | "IDENTITY_MISMATCH";

export interface FrozenCond1Identity {
  sourceCommit: string;
  runnerVersion: string;
  findingsModuleSha256: string;
  extractorVersions: ExtractorVersionMap;
  packetVersion: "cond1-blinded-v1";
  scorerVersion: "cond1-precision-v1";
  asOf: string;
}

export interface Cond1ReadCompletion {
  requiredN: number;
  succeededN: number;
  failedN: number;
}

export interface Cond1CorpusManifest {
  version: "cond1-corpus-manifest-v1";
  campaignId: string;
  identity: FrozenCond1Identity;
  scratchDbSha256: string;
  repoMapSha256: string;
  eligiblePrN: number;
  readCompletion: Record<ExtractorId, Cond1ReadCompletion>;
  /** Exact cross-extractor read intersection, bound by the manifest digest. */
  corpusReadSummary: Cond1CorpusReadSummary;
  emittedFindingN: Record<ExtractorId, number>;
  preparedArtifactSha256: string;
  answerCanonicalSha256: string;
}

export type Cond1EvidenceKind = "REVIEW_THREAD_STATE" | "DEFERRAL_LIST_ITEM" | "ADDED_DIFF_MARKER";

export interface Cond1ProjectedEvidence {
  stateAtRelevantTime?: "RESOLVED" | "UNRESOLVED" | "UNKNOWN";
  temporalBasis?: "CURRENT_STATE_ONLY";
  boundedExcerpt?: string;
  locationAlias?: string;
}

export interface Cond1PreparedFinding {
  extractor: ExtractorId;
  extractorVersion: string;
  sourceFindingId: string;
  corpusPrKey: string;
  repoAlias: string;
  evidenceKind: Cond1EvidenceKind;
  evidence: Cond1ProjectedEvidence;
  evidenceSufficient: boolean;
  projectionFailure: "REDACTION_FAILED" | null;
}

export interface Cond1PreparedArtifact {
  version: "cond1-prepared-v1";
  campaignId: string;
  identity: FrozenCond1Identity;
  scratchDbSha256: string;
  repoMapSha256: string;
  eligiblePrN: number;
  findings: readonly Cond1PreparedFinding[];
}

export interface Cond1BlindedEntry {
  findingAlias: string;
  repoAlias: string;
  prAlias: string;
  evidenceKind: Cond1EvidenceKind;
  criterion: "DOES_THE_DISPLAYED_EVIDENCE_SUPPORT_THE_STATED_FINDING";
  evidence: Cond1ProjectedEvidence;
}

export interface Cond1BlindedPacket {
  campaignId: string;
  packetVersion: "cond1-blinded-v1";
  randomizationSeedCommitment: string;
  entries: readonly Cond1BlindedEntry[];
}

export interface Cond1SealedKey {
  version: "cond1-sealed-key-v1";
  campaignId: string;
  randomizationSeed: string;
  answerCanonicalSha256: string;
  answers: readonly Cond1SealedAnswer[];
}

export interface Cond1SealedAnswer {
  findingAlias: string;
  extractor: ExtractorId;
  extractorVersion: string;
  sourceFindingId: string;
  corpusPrKey: string;
  evidenceSufficient: boolean;
  projectionFailure: "REDACTION_FAILED" | null;
}

export type Cond1Verdict = "TRUE_POSITIVE" | "FALSE_POSITIVE" | "UNCERTAIN";
export type Cond1ReasonCode =
  | "EVIDENCE_SUPPORTS"
  | "CONTEXT_NEGATES"
  | "NOT_A_DEFERRAL"
  | "NOT_AN_ADDED_MARKER"
  | "WRONG_THREAD_STATE"
  | "INSUFFICIENT_EVIDENCE";

export interface Cond1HumanVerdict {
  findingAlias: string;
  verdict: Cond1Verdict;
  adjudicatorAlias: string;
  reasonCode: Cond1ReasonCode;
}

export interface ExtractorPrecisionScore {
  extractor: ExtractorId;
  corpusPrN: number;
  emittedN: number;
  requiredAdjudicationN: number;
  adjudicatedN: number;
  truePositiveN: number;
  falsePositiveN: number;
  uncertainN: number;
  unadjudicatedN: number;
  precisionNumerator: number;
  precisionDenominator: number;
  precision: number | null;
  threshold: 0.8;
  sparse: boolean;
  status: Cond1Status;
  limitation: Cond1Limitation;
}

export interface Cond1AggregateScore {
  campaign: "COND1_FINDINGS_PRECISION";
  identity: FrozenCond1Identity & {
    scratchDbSha256: string;
    repoMapSha256: string;
    corpusManifestSha256: string;
    answerKeyCanonicalSha256: string;
  };
  corpus: {
    eligiblePrN: number;
    fullyReadPrN: number;
    failedPrN: number;
  };
  extractors: Record<ExtractorId, ExtractorPrecisionScore>;
  overallStatus: Cond1Status;
  durablePrivacy: {
    rawEvidenceN: 0;
    evidenceRefN: 0;
    pathN: 0;
    tokenN: 0;
  };
}

export interface Cond1CorpusReadSummary {
  fullyReadPrN: number;
  failedPrN: number;
}

export interface ScoreCond1Input {
  manifest: Cond1CorpusManifest;
  corpusManifestFileSha256: string;
  answers: readonly Cond1SealedAnswer[];
  verdicts: readonly Cond1HumanVerdict[];
}
