import { createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { publishApprovedOutput } from "../common/approved-input.js";
import { canonicalJson, sha256Bytes, sha256Canonical } from "../common/canonical.js";
import { redactEvidenceExcerpt } from "../common/redaction.js";
import { type R3EvaluateRequest, type R3PrivateCandidate, evaluateR3Private } from "./evaluate.js";
import {
  type R3BlindedPacket,
  type R3SealedKey,
  type R3SealedKeyEntry,
  R3_PACKET_VERSION,
  R3_SCORER_VERSION,
} from "./types.js";

const SHA256_RE = /^[0-9a-f]{64}$/u;

export interface R3PacketRequest extends Omit<R3EvaluateRequest, "out"> {
  aggregatePath: string;
  aggregateSha256: string;
  packetOut: string;
  keyOut: string;
}

export interface R3PacketDependencies {
  randomSeed?: () => Buffer;
  intentExcerpt?: (candidate: R3PrivateCandidate) => unknown;
}

function refuse(code: string): never {
  throw new Error(code);
}

function retainedFailure(error: unknown, artifacts: readonly string[]): Error {
  const message =
    error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)
      ? error.message
      : "r3_packet_failure";
  return new Error(`${message}_${artifacts.join("_and_")}_retained`);
}

function directFile(state: string, value: string): string {
  const statePath = fs.realpathSync.native(state);
  const filePath = fs.realpathSync.native(value);
  if (path.dirname(filePath) !== statePath) refuse("r3_aggregate_path_invalid");
  return filePath;
}

function rank(seed: Buffer, domain: string, value: string): string {
  return createHmac("sha256", seed).update(domain).update("\0").update(value).digest("hex");
}

function stableIdentity(candidate: R3PrivateCandidate): string {
  return `${candidate.repoAlias}\0${candidate.sessionId}\0${candidate.candidateWorkItemId ?? ""}`;
}

function backtestSample(
  candidates: readonly R3PrivateCandidate[],
  seed: Buffer,
): R3PrivateCandidate[] {
  const byAlias = new Map<string, R3PrivateCandidate[]>();
  for (const candidate of candidates) {
    const rows = byAlias.get(candidate.repoAlias) ?? [];
    rows.push(candidate);
    byAlias.set(candidate.repoAlias, rows);
  }
  for (const rows of byAlias.values()) {
    rows.sort((a, b) =>
      rank(seed, "backtest", stableIdentity(a)).localeCompare(
        rank(seed, "backtest", stableIdentity(b)),
      ),
    );
  }
  const result: R3PrivateCandidate[] = [];
  const aliases = [...byAlias.keys()].sort();
  for (let index = 0; result.length < 100; index += 1) {
    let added = false;
    for (const alias of aliases) {
      const row = byAlias.get(alias)?.[index];
      if (row !== undefined && result.length < 100) {
        result.push(row);
        added = true;
      }
    }
    if (!added) break;
  }
  return result;
}

function day(value: string | null): string {
  return value !== null && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString().slice(0, 10)
    : "UNKNOWN";
}

/** Build a mixed, blinded packet and a separately published private join key. */
export async function packetR3(
  request: R3PacketRequest,
  dependencies: R3PacketDependencies = {},
): Promise<{ packet: R3BlindedPacket; key: R3SealedKey }> {
  if (!SHA256_RE.test(request.aggregateSha256)) refuse("r3_aggregate_digest_invalid");
  const evaluated = await evaluateR3Private({ ...request, out: request.packetOut });
  const retainedArtifacts = ["scratch_verification"];
  try {
    const aggregateBytes = fs.readFileSync(
      directFile(evaluated.approved.scratchStatePath, request.aggregatePath),
    );
    if (sha256Bytes(aggregateBytes) !== request.aggregateSha256)
      refuse("r3_aggregate_digest_mismatch");
    let aggregate: unknown;
    try {
      aggregate = JSON.parse(aggregateBytes.toString("utf8")) as unknown;
    } catch {
      refuse("r3_aggregate_json_invalid");
    }
    if (canonicalJson(aggregate) !== canonicalJson(evaluated.report))
      refuse("r3_aggregate_content_mismatch");
    const seed = dependencies.randomSeed?.() ?? randomBytes(32);
    if (!Buffer.isBuffer(seed) || seed.length < 32) refuse("r3_random_seed_invalid");
    const commitment = sha256Bytes(seed);
    const campaignId = sha256Canonical({
      identity: evaluated.report.identity,
      aggregate: request.aggregateSha256,
    }).slice(0, 32);
    const uplift = evaluated.candidates.filter(
      (candidate) =>
        candidate.candidateReason === "UNIQUE_CANDIDATE" &&
        candidate.disposition !== "HIGHER_PRECEDENCE" &&
        candidate.candidateWorkItemId !== null,
    );
    const backtest = backtestSample(
      evaluated.candidates.filter(
        (candidate) =>
          candidate.candidateReason === "UNIQUE_CANDIDATE" &&
          candidate.disposition === "HIGHER_PRECEDENCE" &&
          candidate.candidateWorkItemId !== null,
      ),
      seed,
    );
    const selected = [
      ...uplift.map((candidate) => ({ candidate, cohort: "UPLIFT" as const })),
      ...backtest.map((candidate) => ({ candidate, cohort: "BACKTEST" as const })),
    ];
    selected.sort((a, b) =>
      rank(seed, "order", stableIdentity(a.candidate)).localeCompare(
        rank(seed, "order", stableIdentity(b.candidate)),
      ),
    );
    const keyEntries: R3SealedKeyEntry[] = [];
    const entries = selected.map(({ candidate, cohort }) => {
      const stable = stableIdentity(candidate);
      const candidateId = rank(seed, "candidate", stable).slice(0, 32);
      const proposedPrAlias = `pr-${rank(seed, "pr", candidate.candidateWorkItemId as string).slice(0, 16)}`;
      const rawExcerpt = dependencies.intentExcerpt?.(candidate);
      const redacted = rawExcerpt === undefined ? undefined : redactEvidenceExcerpt(rawExcerpt);
      const redactionFailed = rawExcerpt !== undefined && redacted === null;
      keyEntries.push({
        candidateId,
        sessionId: candidate.sessionId,
        candidateWorkItemId: candidate.candidateWorkItemId as string,
        repoAlias: candidate.repoAlias,
        cohort,
        backtestCorrect: candidate.backtestCorrect,
        redactionFailed,
      });
      return {
        candidateId,
        repoAlias: candidate.repoAlias,
        sessionWindow: {
          startedBucket: day(candidate.firstTurnAt),
          endedBucket: day(candidate.lastTurnAt),
        },
        proposedPrAlias,
        structuredEvidence: {
          sessionCommitSignalN: candidate.commitSignalN,
          prLifecycleOverlap: candidate.lifecycleOverlap,
          acceptedHigherPrecedenceSignal:
            candidate.excludedBy === null ? ("ABSENT" as const) : ("PRESENT" as const),
          ...(redacted === undefined || redacted === null
            ? {}
            : { redactedIntentExcerpt: redacted }),
        },
        question: "SAME_WORK_ITEM" as const,
      };
    });
    const packet: R3BlindedPacket = {
      campaignId,
      packetVersion: R3_PACKET_VERSION,
      randomizationSeedCommitment: commitment,
      aggregateSha256: request.aggregateSha256,
      entries,
    };
    const key: R3SealedKey = {
      campaignId,
      packetVersion: R3_PACKET_VERSION,
      scorerVersion: R3_SCORER_VERSION,
      randomizationSeed: seed.toString("hex"),
      randomizationSeedCommitment: commitment,
      aggregateSha256: request.aggregateSha256,
      entries: keyEntries,
    };
    publishApprovedOutput(evaluated.approved, request.packetOut, canonicalJson(packet));
    retainedArtifacts.push("packet");
    publishApprovedOutput(evaluated.approved, request.keyOut, canonicalJson(key));
    retainedArtifacts.push("sealed_key");
    return { packet, key };
  } catch (error) {
    throw retainedFailure(error, retainedArtifacts);
  }
}
