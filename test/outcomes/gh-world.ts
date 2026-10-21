/**
 * test/outcomes/gh-world.ts — one synthetic GitHub state served over BOTH the
 * per-PR REST endpoints and the batched GraphQL PR page, through a fake `gh`
 * runner that COUNTS every invocation by the GithubClient read it serves.
 *
 * The REST responses mirror GitHub's REST payloads (what the pre-S3 code
 * reads); the GraphQL responses mirror the shape recorded in the S3 spike
 * against real GitHub (nodes, lastCommit.statusCheckRollup, field-level
 * FORBIDDEN errors with exit code 1). Synthetic owner/repo only.
 */

import type { GhRunResult, GhRunner } from "../../src/outcomes/github/gh-cli-client.js";

export type WorldState = "OPEN" | "CLOSED" | "MERGED";

export interface WorldPR {
  number: number;
  state: WorldState;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  headRefName: string;
  headSha: string;
  /**
   * REST `merge_commit_sha`. GraphQL serves it as `mergeCommit.oid` for a
   * merged PR and as `potentialMergeCommit.oid` otherwise (spike finding).
   */
  mergeCommitSha: string | null;
  body: string | null;
  commits: Array<{ sha: string; message: string }>;
  threads: Array<{ id: string; isResolved: boolean }>;
  /** REST check-runs aggregate for the head SHA. */
  checks: "SUCCESS" | "FAILURE" | "NONE" | "PENDING";
  /** GraphQL statusCheckRollup.state for the head commit (null = no checks). */
  rollup: "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | "EXPECTED" | null;
  diff: string;
}

export interface WorldRepo {
  prs: WorldPR[];
  /** Token cannot read check runs: REST 403, GraphQL FORBIDDEN field errors. */
  checksForbidden?: boolean;
  /** Per-PR variant: only these PR numbers' checks are unreadable. */
  forbiddenPRs?: Set<number>;
  /** Reverse lookup: commit sha → PR numbers (REST commits/{sha}/pulls). */
  commitPulls?: Map<string, number[]>;
}

export type ReadKind =
  | "listPRs"
  | "getCheckConclusion"
  | "listPRCommits"
  | "getPRBody"
  | "getPRDiff"
  | "listPullsForCommit"
  | "getReviewThreads"
  | "getPRHeadKey"
  | "graphqlPage"
  | "graphqlReads";

export class GhWorld {
  repos = new Map<string, WorldRepo>();
  counts: Record<ReadKind, number> = zeroCounts();
  /** Per-read log: kind + PR number / sha, for exact assertions. */
  log: Array<{ kind: ReadKind; ref: string }> = [];
  /** GraphQL page sizes requested, in order. */
  pageSizes: number[] = [];
  /** GraphQL page query texts, in order. */
  queries: string[] = [];
  /** When set, a GraphQL page request with n above this fails with stdout-limit. */
  maxPageSizeBeforeStdoutLimit: number | undefined;
  /** Aliased-reads batch sizes (PR count per call), in order. */
  readBatchSizes: number[] = [];
  /** When set, a reads batch with more PRs than this fails with stdout-limit. */
  maxReadBatchBeforeStdoutLimit: number | undefined;
  /** When true, every reads batch exits 1 with no stdout (transport failure). */
  failReads = false;
  /** When set, every reads batch fails with this HTTP status (e.g. 401). */
  failReadsHttp: number | undefined;

  repo(owner: string, name: string): WorldRepo {
    const key = `${owner}/${name}`;
    let r = this.repos.get(key);
    if (r === undefined) {
      r = { prs: [] };
      this.repos.set(key, r);
    }
    return r;
  }

  reset(): void {
    this.counts = zeroCounts();
    this.log = [];
    this.pageSizes = [];
    this.queries = [];
    this.readBatchSizes = [];
  }

  /** Total per-PR REST (and per-PR GraphQL threads) reads — everything but the batched calls. */
  perPrReads(): number {
    return Object.entries(this.counts)
      .filter(([k]) => k !== "graphqlPage" && k !== "graphqlReads" && k !== "listPRs")
      .reduce((a, [, v]) => a + v, 0);
  }

  runner(): GhRunner {
    return async (args, opts) => this.serve(args, opts.input, opts.maxStdoutBytes);
  }

  private hit(kind: ReadKind, ref: string): void {
    this.counts[kind] += 1;
    this.log.push({ kind, ref });
  }

  private find(owner: string, name: string): WorldRepo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  private serve(args: string[], input: string | undefined, maxStdoutBytes?: number): GhRunResult {
    if (args[0] !== "api") return fail(1, "unknown command");
    if (args[1] === "graphql") return this.serveGraphql(input ?? "", maxStdoutBytes);
    const route = args[1] ?? "";
    const isDiff = args.includes("Accept: application/vnd.github.diff");
    const [pathPart] = route.split("?");
    const m = /^repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(pathPart ?? "");
    if (m === null) return fail(1, "bad route");
    const [, owner = "", name = "", rest = ""] = m;
    const repo = this.find(owner, name);
    if (repo === undefined) return fail(1, "gh: Not Found (HTTP 404)");

    let mm: RegExpExecArray | null;
    if (rest === "pulls") {
      this.hit("listPRs", "");
      const top = sortByUpdatedDesc(repo.prs).slice(0, 100);
      return ok(JSON.stringify(top.map(restPR)));
    }
    mm = /^commits\/([^/]+)\/check-runs$/.exec(rest);
    if (mm !== null) {
      const sha = mm[1] ?? "";
      this.hit("getCheckConclusion", sha);
      const pr = repo.prs.find((p) => p.headSha === sha);
      if (
        repo.checksForbidden === true ||
        (pr !== undefined && repo.forbiddenPRs?.has(pr.number) === true)
      ) {
        return fail(1, "gh: Resource not accessible by personal access token (HTTP 403)");
      }
      const checks = pr?.checks ?? "NONE";
      const runs =
        checks === "NONE"
          ? []
          : checks === "SUCCESS"
            ? [{ conclusion: "success", status: "completed" }]
            : checks === "FAILURE"
              ? [{ conclusion: "failure", status: "completed" }]
              : [{ conclusion: null, status: "in_progress" }];
      return ok(JSON.stringify({ total_count: runs.length, check_runs: runs }));
    }
    mm = /^commits\/([^/]+)\/pulls$/.exec(rest);
    if (mm !== null) {
      const sha = mm[1] ?? "";
      this.hit("listPullsForCommit", sha);
      const nums = repo.commitPulls?.get(sha) ?? [];
      return ok(JSON.stringify(nums.map((number) => ({ number }))));
    }
    mm = /^pulls\/(\d+)\/commits$/.exec(rest);
    if (mm !== null) {
      const pr = repo.prs.find((p) => p.number === Number(mm?.[1]));
      this.hit("listPRCommits", String(mm[1]));
      if (pr === undefined) return fail(1, "gh: Not Found (HTTP 404)");
      return ok(
        JSON.stringify(
          pr.commits.slice(0, 100).map((c) => ({ sha: c.sha, commit: { message: c.message } })),
        ),
      );
    }
    mm = /^pulls\/(\d+)$/.exec(rest);
    if (mm !== null) {
      const pr = repo.prs.find((p) => p.number === Number(mm?.[1]));
      this.hit(isDiff ? "getPRDiff" : "getPRBody", String(mm[1]));
      if (pr === undefined) return fail(1, "gh: Not Found (HTTP 404)");
      if (isDiff) return ok(pr.diff);
      return ok(JSON.stringify(restPR(pr)));
    }
    return fail(1, "gh: Not Found (HTTP 404)");
  }

  private serveGraphql(input: string, maxStdoutBytes?: number): GhRunResult {
    const req = JSON.parse(input) as { query: string; variables: Record<string, unknown> };
    const v = req.variables;
    const repo = this.find(String(v.owner), String(v.repo));
    if (req.query.includes("pullRequest(number:$pr")) {
      this.hit("getReviewThreads", String(v.pr));
      const pr = repo?.prs.find((p) => p.number === v.pr);
      return ok(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: pr?.threads ?? [],
                },
              },
            },
          },
        }),
      );
    }
    if (!/pullRequests\(/.test(req.query) && /pullRequest\(number:\s*\d+\)/.test(req.query)) {
      return this.serveReads(req.query, repo, maxStdoutBytes);
    }
    if (!/pullRequests\(/.test(req.query)) return fail(1, "unknown graphql query");
    const n = Number(v.n);
    this.hit("graphqlPage", `${String(v.cursor ?? "")}|${n}`);
    this.pageSizes.push(n);
    this.queries.push(req.query);
    if (maxStdoutBytes === undefined) return fail(1, "page read without a stdout cap");
    if (this.maxPageSizeBeforeStdoutLimit !== undefined && n > this.maxPageSizeBeforeStdoutLimit) {
      return {
        ok: false,
        stdout: "",
        stderr: "\n[gh stdout-limit]",
        code: null,
        failure: "stdout-limit",
      };
    }
    if (repo === undefined) {
      return {
        ok: false,
        stdout: JSON.stringify({
          data: { repository: null },
          errors: [{ type: "NOT_FOUND", path: ["repository"], message: "not found" }],
        }),
        stderr: "gh: Could not resolve to a Repository",
        code: 1,
      };
    }
    // Serve only the states the query asks for, as GitHub does.
    const wanted = (/states:\s*\[([^\]]*)\]/.exec(req.query)?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    const sorted = sortByUpdatedDesc(repo.prs).filter((p) => wanted.includes(p.state));
    const start = v.cursor === null || v.cursor === undefined ? 0 : Number(v.cursor);
    const slice = sorted.slice(start, start + n);
    const end = start + slice.length;
    const errors: Array<{ type: string; path: Array<string | number>; message: string }> = [];
    const node = (pr: WorldPR, path: Array<string | number>) => {
      const forbidden = repo.checksForbidden === true || repo.forbiddenPRs?.has(pr.number) === true;
      if (forbidden) {
        errors.push({
          type: "FORBIDDEN",
          path: [...path, "lastCommit", "nodes", 0, "commit", "statusCheckRollup"],
          message: "Resource not accessible by personal access token",
        });
      }
      return gqlPR(pr, forbidden);
    };
    const repository: Record<string, unknown> = {
      pullRequests: {
        pageInfo: { hasNextPage: end < sorted.length, endCursor: end > 0 ? String(end) : null },
        nodes: slice.map((pr, i) => node(pr, ["repository", "pullRequests", "nodes", i])),
      },
    };
    for (const am of req.query.matchAll(/(\w+):\s*pullRequest\(number:\s*(\d+)\)/g)) {
      const alias = am[1] ?? "";
      const pr = repo.prs.find((p) => p.number === Number(am[2]));
      if (pr === undefined) {
        repository[alias] = null;
        errors.push({ type: "NOT_FOUND", path: ["repository", alias], message: "not found" });
      } else {
        repository[alias] = node(pr, ["repository", alias]);
      }
    }
    const body = JSON.stringify({ data: { repository }, ...(errors.length > 0 ? { errors } : {}) });
    if (errors.length > 0) {
      // Real gh exits 1 on any GraphQL error but still prints the full JSON.
      return { ok: false, stdout: body, stderr: "gh: Resource not accessible", code: 1 };
    }
    return ok(body);
  }

  /** Aliased `n<N>: pullRequest(number:N)` batch: body + first 100 commits per PR. */
  private serveReads(
    query: string,
    repo: WorldRepo | undefined,
    maxStdoutBytes?: number,
  ): GhRunResult {
    const aliases = [...query.matchAll(/(\w+):\s*pullRequest\(number:\s*(\d+)\)/g)];
    this.hit("graphqlReads", String(aliases.length));
    this.readBatchSizes.push(aliases.length);
    if (maxStdoutBytes === undefined) return fail(1, "reads batch without a stdout cap");
    if (this.failReadsHttp !== undefined) {
      return fail(1, `gh: failure (HTTP ${this.failReadsHttp})`);
    }
    if (this.failReads) return fail(1, "gh: boom");
    if (
      this.maxReadBatchBeforeStdoutLimit !== undefined &&
      aliases.length > this.maxReadBatchBeforeStdoutLimit
    ) {
      return {
        ok: false,
        stdout: "",
        stderr: "\n[gh stdout-limit]",
        code: null,
        failure: "stdout-limit",
      };
    }
    const errors: Array<{ type: string; path: string[]; message: string }> = [];
    const repository: Record<string, unknown> = {};
    for (const am of aliases) {
      const alias = am[1] ?? "";
      const pr = repo?.prs.find((p) => p.number === Number(am[2]));
      if (pr === undefined) {
        repository[alias] = null;
        errors.push({ type: "NOT_FOUND", path: ["repository", alias], message: "not found" });
      } else {
        repository[alias] = {
          number: pr.number,
          body: pr.body ?? "",
          commits: {
            totalCount: pr.commits.length,
            nodes: pr.commits
              .slice(0, 100)
              .map((c) => ({ commit: { oid: c.sha, message: c.message } })),
          },
        };
      }
    }
    const body = JSON.stringify({ data: { repository }, ...(errors.length > 0 ? { errors } : {}) });
    if (errors.length > 0) return { ok: false, stdout: body, stderr: "gh: not found", code: 1 };
    return ok(body);
  }
}

function zeroCounts(): Record<ReadKind, number> {
  return {
    listPRs: 0,
    getCheckConclusion: 0,
    listPRCommits: 0,
    getPRBody: 0,
    getPRDiff: 0,
    listPullsForCommit: 0,
    getReviewThreads: 0,
    getPRHeadKey: 0,
    graphqlPage: 0,
    graphqlReads: 0,
  };
}

function ok(stdout: string): GhRunResult {
  return { ok: true, stdout, stderr: "", code: 0 };
}

function fail(code: number, stderr: string): GhRunResult {
  const m = /\(HTTP (\d+)\)/.exec(stderr);
  return {
    ok: false,
    stdout: "",
    stderr,
    code,
    ...(m?.[1] !== undefined ? { httpStatus: Number(m[1]) } : {}),
  };
}

function sortByUpdatedDesc(prs: WorldPR[]): WorldPR[] {
  return [...prs].sort((a, b) =>
    a.updatedAt === b.updatedAt ? b.number - a.number : a.updatedAt < b.updatedAt ? 1 : -1,
  );
}

function restPR(pr: WorldPR): Record<string, unknown> {
  return {
    number: pr.number,
    state: pr.state === "OPEN" ? "open" : "closed",
    merged_at: pr.mergedAt,
    closed_at: pr.closedAt,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    merge_commit_sha: pr.mergeCommitSha,
    body: pr.body,
    head: { sha: pr.headSha, ref: pr.headRefName },
  };
}

function gqlPR(pr: WorldPR, forbidden: boolean): Record<string, unknown> {
  const merged = pr.state === "MERGED";
  return {
    number: pr.number,
    state: pr.state,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    headRefName: pr.headRefName,
    headRefOid: pr.headSha,
    mergeCommit: merged && pr.mergeCommitSha !== null ? { oid: pr.mergeCommitSha } : null,
    potentialMergeCommit: !merged && pr.mergeCommitSha !== null ? { oid: pr.mergeCommitSha } : null,
    body: pr.body ?? "",
    commits: {
      totalCount: pr.commits.length,
      nodes: pr.commits.slice(0, 100).map((c) => ({ commit: { oid: c.sha, message: c.message } })),
    },
    reviewThreads: {
      totalCount: pr.threads.length,
      nodes: pr.threads.slice(0, 100),
    },
    lastCommit: {
      nodes: [
        {
          commit: {
            oid: pr.headSha,
            statusCheckRollup: forbidden || pr.rollup === null ? null : { state: pr.rollup },
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// PR builders
// ---------------------------------------------------------------------------

export function mergedPR(n: number, updatedAt: string, over: Partial<WorldPR> = {}): WorldPR {
  return {
    number: n,
    state: "MERGED",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    mergedAt: updatedAt,
    closedAt: updatedAt,
    headRefName: `feature/pr-${n}`,
    headSha: `head-${n}`,
    mergeCommitSha: `merge-${n}`,
    body: null,
    commits: [{ sha: `c-${n}-0`, message: "plain commit" }],
    threads: [],
    checks: "SUCCESS",
    rollup: "SUCCESS",
    diff: "",
    ...over,
  };
}

export function openPR(n: number, updatedAt: string, over: Partial<WorldPR> = {}): WorldPR {
  return mergedPR(n, updatedAt, {
    state: "OPEN",
    mergedAt: null,
    closedAt: null,
    mergeCommitSha: `test-merge-${n}`,
    ...over,
  });
}

export function closedPR(n: number, updatedAt: string, over: Partial<WorldPR> = {}): WorldPR {
  return mergedPR(n, updatedAt, {
    state: "CLOSED",
    mergedAt: null,
    closedAt: updatedAt,
    mergeCommitSha: null,
    ...over,
  });
}

/** ISO timestamp `2026-08-DDTHH:00:00Z` from an ordinal, strictly increasing. */
export function ts(i: number): string {
  const d = new Date(Date.UTC(2026, 7, 1) + i * 3_600_000);
  return d.toISOString().replace(".000Z", "Z");
}
