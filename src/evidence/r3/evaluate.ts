import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  type BranchShadowEvaluation,
  evaluateBranchLinksShadow,
  snapshotSessionWorkLinks,
} from "../../outcomes/linker.js";
import {
  type ApprovedEvidenceInput,
  type LoadedApprovedEvidenceInput,
  loadApprovedEvidenceInput,
  publishApprovedOutput,
} from "../common/approved-input.js";
import { canonicalJson, sha256Bytes, sha256Canonical } from "../common/canonical.js";
import { assertDatabaseIntegrity } from "../common/sqlite.js";
import { harvestFrozenTranscript } from "./transcript.js";
import type {
  R3AggregateCohort,
  R3AggregateReport,
  R3PrepareManifest,
  R3PrivateCorpus,
} from "./types.js";

const SHA256_RE = /^[0-9a-f]{64}$/u;
const EVALUATOR_MODULE_PATH = fileURLToPath(new URL("../../outcomes/linker.ts", import.meta.url));
const CANDIDATE_REASONS = [
  "NO_VALID_SESSION_KEY",
  "MULTIPLE_SESSION_KEYS",
  "NO_MATCHING_WORK_ITEM_KEY",
  "DUPLICATE_WORKSPACE_MATCH",
  "UNIQUE_CANDIDATE",
] as const;
const DISPOSITION_REASONS = [...CANDIDATE_REASONS, "HIGHER_PRECEDENCE"] as const;
const TRANSCRIPT_FAILURES = [
  "MISSING",
  "UNREADABLE",
  "REPLACED",
  "CHANGED",
  "LIMIT_EXCEEDED",
  "CORPUS_MISMATCH",
] as const;

export interface R3EvaluateRequest {
  approvedInput: ApprovedEvidenceInput;
  sealedDbPath: string;
  sealedDbSha256: string;
  manifestPath: string;
  manifestSha256: string;
  privateCorpusPath: string;
  privateCorpusSha256: string;
  out: string;
}

export interface R3PrivateCandidate extends BranchShadowEvaluation {
  repoAlias: string;
  firstTurnAt: string | null;
  lastTurnAt: string | null;
  commitSignalN: number;
  lifecycleOverlap: "YES" | "NO" | "UNKNOWN";
  backtestCorrect: boolean | null;
}

export interface R3PrivateEvaluation {
  report: R3AggregateReport;
  candidates: readonly R3PrivateCandidate[];
  approved: LoadedApprovedEvidenceInput;
}

function refuse(code: string): never {
  throw new Error(code);
}

function retainedFailure(error: unknown, artifacts: readonly string[]): Error {
  const message =
    error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)
      ? error.message
      : "r3_evaluate_failure";
  return new Error(`${message}_${artifacts.join("_and_")}_retained`);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    refuse(code);
  }
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(code);
  return value as Record<string, unknown>;
}

function directStateFile(state: string, file: string, code: string): string {
  const stateReal = fs.realpathSync.native(state);
  const fileReal = fs.realpathSync.native(file);
  if (path.dirname(fileReal) !== stateReal) refuse(code);
  return fileReal;
}

function readBoundJson(state: string, file: string, digest: string, code: string): unknown {
  if (!SHA256_RE.test(digest)) refuse(`${code}_digest_invalid`);
  const bytes = fs.readFileSync(directStateFile(state, file, `${code}_path_invalid`));
  if (sha256Bytes(bytes) !== digest) refuse(`${code}_digest_mismatch`);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    refuse(`${code}_json_invalid`);
  }
}

function parseManifest(value: unknown): R3PrepareManifest {
  const parsed = record(value, "r3_manifest_invalid");
  exactKeys(
    parsed,
    ["campaign", "status", "identity", "backfill", "corpus", "privacy"],
    "r3_manifest_keys_invalid",
  );
  if (parsed.campaign !== "R3_U4_BRANCH_LINKAGE") refuse("r3_manifest_campaign_invalid");
  const identity = record(parsed.identity, "r3_manifest_identity_invalid");
  exactKeys(
    identity,
    [
      "sourceCommit",
      "runnerVersion",
      "evaluatorModuleSha256",
      "normalizationVersion",
      "schemaVersion",
      "reasonVocabularyVersion",
      "approvedInputDbSha256",
      "sealedHydratedDbSha256",
      "repoMapSha256",
      "privateCorpusSha256",
      "linkSnapshotSha256",
      "asOf",
    ],
    "r3_manifest_identity_keys_invalid",
  );
  for (const key of [
    "evaluatorModuleSha256",
    "approvedInputDbSha256",
    "sealedHydratedDbSha256",
    "repoMapSha256",
    "privateCorpusSha256",
    "linkSnapshotSha256",
  ] as const) {
    if (typeof identity[key] !== "string" || !SHA256_RE.test(identity[key]))
      refuse("r3_manifest_identity_digest_invalid");
  }
  if (
    typeof identity.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(identity.sourceCommit) ||
    identity.runnerVersion !== "r3-u4-runner-v1" ||
    identity.normalizationVersion !== "branch-v1" ||
    identity.schemaVersion !== 7 ||
    identity.reasonVocabularyVersion !== "r3-shadow-reasons-v1" ||
    typeof identity.asOf !== "string" ||
    !Number.isFinite(Date.parse(identity.asOf))
  )
    refuse("r3_manifest_identity_version_invalid");
  if (parsed.status !== "PREPARED" && parsed.status !== "DATA_INSUFFICIENT") {
    refuse("r3_manifest_status_invalid");
  }
  const backfill = record(parsed.backfill, "r3_manifest_backfill_invalid");
  exactKeys(
    backfill,
    ["completed", "selectedN", "keyedN", "ineligibleN", "failedN", "missingN", "failureReasonN"],
    "r3_manifest_backfill_keys_invalid",
  );
  if (typeof backfill.completed !== "boolean") refuse("r3_manifest_backfill_value_invalid");
  for (const key of ["selectedN", "keyedN", "ineligibleN", "failedN", "missingN"] as const) {
    if (
      typeof backfill[key] !== "number" ||
      !Number.isSafeInteger(backfill[key]) ||
      backfill[key] < 0
    )
      refuse("r3_manifest_backfill_value_invalid");
  }
  const reasons = record(backfill.failureReasonN, "r3_manifest_backfill_reasons_invalid");
  for (const count of Object.values(reasons)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      refuse("r3_manifest_backfill_reasons_invalid");
  }
  const corpus = record(parsed.corpus, "r3_manifest_corpus_invalid");
  exactKeys(corpus, ["outcomeBearingSessionsN"], "r3_manifest_corpus_keys_invalid");
  if (
    typeof corpus.outcomeBearingSessionsN !== "number" ||
    !Number.isSafeInteger(corpus.outcomeBearingSessionsN) ||
    corpus.outcomeBearingSessionsN < 0
  )
    refuse("r3_manifest_corpus_value_invalid");
  const privacy = record(parsed.privacy, "r3_manifest_privacy_invalid");
  exactKeys(privacy, ["rawRefN", "transcriptPathN", "tokenN"], "r3_manifest_privacy_keys_invalid");
  if (privacy.rawRefN !== 0 || privacy.transcriptPathN !== 0 || privacy.tokenN !== 0)
    refuse("r3_manifest_privacy_value_invalid");
  return value as R3PrepareManifest;
}

function parseCorpus(value: unknown): R3PrivateCorpus {
  const parsed = record(value, "r3_corpus_invalid");
  exactKeys(parsed, ["version", "entries"], "r3_corpus_keys_invalid");
  if (parsed.version !== "r3-u4-private-corpus-v1" || !Array.isArray(parsed.entries)) {
    refuse("r3_corpus_version_invalid");
  }
  const sessions = new Set<string>();
  for (const raw of parsed.entries) {
    const entry = record(raw, "r3_corpus_entry_invalid");
    exactKeys(entry, ["sessionId", "path", "identity", "sha256"], "r3_corpus_entry_keys_invalid");
    const identity = record(entry.identity, "r3_corpus_identity_invalid");
    exactKeys(identity, ["device", "inode", "size"], "r3_corpus_identity_keys_invalid");
    if (
      typeof entry.sessionId !== "string" ||
      entry.sessionId.length === 0 ||
      sessions.has(entry.sessionId) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      typeof entry.sha256 !== "string" ||
      !SHA256_RE.test(entry.sha256) ||
      typeof identity.device !== "string" ||
      typeof identity.inode !== "string" ||
      typeof identity.size !== "string"
    )
      refuse("r3_corpus_entry_value_invalid");
    sessions.add(entry.sessionId);
  }
  return value as R3PrivateCorpus;
}

function openBoundDb(state: string, file: string, digest: string): Database.Database {
  if (!SHA256_RE.test(digest)) refuse("r3_sealed_db_digest_invalid");
  const bytes = fs.readFileSync(directStateFile(state, file, "r3_sealed_db_path_invalid"));
  if (sha256Bytes(bytes) !== digest) refuse("r3_sealed_db_digest_mismatch");
  const db = new Database(bytes);
  try {
    db.pragma("query_only = ON");
    assertDatabaseIntegrity(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function zero<T extends string>(values: readonly T[]): Record<T, number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

function emptyCohort(repoAlias: string): R3AggregateCohort {
  return {
    repoAlias,
    outcomeBearingSessionsN: 0,
    baselineLinkedOutcomeBearingN: 0,
    candidateReasonN: zero(CANDIDATE_REASONS),
    dispositionReasonN: zero(DISPOSITION_REASONS),
    requiredAdjudicationN: 0,
    adjudicatedN: 0,
    correctN: 0,
    incorrectN: 0,
    uncertainN: 0,
  };
}

function assertEvaluationWorkspaceScope(
  db: Database.Database,
  repositories: readonly { workspaceId: string }[],
): void {
  const approved = new Set(repositories.map((repository) => repository.workspaceId));
  const rows = db
    .prepare(
      `SELECT DISTINCT s.workspace_id
         FROM sessions s
        WHERE s.state='RECONCILED'
          AND EXISTS (SELECT 1 FROM tool_events te
                       WHERE te.session_id=s.session_id AND te.tool_name='Bash')
          -- R3 corpus: evidence-bearing workspaces only (see plan §5G). The evaluation
          -- workspace-scope check must mirror the corpus predicate, else evidence-free
          -- (unmappable) workspaces trip the allowlist. Keep byte-identical across all six sites.
          AND EXISTS (SELECT 1 FROM work_items wi WHERE wi.workspace_id = s.workspace_id)
        ORDER BY s.workspace_id COLLATE BINARY`,
    )
    .all() as Array<{ workspace_id: unknown }>;
  for (const row of rows) {
    if (typeof row.workspace_id !== "string" || !approved.has(row.workspace_id)) {
      refuse("r3_evaluation_workspace_not_allowlisted");
    }
  }
}

function utcDay(value: string | null): string | null {
  if (value === null || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString().slice(0, 10);
}

async function runOnce(
  db: Database.Database,
  corpus: R3PrivateCorpus,
  repositories: readonly { workspaceId: string; reportAlias: string }[],
): Promise<{
  digest: string;
  candidates: R3PrivateCandidate[];
  aggregate: Omit<
    R3AggregateReport,
    "campaign" | "deterministicRerun" | "identity" | "backfill" | "status"
  >;
}> {
  assertEvaluationWorkspaceScope(db, repositories);
  const before = snapshotSessionWorkLinks(db);
  const bySession = new Map(corpus.entries.map((entry) => [entry.sessionId, entry]));
  const shadow = await evaluateBranchLinksShadow(db, "shadow", {
    transcriptEvidence: {
      entryForSession: (sessionId) => bySession.get(sessionId),
      harvest: harvestFrozenTranscript,
    },
  });
  const after = snapshotSessionWorkLinks(db);
  const linkTableUnchanged = before === after;
  const aliases = new Map(repositories.map((repo) => [repo.workspaceId, repo.reportAlias]));
  const sessionRows = db
    .prepare(
      `SELECT s.session_id, s.workspace_id, s.first_turn_at, s.last_turn_at,
            (SELECT COUNT(*) FROM tool_events te WHERE te.session_id=s.session_id AND te.commit_sha IS NOT NULL) commit_n
       FROM sessions s WHERE s.state='RECONCILED'
         AND EXISTS (SELECT 1 FROM tool_events te WHERE te.session_id=s.session_id AND te.tool_name='Bash')
         -- R3 corpus: evidence-bearing workspaces only (see plan §5G). Keep byte-aligned with prepare.ts.
          AND EXISTS (SELECT 1 FROM work_items wi WHERE wi.workspace_id = s.workspace_id)`,
    )
    .all() as Array<{
    session_id: string;
    workspace_id: string;
    first_turn_at: string | null;
    last_turn_at: string | null;
    commit_n: number;
  }>;
  const sessions = new Map(sessionRows.map((row) => [row.session_id, row]));
  const accepted = db.prepare(
    "SELECT work_item_id FROM session_work_links WHERE session_id=? AND method IN ('MANUAL','PR_LINK','SHA_OVERLAP')",
  );
  const lifecycle = db.prepare(
    "SELECT opened_at, COALESCE(merged_at, closed_at) ended_at FROM work_items WHERE work_item_id=?",
  );
  const candidates: R3PrivateCandidate[] = shadow.evaluations.map((evaluation) => {
    const session = sessions.get(evaluation.sessionId);
    if (session === undefined) refuse("r3_shadow_unknown_session");
    const repoAlias = aliases.get(session.workspace_id);
    if (repoAlias === undefined) refuse("r3_shadow_workspace_not_allowlisted");
    const acceptedIds = (accepted.all(evaluation.sessionId) as Array<{ work_item_id: string }>).map(
      (row) => row.work_item_id,
    );
    const dates =
      evaluation.candidateWorkItemId === null
        ? undefined
        : (lifecycle.get(evaluation.candidateWorkItemId) as
            | { opened_at: string | null; ended_at: string | null }
            | undefined);
    const startDay = utcDay(session.first_turn_at);
    const endDay = utcDay(session.last_turn_at);
    const openedDay = utcDay(dates?.opened_at ?? null);
    const closedDay = utcDay(dates?.ended_at ?? null);
    const lifecycleOverlap =
      startDay === null || endDay === null || openedDay === null
        ? ("UNKNOWN" as const)
        : endDay < openedDay || (closedDay !== null && startDay > closedDay)
          ? ("NO" as const)
          : ("YES" as const);
    return {
      ...evaluation,
      repoAlias,
      firstTurnAt: session.first_turn_at,
      lastTurnAt: session.last_turn_at,
      commitSignalN: session.commit_n,
      lifecycleOverlap,
      backtestCorrect:
        evaluation.excludedBy === null || evaluation.candidateWorkItemId === null
          ? null
          : acceptedIds.includes(evaluation.candidateWorkItemId),
    };
  });

  const cohortMap = new Map(
    repositories.map((repo) => [repo.reportAlias, emptyCohort(repo.reportAlias)]),
  );
  const baselineLinked = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT s.session_id FROM sessions s JOIN session_work_links l ON l.session_id=s.session_id
      WHERE s.state='RECONCILED' AND EXISTS (SELECT 1 FROM tool_events te WHERE te.session_id=s.session_id AND te.tool_name='Bash')
      -- Keep the numerator aligned with the section 5G narrowed corpus: the numerator must be a subset of the denominator.
      AND EXISTS (SELECT 1 FROM work_items wi WHERE wi.workspace_id = s.workspace_id)`,
        )
        .all() as Array<{ session_id: string }>
    ).map((row) => row.session_id),
  );
  for (const candidate of candidates) {
    const cohort = cohortMap.get(candidate.repoAlias);
    if (cohort === undefined) refuse("r3_cohort_missing");
    cohort.outcomeBearingSessionsN += 1;
    if (baselineLinked.has(candidate.sessionId)) cohort.baselineLinkedOutcomeBearingN += 1;
    cohort.candidateReasonN[candidate.candidateReason] += 1;
    cohort.dispositionReasonN[candidate.disposition] += 1;
    if (
      candidate.candidateReason === "UNIQUE_CANDIDATE" &&
      candidate.disposition !== "HIGHER_PRECEDENCE"
    )
      cohort.requiredAdjudicationN += 1;
  }
  const uniqueUplift = candidates.filter(
    (item) =>
      item.candidateReason === "UNIQUE_CANDIDATE" && item.disposition !== "HIGHER_PRECEDENCE",
  );
  const backtest = candidates.filter(
    (item) =>
      item.candidateReason === "UNIQUE_CANDIDATE" && item.disposition === "HIGHER_PRECEDENCE",
  );
  const allSessionsN = (db.prepare("SELECT COUNT(*) n FROM sessions").get() as { n: number }).n;
  const reconciledN = (
    db.prepare("SELECT COUNT(*) n FROM sessions WHERE state='RECONCILED'").get() as { n: number }
  ).n;
  // reconciled + Bash, BEFORE the evidence-bearing (work_items) filter — lets us report the
  // no-Bash and no-work_items exclusions separately instead of lumping them (see plan §5G).
  const reconciledBashN = (
    db
      .prepare(
        `SELECT COUNT(*) n FROM sessions s
          WHERE s.state='RECONCILED'
            AND EXISTS (SELECT 1 FROM tool_events te
                        WHERE te.session_id=s.session_id AND te.tool_name='Bash')`,
      )
      .get() as { n: number }
  ).n;
  const aggregate = {
    denominator: {
      reconciledSessionsN: reconciledN,
      outcomeBearingSessionsN: candidates.length,
      baselineLinkedOutcomeBearingN: baselineLinked.size,
      excludedNotReconciledN: allSessionsN - reconciledN,
      excludedNoBashN: reconciledN - reconciledBashN,
      excludedNoWorkItemsN: reconciledBashN - candidates.length,
    },
    shadow: {
      candidateReasonN: shadow.candidateReasonCounts,
      dispositionReasonN: shadow.dispositionCounts,
      uniqueUpliftCandidatesN: uniqueUplift.length,
      higherPrecedenceCandidatesN: backtest.length,
      backtestEligibleN: backtest.length,
      backtestAgreementN: backtest.filter((item) => item.backtestCorrect === true).length,
      backtestDisagreementN: backtest.filter((item) => item.backtestCorrect === false).length,
      transcriptSucceededN: shadow.strictTranscript?.succeeded ?? 0,
      transcriptFailureReasonN:
        shadow.strictTranscript?.failureReasonCounts ?? zero(TRANSCRIPT_FAILURES),
    },
    adjudication: {
      requiredN: uniqueUplift.length,
      adjudicatedN: 0,
      correctN: 0,
      incorrectN: 0,
      uncertainN: 0,
      precisionNumerator: 0,
      precisionDenominator: 0,
    },
    projected: {
      correctUniqueUpliftN: 0,
      linkedNumerator: baselineLinked.size,
      outcomeBearingDenominator: candidates.length,
      coverage: null,
      precision: null,
    },
    byRepoAlias: [...cohortMap.values()].sort((a, b) =>
      a.repoAlias < b.repoAlias ? -1 : a.repoAlias > b.repoAlias ? 1 : 0,
    ),
    privacy: {
      linkTableUnchanged,
      rawRefN: 0 as const,
      transcriptPathN: 0 as const,
      tokenN: 0 as const,
    },
  };
  return { digest: sha256Canonical(aggregate), candidates, aggregate };
}

export async function evaluateR3Private(request: R3EvaluateRequest): Promise<R3PrivateEvaluation> {
  const approved = await loadApprovedEvidenceInput(request.approvedInput);
  try {
    const manifest = parseManifest(
      readBoundJson(
        approved.scratchStatePath,
        request.manifestPath,
        request.manifestSha256,
        "r3_manifest",
      ),
    );
    const corpus = parseCorpus(
      readBoundJson(
        approved.scratchStatePath,
        request.privateCorpusPath,
        request.privateCorpusSha256,
        "r3_corpus",
      ),
    );
    if (
      manifest.identity.approvedInputDbSha256 !== approved.scratchDbSha256 ||
      manifest.identity.repoMapSha256 !== approved.repoMapSha256 ||
      manifest.identity.sealedHydratedDbSha256 !== request.sealedDbSha256 ||
      manifest.identity.privateCorpusSha256 !== request.privateCorpusSha256 ||
      manifest.corpus.outcomeBearingSessionsN !== corpus.entries.length
    )
      refuse("r3_evaluation_binding_mismatch");
    if (
      sha256Bytes(fs.readFileSync(EVALUATOR_MODULE_PATH)) !==
      manifest.identity.evaluatorModuleSha256
    )
      refuse("r3_evaluator_module_digest_changed");
    const db = openBoundDb(approved.scratchStatePath, request.sealedDbPath, request.sealedDbSha256);
    try {
      const first = await runOnce(db, corpus, approved.repositories);
      const second = await runOnce(db, corpus, approved.repositories);
      const transcriptFailedN = Object.values(
        first.aggregate.shadow.transcriptFailureReasonN,
      ).reduce((a, b) => a + b, 0);
      const equal = first.digest === second.digest;
      const sufficient =
        manifest.status === "PREPARED" &&
        manifest.backfill.completed &&
        manifest.backfill.failedN === 0 &&
        transcriptFailedN === 0 &&
        first.aggregate.privacy.linkTableUnchanged &&
        second.aggregate.privacy.linkTableUnchanged &&
        equal;
      const report: R3AggregateReport = {
        campaign: "R3_U4_BRANCH_LINKAGE",
        status: sufficient ? "PREPARED" : "DATA_INSUFFICIENT",
        identity: { ...manifest.identity, prepareManifestSha256: request.manifestSha256 },
        backfill: manifest.backfill,
        ...first.aggregate,
        deterministicRerun: {
          firstCanonicalSha256: first.digest,
          secondCanonicalSha256: second.digest,
          equal,
        },
      };
      return { report, candidates: first.candidates, approved };
    } finally {
      db.close();
    }
  } catch (error) {
    throw retainedFailure(error, ["scratch_verification"]);
  }
}

export async function evaluateR3(request: R3EvaluateRequest): Promise<R3AggregateReport> {
  const result = await evaluateR3Private(request);
  try {
    publishApprovedOutput(result.approved, request.out, canonicalJson(result.report));
  } catch (error) {
    throw retainedFailure(error, ["scratch_verification"]);
  }
  return result.report;
}
