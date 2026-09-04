/**
 * test/outcomes/gh-cli-client.test.ts — GhCliClient: disabled + injected runner.
 *
 * Mirrors github-client.test.ts but drives the `gh` CLI transport through an
 * injected runner (no real process spawned). Verifies:
 *   - disabled (token ok:false) → all methods {ok:false}, 0 runner calls.
 *   - listPRs / getCheckConclusion / listPRCommits / getPRBody / getPRDiff parse
 *     `gh api` stdout into the same shapes the consumers expect.
 *   - getReviewThreads parses GraphQL stdout and paginates.
 *   - a non-zero `gh` exit degrades to {ok:false,reason} (never throws).
 */

import { describe, expect, it } from "vitest";
import { GhCliClient } from "../../src/outcomes/github/gh-cli-client.js";
import type { GhRunResult, GhRunner } from "../../src/outcomes/github/gh-cli-client.js";

/** Build a runner that returns canned stdout, recording the args of each call. */
function makeRunner(handler: (args: string[], input?: string) => Partial<GhRunResult>): {
  runner: GhRunner;
  calls: Array<{ args: string[]; input?: string }>;
} {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const runner: GhRunner = async (args, opts) => {
    calls.push({ args, ...(opts.input !== undefined ? { input: opts.input } : {}) });
    const r = handler(args, opts.input);
    return { ok: true, stdout: "", stderr: "", code: 0, ...r };
  };
  return { runner, calls };
}

describe("GhCliClient — disabled state", () => {
  it("returns ok:false for all methods and spawns 0 processes", async () => {
    const { runner, calls } = makeRunner(() => ({ stdout: "[]" }));
    const client = new GhCliClient({ ok: false, reason: "github-token-not-found" }, runner);

    expect(client.enabled).toBe(false);
    expect((await client.listPRs("o", "r")).ok).toBe(false);
    expect((await client.getCheckConclusion("o", "r", "sha")).ok).toBe(false);
    expect((await client.listPRCommits("o", "r", 1)).ok).toBe(false);
    expect((await client.getPRBody("o", "r", 1)).ok).toBe(false);
    expect((await client.getPRDiff("o", "r", 1)).ok).toBe(false);
    expect((await client.getReviewThreads("o", "r", 1)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("GhCliClient — listPRs", () => {
  it("parses the PR list from gh api stdout", async () => {
    const fakePRs = [
      {
        number: 42,
        state: "closed",
        merged_at: "2026-08-01T00:00:00Z",
        closed_at: "2026-08-01T00:00:00Z",
        created_at: "2026-07-28T00:00:00Z",
        merge_commit_sha: "abc1234",
        head: { sha: "def5678", ref: "feature/cli" },
      },
    ];
    const { runner, calls } = makeRunner(() => ({ stdout: JSON.stringify(fakePRs) }));
    const client = new GhCliClient({ ok: true, data: "tok" }, runner);

    const result = await client.listPRs("owner", "repo");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.number).toBe(42);
    expect(result.data[0]?.head.refKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.data[0]?.head).not.toHaveProperty("ref");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe("api");
    expect(calls[0]?.args[1]).toContain("repos/owner/repo/pulls");
  });

  it("rejects the whole page when one ref is missing", async () => {
    const invalid = [
      {
        number: 1,
        state: "open",
        merged_at: null,
        closed_at: null,
        created_at: "2026-08-01T00:00:00Z",
        merge_commit_sha: null,
        head: { sha: "sha", ref: "raw/private" },
      },
      {
        number: 2,
        state: "open",
        merged_at: null,
        closed_at: null,
        created_at: "2026-08-01T00:00:00Z",
        merge_commit_sha: null,
        head: { sha: "sha" },
      },
    ];
    const { runner } = makeRunner(() => ({ stdout: JSON.stringify(invalid) }));
    const result = await new GhCliClient({ ok: true, data: "tok" }, runner).listPRs("o", "r");
    expect(result).toEqual({ ok: false, reason: "github-pr-payload-invalid" });
    expect(JSON.stringify(result)).not.toContain("raw/private");
  });

  it("gets an arbitrary PR head key, including an ineligible ref", async () => {
    const { runner, calls } = makeRunner(() => ({
      stdout: JSON.stringify({ head: { ref: "feature/historical" } }),
    }));
    const keyed = await new GhCliClient({ ok: true, data: "tok" }, runner).getPRHeadKey(
      "o",
      "r",
      123,
    );
    expect(keyed.ok && keyed.data).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(keyed)).not.toContain("feature/historical");
    expect(calls[0]?.args[1]).toBe("repos/o/r/pulls/123");

    const { runner: ineligibleRunner } = makeRunner(() => ({
      stdout: JSON.stringify({ head: { ref: "HEAD" } }),
    }));
    await expect(
      new GhCliClient({ ok: true, data: "tok" }, ineligibleRunner).getPRHeadKey("o", "r", 1),
    ).resolves.toEqual({ ok: true, data: null });
  });

  it("rejects missing/non-string refs and disabled mode spawns zero processes", async () => {
    for (const payload of [{ head: {} }, { head: { ref: false } }]) {
      const { runner } = makeRunner(() => ({ stdout: JSON.stringify(payload) }));
      await expect(
        new GhCliClient({ ok: true, data: "tok" }, runner).getPRHeadKey("o", "r", 1),
      ).resolves.toEqual({ ok: false, reason: "github-pr-payload-invalid" });
    }
    const { runner, calls } = makeRunner(() => ({ stdout: "{}" }));
    await new GhCliClient({ ok: false, reason: "unset" }, runner).getPRHeadKey("o", "r", 1);
    expect(calls).toHaveLength(0);
  });
});

describe("GhCliClient — getCheckConclusion", () => {
  it("returns FAILURE when any check_run failed", async () => {
    const body = {
      check_runs: [
        { conclusion: "success", status: "completed" },
        { conclusion: "failure", status: "completed" },
      ],
      total_count: 2,
    };
    const { runner } = makeRunner(() => ({ stdout: JSON.stringify(body) }));
    const client = new GhCliClient({ ok: true, data: "tok" }, runner);
    const result = await client.getCheckConclusion("o", "r", "sha");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toBe("FAILURE");
  });

  it("returns NONE when no check runs exist", async () => {
    const { runner } = makeRunner(() => ({
      stdout: JSON.stringify({ check_runs: [], total_count: 0 }),
    }));
    const client = new GhCliClient({ ok: true, data: "tok" }, runner);
    const result = await client.getCheckConclusion("o", "r", "sha");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toBe("NONE");
  });
});

describe("GhCliClient — listPRCommits", () => {
  it("maps commit SHAs from gh api stdout", async () => {
    const { runner } = makeRunner(() => ({
      stdout: JSON.stringify([{ sha: "aaa" }, { sha: "bbb" }]),
    }));
    const client = new GhCliClient({ ok: true, data: "tok" }, runner);
    const result = await client.listPRCommits("o", "r", 7);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual([
      { sha: "aaa", message: "" },
      { sha: "bbb", message: "" },
    ]);
  });
});

describe("GhCliClient — getPRDiff", () => {
  it("passes the diff Accept header and returns raw stdout", async () => {
    const { runner, calls } = makeRunner(() => ({ stdout: "diff --git a/x b/x\n+TODO" }));
    const client = new GhCliClient({ ok: true, data: "tok" }, runner);
    const result = await client.getPRDiff("o", "r", 3);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toContain("diff --git");
    expect(calls[0]?.args).toContain("Accept: application/vnd.github.diff");
  });
});

describe("GhCliClient — getReviewThreads", () => {
  it("parses isResolved from GraphQL stdout (single page)", async () => {
    const gql = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { id: "thread-1", isResolved: false },
                { id: "thread-2", isResolved: true },
              ],
            },
          },
        },
      },
    };
    const { runner, calls } = makeRunner(() => ({ stdout: JSON.stringify(gql) }));
    const client = new GhCliClient({ ok: true, data: "tok" }, runner);
    const result = await client.getReviewThreads("o", "r", 1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toHaveLength(2);
    expect(result.data[0]?.isResolved).toBe(false);
    // GraphQL body is delivered on stdin.
    expect(calls[0]?.args).toEqual(["api", "graphql", "--input", "-"]);
    expect(calls[0]?.input).toContain("reviewThreads");
  });
});

describe("GhCliClient — degradation", () => {
  it("maps a non-zero gh exit to {ok:false} without throwing", async () => {
    const runner: GhRunner = async () => ({
      ok: false,
      stdout: "",
      stderr: "gh: Not Found (HTTP 404)",
      code: 1,
      httpStatus: 404,
    });
    const client = new GhCliClient({ ok: true, data: "tok" }, runner);
    const result = await client.listPRs("o", "r");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("github-api-error:404");
  });

  // TEST 7: errReason ENOENT branch → reason ends with ":gh-not-found"
  it("maps ENOENT stderr to :gh-not-found reason", async () => {
    const { runner } = makeRunner(() => ({
      ok: false,
      stdout: "",
      stderr: "spawn gh ENOENT",
      code: null,
    }));
    const client = new GhCliClient({ ok: true, data: "tok" }, runner);
    const result = await client.listPRs("o", "r");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason.endsWith(":gh-not-found")).toBe(true);
  });

  // TEST 8: JSON.parse failure returns a stable reason without echoing response content.
  it("degrades to {ok:false} when gh stdout is not valid JSON", async () => {
    const { runner } = makeRunner(() => ({ ok: true, stdout: "not-json", code: 0 }));
    const client = new GhCliClient({ ok: true, data: "tok" }, runner);
    const result = await client.listPRs("o", "r");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("github-pr-payload-invalid");
  });
});

// TEST 5: getReviewThreads multi-page pagination
describe("GhCliClient — getReviewThreads multi-page", () => {
  it("fetches all pages and forwards cursor from page 1 to page 2", async () => {
    const page1 = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: "C1" },
              nodes: [{ id: "thread-1", isResolved: false }],
            },
          },
        },
      },
    };
    const page2 = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "thread-2", isResolved: true }],
            },
          },
        },
      },
    };
    let callCount = 0;
    const { runner, calls } = makeRunner(() => {
      callCount += 1;
      return { stdout: JSON.stringify(callCount === 1 ? page1 : page2) };
    });
    const client = new GhCliClient({ ok: true, data: "tok" }, runner);
    const result = await client.getReviewThreads("o", "r", 5);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(calls).toHaveLength(2);
    // Second call must carry the cursor from page 1.
    const call2Input = calls[1]?.input;
    expect(call2Input).toBeDefined();
    const parsed = JSON.parse(call2Input ?? "{}") as { variables: { cursor: string } };
    expect(parsed.variables.cursor).toBe("C1");
    // Both pages' nodes are aggregated.
    expect(result.data).toHaveLength(2);
    expect(result.data.map((t) => t.id)).toEqual(["thread-1", "thread-2"]);
  });
});

// TEST 9: getPRBody
describe("GhCliClient — getPRBody", () => {
  it("returns the body string from the PR payload", async () => {
    const { runner } = makeRunner(() => ({
      stdout: JSON.stringify({ body: "This PR fixes the bug." }),
    }));
    const client = new GhCliClient({ ok: true, data: "tok" }, runner);
    const result = await client.getPRBody("o", "r", 42);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toBe("This PR fixes the bug.");
  });

  it("maps a null body to an empty string", async () => {
    const { runner } = makeRunner(() => ({
      stdout: JSON.stringify({ body: null }),
    }));
    const client = new GhCliClient({ ok: true, data: "tok" }, runner);
    const result = await client.getPRBody("o", "r", 42);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toBe("");
  });
});

// TEST 10: defaultGhRunner real-spawn coverage (SKIPPED)
// The real defaultGhRunner's spawn path (hard-timeout SIGKILL, stdin EPIPE guard,
// Buffer-chunk reassembly for multibyte sequences) is NOT covered by these injected-
// runner tests. A clean cross-platform harness that works on Windows (no SIGKILL
// support from node child_process on some paths, differing pipe behaviour) requires
// non-trivial setup. This path remains covered only by manual / integration testing.
// Tracked as a follow-on in the DEFER list.
