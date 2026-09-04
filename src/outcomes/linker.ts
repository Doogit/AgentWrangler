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
import type {
  FrozenTranscriptEntry,
  StrictTranscriptHarvester,
  TranscriptReadFailureReason,
} from "../evidence/r3/transcript.js";
import { fingerprintBranchRef } from "./branch-key.js";
import type { GithubClient } from "./github/client.js";

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
export async function linkSessions(db: Db, client: GithubClient): Promise<void> {
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

    // If session already has a MANUAL link, skip (MANUAL wins).
    const manualExists = hasManual.get(session.session_id);
    if (manualExists !== undefined) continue;

    const repoOwner = session.repo_owner;
    const repoName = session.repo_name;

    // 1. TRAILER (GitHub commit/PR trailers, only when a repository is available)
    if (repoOwner !== null && repoName !== null && client.enabled) {
      const workItems = db
        .prepare("SELECT work_item_id, number FROM work_items WHERE workspace_id = ?")
        .all(session.workspace_id) as Array<{ work_item_id: string; number: number }>;
      const trailerMatches: string[] = [];

      for (const wi of workItems) {
        let trailerIds = prTrailerIdCache.get(wi.work_item_id);
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
          prTrailerIdCache.set(wi.work_item_id, trailerIds);
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
          if (shaToWorkItems.has(sha) || reverseLookups >= REVERSE_LOOKUP_CAP || !client.enabled) {
            continue;
          }
          reverseLookups += 1;
          const pullsResult = await client.listPullsForCommit(repoOwner, repoName, sha);
          if (!pullsResult.ok) continue;
          const reverseMatches = new Set<string>();
          for (const prNumber of pullsResult.data) {
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
