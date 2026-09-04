/**
 * src/outcomes/sync.ts — GitHub → work_items sync.
 *
 * Fetches PRs from GitHub and upserts into the work_items table.
 * Watermark in user_config (key: "gh_watermark:<owner>/<repo>") prevents
 * re-fetching already-processed PRs.
 *
 * Body and diff are parsed in-memory only — never stored (SEC-101).
 * Skip workspaces without repo_owner/repo_name.
 */

import type { Db } from "../db/open.js";
import type { GithubClient } from "./github/client.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./pool.js";

export interface WorkspaceRef {
  workspace_id: string;
  repo_owner: string;
  repo_name: string;
}

/**
 * Sync PRs for one workspace into work_items.
 * Idempotent — ON CONFLICT DO UPDATE safe to call repeatedly.
 * Skips workspace silently if client is disabled.
 */
export async function syncWorkItems(
  db: Db,
  client: GithubClient,
  workspace: WorkspaceRef,
): Promise<void> {
  if (!client.enabled) return;

  const { workspace_id, repo_owner, repo_name } = workspace;
  const watermarkKey = `gh_watermark:${repo_owner}/${repo_name}`;

  // Read watermark
  const wmRow = db.prepare("SELECT value FROM user_config WHERE key = ?").get(watermarkKey) as
    | { value: string | null }
    | undefined;
  const since = wmRow?.value ?? undefined;

  const listResult = await client.listPRs(repo_owner, repo_name, since);
  if (!listResult.ok) {
    console.warn(`syncWorkItems: listPRs failed — ${listResult.reason}`);
    return;
  }

  const prs = listResult.data;
  if (prs.length === 0) return;

  const upsert = db.prepare(`
    INSERT INTO work_items
      (work_item_id, workspace_id, number, state, final_commit,
       checks_conclusion, opened_at, merged_at, closed_at, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_item_id) DO UPDATE SET
      state             = excluded.state,
      final_commit      = excluded.final_commit,
      checks_conclusion = COALESCE(excluded.checks_conclusion, work_items.checks_conclusion),
      merged_at         = excluded.merged_at,
      closed_at         = excluded.closed_at,
      synced_at         = excluded.synced_at
  `);

  const ensureConfig = db.prepare(`
    INSERT OR IGNORE INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
  `);
  const updateConfig = db.prepare("UPDATE user_config SET value = ?, updated_at = ? WHERE key = ?");
  const upsertBranchKey = db.prepare(`
    INSERT INTO work_item_branch_keys
      (work_item_id, head_ref_key, normalization_version, synced_at)
    VALUES (?, ?, 'branch-v1', ?)
    ON CONFLICT(work_item_id) DO UPDATE SET
      head_ref_key          = excluded.head_ref_key,
      normalization_version = excluded.normalization_version,
      synced_at             = excluded.synced_at
  `);
  const deleteBranchKey = db.prepare("DELETE FROM work_item_branch_keys WHERE work_item_id = ?");

  const now = new Date().toISOString();
  let newestUpdated = since ?? "1970-01-01T00:00:00Z";

  // Compute per-PR row fields synchronously, then fetch check conclusions with
  // bounded concurrency (~0.77s per call; serially that was ~97s across a
  // 126-PR page — pooled at DEFAULT_CONCURRENCY it drops proportionally).
  const rows = prs.map((pr) => {
    const workItemId = `gh:${repo_owner}/${repo_name}#${pr.number}`;
    const state = pr.merged_at !== null ? "MERGED" : pr.state === "closed" ? "CLOSED" : "OPEN";
    const finalCommit = pr.merge_commit_sha ?? pr.head.sha;
    return { pr, workItemId, state, finalCommit };
  });

  const conclusions = await mapWithConcurrency(rows, DEFAULT_CONCURRENCY, (row) =>
    client.getCheckConclusion(repo_owner, repo_name, row.pr.head.sha),
  );

  const writePR = db.transaction(
    (row: (typeof rows)[number], checksConclusion: string | null, syncedAt: string) => {
      upsert.run(
        row.workItemId,
        workspace_id,
        row.pr.number,
        row.state,
        row.finalCommit,
        checksConclusion,
        row.pr.created_at,
        row.pr.merged_at,
        row.pr.closed_at,
        syncedAt,
      );
      if (row.pr.head.refKey === null) {
        deleteBranchKey.run(row.workItemId);
      } else {
        upsertBranchKey.run(row.workItemId, row.pr.head.refKey, syncedAt);
      }
    },
  );

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as (typeof rows)[number];
    // Get check conclusion for the HEAD SHA.
    // If the call fails (rate-limit, truncation, transient error), pass null so the
    // COALESCE in the upsert preserves any previously-correct value rather than
    // overwriting it — preventing a false OBSERVED_SUCCESS from a transient failure.
    const checkResult = conclusions[i];
    const checksConclusion = checkResult?.ok === true ? checkResult.data : null;

    // The work-item projection and privacy-safe branch key are one unit: a
    // changed head SHA can never commit alongside a stale branch key.
    writePR(row, checksConclusion, now);

    // Track newest updated_at for watermark
    const updatedAt = row.pr.merged_at ?? row.pr.closed_at ?? row.pr.created_at;
    if (updatedAt > newestUpdated) newestUpdated = updatedAt;
  }

  // Advance watermark
  ensureConfig.run(watermarkKey, newestUpdated, now);
  updateConfig.run(newestUpdated, now, watermarkKey);
}

export interface BranchKeyBackfillOptions {
  /** Exclusive work_item_id cursor from the preceding page. */
  cursor?: string | null;
  /** Maximum rows selected in this page. Defaults to 100, capped at 1000. */
  limit?: number;
  /** Maximum concurrent GitHub reads. Defaults to the outcomes pool size. */
  concurrency?: number;
  /** Evidence-only bounds. Omitted by every production caller. */
  evidence?: BranchKeyBackfillEvidenceOptions;
}

export interface BranchKeyBackfillApprovedRepo {
  workspaceId: string;
  owner: string;
  repo: string;
}

export interface BranchKeyBackfillCheckpoint {
  afterWorkItemId: string | null;
  scanned: number;
  selected: number;
  keyed: number;
  ineligible: number;
  failed: number;
}

export interface BranchKeyBackfillEvidenceOptions {
  repositories: readonly BranchKeyBackfillApprovedRepo[];
  /** Frozen selection upper bound. */
  asOf: string;
  /** Frozen timestamp written to new branch-key rows. */
  syncedAt: string;
  /** Begin deterministic missing-key traversal from the first row. */
  resumeFromStart?: boolean;
  /** Runs only after all page classifications and database writes commit. */
  onPageCheckpoint?: (checkpoint: BranchKeyBackfillCheckpoint) => void | Promise<void>;
}

export type BranchKeyBackfillClassification = "KEYED" | "INELIGIBLE" | "FETCH_FAILED";
export type BranchKeyBackfillFailureReason = "GITHUB_READ_FAILED" | "GITHUB_READ_THREW";

export interface BranchKeyBackfillResult {
  selected: number;
  keyed: number;
  ineligible: number;
  failed: number;
  missing: number;
  /** Non-null only when another deterministic page remains. */
  nextCursor: string | null;
  /** Evidence-only count of rows inspected by this bounded keyset page. */
  scanned?: number;
  classifications?: Record<BranchKeyBackfillClassification, number>;
  failureReasonCounts?: Record<BranchKeyBackfillFailureReason, number>;
}

interface MissingBranchKeyRow {
  work_item_id: string;
  workspace_id: string;
  repo_owner: string;
  repo_name: string;
  number: number;
  synced_at: string;
}

const STRICT_UTC_RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u;
const EVIDENCE_SCAN_CHUNK = 256;

function parseStrictUtcTimestamp(value: string, code: string): number {
  const match = STRICT_UTC_RFC3339.exec(value);
  if (match === null) throw new Error(code);
  const milliseconds = (match[2] ?? "").padEnd(3, "0");
  const canonical = `${match[1]}.${milliseconds}Z`;
  const epoch = Date.parse(canonical);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== canonical) throw new Error(code);
  return epoch;
}

function assertEvidenceRepositories(db: Db, evidence: BranchKeyBackfillEvidenceOptions): void {
  if (
    evidence.repositories.length === 0 ||
    evidence.asOf.length === 0 ||
    evidence.syncedAt.length === 0 ||
    !Number.isFinite(parseStrictUtcTimestamp(evidence.asOf, "branch_backfill_as_of_invalid")) ||
    !Number.isFinite(
      parseStrictUtcTimestamp(evidence.syncedAt, "branch_backfill_synced_at_invalid"),
    )
  ) {
    throw new Error("branch_backfill_evidence_options_invalid");
  }
  const seen = new Set<string>();
  const findWorkspace = db.prepare(
    "SELECT repo_owner, repo_name FROM workspaces WHERE workspace_id = ?",
  );
  for (const repository of evidence.repositories) {
    if (seen.has(repository.workspaceId)) throw new Error("branch_backfill_allowlist_duplicate");
    seen.add(repository.workspaceId);
    const row = findWorkspace.get(repository.workspaceId) as
      | { repo_owner: string | null; repo_name: string | null }
      | undefined;
    if (
      row === undefined ||
      row.repo_owner !== repository.owner ||
      row.repo_name !== repository.repo
    ) {
      throw new Error("branch_backfill_allowlist_mismatch");
    }
  }
}

/**
 * Validation-only, bounded backfill for historical work items missed by the
 * 100-row incremental listing. It is deliberately not wired into the daemon.
 * Existing keys are never fetched or overwritten, and failed/ineligible rows
 * remain missing so a later traversal from the start can retry them.
 */
export async function backfillMissingWorkItemBranchKeys(
  db: Db,
  client: GithubClient,
  options: BranchKeyBackfillOptions = {},
): Promise<BranchKeyBackfillResult> {
  const requestedLimit = options.limit ?? 100;
  const limit = Math.max(1, Math.min(1000, Math.trunc(requestedLimit)));
  const requestedConcurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const concurrency = Math.max(1, Math.min(32, Math.trunc(requestedConcurrency)));
  const evidence = options.evidence;
  if (evidence !== undefined) assertEvidenceRepositories(db, evidence);
  const cursor = evidence?.resumeFromStart === true ? "" : (options.cursor ?? "");

  const allowlistClause =
    evidence === undefined
      ? ""
      : ` AND (${evidence.repositories
          .map(() => "(wi.workspace_id = ? AND ws.repo_owner = ? AND ws.repo_name = ?)")
          .join(" OR ")})`;
  const queryArguments: Array<string | number> = [cursor];
  if (evidence !== undefined) {
    for (const repository of evidence.repositories) {
      queryArguments.push(repository.workspaceId, repository.owner, repository.repo);
    }
  }
  queryArguments.push(evidence === undefined ? limit + 1 : EVIDENCE_SCAN_CHUNK);

  const queriedCandidates = db
    .prepare(
      `SELECT wi.work_item_id, wi.workspace_id, ws.repo_owner, ws.repo_name, wi.number,
              wi.synced_at
         FROM work_items wi
         JOIN workspaces ws ON ws.workspace_id = wi.workspace_id
         LEFT JOIN work_item_branch_keys bk ON bk.work_item_id = wi.work_item_id
        WHERE bk.work_item_id IS NULL
          AND ws.repo_owner IS NOT NULL
          AND ws.repo_name IS NOT NULL
          AND wi.work_item_id =
              'gh:' || ws.repo_owner || '/' || ws.repo_name || '#' || wi.number
          AND wi.work_item_id > ?
          ${allowlistClause}
        ORDER BY wi.work_item_id
        LIMIT ?`,
    )
    .all(...queryArguments) as MissingBranchKeyRow[];

  const candidates =
    evidence === undefined
      ? queriedCandidates
      : queriedCandidates
          .filter(
            (row) =>
              parseStrictUtcTimestamp(
                row.synced_at,
                "branch_backfill_work_item_timestamp_invalid",
              ) <= parseStrictUtcTimestamp(evidence.asOf, "branch_backfill_as_of_invalid"),
          )
          .slice(0, limit + 1);

  const eligibleOverflow = candidates.length > limit;
  const page = eligibleOverflow ? candidates.slice(0, limit) : candidates;
  const results = await mapWithConcurrency(page, concurrency, async (row) => {
    try {
      const result = await client.getPRHeadKey(row.repo_owner, row.repo_name, row.number);
      return result.ok
        ? result
        : { ok: false as const, failureReason: "GITHUB_READ_FAILED" as const };
    } catch {
      return { ok: false as const, failureReason: "GITHUB_READ_THREW" as const };
    }
  });

  const insertKey = db.prepare(`
    INSERT OR IGNORE INTO work_item_branch_keys
      (work_item_id, head_ref_key, normalization_version, synced_at)
    VALUES (?, ?, 'branch-v1', ?)
  `);
  let keyed = 0;
  let ineligible = 0;
  let failed = 0;
  const classifications: Record<BranchKeyBackfillClassification, number> = {
    KEYED: 0,
    INELIGIBLE: 0,
    FETCH_FAILED: 0,
  };
  const failureReasonCounts: Record<BranchKeyBackfillFailureReason, number> = {
    GITHUB_READ_FAILED: 0,
    GITHUB_READ_THREW: 0,
  };
  const commitClassifications = db.transaction(() => {
    for (let i = 0; i < page.length; i++) {
      const result = results[i];
      if (result?.ok !== true) {
        failed += 1;
        classifications.FETCH_FAILED += 1;
        const reason = result?.failureReason ?? "GITHUB_READ_THREW";
        failureReasonCounts[reason] = (failureReasonCounts[reason] ?? 0) + 1;
        continue;
      }
      if (result.data === null) {
        ineligible += 1;
        classifications.INELIGIBLE += 1;
        continue;
      }
      const info = insertKey.run(
        page[i]?.work_item_id,
        result.data,
        evidence?.syncedAt ?? new Date().toISOString(),
      );
      if (info.changes === 1) {
        keyed += 1;
        classifications.KEYED += 1;
      }
    }
  });
  commitClassifications();

  const scanMayContinue =
    evidence !== undefined && queriedCandidates.length === EVIDENCE_SCAN_CHUNK;
  const checkpointCursor = eligibleOverflow
    ? (page.at(-1)?.work_item_id ?? null)
    : (queriedCandidates.at(-1)?.work_item_id ?? null);
  const nextCursor = eligibleOverflow || scanMayContinue ? checkpointCursor : null;
  if (evidence?.onPageCheckpoint !== undefined) {
    await evidence.onPageCheckpoint({
      afterWorkItemId: checkpointCursor,
      scanned: queriedCandidates.length,
      selected: page.length,
      keyed,
      ineligible,
      failed,
    });
  }

  return {
    selected: page.length,
    keyed,
    ineligible,
    failed,
    missing: ineligible + failed,
    nextCursor,
    ...(evidence === undefined
      ? {}
      : { scanned: queriedCandidates.length, classifications, failureReasonCounts }),
  };
}

/**
 * Sync all mapped workspaces (those with repo_owner and repo_name set).
 */
export async function syncAllWorkspaces(db: Db, client: GithubClient): Promise<void> {
  if (!client.enabled) return;

  const workspaces = db
    .prepare(
      "SELECT workspace_id, repo_owner, repo_name FROM workspaces WHERE repo_owner IS NOT NULL AND repo_name IS NOT NULL",
    )
    .all() as Array<{ workspace_id: string; repo_owner: string; repo_name: string }>;

  for (const ws of workspaces) {
    await syncWorkItems(db, client, ws);
  }
}
