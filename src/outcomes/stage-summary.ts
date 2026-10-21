import type { GhResult, GithubClient } from "./github/client.js";
import type { PRPageRequest } from "./github/pr-page.js";

export type OutcomeFailureCode =
  | "unauthorized"
  | "access-ambiguous"
  | "not-found-ambiguous"
  | "rate-limited"
  | "timeout"
  | "gh-missing"
  | "malformed"
  | "transport"
  | "provider-error";

export interface OutcomeStageSummary {
  eligibleRepositories: number;
  attemptedReads: number;
  failedReads: number;
  categories: Partial<Record<OutcomeFailureCode, number>>;
  repositories: Array<{
    attemptedReads: number;
    failedReads: number;
    categories: Partial<Record<OutcomeFailureCode, number>>;
  }>;
}

export function failureCode(reason: string): OutcomeFailureCode {
  if (/:401(?:\b|$)/.test(reason)) return "unauthorized";
  if (/:403(?:\b|$)/.test(reason)) return "access-ambiguous";
  if (/:404(?:\b|$)/.test(reason)) return "not-found-ambiguous";
  if (/:429(?:\b|$)/.test(reason)) return "rate-limited";
  if (/timeout|abort/i.test(reason)) return "timeout";
  if (/gh-not-found|ENOENT/i.test(reason)) return "gh-missing";
  if (/invalid|malformed|stdout-limit/i.test(reason)) return "malformed";
  if (/fetch|spawn|transport/i.test(reason)) return "transport";
  return "provider-error";
}

export function newStageSummary(eligibleRepositories = 0): OutcomeStageSummary {
  return {
    eligibleRepositories,
    attemptedReads: 0,
    failedReads: 0,
    categories: {},
    repositories: [],
  };
}

/** Observe every provider read without retaining repository names, payloads or raw errors. */
export function observeGithubClient(
  client: GithubClient,
  summary: OutcomeStageSummary,
): GithubClient {
  const byRepo = new Map<string, OutcomeStageSummary["repositories"][number]>();
  const observe = async <T>(
    owner: string,
    repo: string,
    read: () => Promise<GhResult<T>>,
  ): Promise<GhResult<T>> => {
    let repository = byRepo.get(`${owner}/${repo}`);
    if (!repository) {
      repository = { attemptedReads: 0, failedReads: 0, categories: {} };
      byRepo.set(`${owner}/${repo}`, repository);
      summary.repositories.push(repository);
    }
    summary.attemptedReads++;
    repository.attemptedReads++;
    let result: GhResult<T>;
    try {
      result = await read();
    } catch {
      result = { ok: false, reason: "transport" };
    }
    if (!result.ok) {
      const code = failureCode(result.reason);
      summary.failedReads++;
      repository.failedReads++;
      summary.categories[code] = (summary.categories[code] ?? 0) + 1;
      repository.categories[code] = (repository.categories[code] ?? 0) + 1;
    }
    return result;
  };
  const listPRPage = client.listPRPage;
  const listPRReads = client.listPRReads;
  return {
    ...(listPRReads === undefined
      ? {}
      : {
          listPRReads: (o: string, r: string, numbers: readonly number[]) =>
            observe(o, r, () => listPRReads.call(client, o, r, numbers)),
        }),
    ...(listPRPage === undefined
      ? {}
      : {
          listPRPage: (o: string, r: string, req: PRPageRequest) =>
            observe(o, r, () => listPRPage.call(client, o, r, req)),
        }),
    enabled: client.enabled,
    listPRs: (o, r, s) => observe(o, r, () => client.listPRs(o, r, s)),
    getPRHeadKey: (o, r, n) => observe(o, r, () => client.getPRHeadKey(o, r, n)),
    getCheckConclusion: (o, r, ref) => observe(o, r, () => client.getCheckConclusion(o, r, ref)),
    listPRCommits: (o, r, n) => observe(o, r, () => client.listPRCommits(o, r, n)),
    listPullsForCommit: (o, r, sha) => observe(o, r, () => client.listPullsForCommit(o, r, sha)),
    getPRBody: (o, r, n) => observe(o, r, () => client.getPRBody(o, r, n)),
    getPRDiff: (o, r, n) => observe(o, r, () => client.getPRDiff(o, r, n)),
    getReviewThreads: (o, r, n) => observe(o, r, () => client.getReviewThreads(o, r, n)),
  };
}
