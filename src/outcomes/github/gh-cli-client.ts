/**
 * src/outcomes/github/gh-cli-client.ts — GitHub reads via the `gh` CLI.
 *
 * Why this exists (T1 round 2 — event-loop starvation):
 *   The fetch-based GithubSyncClient does its socket reads AND its
 *   AbortSignal.timeout on the daemon's single event loop. During the outcomes
 *   pass that loop is monopolised by the synchronous transcript-harvest / SHA
 *   loop, so undici's socket callbacks are starved past the abort deadline and
 *   even a prompt GitHub reply (~0.25s) aborts at the timeout — the pass never
 *   reaches writeObservedOutcomes.
 *
 *   GhCliClient moves every GitHub read into a `gh api` child process. That
 *   process has its OWN event loop, so the network completes independently of
 *   the jammed parent loop; the parent only reads the finished result off an
 *   OS-buffered pipe once it drains (linkSessions' setImmediate yields keep jam
 *   windows short). No undici timers on the hot loop → no starvation aborts.
 *
 * Same contract as GithubSyncClient (implements GithubClient):
 *   - Disabled (token ok:false) → every method returns {ok:false} and spawns
 *     ZERO processes.
 *   - Never throws; always {ok,data}|{ok:false,reason} (clean degradation).
 *   - If `gh` is not installed the spawn error degrades to {ok:false,reason}.
 *
 * Auth: the daemon's own credential (Windows Credential Manager PAT) is passed
 * to `gh` via GH_TOKEN, so AgentWrangler keeps using its configured token
 * rather than whatever account `gh auth login` happens to hold.
 *
 * Note vs the fetch client: no ETag/304 conditional-request caching on this
 * path (gh does not expose it); the sync watermark still bounds volume.
 */

import { spawn } from "node:child_process";
import { type CheckRunsBody, aggregateCheckConclusion, normalizePRBody } from "../conclusions.js";
import {
  type GhPR,
  type GhResult,
  type GhReviewThread,
  type GithubClient,
  projectPRHeadKey,
  projectPRPage,
} from "./client.js";
import type { TokenResult } from "./credential.js";

// ---------------------------------------------------------------------------
// Child-process runner (injectable for tests)
// ---------------------------------------------------------------------------

export interface GhRunResult {
  /** Process exited 0. */
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  /** HTTP status parsed from a `gh` error line, if present. */
  httpStatus?: number;
  /** Local transport refusal; never contains response or credential content. */
  failure?: "timeout" | "stdout-limit";
}

export type GhRunner = (
  args: string[],
  opts: {
    input?: string;
    token: string | null;
    /** Optional streaming stdout cap. Omitted preserves the daemon's existing unlimited behavior. */
    maxStdoutBytes?: number;
    /** Testable timeout override. Omitted preserves the production 20-second bound. */
    timeoutMs?: number;
  },
) => Promise<GhRunResult>;

/**
 * Termination bound for a single `gh` invocation. `gh` returns in ~0.25s;
 * this generous backstop only fires if the parent loop is wedged continuously.
 * Settlement follows the child's `close` event so cleanup never races open stdio.
 */
const GH_HARD_TIMEOUT_MS = 20_000;

/** gh: "... (HTTP 404)" → 404. */
function parseHttpStatus(stderr: string): number | undefined {
  const m = /\(HTTP (\d+)\)/.exec(stderr);
  return m?.[1] !== undefined ? Number.parseInt(m[1], 10) : undefined;
}

export type GhSpawn = typeof spawn;

/** Build the shared runner around an injectable spawn implementation. */
export function createGhRunner(spawnFn: GhSpawn = spawn): GhRunner {
  return (args, opts) =>
    new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1" };
      if (opts.token !== null) env.GH_TOKEN = opts.token;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawnFn("gh", args, { env, windowsHide: true });
      } catch (e: unknown) {
        resolve({
          ok: false,
          stdout: "",
          stderr: e instanceof Error ? e.message : String(e),
          code: null,
        });
        return;
      }

      // FIX 2: Collect Buffer chunks and decode once on close to avoid UTF-8
      // corruption at pipe-chunk boundaries (e.g. multibyte chars in PR titles).
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let termination: GhRunResult["failure"];
      let settled = false;
      const settle = (r: GhRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        if (termination !== undefined) return;
        termination = "timeout";
        child.kill("SIGKILL");
        // Do not settle here. `close` proves the child and its stdio handles are done.
      }, opts.timeoutMs ?? GH_HARD_TIMEOUT_MS);

      child.stdout?.on("data", (d: Buffer) => {
        if (termination !== undefined) return;
        if (opts.maxStdoutBytes !== undefined && stdoutBytes + d.byteLength > opts.maxStdoutBytes) {
          termination = "stdout-limit";
          child.kill("SIGKILL");
          return;
        }
        outChunks.push(d);
        stdoutBytes += d.byteLength;
      });
      child.stderr?.on("data", (d: Buffer) => {
        errChunks.push(d);
      });
      // ENOENT (gh not installed) and other spawn failures arrive here.
      child.on("error", (e: Error) => {
        if (termination !== undefined) return;
        const stdout = Buffer.concat(outChunks).toString("utf8");
        settle({ ok: false, stdout, stderr: e.message, code: null });
      });
      child.on("close", (code: number | null) => {
        const stdout = Buffer.concat(outChunks).toString("utf8");
        const stderr = Buffer.concat(errChunks).toString("utf8");
        const httpStatus = parseHttpStatus(stderr);
        const terminationMarker =
          termination === "timeout"
            ? "\n[gh hard-timeout]"
            : termination === "stdout-limit"
              ? "\n[gh stdout-limit]"
              : "";
        settle({
          ok: termination === undefined && code === 0,
          stdout,
          stderr: `${stderr}${terminationMarker}`,
          code,
          ...(httpStatus !== undefined ? { httpStatus } : {}),
          ...(termination !== undefined ? { failure: termination } : {}),
        });
      });

      // FIX 1: Guard stdin against EPIPE — if gh exits before reading stdin (e.g.
      // ENOENT when gh is absent, or a fast auth failure), writing to the closed
      // pipe would emit an unhandled 'error' event and crash the daemon.
      child.stdin?.on("error", () => {});
      if (opts.input !== undefined) child.stdin?.write(opts.input);
      child.stdin?.end();
    });
}

export const defaultGhRunner: GhRunner = createGhRunner();

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GhCliClient implements GithubClient {
  private readonly token: string | null;
  private readonly runner: GhRunner;

  constructor(tokenResult: TokenResult, runner: GhRunner = defaultGhRunner) {
    this.token = tokenResult.ok ? tokenResult.data : null;
    this.runner = runner;
  }

  get enabled(): boolean {
    return this.token !== null;
  }

  private disabledResult<T>(): GhResult<T> {
    return { ok: false, reason: "github-token-unset" };
  }

  private errReason(prefix: string, r: GhRunResult): string {
    if (r.httpStatus !== undefined) return `${prefix}:${r.httpStatus}`;
    if (/ENOENT|not recognized|no such file/i.test(r.stderr)) return `${prefix}:gh-not-found`;
    return `${prefix}:${r.code ?? "spawn"}`;
  }

  private run(args: string[], input?: string): Promise<GhRunResult> {
    return this.runner(args, { token: this.token, ...(input !== undefined ? { input } : {}) });
  }

  async listPRs(owner: string, repo: string, since?: string): Promise<GhResult<GhPR[]>> {
    if (!this.enabled) return this.disabledResult();
    const qs = new URLSearchParams({
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: "100",
    });
    if (since !== undefined) qs.set("since", since);
    const r = await this.run(["api", `repos/${owner}/${repo}/pulls?${qs}`]);
    if (!r.ok) return { ok: false, reason: this.errReason("github-api-error", r) };
    try {
      return projectPRPage(JSON.parse(r.stdout) as unknown);
    } catch {
      return { ok: false, reason: "github-pr-payload-invalid" };
    }
  }

  async getPRHeadKey(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GhResult<string | null>> {
    if (!this.enabled) return this.disabledResult();
    const r = await this.run(["api", `repos/${owner}/${repo}/pulls/${prNumber}`]);
    if (!r.ok) return { ok: false, reason: this.errReason("github-pr-error", r) };
    try {
      return projectPRHeadKey(JSON.parse(r.stdout) as unknown);
    } catch {
      return { ok: false, reason: "github-pr-payload-invalid" };
    }
  }

  async getCheckConclusion(owner: string, repo: string, ref: string): Promise<GhResult<string>> {
    if (!this.enabled) return this.disabledResult();
    const r = await this.run([
      "api",
      `repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`,
    ]);
    if (!r.ok) return { ok: false, reason: this.errReason("github-checks-error", r) };
    try {
      return aggregateCheckConclusion(JSON.parse(r.stdout) as CheckRunsBody);
    } catch (e: unknown) {
      return {
        ok: false,
        reason: `github-checks-fetch-error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  async listPRCommits(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GhResult<{ sha: string; message: string }[]>> {
    if (!this.enabled) return this.disabledResult();
    // GitHub caps commits per page at 100; PRs with >100 commits truncate the SHA set
    // (pre-existing limitation, same on both transports).
    const r = await this.run([
      "api",
      `repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100`,
    ]);
    if (!r.ok) return { ok: false, reason: this.errReason("github-commits-error", r) };
    try {
      const data = JSON.parse(r.stdout) as Array<{ sha: string; commit?: { message?: string } }>;
      return {
        ok: true,
        data: data.map((c) => ({ sha: c.sha, message: c.commit?.message ?? "" })),
      };
    } catch (e: unknown) {
      return {
        ok: false,
        reason: `github-commits-fetch-error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  async listPullsForCommit(owner: string, repo: string, sha: string): Promise<GhResult<number[]>> {
    if (!this.enabled) return this.disabledResult();
    const r = await this.run(["api", `repos/${owner}/${repo}/commits/${sha}/pulls`]);
    // 404 = SHA not found in this repo → no PRs (non-fatal, mirror fetch transport).
    // Any other failure (auth/rate-limit/network) propagates so coverage isn't silently lowered.
    if (!r.ok) {
      if (r.httpStatus === 404) return { ok: true, data: [] };
      return { ok: false, reason: this.errReason("github-commit-pulls-error", r) };
    }
    try {
      const data = JSON.parse(r.stdout) as Array<{ number: number }>;
      return { ok: true, data: data.map((p) => p.number) };
    } catch (e: unknown) {
      return {
        ok: false,
        reason: `github-commit-pulls-fetch-error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  async getPRBody(owner: string, repo: string, prNumber: number): Promise<GhResult<string>> {
    if (!this.enabled) return this.disabledResult();
    const r = await this.run(["api", `repos/${owner}/${repo}/pulls/${prNumber}`]);
    if (!r.ok) return { ok: false, reason: this.errReason("github-pr-error", r) };
    try {
      const data = JSON.parse(r.stdout) as { body: string | null };
      return { ok: true, data: normalizePRBody(data) };
    } catch (e: unknown) {
      return {
        ok: false,
        reason: `github-pr-fetch-error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  async getPRDiff(owner: string, repo: string, prNumber: number): Promise<GhResult<string>> {
    if (!this.enabled) return this.disabledResult();
    const r = await this.run([
      "api",
      `repos/${owner}/${repo}/pulls/${prNumber}`,
      "-H",
      "Accept: application/vnd.github.diff",
    ]);
    if (!r.ok) return { ok: false, reason: this.errReason("github-diff-error", r) };
    return { ok: true, data: r.stdout };
  }

  async getReviewThreads(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GhResult<GhReviewThread[]>> {
    if (!this.enabled) return this.disabledResult();
    const query = `
      query($owner:String!, $repo:String!, $pr:Int!, $cursor:String) {
        repository(owner:$owner, name:$repo) {
          pullRequest(number:$pr) {
            reviewThreads(first:100, after:$cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { id isResolved }
            }
          }
        }
      }
    `;
    type GqlBody = {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              pageInfo?: { hasNextPage: boolean; endCursor: string | null };
              nodes?: GhReviewThread[];
            };
          };
        };
      };
      errors?: Array<{ message: string }>;
    };

    const allThreads: GhReviewThread[] = [];
    let cursor: string | null = null;

    do {
      const input = JSON.stringify({
        query,
        variables: { owner, repo, pr: prNumber, cursor },
      });
      const r = await this.run(["api", "graphql", "--input", "-"], input);
      if (!r.ok) return { ok: false, reason: this.errReason("github-graphql-error", r) };
      let body: GqlBody;
      try {
        body = JSON.parse(r.stdout) as GqlBody;
      } catch (e: unknown) {
        return {
          ok: false,
          reason: `github-graphql-fetch-error: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      if (body.errors !== undefined && body.errors.length > 0) {
        return {
          ok: false,
          reason: `github-graphql-errors: ${body.errors.map((e) => e.message).join("; ")}`,
        };
      }
      const reviewThreads = body.data?.repository?.pullRequest?.reviewThreads;
      allThreads.push(...(reviewThreads?.nodes ?? []));
      const pageInfo = reviewThreads?.pageInfo;
      if (pageInfo?.hasNextPage !== true) break;
      cursor = pageInfo.endCursor ?? null;
    } while (cursor !== null);

    return { ok: true, data: allThreads };
  }
}
