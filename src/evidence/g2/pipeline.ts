import type { Db } from "../../db/open.js";
import type { JudgeClient } from "../../oauth/judge-g2-client.js";
import { scoreCond1 } from "../cond1/score.js";
import type {
  Cond1AggregateScore,
  Cond1CorpusManifest,
  Cond1HumanVerdict,
  Cond1SealedKey,
  ScoreCond1Input,
} from "../cond1/types.js";
import { type G2PacketEntry, adjudicatePacket as adjudicate } from "./adjudicate.js";
import { G2_KAPPA_GATE, G2_MIN_SEED_N, type JudgeLabel, cohenKappa } from "./kappa.js";
import { persistJudgeVerdicts } from "./store.js";

export interface G2SeedLabel {
  findingAlias: string;
  label: JudgeLabel;
}

export interface G2JudgePipelineInput {
  db: Db;
  judge: JudgeClient;
  packetEntries: readonly G2PacketEntry[];
  seed: readonly G2SeedLabel[];
  key: Cond1SealedKey;
  manifest: Cond1CorpusManifest;
  corpusManifestFileSha256: string;
}

export interface G2JudgePipelineDeps {
  scorer?: (input: ScoreCond1Input) => Cond1AggregateScore;
  // Minimum seed size to accept for calibration; overridable in tests. Defaults
  // to G2_MIN_SEED_N.
  minSeedN?: number;
}

export type G2JudgePipelineResult =
  | { status: "JUDGE_ERROR"; reason: string; findingAlias: string }
  | { status: "INVALID_SEED"; reason: string; seedN: number; matchedN: number; minSeedN: number }
  | {
      status: "BLOCKED_LOW_KAPPA";
      kappa: number;
      rawAgreement: number;
      seedN: number;
      gate: number;
    }
  | {
      status: "SCORED";
      kappa: number;
      rawAgreement: number;
      seedN: number;
      labeledN: number;
      score: Cond1AggregateScore;
    };

export async function runG2JudgePipeline(
  input: G2JudgePipelineInput,
  deps: G2JudgePipelineDeps = {},
): Promise<G2JudgePipelineResult> {
  // Guard the calibration anchor BEFORE sending anything to the judge: refuse to
  // run on a degenerate seed. Every seed alias must be present in the packet (no
  // silent drop — a stale seed reused against a re-randomized packet would
  // otherwise "pass" on a tiny matched subset), and the seed must clear the
  // minimum-N floor. Checking up front means an invalid seed sends no evidence.
  const minSeedN = deps.minSeedN ?? G2_MIN_SEED_N;
  const packetAliases = new Set(input.packetEntries.map((entry) => entry.findingAlias));
  const matchedSeed = input.seed.filter((seed) => packetAliases.has(seed.findingAlias));
  if (matchedSeed.length !== input.seed.length || matchedSeed.length < minSeedN) {
    return {
      status: "INVALID_SEED",
      reason:
        matchedSeed.length !== input.seed.length
          ? "One or more seed aliases are not present in the packet (stale seed?)."
          : `Seed size ${matchedSeed.length} is below the minimum ${minSeedN} for calibration.`,
      seedN: input.seed.length,
      matchedN: matchedSeed.length,
      minSeedN,
    };
  }

  const adjudication = await adjudicate(input.packetEntries, input.judge);
  if (!adjudication.ok) {
    return {
      status: "JUDGE_ERROR",
      reason: adjudication.reason,
      findingAlias: adjudication.findingAlias,
    };
  }

  const verdictByAlias = new Map(adjudication.entries.map((entry) => [entry.findingAlias, entry]));
  const seedPairs = input.seed.flatMap((seed) => {
    const verdict = verdictByAlias.get(seed.findingAlias);
    return verdict === undefined ? [] : [[seed.label, verdict.verdict] as const];
  });

  const calibration = cohenKappa(
    seedPairs.map(([seedLabel]) => seedLabel),
    seedPairs.map(([, judgeLabel]) => judgeLabel),
  );

  if (calibration.kappa < G2_KAPPA_GATE) {
    return {
      status: "BLOCKED_LOW_KAPPA",
      kappa: calibration.kappa,
      rawAgreement: calibration.rawAgreement,
      seedN: calibration.n,
      gate: G2_KAPPA_GATE,
    };
  }

  const answerByAlias = new Map(input.key.answers.map((answer) => [answer.findingAlias, answer]));
  const labeledEntries = adjudication.entries.flatMap((entry) => {
    const answer = answerByAlias.get(entry.findingAlias);
    return answer === undefined ? [] : [[entry, answer] as const];
  });

  // Persist only findings the scorer counts (evidenceSufficient); redaction-failed
  // findings score as UNCERTAIN, so writing a confident human_state for them would
  // make the live DB disagree with the score.
  persistJudgeVerdicts(
    input.db,
    labeledEntries
      .filter(([, answer]) => answer.evidenceSufficient)
      .map(([entry, answer]) => ({
        findingId: answer.sourceFindingId,
        verdict: entry.verdict,
        confidence: entry.confidence,
      })),
  );

  const verdicts: Cond1HumanVerdict[] = labeledEntries.map(([entry, answer]) => ({
    findingAlias: entry.findingAlias,
    verdict: !answer.evidenceSufficient
      ? "UNCERTAIN"
      : entry.verdict === "CONFIRMED"
        ? "TRUE_POSITIVE"
        : "FALSE_POSITIVE",
    adjudicatorAlias: "g2-judge",
    reasonCode: !answer.evidenceSufficient
      ? "INSUFFICIENT_EVIDENCE"
      : entry.verdict === "CONFIRMED"
        ? "EVIDENCE_SUPPORTS"
        : "CONTEXT_NEGATES",
  }));
  const scorer = deps.scorer ?? scoreCond1;
  const score = scorer({
    manifest: input.manifest,
    corpusManifestFileSha256: input.corpusManifestFileSha256,
    answers: input.key.answers,
    verdicts,
  });

  return {
    status: "SCORED",
    kappa: calibration.kappa,
    rawAgreement: calibration.rawAgreement,
    seedN: calibration.n,
    labeledN: verdicts.length,
    score,
  };
}
