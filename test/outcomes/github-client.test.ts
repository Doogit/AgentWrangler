/**
 * test/outcomes/github-client.test.ts — GithubSyncClient: disabled + fake fetch.
 *
 * Verifies:
 *   - disabled (token ok:false) → all methods return {ok:false,...}, 0 fetch calls.
 *   - listPRs: fake fetch returns PR list.
 *   - getCheckConclusion: FAILURE / SUCCESS / NONE aggregation.
 *   - getReviewThreads: GraphQL response parsed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { GithubSyncClient } from "../../src/outcomes/github/client.js";
import type { FetchFn } from "../../src/outcomes/github/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetch(responsesByUrl: Map<string, unknown>): { fn: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const fn: FetchFn = async (input, _init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    calls.push(url);
    const body = responsesByUrl.get(url) ?? responsesByUrl.get("*");
    if (body === undefined) {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => "",
        headers: { get: () => null },
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    } as unknown as Response;
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GithubSyncClient — disabled state", () => {
  it("returns ok:false for all methods and makes 0 fetch calls", async () => {
    const { fn, calls } = makeFetch(new Map());
    const client = new GithubSyncClient({ ok: false, reason: "github-token-not-found" }, fn);

    expect(client.enabled).toBe(false);

    const pr = await client.listPRs("owner", "repo");
    expect(pr.ok).toBe(false);

    const check = await client.getCheckConclusion("owner", "repo", "abc123");
    expect(check.ok).toBe(false);

    const commits = await client.listPRCommits("owner", "repo", 1);
    expect(commits.ok).toBe(false);

    const pulls = await client.listPullsForCommit("owner", "repo", "abc");
    expect(pulls.ok).toBe(false);

    const threads = await client.getReviewThreads("owner", "repo", 1);
    expect(threads.ok).toBe(false);

    expect(calls).toHaveLength(0);
  });
});

describe("GithubSyncClient — listPRs", () => {
  it("returns parsed PR list from REST endpoint", async () => {
    const fakePRs = [
      {
        number: 42,
        state: "closed",
        merged_at: "2026-08-01T00:00:00Z",
        closed_at: "2026-08-01T00:00:00Z",
        created_at: "2026-07-28T00:00:00Z",
        merge_commit_sha: "abc1234",
        head: { sha: "def5678", ref: "feature/transport" },
      },
    ];
    const responses = new Map<string, unknown>([["*", fakePRs]]);
    const { fn, calls } = makeFetch(responses);
    const client = new GithubSyncClient({ ok: true, data: "fake-token" }, fn);

    const result = await client.listPRs("owner", "repo");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.number).toBe(42);
    expect(result.data[0]?.head.refKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.data[0]?.head).not.toHaveProperty("ref");
    expect(calls.length).toBe(1);
  });

  it("rejects a malformed page atomically without exposing a raw ref", async () => {
    const page = [
      {
        number: 1,
        state: "open",
        merged_at: null,
        closed_at: null,
        created_at: "2026-08-01T00:00:00Z",
        merge_commit_sha: null,
        head: { sha: "one", ref: "raw/secret-branch" },
      },
      {
        number: 2,
        state: "open",
        merged_at: null,
        closed_at: null,
        created_at: "2026-08-01T00:00:00Z",
        merge_commit_sha: null,
        head: { sha: "two" },
      },
    ];
    const { fn } = makeFetch(new Map([["*", page]]));
    const result = await new GithubSyncClient({ ok: true, data: "tok" }, fn).listPRs("o", "r");
    expect(result).toEqual({ ok: false, reason: "github-pr-payload-invalid" });
    expect(JSON.stringify(result)).not.toContain("raw/secret-branch");
  });

  it("projects keyed and ineligible refs for an arbitrary PR without returning raw refs", async () => {
    const { fn, calls } = makeFetch(new Map([["*", { head: { ref: "feature/older" } }]]));
    const client = new GithubSyncClient({ ok: true, data: "tok" }, fn);
    const keyed = await client.getPRHeadKey("o", "r", 7);
    expect(keyed.ok && keyed.data).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(keyed)).not.toContain("feature/older");
    expect(calls[0]).toContain("/pulls/7");

    const { fn: invalidFn } = makeFetch(new Map([["*", { head: { ref: "HEAD" } }]]));
    await expect(
      new GithubSyncClient({ ok: true, data: "tok" }, invalidFn).getPRHeadKey("o", "r", 8),
    ).resolves.toEqual({ ok: true, data: null });
  });

  it("rejects a missing/non-string head ref and disabled getPRHeadKey makes zero calls", async () => {
    for (const payload of [{ head: {} }, { head: { ref: 42 } }]) {
      const { fn } = makeFetch(new Map([["*", payload]]));
      await expect(
        new GithubSyncClient({ ok: true, data: "tok" }, fn).getPRHeadKey("o", "r", 1),
      ).resolves.toEqual({ ok: false, reason: "github-pr-payload-invalid" });
    }
    const { fn, calls } = makeFetch(new Map());
    await new GithubSyncClient({ ok: false, reason: "unset" }, fn).getPRHeadKey("o", "r", 1);
    expect(calls).toHaveLength(0);
  });
});

describe("GithubSyncClient — getCheckConclusion", () => {
  it("returns FAILURE when any check_run has conclusion=failure", async () => {
    const fakeChecks = {
      check_runs: [
        { conclusion: "success", status: "completed" },
        { conclusion: "failure", status: "completed" },
      ],
      total_count: 2,
    };
    const { fn } = makeFetch(new Map([["*", fakeChecks]]));
    const client = new GithubSyncClient({ ok: true, data: "tok" }, fn);
    const result = await client.getCheckConclusion("o", "r", "sha");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toBe("FAILURE");
  });

  it("returns NONE when no check runs exist", async () => {
    const { fn } = makeFetch(new Map([["*", { check_runs: [], total_count: 0 }]]));
    const client = new GithubSyncClient({ ok: true, data: "tok" }, fn);
    const result = await client.getCheckConclusion("o", "r", "sha");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toBe("NONE");
  });
});

describe("GithubSyncClient — getReviewThreads", () => {
  it("returns parsed isResolved state from GraphQL", async () => {
    const fakeGql = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { id: "thread-1", isResolved: false },
                { id: "thread-2", isResolved: true },
              ],
            },
          },
        },
      },
    };
    const { fn } = makeFetch(new Map([["*", fakeGql]]));
    const client = new GithubSyncClient({ ok: true, data: "tok" }, fn);
    const result = await client.getReviewThreads("o", "r", 1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toHaveLength(2);
    expect(result.data[0]?.isResolved).toBe(false);
    expect(result.data[1]?.isResolved).toBe(true);
  });
});
