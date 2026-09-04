import type { GhReviewThread } from "../../outcomes/github/client.js";

export interface EvidenceGithubRepository {
  owner: string;
  repo: string;
  reportAlias: string;
}

export interface EvidenceGithubPullRequest {
  reportAlias: string;
  number: number;
  mergedAt: string;
}

export type EvidenceGithubFailureReason =
  | "EVIDENCE_GITHUB_DISABLED"
  | "EVIDENCE_GITHUB_REQUEST_INVALID"
  | "EVIDENCE_GITHUB_COMMAND_FAILED"
  | "EVIDENCE_GITHUB_RESPONSE_TOO_LARGE"
  | "EVIDENCE_GITHUB_PAYLOAD_INVALID"
  | "EVIDENCE_GITHUB_PAGINATION_LIMIT"
  | "EVIDENCE_GITHUB_CURSOR_INVALID"
  | "EVIDENCE_GITHUB_DUPLICATE"
  | "EVIDENCE_GITHUB_DUPLICATE_CONFLICT";

export type EvidenceGithubResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: EvidenceGithubFailureReason };

/**
 * Narrow read surface for the approved R3/COND-1 evidence campaigns.
 * It is intentionally separate from the daemon's broader GithubClient.
 */
export interface EvidenceGithubClient {
  readonly enabled: boolean;
  getPRHeadKey(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<EvidenceGithubResult<string | null>>;
  listMergedPRs(
    repositories: readonly EvidenceGithubRepository[],
    asOf: string,
  ): Promise<EvidenceGithubResult<readonly EvidenceGithubPullRequest[]>>;
  getPRBody(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<EvidenceGithubResult<string | null>>;
  getPRDiff(owner: string, repo: string, prNumber: number): Promise<EvidenceGithubResult<string>>;
  getReviewThreads(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<EvidenceGithubResult<readonly GhReviewThread[]>>;
}
