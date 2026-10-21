/**
 * src/outcomes/github/pr-page.ts — one batched GraphQL page of PRs (P0-U13 S3).
 *
 * One `repository.pullRequests(first:n, orderBy UPDATED_AT DESC)` page returns,
 * per PR, everything the outcomes stages used to read with separate REST calls:
 * the listing fields, body, commits (first 100, same cap as REST), review
 * threads (first 100) and the head commit's statusCheckRollup. The first page
 * of a pass also carries PRs named by number (aliases `n<number>`) so they
 * re-resolve without extra calls. Only MERGED and CLOSED PRs are listed: OPEN
 * PRs are never requested (operator decision 2026-09-28, P0-U13 S3).
 *
 * Field shapes follow the 2026-09-28 spike against real GitHub. Bodies and
 * commit messages live only in the pass-scoped PassPrPages (never stored).
 */

import { fingerprintBranchRef } from "../branch-key.js";
import { conclusionFromRollup } from "../conclusions.js";
import type { GhPR, GhResult, GhReviewThread } from "./client.js";

export interface GhPagePR {
  /** Same projection the REST listing produced (client.ts projectPRPage). */
  pr: GhPR;
  body: string;
  commits: Array<{ sha: string; message: string }>;
  /** null when the PR has more threads than one page holds: read them per PR. */
  threads: GhReviewThread[] | null;
  /** SUCCESS/NONE when the rollup settles it; null → use the per-SHA REST read. */
  checks: "SUCCESS" | "NONE" | null;
  /** The token cannot read this PR's statusCheckRollup: checks are unknown (a null rollup is NOT "NONE"). */
  checksForbidden: boolean;
}

export interface GhPRPage {
  /** The UPDATED_AT-desc listing, in order (drives paging and the watermark stop). */
  prs: GhPagePR[];
  /** By-number PRs from the first page's aliases. */
  extras: GhPagePR[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface PRPageRequest {
  cursor: string | null;
  /** Extra PR numbers to read by alias (first page of a pass only). */
  numbers: readonly number[];
}

export const PR_PAGE_SIZE = 50;
export const PR_PAGE_RETRY_SIZE = 25;
export const PR_PAGE_MAX_STDOUT_BYTES = 4 * 1024 * 1024;

const PR_FIELDS = `fragment PR on PullRequest {
  number state createdAt updatedAt mergedAt closedAt headRefName headRefOid
  mergeCommit { oid } potentialMergeCommit { oid } body
  commits(first: 100) { totalCount nodes { commit { oid message } } }
  reviewThreads(first: 100) { totalCount nodes { id isResolved } }
  lastCommit: commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
}`;

export function buildPRPageQuery(numbers: readonly number[]): string {
  const aliases = numbers
    .filter((n) => Number.isInteger(n) && n > 0)
    .map((n) => `    n${n}: pullRequest(number: ${n}) { ...PR }`)
    .join("\n");
  return `${PR_FIELDS}
query($owner: String!, $repo: String!, $n: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: $n, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}, states: [MERGED, CLOSED]) {
      pageInfo { hasNextPage endCursor }
      nodes { ...PR }
    }
${aliases}
  }
}`;
}

/** What the linker's per-PR fallback reads: commits (first 100, as REST) and body. */
export interface GhPRRead {
  body: string;
  commits: Array<{ sha: string; message: string }>;
}

/** PRs per aliased reads call (spike: ~4–8 KB per PR, so 50 stays well under the stdout cap). */
export const PR_READ_BATCH = 50;

const PR_READ_FIELDS = `fragment R on PullRequest {
  number body
  commits(first: 100) { totalCount nodes { commit { oid message } } }
}`;

export function buildPRReadsQuery(numbers: readonly number[]): string {
  const aliases = numbers
    .filter((n) => Number.isInteger(n) && n > 0)
    .map((n) => `    n${n}: pullRequest(number: ${n}) { ...R }`)
    .join("\n");
  return `${PR_READ_FIELDS}
query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
${aliases}
  }
}`;
}

/**
 * Validate and project one aliased-reads body. A missing/null alias (deleted or
 * unreadable PR) or a malformed node is simply absent from the map: the caller
 * falls back to the per-PR REST reads for it. Any other error fails the batch.
 */
export function projectPRReads(body: unknown): GhResult<Map<number, GhPRRead>> {
  const invalid = { ok: false as const, reason: "github-pr-payload-invalid" };
  if (!isRecord(body)) return invalid;
  if (body.errors !== undefined) {
    if (!Array.isArray(body.errors)) return invalid;
    for (const e of body.errors) {
      const type = isRecord(e) ? e.type : undefined;
      const path = isRecord(e) && Array.isArray(e.path) ? e.path : [];
      if (type === "RATE_LIMITED") return { ok: false, reason: "github-graphql-error:429" };
      const notFoundAlias =
        type === "NOT_FOUND" &&
        path.length === 2 &&
        path[0] === "repository" &&
        typeof path[1] === "string" &&
        /^n\d+$/.test(path[1]);
      if (!notFoundAlias) return { ok: false, reason: "github-graphql-errors" };
    }
  }
  const repository = isRecord(body.data) ? body.data.repository : undefined;
  if (!isRecord(repository)) return invalid;
  const reads = new Map<number, GhPRRead>();
  for (const [alias, node] of Object.entries(repository)) {
    if (!/^n\d+$/.test(alias) || !isRecord(node)) continue;
    const { number, body: prBody, commits } = node;
    if (!Number.isInteger(number) || !isNullableString(prBody)) continue;
    if (!isRecord(commits) || !Array.isArray(commits.nodes)) continue;
    const list: Array<{ sha: string; message: string }> = [];
    let valid = true;
    for (const c of commits.nodes) {
      const commit = isRecord(c) ? c.commit : undefined;
      if (!isRecord(commit) || typeof commit.oid !== "string") {
        valid = false;
        break;
      }
      list.push({
        sha: commit.oid,
        message: typeof commit.message === "string" ? commit.message : "",
      });
    }
    if (valid) reads.set(number as number, { body: prBody ?? "", commits: list });
  }
  return { ok: true, data: reads };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function oidOf(value: unknown): string | null {
  return isRecord(value) && typeof value.oid === "string" ? value.oid : null;
}

function projectNode(node: unknown, forbidden: boolean): GhPagePR | null {
  if (!isRecord(node)) return null;
  const {
    number,
    state,
    createdAt,
    updatedAt,
    mergedAt,
    closedAt,
    headRefName,
    headRefOid,
    body,
    commits,
    reviewThreads,
    lastCommit,
  } = node;
  if (
    !Number.isInteger(number) ||
    (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string" ||
    !isNullableString(mergedAt) ||
    !isNullableString(closedAt) ||
    typeof headRefName !== "string" ||
    typeof headRefOid !== "string" ||
    !isNullableString(body) ||
    !isRecord(commits) ||
    !Array.isArray(commits.nodes) ||
    !isRecord(reviewThreads) ||
    !Array.isArray(reviewThreads.nodes) ||
    typeof reviewThreads.totalCount !== "number" ||
    !isRecord(lastCommit) ||
    !Array.isArray(lastCommit.nodes)
  ) {
    return null;
  }

  const commitList: Array<{ sha: string; message: string }> = [];
  for (const c of commits.nodes) {
    const commit = isRecord(c) ? c.commit : undefined;
    if (!isRecord(commit) || typeof commit.oid !== "string") return null;
    commitList.push({
      sha: commit.oid,
      message: typeof commit.message === "string" ? commit.message : "",
    });
  }
  const threads: GhReviewThread[] = [];
  for (const t of reviewThreads.nodes) {
    if (!isRecord(t) || typeof t.id !== "string" || typeof t.isResolved !== "boolean") return null;
    threads.push({ id: t.id, isResolved: t.isResolved });
  }

  // Checks come from the rollup only when it belongs to the head the REST read
  // would have used (row.pr.head.sha); anything else falls back to REST.
  const head = isRecord(lastCommit.nodes[0]) ? lastCommit.nodes[0].commit : undefined;
  // A forbidden PR's rollup arrives as null: that is unknown, never "NONE".
  let checks: GhPagePR["checks"] = null;
  if (!forbidden && isRecord(head) && head.oid === headRefOid)
    checks = conclusionFromRollup(head.statusCheckRollup);

  return {
    pr: {
      number: number as number,
      // REST reports merged PRs as "closed"; sync derives MERGED from merged_at.
      state: state === "OPEN" ? "open" : "closed",
      merged_at: mergedAt,
      closed_at: closedAt,
      created_at: createdAt,
      // REST merge_commit_sha: the merge commit once merged, else the test merge commit.
      merge_commit_sha: oidOf(node.mergeCommit) ?? oidOf(node.potentialMergeCommit),
      head: { sha: headRefOid, refKey: fingerprintBranchRef(headRefName) },
      updated_at: updatedAt,
    },
    body: body ?? "",
    commits: commitList,
    threads: reviewThreads.totalCount > threads.length ? null : threads,
    checks,
    checksForbidden: forbidden,
  };
}

/**
 * Validate and project one GraphQL page body. Field-level errors are
 * classified, not fatal: FORBIDDEN on statusCheckRollup marks the page's checks
 * unknown, a missing by-number alias is dropped; any other error fails the page.
 */
export function projectGraphqlPRPage(body: unknown): GhResult<GhPRPage> {
  const invalid = { ok: false as const, reason: "github-pr-payload-invalid" };
  if (!isRecord(body)) return invalid;

  // FORBIDDEN is scoped to the PR whose rollup errored: `L<index>` for a listing
  // node, the alias for a by-number PR. A path of unknown shape forbids the page.
  const forbiddenNodes = new Set<string>();
  let forbiddenPage = false;
  if (body.errors !== undefined) {
    if (!Array.isArray(body.errors)) return invalid;
    for (const e of body.errors) {
      const type = isRecord(e) ? e.type : undefined;
      const path = isRecord(e) && Array.isArray(e.path) ? e.path : [];
      if (type === "FORBIDDEN" && path.includes("statusCheckRollup")) {
        if (path[1] === "pullRequests" && path[2] === "nodes" && typeof path[3] === "number") {
          forbiddenNodes.add(`L${path[3]}`);
        } else if (typeof path[1] === "string" && /^n\d+$/.test(path[1])) {
          forbiddenNodes.add(path[1]);
        } else {
          forbiddenPage = true;
        }
      } else if (
        type === "NOT_FOUND" &&
        path.length === 2 &&
        path[0] === "repository" &&
        typeof path[1] === "string" &&
        /^n\d+$/.test(path[1])
      ) {
        // A PR named by number no longer resolves; it simply is not on the page.
      } else if (type === "RATE_LIMITED") {
        return { ok: false, reason: "github-graphql-error:429" };
      } else {
        return { ok: false, reason: "github-graphql-errors" };
      }
    }
  }

  const repository = isRecord(body.data) ? body.data.repository : undefined;
  if (!isRecord(repository)) return invalid;
  const listing = repository.pullRequests;
  if (!isRecord(listing) || !Array.isArray(listing.nodes) || !isRecord(listing.pageInfo)) {
    return invalid;
  }
  const { hasNextPage, endCursor } = listing.pageInfo;
  if (typeof hasNextPage !== "boolean" || !isNullableString(endCursor)) return invalid;

  const prs: GhPagePR[] = [];
  for (const [i, node] of listing.nodes.entries()) {
    const projected = projectNode(node, forbiddenPage || forbiddenNodes.has(`L${i}`));
    if (projected === null) return invalid;
    prs.push(projected);
  }

  const extras: GhPagePR[] = [];
  for (const [alias, node] of Object.entries(repository)) {
    if (!/^n\d+$/.test(alias) || node === null) continue;
    const projected = projectNode(node, forbiddenPage || forbiddenNodes.has(alias));
    if (projected === null) return invalid;
    extras.push(projected);
  }

  return { ok: true, data: { prs, extras, hasNextPage, endCursor } };
}

/**
 * Pass-scoped page data shared by sync → link → findings. Created once per
 * outcomes pass (src/daemon/outcomes-pass.ts) and discarded with it; sync
 * replaces a repo's entry every time it reads that repo.
 */
export class PassPrPages {
  private readonly repos = new Map<string, ReadonlyMap<number, GhPagePR>>();

  set(owner: string, repo: string, prs: ReadonlyMap<number, GhPagePR>): void {
    this.repos.set(`${owner}/${repo}`, prs);
  }

  get(owner: string, repo: string, prNumber: number): GhPagePR | undefined {
    return this.repos.get(`${owner}/${repo}`)?.get(prNumber);
  }
}
