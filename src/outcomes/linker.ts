/**
 * src/outcomes/linker.ts — OutcomeLinker.
 *
 * Links sessions to work_items via ADR-103 D-7 precedence:
 *   1. PR_LINK  (conf 1.0) — in-memory re-harvested pr-link records
 *   2. SHA_OVERLAP (conf min(0.9, 0.5+0.1·|∩|)) — tool_events.commit_sha ∩ PR SHAs
 *      SHA in ≥2 PRs → UNLINKED (ambiguity → honesty)
 *   3. BRANCH (conf 0.6) — [UNMEASURED] coded-but-disabled stub (FLAG-D3)
 *   4. MANUAL (conf 1.0) — existing row from UI link/unlink
 *
 * UNLINKED is implicit (no row in session_work_links).
 *
 * pr-link re-harvest: reads transcript files in-memory for pr-link records.
 * Technique from spikes/s3-linkage/s3-harvest.mjs:68-75.
 * Only ids/PR numbers are retained — no content stored (SEC-101).
 */

import * as fs from "node:fs";
import * as readline from "node:readline";
import type { Db } from "../db/open.js";
import { awaitDbWriteGate } from "../db/write-gate.js";
import type {
  FrozenTranscriptEntry,
  StrictTranscriptHarvester,
  TranscriptReadFailureReason,
} from "../evidence/r3/transcript.js";
import { fingerprintBranchRef } from "./branch-key.js";
import type { GithubClient } from "./github/client.js";
import { type GhPRRead, PR_READ_BATCH, type PassPrPages } from "./github/pr-page.js";
import { type OutcomeStageSummary, newStageSummary, observeGithubClient } from "./stage-summary.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PrLinkRecord {
  prNumber: number;
  prRepository: string; // "owner/repo"
}

interface SessionPrLinks {
  session_id: string;
  file_path: string;
  links: PrLinkRecord[];
}

export type BranchLinkMode = "off" | "shadow";

export type BranchCandidateReason =
  | "NO_VALID_SESSION_KEY"
  | "MULTIPLE_SESSION_KEYS"
  | "NO_MATCHING_WORK_ITEM_KEY"
  | "DUPLICATE_WORKSPACE_MATCH"
  | "UNIQUE_CANDIDATE";

export type BranchHigherPrecedenceMethod = "MANUAL" | "PR_LINK" | "SHA_OVERLAP";
export type BranchDispositionReason = BranchCandidateReason | "HIGHER_PRECEDENCE";

export interface BranchShadowEvaluation {
  sessionId: string;
  candidateWorkItemId: string | null;
  candidateReason: BranchCandidateReason;
  disposition: BranchDispositionReason;
  excludedBy: BranchHigherPrecedenceMethod | null;
}

export interface BranchShadowReport {
  mode: BranchLinkMode;
  sessionsEvaluated: number;
  evaluations: BranchShadowEvaluation[];
  candidateReasonCounts: Record<BranchCandidateReason, number>;
  dispositionCounts: Record<BranchDispositionReason, number>;
  strictTranscript?: {
    succeeded: number;
    malformedLines: number;
    failureReasonCounts: Record<TranscriptReadFailureReason, number>;
  };
}

export interface BranchShadowOptions {
  transcriptEvidence?: {
    entryForSession: (sessionId: string) => FrozenTranscriptEntry | undefined;
    harvest: StrictTranscriptHarvester;
  };
}

interface HarvestedTranscript {
  links: PrLinkRecord[];
  branchKeys: Set<string>;
}

export function snapshotSessionWorkLinks(db: Db): string {
  const rows = db
    .prepare(
      `SELECT session_id, work_item_id, confidence, method
         FROM session_work_links
        ORDER BY session_id, work_item_id, confidence, method`,
    )
    .all() as Array<{
    session_id: string;
    work_item_id: string;
    confidence: number;
    method: string;
  }>;
  return JSON.stringify(
    rows.map(({ session_id, work_item_id, confidence, method }) => [
      session_id,
      work_item_id,
      confidence,
      method,
    ]),
  );
}

// ---------------------------------------------------------------------------
// Transcript pr-link harvester
// ---------------------------------------------------------------------------

/**
 * Re-harvest pr-link records from a transcript JSONL file in-memory.
 * Returns only ids/PR numbers — body content is discarded.
 */
async function harvestTranscript(
  filePath: string,
  collectBranchKeys: boolean,
): Promise<HarvestedTranscript> {
  const links: PrLinkRecord[] = [];
  const branchKeys = new Set<string>();
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const rec = JSON.parse(trimmed) as Record<string, unknown>;
        if (collectBranchKeys && branchKeys.size < 2) {
          const branchKey = fingerprintBranchRef(rec.gitBranch);
          if (branchKey !== null) branchKeys.add(branchKey);
        }
        if (rec.type === "pr-link") {
          const prNumber = rec.prNumber;
          const prRepository = rec.prRepository;
          if (typeof prNumber === "number" && typeof prRepository === "string") {
            links.push({ prNumber, prRepository });
          }
        }
      } catch {
        // Malformed line — skip
      }
    }
  } catch {
    // File unreadable — skip
  }
  return { links, branchKeys };
}

async function harvestPrLinks(filePath: string): Promise<PrLinkRecord[]> {
  return (await harvestTranscript(filePath, false)).links;
}

function resolvePrLinkMatches(db: Db, links: PrLinkRecord[]): string[] {
  const matches: string[] = [];
  for (const link of links) {
    const parts = link.prRepository.split("/");
    if (parts.length !== 2) continue;
    const [linkOwner, linkRepo] = parts as [string, string];

    const workItemId = `gh:${linkOwner}/${linkRepo}#${link.prNumber}`;
    const exists = db.prepare("SELECT 1 FROM work_items WHERE work_item_id = ?").get(workItemId);
    if (exists !== undefined) matches.push(workItemId);
  }
  return matches;
}

// ---------------------------------------------------------------------------
// SHA_OVERLAP linkage
// ---------------------------------------------------------------------------

function shaOverlapConfidence(overlap: number): number {
  return Math.min(0.9, 0.5 + 0.1 * overlap);
}

/** Cede the event loop after this many sessions in the linkSessions loop. */
const YIELD_EVERY = 16;

/** Maximum GitHub commit-to-PR reverse lookups in a single linker cycle. */
const REVERSE_LOOKUP_CAP = 50;

/**
 * P0-U13: a PR's commit SHAs + trailer ids, persisted per work item in
 * user_config (`gh_pr_reads:<work_item_id>`, no migration) together with the
 * work_items.synced_at they were read at. sync rewrites synced_at only when a
 * PR changed (or is OPEN), so a terminal PR whose synced_at still matches is
 * not re-read. S3: the pass's GraphQL page supplies fresh reads for every PR
 * it carries; this store covers the PRs a warm pass's page does not reach.
 */
interface PersistedPrReads {
  syncedAt: string | null;
  shas: string[];
  trailerIds: string[];
}

/**
 * P0-U13: reverse commit→PR lookups per repo, persisted in user_config
 * (`gh_commit_pulls:<owner>/<repo>`) and valid while the repo's sync watermark
 * is unchanged — a PR that could newly contain a commit moves the watermark.
 */
interface PersistedCommitPulls {
  watermark: string | null;
  pulls: Record<string, number[]>;
  /** SHAs GitHub answered 422 (unknown commit): not re-asked under the same watermark. */
  unknown?: string[];
}

function extractPrReads(
  commits: Array<{ sha: string; message: string }>,
  body: string,
): { shas: Set<string>; trailerIds: Set<string> } {
  const trailerIds = new Set<string>();
  for (const commit of commits) {
    for (const trailerId of extractTrailerSessionIds(commit.message)) trailerIds.add(trailerId);
  }
  for (const trailerId of extractTrailerSessionIds(body)) trailerIds.add(trailerId);
  return { shas: new Set(commits.map((commit) => commit.sha)), trailerIds };
}

function parseJson<T>(value: string | null | undefined): T | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Extract session ids from supported commit/PR trailer lines.
 *
 * This deliberately returns ids only: callers must not retain the source text.
 */
function extractTrailerSessionIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const claudeSession =
      /^Claude-Session:\s*https:\/\/claude\.ai\/code\/session_(\S+)(?:\s|$)/.exec(trimmed);
    if (claudeSession?.[1] !== undefined) {
      ids.push(claudeSession[1]);
      continue;
    }

    const agentSession =
      /^Agent-Session-Id:\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s*$/.exec(
        trimmed,
      );
    if (agentSession?.[1] !== undefined) ids.push(agentSession[1]);
  }
  return ids;
}

const BRANCH_CANDIDATE_REASONS: BranchCandidateReason[] = [
  "NO_VALID_SESSION_KEY",
  "MULTIPLE_SESSION_KEYS",
  "NO_MATCHING_WORK_ITEM_KEY",
  "DUPLICATE_WORKSPACE_MATCH",
  "UNIQUE_CANDIDATE",
];

const BRANCH_DISPOSITION_REASONS: BranchDispositionReason[] = [
  ...BRANCH_CANDIDATE_REASONS,
  "HIGHER_PRECEDENCE",
];

function zeroCounts<T extends string>(values: T[]): Record<T, number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

function higherPrecedenceMethod(methods: Set<string>): BranchHigherPrecedenceMethod | null {
  if (methods.has("MANUAL")) return "MANUAL";
  if (methods.has("PR_LINK")) return "PR_LINK";
  if (methods.has("SHA_OVERLAP")) return "SHA_OVERLAP";
  return null;
}

/**
 * Evaluate exact branch-key candidates without changing accepted links.
 *
 * This validation-only path is disabled by default and intentionally has no
 * write mode. Its return value contains no transcript paths, raw refs, or
 * fingerprint keys.
 */
export async function evaluateBranchLinksShadow(
  db: Db,
  mode: BranchLinkMode = "off",
  options: BranchShadowOptions = {},
): Promise<BranchShadowReport> {
  const candidateReasonCounts = zeroCounts(BRANCH_CANDIDATE_REASONS);
  const dispositionCounts = zeroCounts(BRANCH_DISPOSITION_REASONS);
  const transcriptFailureReasonCounts = zeroCounts<TranscriptReadFailureReason>([
    "MISSING",
    "UNREADABLE",
    "REPLACED",
    "CHANGED",
    "LIMIT_EXCEEDED",
    "CORPUS_MISMATCH",
  ]);
  let transcriptSucceeded = 0;
  let malformedLines = 0;

  // This return must precede every SQL preparation and transcript/branch read.
  if (mode === "off") {
    return {
      mode,
      sessionsEvaluated: 0,
      evaluations: [],
      candidateReasonCounts,
      dispositionCounts,
    };
  }

  const sessions = db
    .prepare(
      `SELECT s.session_id, s.file_path, s.workspace_id
       FROM sessions s
       WHERE s.state = 'RECONCILED'
         AND EXISTS (SELECT 1 FROM tool_events te
                     WHERE te.session_id = s.session_id AND te.tool_name = 'Bash')
         -- R3 corpus: evidence-bearing workspaces only (see plan §5G). Shadow/on mode
         -- links sessions to work_items; a workspace with none can never link. Keep this
         -- predicate byte-identical with the three evidence-runner corpus queries.
         AND EXISTS (SELECT 1 FROM work_items wi WHERE wi.workspace_id = s.workspace_id)
       ORDER BY s.session_id`,
    )
    .all() as Array<{ session_id: string; file_path: string; workspace_id: string }>;

  const matchingWorkItems = db.prepare(
    `SELECT wi.work_item_id
     FROM work_item_branch_keys bk
     JOIN work_items wi ON wi.work_item_id = bk.work_item_id
     JOIN workspaces ws ON ws.workspace_id = wi.workspace_id
     WHERE wi.workspace_id = ? AND bk.head_ref_key = ?
       AND wi.work_item_id = 'gh:' || ws.repo_owner || '/' || ws.repo_name || '#' || wi.number
     ORDER BY wi.work_item_id
     LIMIT 2`,
  );
  const existingMethods = db.prepare(
    `SELECT method
     FROM session_work_links
     WHERE session_id = ? AND method IN ('MANUAL', 'PR_LINK', 'SHA_OVERLAP')`,
  );

  const evaluations: BranchShadowEvaluation[] = [];
  let processed = 0;
  for (const session of sessions) {
    if (processed > 0 && processed % YIELD_EVERY === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    processed += 1;

    let links: PrLinkRecord[];
    let branchKeys: Set<string>;
    if (options.transcriptEvidence === undefined) {
      ({ links, branchKeys } = await harvestTranscript(session.file_path, true));
    } else {
      const entry = options.transcriptEvidence.entryForSession(session.session_id);
      const result =
        entry === undefined
          ? ({ ok: false, reason: "MISSING" } as const)
          : entry.sessionId !== session.session_id || entry.path !== session.file_path
            ? ({ ok: false, reason: "CORPUS_MISMATCH" } as const)
            : await options.transcriptEvidence.harvest(entry);
      if (result.ok) {
        links = result.projection.links;
        branchKeys = result.projection.branchKeys;
        transcriptSucceeded += 1;
        malformedLines += result.projection.malformedLines;
      } else {
        transcriptFailureReasonCounts[result.reason] += 1;
        links = [];
        branchKeys = new Set();
      }
    }
    let candidateReason: BranchCandidateReason;
    let candidateWorkItemId: string | null = null;

    if (branchKeys.size === 0) {
      candidateReason = "NO_VALID_SESSION_KEY";
    } else if (branchKeys.size > 1) {
      candidateReason = "MULTIPLE_SESSION_KEYS";
    } else {
      const branchKey = branchKeys.values().next().value as string;
      const matches = matchingWorkItems.all(session.workspace_id, branchKey) as Array<{
        work_item_id: string;
      }>;
      if (matches.length === 0) {
        candidateReason = "NO_MATCHING_WORK_ITEM_KEY";
      } else if (matches.length > 1) {
        candidateReason = "DUPLICATE_WORKSPACE_MATCH";
      } else {
        candidateReason = "UNIQUE_CANDIDATE";
        candidateWorkItemId = matches[0]?.work_item_id ?? null;
      }
    }

    const methods = new Set(
      (existingMethods.all(session.session_id) as Array<{ method: string }>).map(
        ({ method }) => method,
      ),
    );
    if (resolvePrLinkMatches(db, links).length > 0) methods.add("PR_LINK");
    const excludedBy = higherPrecedenceMethod(methods);
    const disposition: BranchDispositionReason =
      excludedBy === null ? candidateReason : "HIGHER_PRECEDENCE";

    candidateReasonCounts[candidateReason] += 1;
    dispositionCounts[disposition] += 1;
    evaluations.push({
      sessionId: session.session_id,
      candidateWorkItemId,
      candidateReason,
      disposition,
      excludedBy,
    });
  }

  return {
    mode,
    sessionsEvaluated: evaluations.length,
    evaluations,
    candidateReasonCounts,
    dispositionCounts,
    ...(options.transcriptEvidence === undefined
      ? {}
      : {
          strictTranscript: {
            succeeded: transcriptSucceeded,
            malformedLines,
            failureReasonCounts: transcriptFailureReasonCounts,
          },
        }),
  };
}

// ---------------------------------------------------------------------------
// Core linker
// ---------------------------------------------------------------------------

/**
 * Link all RECONCILED sessions (with ≥1 Bash tool_event) to work_items.
 * Writes to session_work_links (INSERT OR REPLACE — idempotent).
 * MANUAL rows are preserved (method='MANUAL'); re-linking a session that
 * already has a MANUAL link skips it.
 *
 * @param client — needed only for SHA_OVERLAP: fetch PR commit SHAs.
 *                 Pass disabled client to skip SHA_OVERLAP linkage.
 */
export async function linkSessions(
  db: Db,
  underlyingClient: GithubClient,
  pages?: PassPrPages,
): Promise<OutcomeStageSummary> {
  const summary = newStageSummary();
  const client = observeGithubClient(underlyingClient, summary);
  // Get all RECONCILED sessions with ≥1 Bash tool_event and their workspace mapping.
  const sessions = db
    .prepare(
      `SELECT s.session_id, s.file_path, s.workspace_id,
              w.repo_owner, w.repo_name
       FROM sessions s
       JOIN workspaces w USING (workspace_id)
       WHERE s.state = 'RECONCILED'
         AND EXISTS (SELECT 1 FROM tool_events te
                     WHERE te.session_id = s.session_id AND te.tool_name = 'Bash')`,
    )
    .all() as Array<{
    session_id: string;
    file_path: string;
    workspace_id: string;
    repo_owner: string | null;
    repo_name: string | null;
  }>;
  summary.eligibleRepositories = new Set(
    sessions
      .filter((session) => session.repo_owner && session.repo_name)
      .map((session) => `${session.repo_owner}/${session.repo_name}`),
  ).size;

  const insertLink = db.prepare(`
    INSERT INTO session_work_links (session_id, work_item_id, confidence, method)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, work_item_id) DO UPDATE SET
      confidence = excluded.confidence,
      method     = excluded.method
  `);

  const deleteLink = db.prepare(
    "DELETE FROM session_work_links WHERE session_id = ? AND method != 'MANUAL'",
  );

  const hasManual = db.prepare(
    "SELECT 1 FROM session_work_links WHERE session_id = ? AND method = 'MANUAL' LIMIT 1",
  );

  // Batch PR SHAs by work_item_id → Set<sha> for SHA_OVERLAP
  // (lazy: only populated when needed for a workspace)
  const prShaCache = new Map<string, Set<string>>(); // work_item_id → sha set
  const prTrailerIdCache = new Map<string, Set<string>>(); // work_item_id → session ids
  const selectConfig = db.prepare("SELECT value FROM user_config WHERE key = ?");
  const upsertConfig = db.prepare(`
    INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const deleteConfig = db.prepare("DELETE FROM user_config WHERE key = ?");
  const readConfig = (key: string): string | null | undefined =>
    (selectConfig.get(key) as { value: string | null } | undefined)?.value;

  /** Persist a terminal PR's reads unless the stored copy already matches. */
  const persistPrReads = (
    wi: { work_item_id: string; state: string; synced_at: string | null },
    reads: { shas: Set<string>; trailerIds: Set<string> },
  ): void => {
    // OPEN PRs are re-read every pass (sync rewrites them every pass), so a
    // stored copy would never be used.
    if (wi.state === "OPEN") return;
    const key = `gh_pr_reads:${wi.work_item_id}`;
    const value = JSON.stringify({
      syncedAt: wi.synced_at,
      shas: [...reads.shas],
      trailerIds: [...reads.trailerIds],
    } satisfies PersistedPrReads);
    if (readConfig(key) !== value) upsertConfig.run(key, value, new Date().toISOString());
  };

  const commitPullsByRepo = new Map<
    string,
    Omit<PersistedCommitPulls, "unknown"> & { unknown: Set<string>; dirty: boolean }
  >();
  const commitPullsFor = (owner: string, repo: string) => {
    const repoKey = `${owner}/${repo}`;
    let memo = commitPullsByRepo.get(repoKey);
    if (memo === undefined) {
      const watermark = readConfig(`gh_watermark:${repoKey}`) ?? null;
      const stored = parseJson<PersistedCommitPulls>(readConfig(`gh_commit_pulls:${repoKey}`));
      const valid =
        stored?.watermark === watermark &&
        typeof stored.pulls === "object" &&
        stored.pulls !== null;
      memo = {
        watermark,
        pulls: valid ? stored.pulls : {},
        unknown: new Set(valid && Array.isArray(stored.unknown) ? stored.unknown : []),
        dirty: false,
      };
      commitPullsByRepo.set(repoKey, memo);
    }
    return memo;
  };

  /** A terminal PR's stored reads, valid while its synced_at is unchanged (OPEN is never trusted). */
  const storedReadsFor = (wi: {
    work_item_id: string;
    state: string;
    synced_at: string | null;
  }): PersistedPrReads | undefined => {
    if (wi.state === "OPEN") return undefined;
    const stored = parseJson<PersistedPrReads>(readConfig(`gh_pr_reads:${wi.work_item_id}`));
    return stored !== undefined && stored.syncedAt === wi.synced_at ? stored : undefined;
  };

  // P0-U13 S3b: work items that are off this pass's page and have no valid stored
  // reads (a cold boot: every older PR) are read in aliased GraphQL batches instead
  // of two REST calls each. PRs a batch cannot return keep the per-PR REST fallback.
  const fetchedReads = new Map<string, GhPRRead>();
  const deniedRepos = new Set<string>();
  const listPRReads = client.listPRReads;
  if (listPRReads !== undefined && client.enabled) {
    const seenWorkspaces = new Set<string>();
    for (const session of sessions) {
      const { repo_owner: owner, repo_name: name, workspace_id: workspaceId } = session;
      if (owner === null || name === null || seenWorkspaces.has(workspaceId)) continue;
      if (hasManual.get(session.session_id) !== undefined) continue;
      seenWorkspaces.add(workspaceId);
      const repoKey = `${owner}/${name}`;
      const wanted = (
        db
          .prepare(
            "SELECT work_item_id, number, state, synced_at FROM work_items WHERE workspace_id = ?",
          )
          .all(workspaceId) as Array<{
          work_item_id: string;
          number: number;
          state: string;
          synced_at: string | null;
        }>
      ).filter(
        (wi) =>
          pages?.get(owner, name, wi.number) === undefined && storedReadsFor(wi) === undefined,
      );
      for (let i = 0; i < wanted.length && !deniedRepos.has(repoKey); i += PR_READ_BATCH) {
        const chunk = wanted.slice(i, i + PR_READ_BATCH);
        const result = await listPRReads.call(
          client,
          owner,
          name,
          chunk.map((wi) => wi.number),
        );
        if (!result.ok) {
          // The per-PR REST read would be denied identically: do not retry it N times.
          if (/:(401|403|429)$/.test(result.reason)) deniedRepos.add(repoKey);
          continue;
        }
        for (const wi of chunk) {
          const read = result.data.get(wi.number);
          if (read !== undefined) fetchedReads.set(wi.work_item_id, read);
        }
      }
    }
  }

  let reverseLookups = 0;

  let processed = 0;
  for (const session of sessions) {
    // Yield to the event loop every YIELD_EVERY sessions to keep the daemon event
    // loop responsive during back-to-back synchronous transcript streaming in
    // linkSessions (general responsiveness). GitHub I/O now runs in a `gh` child
    // process (off the parent loop), so this is no longer rescuing undici timers.
    // YIELD_EVERY=16 is empirically chosen; tune if starvation recurs.
    if (processed > 0 && processed % YIELD_EVERY === 0) {
      await new Promise((r) => setImmediate(r));
    }
    processed += 1;
    // Each write below follows the gate (or the gate after the last await before it).
    await awaitDbWriteGate();

    // If session already has a MANUAL link, skip (MANUAL wins).
    const manualExists = hasManual.get(session.session_id);
    if (manualExists !== undefined) continue;

    const repoOwner = session.repo_owner;
    const repoName = session.repo_name;

    // 1. TRAILER (GitHub commit/PR trailers, only when a repository is available)
    if (repoOwner !== null && repoName !== null && client.enabled) {
      const workItems = db
        .prepare(
          "SELECT work_item_id, number, state, synced_at FROM work_items WHERE workspace_id = ?",
        )
        .all(session.workspace_id) as Array<{
        work_item_id: string;
        number: number;
        state: string;
        synced_at: string | null;
      }>;
      const trailerMatches: string[] = [];

      for (const wi of workItems) {
        let trailerIds = prTrailerIdCache.get(wi.work_item_id);
        if (trailerIds === undefined) {
          // This pass's GraphQL page already holds the PR's commits and body.
          const paged = pages?.get(repoOwner, repoName, wi.number);
          if (paged !== undefined) {
            const reads = extractPrReads(paged.commits, paged.body);
            trailerIds = reads.trailerIds;
            prShaCache.set(wi.work_item_id, reads.shas);
            prTrailerIdCache.set(wi.work_item_id, trailerIds);
            persistPrReads(wi, reads);
          }
        }
        // OPEN PRs are rewritten every pass, so they must be re-read every pass —
        // enforce that invariant directly rather than relying on synced_at, which
        // sync.ts only bumps when its own check-conclusion read succeeds (P0-U13
        // review: a repo-wide check-conclusion denial freezes synced_at for an
        // OPEN PR without stopping it from evolving).
        if (trailerIds === undefined) {
          const stored = storedReadsFor(wi);
          if (stored !== undefined) {
            trailerIds = new Set(stored.trailerIds);
            prShaCache.set(wi.work_item_id, new Set(stored.shas));
            prTrailerIdCache.set(wi.work_item_id, trailerIds);
          }
        }
        if (trailerIds === undefined) {
          const fetched = fetchedReads.get(wi.work_item_id);
          if (fetched !== undefined) {
            const reads = extractPrReads(fetched.commits, fetched.body);
            trailerIds = reads.trailerIds;
            prShaCache.set(wi.work_item_id, reads.shas);
            prTrailerIdCache.set(wi.work_item_id, trailerIds);
            persistPrReads(wi, reads);
          }
        }
        if (trailerIds === undefined && deniedRepos.has(`${repoOwner}/${repoName}`)) {
          trailerIds = new Set<string>();
          prShaCache.set(wi.work_item_id, new Set());
          prTrailerIdCache.set(wi.work_item_id, trailerIds);
          deleteConfig.run(`gh_pr_reads:${wi.work_item_id}`);
        }
        if (trailerIds === undefined) {
          trailerIds = new Set<string>();
          const commitResult = await client.listPRCommits(repoOwner, repoName, wi.number);
          if (commitResult.ok) {
            prShaCache.set(wi.work_item_id, new Set(commitResult.data.map((commit) => commit.sha)));
            for (const commit of commitResult.data) {
              for (const trailerId of extractTrailerSessionIds(commit.message)) {
                trailerIds.add(trailerId);
              }
            }
          } else {
            prShaCache.set(wi.work_item_id, new Set());
          }

          const bodyResult = await client.getPRBody(repoOwner, repoName, wi.number);
          if (bodyResult.ok) {
            for (const trailerId of extractTrailerSessionIds(bodyResult.data)) {
              trailerIds.add(trailerId);
            }
          }
          await awaitDbWriteGate();
          prTrailerIdCache.set(wi.work_item_id, trailerIds);
          // Only complete reads carry over; a failed read is retried next pass.
          if (commitResult.ok && bodyResult.ok) {
            persistPrReads(wi, { shas: prShaCache.get(wi.work_item_id) ?? new Set(), trailerIds });
          } else {
            deleteConfig.run(`gh_pr_reads:${wi.work_item_id}`);
          }
        }
        if (trailerIds.has(session.session_id)) trailerMatches.push(wi.work_item_id);
      }

      if (trailerMatches.length > 0) {
        deleteLink.run(session.session_id);
        for (const wid of trailerMatches) {
          insertLink.run(session.session_id, wid, 1.0, "TRAILER");
        }
        continue;
      }
    }

    // 2. PR_LINK
    const prLinks = await harvestPrLinks(session.file_path);
    await awaitDbWriteGate();
    const prLinkMatches = resolvePrLinkMatches(db, prLinks);

    if (prLinkMatches.length > 0) {
      // Delete non-manual existing links then insert PR_LINK rows
      deleteLink.run(session.session_id);
      for (const wid of prLinkMatches) {
        insertLink.run(session.session_id, wid, 1.0, "PR_LINK");
      }
      continue;
    }

    // 3. SHA_OVERLAP (only if no higher-precedence match + workspace has repo mapping)
    if (repoOwner !== null && repoName !== null) {
      // Get this session's SHAs from tool_events
      const sessionShas = new Set(
        (
          db
            .prepare(
              "SELECT commit_sha FROM tool_events WHERE session_id = ? AND commit_sha IS NOT NULL",
            )
            .all(session.session_id) as Array<{ commit_sha: string }>
        ).map((r) => r.commit_sha),
      );

      if (sessionShas.size > 0) {
        // Get all synced work_items for this workspace
        const workItems = db
          .prepare("SELECT work_item_id, number FROM work_items WHERE workspace_id = ?")
          .all(session.workspace_id) as Array<{ work_item_id: string; number: number }>;

        // Build SHA → [work_item_ids] map for overlap check
        const shaToWorkItems = new Map<string, string[]>();

        for (const wi of workItems) {
          // Populate SHA cache if missing
          if (!prShaCache.has(wi.work_item_id) && client.enabled) {
            const shaResult = await client.listPRCommits(repoOwner, repoName, wi.number);
            if (shaResult.ok) {
              prShaCache.set(wi.work_item_id, new Set(shaResult.data.map((c) => c.sha)));
            } else {
              prShaCache.set(wi.work_item_id, new Set());
            }
          }
          const prShas = prShaCache.get(wi.work_item_id) ?? new Set();
          for (const sha of sessionShas) {
            if (prShas.has(sha)) {
              const existing = shaToWorkItems.get(sha) ?? [];
              existing.push(wi.work_item_id);
              shaToWorkItems.set(sha, existing);
            }
          }
        }

        // Only SHAs absent from every synced PR commit list can use a reverse lookup.
        for (const sha of sessionShas) {
          if (shaToWorkItems.has(sha) || !client.enabled) continue;
          const memo = commitPullsFor(repoOwner, repoName);
          let prNumbers = Object.hasOwn(memo.pulls, sha) ? memo.pulls[sha] : undefined;
          if (prNumbers === undefined) {
            if (memo.unknown.has(sha)) continue;
            if (reverseLookups >= REVERSE_LOOKUP_CAP) continue;
            reverseLookups += 1;
            const pullsResult = await client.listPullsForCommit(repoOwner, repoName, sha);
            if (!pullsResult.ok) {
              // 422 = commit unknown to GitHub; it answers the same until the repo moves.
              if (/:422$/.test(pullsResult.reason)) {
                memo.unknown.add(sha);
                memo.dirty = true;
              }
              continue;
            }
            prNumbers = pullsResult.data;
            memo.pulls[sha] = prNumbers;
            memo.dirty = true;
          }
          const reverseMatches = new Set<string>();
          for (const prNumber of prNumbers) {
            for (const wi of workItems) {
              if (wi.number === prNumber) reverseMatches.add(wi.work_item_id);
            }
          }
          if (reverseMatches.size > 0) {
            shaToWorkItems.set(sha, [...reverseMatches]);
          }
        }

        // Count overlap per work_item; check for SHA ambiguity
        const overlapCount = new Map<string, number>();
        let ambiguous = false;

        for (const [, wids] of shaToWorkItems) {
          if (wids.length > 1) {
            ambiguous = true;
            break;
          }
          const wid = wids[0];
          if (wid === undefined) continue;
          overlapCount.set(wid, (overlapCount.get(wid) ?? 0) + 1);
        }

        if (!ambiguous && overlapCount.size > 0) {
          await awaitDbWriteGate();
          deleteLink.run(session.session_id);
          for (const [wid, count] of overlapCount) {
            insertLink.run(session.session_id, wid, shaOverlapConfidence(count), "SHA_OVERLAP");
          }
        }
      }
    }

    // 4. BRANCH — not implemented in WP5 (ADR-103 FLAG-D3 [UNMEASURED])

    // 5. UNLINKED — implicit; do nothing (no row).
  }
  await awaitDbWriteGate();
  for (const [repoKey, memo] of commitPullsByRepo) {
    if (!memo.dirty) continue;
    upsertConfig.run(
      `gh_commit_pulls:${repoKey}`,
      JSON.stringify({
        watermark: memo.watermark,
        pulls: memo.pulls,
        unknown: [...memo.unknown],
      } satisfies PersistedCommitPulls),
      new Date().toISOString(),
    );
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Manual link/unlink (write path — called from router POST endpoints)
// ---------------------------------------------------------------------------

export function manualLink(db: Db, sessionId: string, workItemId: string): void {
  db.prepare(`
    INSERT INTO session_work_links (session_id, work_item_id, confidence, method)
    VALUES (?, ?, 1.0, 'MANUAL')
    ON CONFLICT(session_id, work_item_id) DO UPDATE SET
      confidence = 1.0,
      method     = 'MANUAL'
  `).run(sessionId, workItemId);
}

export function manualUnlink(db: Db, sessionId: string, workItemId: string): number {
  const result = db
    .prepare(
      "DELETE FROM session_work_links WHERE session_id = ? AND work_item_id = ? AND method = 'MANUAL'",
    )
    .run(sessionId, workItemId);
  return result.changes;
}
