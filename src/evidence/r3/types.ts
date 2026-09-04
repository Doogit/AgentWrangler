import type { BranchCandidateReason, BranchDispositionReason } from "../../outcomes/linker.js";
import type { FileIdentity } from "../common/boundary.js";
import type { FrozenTranscriptEntry, TranscriptReadFailureReason } from "./transcript.js";

export const R3_RUNNER_VERSION = "r3-u4-runner-v1" as const;
export const R3_PACKET_VERSION = "r3-u4-blinded-v1" as const;
export const R3_SCORER_VERSION = "r3-u4-score-v1" as const;
export const R3_REASON_VOCABULARY_VERSION = "r3-shadow-reasons-v1" as const;

export interface FrozenR3Identity {
  sourceCommit: string;
  runnerVersion: typeof R3_RUNNER_VERSION;
  evaluatorModuleSha256: string;
  normalizationVersion: "branch-v1";
  schemaVersion: 7;
  reasonVocabularyVersion: typeof R3_REASON_VOCABULARY_VERSION;
}

export interface R3BackfillAggregate {
  completed: boolean;
  selectedN: number;
  keyedN: number;
  ineligibleN: number;
  failedN: number;
  missingN: number;
  failureReasonN: Record<string, number>;
}

export interface R3PrepareManifest {
  campaign: "R3_U4_BRANCH_LINKAGE";
  status: "PREPARED" | "DATA_INSUFFICIENT";
  identity: FrozenR3Identity & {
    approvedInputDbSha256: string;
    sealedHydratedDbSha256: string;
    repoMapSha256: string;
    privateCorpusSha256: string;
    linkSnapshotSha256: string;
    asOf: string;
  };
  backfill: R3BackfillAggregate;
  corpus: {
    outcomeBearingSessionsN: number;
  };
  privacy: {
    rawRefN: 0;
    transcriptPathN: 0;
    tokenN: 0;
  };
}

export interface R3PrivateCorpus {
  version: "r3-u4-private-corpus-v1";
  entries: readonly FrozenTranscriptEntry[];
}

export interface R3AggregateCohort {
  repoAlias: string;
  outcomeBearingSessionsN: number;
  baselineLinkedOutcomeBearingN: number;
  candidateReasonN: Record<BranchCandidateReason, number>;
  dispositionReasonN: Record<BranchDispositionReason, number>;
  requiredAdjudicationN: number;
  adjudicatedN: number;
  correctN: number;
  incorrectN: number;
  uncertainN: number;
}

export interface R3AggregateReport {
  campaign: "R3_U4_BRANCH_LINKAGE";
  status: "DATA_INSUFFICIENT" | "PREPARED";
  identity: R3PrepareManifest["identity"] & {
    prepareManifestSha256: string;
  };
  backfill: R3BackfillAggregate;
  denominator: {
    reconciledSessionsN: number;
    outcomeBearingSessionsN: number;
    baselineLinkedOutcomeBearingN: number;
    excludedNotReconciledN: number;
    excludedNoBashN: number;
    excludedNoWorkItemsN: number;
  };
  shadow: {
    candidateReasonN: Record<BranchCandidateReason, number>;
    dispositionReasonN: Record<BranchDispositionReason, number>;
    uniqueUpliftCandidatesN: number;
    higherPrecedenceCandidatesN: number;
    backtestEligibleN: number;
    backtestAgreementN: number;
    backtestDisagreementN: number;
    transcriptSucceededN: number;
    transcriptFailureReasonN: Record<TranscriptReadFailureReason, number>;
  };
  adjudication: {
    requiredN: number;
    adjudicatedN: number;
    correctN: number;
    incorrectN: number;
    uncertainN: number;
    precisionNumerator: number;
    precisionDenominator: number;
  };
  projected: {
    correctUniqueUpliftN: number;
    linkedNumerator: number;
    outcomeBearingDenominator: number;
    coverage: number | null;
    precision: number | null;
  };
  byRepoAlias: readonly R3AggregateCohort[];
  deterministicRerun: {
    firstCanonicalSha256: string;
    secondCanonicalSha256: string;
    equal: boolean;
  };
  privacy: {
    linkTableUnchanged: boolean;
    rawRefN: 0;
    transcriptPathN: 0;
    tokenN: 0;
  };
}

export interface R3PacketEntry {
  candidateId: string;
  repoAlias: string;
  sessionWindow: { startedBucket: string; endedBucket: string };
  proposedPrAlias: string;
  structuredEvidence: {
    sessionCommitSignalN: number;
    prLifecycleOverlap: "YES" | "NO" | "UNKNOWN";
    acceptedHigherPrecedenceSignal: "PRESENT" | "ABSENT";
    redactedIntentExcerpt?: string;
  };
  question: "SAME_WORK_ITEM";
}

export interface R3BlindedPacket {
  campaignId: string;
  packetVersion: typeof R3_PACKET_VERSION;
  randomizationSeedCommitment: string;
  aggregateSha256: string;
  entries: readonly R3PacketEntry[];
}

export interface R3SealedKeyEntry {
  candidateId: string;
  sessionId: string;
  candidateWorkItemId: string;
  repoAlias: string;
  cohort: "UPLIFT" | "BACKTEST";
  backtestCorrect: boolean | null;
  redactionFailed: boolean;
}

export interface R3SealedKey {
  campaignId: string;
  packetVersion: typeof R3_PACKET_VERSION;
  scorerVersion: typeof R3_SCORER_VERSION;
  randomizationSeed: string;
  randomizationSeedCommitment: string;
  aggregateSha256: string;
  entries: readonly R3SealedKeyEntry[];
}

export interface R3HumanVerdict {
  candidateId: string;
  verdict: "CORRECT" | "INCORRECT" | "UNCERTAIN";
  adjudicatorAlias: string;
  reasonCode: "TIMELINE" | "COMMIT_SIGNAL" | "KNOWN_WORK_ITEM" | "CONFLICT" | "INSUFFICIENT";
}

export interface R3ScoredReport extends Omit<R3AggregateReport, "status"> {
  status: "PASS" | "FAIL" | "DATA_INSUFFICIENT";
}

export interface PublishedR3Artifact {
  sha256: string;
  identity: FileIdentity;
}
