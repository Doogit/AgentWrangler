import { type GhReviewThread, projectPRHeadKey } from "../../outcomes/github/client.js";
import type { TokenResult } from "../../outcomes/github/credential.js";
import {
  type GhRunResult,
  type GhRunner,
  defaultGhRunner,
} from "../../outcomes/github/gh-cli-client.js";
import type {
  EvidenceGithubClient,
  EvidenceGithubFailureReason,
  EvidenceGithubPullRequest,
  EvidenceGithubRepository,
  EvidenceGithubResult,
} from "./client.js";

const MAX_PAGES = 1_000;
export const EVIDENCE_DIFF_MAX_BYTES = 16 * 1024 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const SAFE_ALIAS = /^[A-Za-z0-9_.-]+$/;
const STRICT_UTC_RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;

const REVIEW_THREADS_QUERY = `query($owner:String!, $repo:String!, $pr:Int!, $cursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$pr) {
      reviewThreads(first:100, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved }
      }
    }
  }
}`;

function fail<T>(reason: EvidenceGithubFailureReason): EvidenceGithubResult<T> {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidRepo(owner: string, repo: string): boolean {
  return (
    owner.length > 0 &&
    repo.length > 0 &&
    owner !== "." &&
    owner !== ".." &&
    repo !== "." &&
    repo !== ".." &&
    SAFE_SEGMENT.test(owner) &&
    SAFE_SEGMENT.test(repo)
  );
}

function isValidPrNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Fixed-width UTC key retains the approved timestamp's nanosecond ordering. */
function utcSortKey(value: string): string | null {
  const match = STRICT_UTC_RFC3339.exec(value);
  const seconds = match?.[1];
  if (seconds === undefined) return null;
  const parsed = new Date(`${seconds}Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== seconds) {
    return null;
  }
  return `${seconds}.${(match?.[2] ?? "").padEnd(9, "0")}Z`;
}

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRunnerResult(value: unknown): value is GhRunResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.ok === "boolean" &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    (typeof value.code === "number" || value.code === null)
  );
}

export class EvidenceGhCliClient implements EvidenceGithubClient {
  private readonly token: string | null;
  private readonly runner: GhRunner;

  constructor(tokenResult: TokenResult, runner: GhRunner = defaultGhRunner) {
    this.token = tokenResult.ok ? tokenResult.data : null;
    this.runner = runner;
  }

  get enabled(): boolean {
    return this.token !== null;
  }

  private async run(
    args: string[],
    input?: string,
    maxStdoutBytes?: number,
  ): Promise<EvidenceGithubResult<GhRunResult>> {
    if (!this.enabled) return fail("EVIDENCE_GITHUB_DISABLED");
    let result: unknown;
    try {
      result = await this.runner(args, {
        token: this.token,
        ...(input === undefined ? {} : { input }),
        ...(maxStdoutBytes === undefined ? {} : { maxStdoutBytes }),
      });
    } catch {
      return fail("EVIDENCE_GITHUB_COMMAND_FAILED");
    }
    if (isRunnerResult(result) && result.failure === "stdout-limit") {
      return fail("EVIDENCE_GITHUB_RESPONSE_TOO_LARGE");
    }
    if (!isRunnerResult(result) || !result.ok) {
      return fail("EVIDENCE_GITHUB_COMMAND_FAILED");
    }
    return { ok: true, data: result };
  }

  async getPRHeadKey(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<EvidenceGithubResult<string | null>> {
    if (!this.enabled) return { ok: false, reason: "EVIDENCE_GITHUB_DISABLED" };
    if (!isValidRepo(owner, repo) || !isValidPrNumber(prNumber)) {
      return { ok: false, reason: "EVIDENCE_GITHUB_REQUEST_INVALID" };
    }
    const result = await this.run(["api", `repos/${owner}/${repo}/pulls/${prNumber}`]);
    if (!result.ok) return result;
    let payload: unknown;
    try {
      payload = JSON.parse(result.data.stdout) as unknown;
    } catch {
      return { ok: false, reason: "EVIDENCE_GITHUB_PAYLOAD_INVALID" };
    }
    const projected = projectPRHeadKey(payload);
    return projected.ok ? projected : { ok: false, reason: "EVIDENCE_GITHUB_PAYLOAD_INVALID" };
  }

  async listMergedPRs(
    repositories: readonly EvidenceGithubRepository[],
    asOf: string,
  ): Promise<EvidenceGithubResult<readonly EvidenceGithubPullRequest[]>> {
    if (!this.enabled) return fail("EVIDENCE_GITHUB_DISABLED");
    const asOfKey = utcSortKey(asOf);
    if (asOfKey === null || repositories.length === 0) {
      return fail("EVIDENCE_GITHUB_REQUEST_INVALID");
    }

    const aliases = new Set<string>();
    for (const repository of repositories) {
      if (
        !isValidRepo(repository.owner, repository.repo) ||
        !SAFE_ALIAS.test(repository.reportAlias) ||
        repository.reportAlias.length === 0 ||
        aliases.has(repository.reportAlias)
      ) {
        return fail("EVIDENCE_GITHUB_REQUEST_INVALID");
      }
      aliases.add(repository.reportAlias);
    }

    const orderedRepos = [...repositories].sort((a, b) =>
      binaryCompare(a.reportAlias, b.reportAlias),
    );
    const rows: EvidenceGithubPullRequest[] = [];

    for (const repository of orderedRepos) {
      const seen = new Map<number, string | null>();
      let completed = false;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const path =
          `repos/${repository.owner}/${repository.repo}/pulls?` +
          `state=closed&sort=updated&direction=desc&per_page=100&page=${page}`;
        const result = await this.run(["api", path]);
        if (!result.ok) return result;

        let payload: unknown;
        try {
          payload = JSON.parse(result.data.stdout) as unknown;
        } catch {
          return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
        }
        if (!Array.isArray(payload)) return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
        if (payload.length > 100) return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
        if (payload.length === 0) {
          completed = true;
          break;
        }

        for (const item of payload) {
          if (
            !isRecord(item) ||
            !isValidPrNumber(item.number as number) ||
            !(typeof item.merged_at === "string" || item.merged_at === null)
          ) {
            return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
          }
          const number = item.number as number;
          const mergedAt = item.merged_at as string | null;
          const mergedAtKey = mergedAt === null ? null : utcSortKey(mergedAt);
          if (mergedAt !== null && mergedAtKey === null) {
            return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
          }
          if (seen.has(number)) {
            return fail(
              seen.get(number) === mergedAt
                ? "EVIDENCE_GITHUB_DUPLICATE"
                : "EVIDENCE_GITHUB_DUPLICATE_CONFLICT",
            );
          }
          seen.set(number, mergedAt);
          if (mergedAt !== null && mergedAtKey !== null && mergedAtKey <= asOfKey) {
            rows.push({ reportAlias: repository.reportAlias, number, mergedAt });
          }
        }
      }
      if (!completed) return fail("EVIDENCE_GITHUB_PAGINATION_LIMIT");
    }

    rows.sort((a, b) => binaryCompare(a.reportAlias, b.reportAlias) || a.number - b.number);
    return { ok: true, data: rows };
  }

  async getPRBody(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<EvidenceGithubResult<string | null>> {
    if (!this.enabled) return fail("EVIDENCE_GITHUB_DISABLED");
    if (!isValidRepo(owner, repo) || !isValidPrNumber(prNumber)) {
      return fail("EVIDENCE_GITHUB_REQUEST_INVALID");
    }
    const result = await this.run(["api", `repos/${owner}/${repo}/pulls/${prNumber}`]);
    if (!result.ok) return result;
    let payload: unknown;
    try {
      payload = JSON.parse(result.data.stdout) as unknown;
    } catch {
      return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
    }
    if (!isRecord(payload) || !(typeof payload.body === "string" || payload.body === null)) {
      return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
    }
    return { ok: true, data: payload.body };
  }

  async getPRDiff(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<EvidenceGithubResult<string>> {
    if (!this.enabled) return fail("EVIDENCE_GITHUB_DISABLED");
    if (!isValidRepo(owner, repo) || !isValidPrNumber(prNumber)) {
      return fail("EVIDENCE_GITHUB_REQUEST_INVALID");
    }
    const result = await this.run(
      [
        "api",
        `repos/${owner}/${repo}/pulls/${prNumber}`,
        "-H",
        "Accept: application/vnd.github.diff",
      ],
      undefined,
      EVIDENCE_DIFF_MAX_BYTES,
    );
    return result.ok ? { ok: true, data: result.data.stdout } : result;
  }

  async getReviewThreads(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<EvidenceGithubResult<readonly GhReviewThread[]>> {
    if (!this.enabled) return fail("EVIDENCE_GITHUB_DISABLED");
    if (!isValidRepo(owner, repo) || !isValidPrNumber(prNumber)) {
      return fail("EVIDENCE_GITHUB_REQUEST_INVALID");
    }

    const threads: GhReviewThread[] = [];
    const threadStates = new Map<string, boolean>();
    const cursors = new Set<string>();
    let cursor: string | null = null;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const input = JSON.stringify({
        query: REVIEW_THREADS_QUERY,
        variables: { owner, repo, pr: prNumber, cursor },
      });
      const result = await this.run(["api", "graphql", "--input", "-"], input);
      if (!result.ok) return result;

      let payload: unknown;
      try {
        payload = JSON.parse(result.data.stdout) as unknown;
      } catch {
        return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
      }
      if (!isRecord(payload)) return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
      if (payload.errors !== undefined) {
        if (!Array.isArray(payload.errors)) return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
        if (payload.errors.length > 0) return fail("EVIDENCE_GITHUB_COMMAND_FAILED");
      }
      const data = payload.data;
      if (!isRecord(data)) return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
      const repository = data.repository;
      if (!isRecord(repository)) return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
      const pullRequest = repository.pullRequest;
      if (!isRecord(pullRequest)) return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
      const reviewThreads = pullRequest.reviewThreads;
      if (!isRecord(reviewThreads) || !Array.isArray(reviewThreads.nodes)) {
        return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
      }
      if (reviewThreads.nodes.length > 100) return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
      const pageInfo = reviewThreads.pageInfo;
      if (
        !isRecord(pageInfo) ||
        typeof pageInfo.hasNextPage !== "boolean" ||
        !(typeof pageInfo.endCursor === "string" || pageInfo.endCursor === null)
      ) {
        return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
      }

      for (const node of reviewThreads.nodes) {
        if (
          !isRecord(node) ||
          typeof node.id !== "string" ||
          node.id.length === 0 ||
          typeof node.isResolved !== "boolean"
        ) {
          return fail("EVIDENCE_GITHUB_PAYLOAD_INVALID");
        }
        if (threadStates.has(node.id)) {
          return fail(
            threadStates.get(node.id) === node.isResolved
              ? "EVIDENCE_GITHUB_DUPLICATE"
              : "EVIDENCE_GITHUB_DUPLICATE_CONFLICT",
          );
        }
        threadStates.set(node.id, node.isResolved);
        threads.push({ id: node.id, isResolved: node.isResolved });
      }

      if (!pageInfo.hasNextPage) {
        threads.sort((a, b) => binaryCompare(a.id, b.id));
        return { ok: true, data: threads };
      }
      if (
        pageInfo.endCursor === null ||
        pageInfo.endCursor.length === 0 ||
        cursors.has(pageInfo.endCursor)
      ) {
        return fail("EVIDENCE_GITHUB_CURSOR_INVALID");
      }
      cursors.add(pageInfo.endCursor);
      cursor = pageInfo.endCursor;
    }

    return fail("EVIDENCE_GITHUB_PAGINATION_LIMIT");
  }
}
