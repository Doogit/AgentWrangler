/**
 * test/outcomes/s3-scenario.ts — the shared two-pass GitHub scenario used by
 * the S3 row-equivalence test. The golden rows in s3-golden.json were produced
 * by running the PRE-S3 REST code (47751fde: listPRs + per-PR reads) against
 * this exact scenario, before any S3 source change. Synthetic owner/repo only.
 * Branch-key hashes are relabelled `fp(<ref>)` (a bijection over the scenario's
 * refs) so the fixture holds no 64-hex strings for the secret scanner to flag.
 */

import type Database from "better-sqlite3";
import { fingerprintBranchRef } from "../../src/outcomes/branch-key.js";
import { GhWorld, closedPR, mergedPR, openPR } from "./gh-world.js";

const REF_LABELS = new Map(
  Array.from({ length: 20 }, (_, i) => `feature/pr-${i + 1}`).map((ref) => [
    fingerprintBranchRef(ref),
    `fp(${ref})`,
  ]),
);

export const T1 = "2026-09-01T00:00:00.000Z";
export const T2 = "2026-09-01T00:10:00.000Z";
export const OWNER = "acme";
export const REPO = "repo-alpha";

const TODO_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,1 +1,3 @@",
  " const a = 1;",
  "+// TODO: follow up on the retry path",
  "+// FIXME handle the empty case",
].join("\n");

const DEFERRED_BODY = "Summary\n\n## Deferred\n- item one\n- item two\n";
const TRAILER = "Claude-Session: https://claude.ai/code/session_sess-a1";

export function mapWorkspace(db: Database.Database): void {
  db.prepare("UPDATE workspaces SET repo_owner=?, repo_name=? WHERE workspace_id='ws-alpha'").run(
    OWNER,
    REPO,
  );
}

/** Bash tool events: sess-a1 links by trailer, sess-a2 by SHA overlap, sess-a3 by reverse lookup. */
export function seedSessions(db: Database.Database): void {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO tool_events (event_id, session_id, ts, tool_name, commit_sha)
     VALUES (?, ?, '2026-01-01T00:00:00Z', 'Bash', ?)`,
  );
  ins.run("te-s3-a1", "sess-a1", null);
  ins.run("te-s3-a2", "sess-a2", "c-3-0");
  ins.run("te-s3-a3", "sess-a3", "orphan-sha");
}

export function buildWorldPass1(): GhWorld {
  const world = new GhWorld();
  const repo = world.repo(OWNER, REPO);
  repo.commitPulls = new Map([["orphan-sha", [5]]]);
  repo.prs = [
    mergedPR(1, "2026-08-01T00:00:00Z", {
      commits: [{ sha: "c-1-0", message: `feat: one\n\n${TRAILER}` }],
      threads: [
        { id: "th-1a", isResolved: false },
        { id: "th-1b", isResolved: true },
      ],
      diff: TODO_DIFF,
    }),
    mergedPR(2, "2026-08-02T00:00:00Z", {
      checks: "FAILURE",
      rollup: "FAILURE",
      body: DEFERRED_BODY,
    }),
    closedPR(3, "2026-08-03T00:00:00Z", {
      checks: "NONE",
      rollup: null,
      commits: [{ sha: "c-3-0", message: "wip" }],
    }),
    closedPR(4, "2026-08-04T00:00:00Z", {
      mergeCommitSha: "pm-4",
      body: `Body\n\n${TRAILER}\n`,
    }),
    mergedPR(5, "2026-08-05T00:00:00Z", { checks: "NONE", rollup: null }),
    openPR(6, "2026-08-06T00:00:00Z", {
      checks: "PENDING",
      rollup: "PENDING",
      threads: [{ id: "th-6", isResolved: false }],
      body: DEFERRED_BODY,
    }),
    openPR(7, "2026-08-07T00:00:00Z", {
      headRefName: "HEAD",
      checks: "PENDING",
      rollup: "PENDING",
    }),
    mergedPR(8, "2026-08-08T00:00:00Z", { diff: TODO_DIFF }),
  ];
  return world;
}

/** Pass 2 state: #6 merges, #7's checks finish without an updatedAt bump, #9 is new, #1 gets a comment. */
export function advanceWorldToPass2(world: GhWorld): void {
  const repo = world.repo(OWNER, REPO);
  const byNumber = (n: number) => {
    const pr = repo.prs.find((p) => p.number === n);
    if (pr === undefined) throw new Error(`missing PR ${n}`);
    return pr;
  };
  Object.assign(byNumber(1), { updatedAt: "2026-08-20T00:00:00Z" });
  Object.assign(byNumber(6), {
    state: "MERGED",
    updatedAt: "2026-08-21T00:00:00Z",
    mergedAt: "2026-08-21T00:00:00Z",
    closedAt: "2026-08-21T00:00:00Z",
    mergeCommitSha: "merge-6",
    checks: "SUCCESS",
    rollup: "SUCCESS",
    threads: [{ id: "th-6", isResolved: true }],
    diff: TODO_DIFF,
  });
  Object.assign(byNumber(7), { checks: "SUCCESS", rollup: "SUCCESS" });
  repo.prs.push(mergedPR(9, "2026-08-22T00:00:00Z", { body: DEFERRED_BODY, diff: TODO_DIFF }));
}

export interface RowSnapshot {
  workItems: unknown[];
  branchKeys: unknown[];
  links: unknown[];
  findings: unknown[];
}

export function snapshotRows(db: Database.Database): RowSnapshot {
  return {
    workItems: db
      .prepare(
        `SELECT work_item_id, workspace_id, number, state, final_commit, checks_conclusion,
                opened_at, merged_at, closed_at, synced_at
           FROM work_items ORDER BY work_item_id`,
      )
      .all(),
    branchKeys: db
      .prepare(
        `SELECT work_item_id, head_ref_key, normalization_version, synced_at
           FROM work_item_branch_keys ORDER BY work_item_id`,
      )
      .all()
      .map((row) => {
        const r = row as { head_ref_key: string };
        return { ...r, head_ref_key: REF_LABELS.get(r.head_ref_key) ?? r.head_ref_key };
      }),
    links: db
      .prepare(
        `SELECT session_id, work_item_id, confidence, method
           FROM session_work_links ORDER BY session_id, work_item_id`,
      )
      .all(),
    findings: db
      .prepare(
        `SELECT finding_id, work_item_id, source, severity, status, evidence_ref, confidence,
                raised_at, cleared_at, cleared_by, extractor_version
           FROM review_findings ORDER BY finding_id`,
      )
      .all(),
  };
}
