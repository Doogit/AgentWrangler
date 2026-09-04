/**
 * src/outcomes/findings.ts — FindingsExtractor E1/E2/E3.
 *
 * All three extractors ship EXPERIMENTAL and are excluded from gated/deferral
 * denominators (COND-1 conservative — plan §3, §6 Q6).
 *
 * E1 UNRESOLVED_THREAD: GraphQL isResolved; unresolved@merge → DEFERRED,
 *    resolved-pre-merge → ADDRESSED; evidence_ref = thread id.
 * E2 DEFERRAL_SECTION: regex on in-memory PR body; each item → DEFERRED;
 *    evidence_ref = keyword-class+index (SEC-101: fixed enum + position, never
 *    the raw heading text).
 * E3 DIFF_MARKER: TODO/FIXME on in-memory diff (added lines only), excluding
 *    vendored/lockfile globs; evidence_ref = file:line@commit.
 *
 * Bodies and diffs are parsed in-memory and discarded — never stored (SEC-101).
 * Findings written: source/extractor_version/evidence_ref/raised_at/status.
 * Clearance: cleared_at/cleared_by set when a subsequent run finds them resolved.
 *
 * Pass bounding (latency): bodies/diffs of TERMINAL work items are immutable,
 * so E2/E3 fetch them only for items never yet extracted at this synced_at
 * (per-repo user_config watermark `gh_findings_seen:<owner>/<repo>`, same
 * pattern as the sync gh_watermark). E1 CAN change post-merge (resolution
 * clears DEFERRED), so review threads are re-fetched for OPEN items and
 * newly-synced items every pass, and terminal items at most once per
 * RECHECK_TTL, deterministically staggered by hash of work_item_id (per-item
 * last-check marker `gh_e1_check:<work_item_id>` in user_config — no schema
 * migration). First-ever pass behaves exactly like an unbounded pass.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "../db/open.js";
import {
  EXTRACTOR_VERSIONS,
  extractDeferralFindings,
  extractDiffMarkerFindings,
  projectReviewThreadFindings,
} from "./finding-extractors.js";
import type { GithubClient } from "./github/client.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./pool.js";

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function insertFinding(
  db: Db,
  findingId: string,
  workItemId: string,
  source: string,
  severity: string | null,
  status: string,
  evidenceRef: string,
  confidence: number | null,
  raisedAt: string,
  extractorVersion: string,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO review_findings
      (finding_id, work_item_id, source, severity, status, evidence_ref,
       confidence, raised_at, extractor_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    findingId,
    workItemId,
    source,
    severity,
    status,
    evidenceRef,
    confidence,
    raisedAt,
    extractorVersion,
  );
}

function clearFinding(db: Db, findingId: string, clearedBy: string): void {
  db.prepare(
    "UPDATE review_findings SET cleared_at = ?, cleared_by = ? WHERE finding_id = ? AND cleared_at IS NULL",
  ).run(new Date().toISOString(), clearedBy, findingId);
}

// ---------------------------------------------------------------------------
// Main extractor pass
// ---------------------------------------------------------------------------

/** Default terminal-item E1 recheck TTL: 7 days. */
export const DEFAULT_RECHECK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Test-injectable knobs for the extraction pass (TTL comparisons, clock). */
export interface ExtractFindingsOptions {
  /** Injectable clock (tests). Defaults to `new Date()`. */
  now?: () => Date;
  /** Terminal-item E1 recheck TTL in ms (tests). Defaults to 7 days. */
  recheckTtlMs?: number;
}

/** FNV-1a 32-bit — deterministic stagger phase per work_item_id. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Run E1/E2/E3 extractors for all synced work_items in the given workspace.
 * All finding rows carry extractor_version and evidence_ref; no body/diff content stored.
 */
export async function extractFindings(
  db: Db,
  client: GithubClient,
  repoOwner: string,
  repoName: string,
  options: ExtractFindingsOptions = {},
): Promise<void> {
  if (!client.enabled) return;

  const nowDate = (options.now ?? (() => new Date()))();
  const recheckTtlMs = options.recheckTtlMs ?? DEFAULT_RECHECK_TTL_MS;
  const nowMs = nowDate.getTime();
  const now = nowDate.toISOString();

  const workItems = db
    .prepare(
      `SELECT wi.work_item_id, wi.number, wi.state, wi.final_commit, wi.synced_at
       FROM work_items wi
       JOIN workspaces w USING (workspace_id)
       WHERE w.repo_owner = ? AND w.repo_name = ?`,
    )
    .all(repoOwner, repoName) as Array<{
    work_item_id: string;
    number: number;
    state: string;
    final_commit: string | null;
    synced_at: string | null;
  }>;

  // Per-repo "seen" watermark: max work_items.synced_at whose terminal
  // body/diff extraction completed successfully. Failed fetches must remain
  // retryable, or transient GitHub errors can permanently hide findings.
  const seenKey = `gh_findings_seen:${repoOwner}/${repoName}`;
  const seenRow = db.prepare("SELECT value FROM user_config WHERE key = ?").get(seenKey) as
    | { value: string | null }
    | undefined;
  const seenWm = seenRow?.value ?? undefined;

  // Hoist prepared statements outside the per-work-item loop to avoid
  // re-creating statement handles on every iteration (performance).
  const selectE1 = db.prepare(
    "SELECT finding_id, status FROM review_findings WHERE finding_id = ?",
  );
  const selectExists = db.prepare("SELECT 1 FROM review_findings WHERE finding_id = ?");
  const selectE1Check = db.prepare("SELECT value FROM user_config WHERE key = ?");
  const ensureConfig = db.prepare(`
    INSERT OR IGNORE INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
  `);
  const updateConfig = db.prepare("UPDATE user_config SET value = ?, updated_at = ? WHERE key = ?");

  // Per-item due decisions (sync, before any network I/O).
  const plans = workItems.map((wi) => {
    const isNew = seenWm === undefined || wi.synced_at === null || wi.synced_at > seenWm;
    const isOpen = wi.state === "OPEN";

    // E1: OPEN items and newly-synced items always; terminal items at most
    // once per recheckTtlMs, staggered deterministically by hash so each pass
    // re-checks roughly total/TTL worth instead of everything at once.
    let e1Due = isNew || isOpen;
    if (!e1Due) {
      const checkKey = `gh_e1_check:${wi.work_item_id}`;
      const last = selectE1Check.get(checkKey) as { value: string | null } | undefined;
      if (last?.value === undefined || last.value === null) {
        e1Due = true;
      } else {
        const lastMs = Date.parse(last.value);
        // Interval is recheckTtlMs * (1 + phase), phase ∈ [0,1): strictly at
        // least TTL between terminal rechecks, evenly spread across passes.
        const phase = (hash32(wi.work_item_id) % 1000) / 1000;
        e1Due = Number.isNaN(lastMs) || nowMs - lastMs >= recheckTtlMs * (1 + phase);
      }
    }

    // E2/E3: terminal bodies/diffs are immutable → fetch only when never yet
    // extracted at this synced_at (or still OPEN and thus mutable).
    const e23Due = isNew || isOpen;

    return { wi, isOpen, e1Due, e23Due };
  });

  const extractionResults = await mapWithConcurrency(plans, DEFAULT_CONCURRENCY, async (plan) => {
    const { wi, isOpen, e1Due, e23Due } = plan;
    const prNumber = wi.number;
    let e23Complete = true;

    // E1: Unresolved review threads (GraphQL)
    if (e1Due) {
      const threadsResult = await client.getReviewThreads(repoOwner, repoName, prNumber);
      if (threadsResult.ok) {
        for (const finding of projectReviewThreadFindings(wi.work_item_id, threadsResult.data)) {
          const findingId = finding.sourceFindingId;
          // Merged PRs: unresolved@merge → DEFERRED; resolved → ADDRESSED
          const status = finding.status;

          // Check if finding already exists
          const existing = selectE1.get(findingId) as
            | { finding_id: string; status: string }
            | undefined;

          if (existing === undefined) {
            insertFinding(
              db,
              findingId,
              wi.work_item_id,
              "UNRESOLVED_THREAD",
              "UNKNOWN",
              status,
              finding.evidenceRef,
              null,
              now,
              EXTRACTOR_VERSIONS.E1,
            );
          } else if (existing.status === "DEFERRED" && status === "ADDRESSED") {
            // Thread got resolved → clear it
            clearFinding(db, findingId, wi.final_commit ?? wi.work_item_id);
            db.prepare("UPDATE review_findings SET status = ? WHERE finding_id = ?").run(
              "ADDRESSED",
              findingId,
            );
          }
        }
        // Record last E1 check for terminal items only after a successful
        // GraphQL read. OPEN items are checked every pass, so their marker
        // would be dead weight.
        if (!isOpen) {
          const checkKey = `gh_e1_check:${wi.work_item_id}`;
          ensureConfig.run(checkKey, now, now);
          updateConfig.run(now, now, checkKey);
        }
      }
    }

    if (!e23Due) return { syncedAt: wi.synced_at, isOpen, e23Due, e23Complete };

    // E2: Deferral sections in body (in-memory only)
    {
      const bodyResult = await client.getPRBody(repoOwner, repoName, prNumber);
      if (bodyResult.ok) {
        if (bodyResult.data.length > 0) {
          const items = extractDeferralFindings(bodyResult.data, wi.work_item_id);
          for (let idx = 0; idx < items.length; idx++) {
            const item = items[idx];
            if (item === undefined) continue;
            const findingId = `e2:${wi.work_item_id}:${idx}`;
            const existing = selectExists.get(findingId);
            if (existing === undefined) {
              insertFinding(
                db,
                findingId,
                wi.work_item_id,
                "DEFERRAL_SECTION",
                "UNKNOWN",
                item.status,
                item.evidenceRef,
                null,
                now,
                EXTRACTOR_VERSIONS.E2,
              );
            }
          }
        }
        // body variable goes out of scope here — content discarded
      } else {
        e23Complete = false;
      }
    }

    // E3: TODO/FIXME in diff (in-memory only)
    if (wi.state === "MERGED" && wi.final_commit !== null) {
      const diffResult = await client.getPRDiff(repoOwner, repoName, prNumber);
      if (diffResult.ok) {
        if (diffResult.data.length > 0) {
          const markers = extractDiffMarkerFindings(
            diffResult.data,
            wi.final_commit,
            wi.work_item_id,
          );
          for (let idx = 0; idx < markers.length; idx++) {
            const marker = markers[idx];
            if (marker === undefined) continue;
            const findingId = `e3:${wi.work_item_id}:${idx}`;
            const existing = selectExists.get(findingId);
            if (existing === undefined) {
              insertFinding(
                db,
                findingId,
                wi.work_item_id,
                "DIFF_MARKER",
                "LOW",
                "UNKNOWN",
                marker.evidenceRef,
                null,
                now,
                EXTRACTOR_VERSIONS.E3,
              );
            }
          }
        }
        // diff variable goes out of scope here — content discarded
      } else {
        e23Complete = false;
      }
    }

    return { syncedAt: wi.synced_at, isOpen, e23Due, e23Complete };
  });

  // Advance the seen watermark only through synced_at groups whose terminal
  // body/diff extraction completed. syncWorkItems writes the same synced_at for
  // a fetched page, so a single failed item must hold the whole group retryable.
  let newestSeen = seenWm ?? "1970-01-01T00:00:00Z";
  const terminalDueBySyncedAt = new Map<string, boolean>();
  for (const result of extractionResults) {
    if (!result.e23Due || result.isOpen || result.syncedAt === null) continue;
    const previous = terminalDueBySyncedAt.get(result.syncedAt) ?? true;
    terminalDueBySyncedAt.set(result.syncedAt, previous && result.e23Complete);
  }
  const syncedGroups = Array.from(terminalDueBySyncedAt.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [syncedAt, complete] of syncedGroups) {
    if (syncedAt <= newestSeen) continue;
    if (!complete) break;
    newestSeen = syncedAt;
  }
  if (workItems.length > 0) {
    ensureConfig.run(seenKey, newestSeen, now);
    updateConfig.run(newestSeen, now, seenKey);
  }
}

/**
 * Run extractors for all mapped workspaces.
 */
export async function extractAllFindings(db: Db, client: GithubClient): Promise<void> {
  if (!client.enabled) return;

  const workspaces = db
    .prepare(
      "SELECT repo_owner, repo_name FROM workspaces WHERE repo_owner IS NOT NULL AND repo_name IS NOT NULL",
    )
    .all() as Array<{ repo_owner: string; repo_name: string }>;

  for (const ws of workspaces) {
    await extractFindings(db, client, ws.repo_owner, ws.repo_name);
  }
}
