/**
 * test/outcomes/github-client-pagination.test.ts
 * Tests for getReviewThreads cursor-based pagination (WP6).
 *
 * Asserts:
 *  - 2-page response returns all threads across both pages.
 *  - The endCursor from page 1 is threaded as `cursor` variable in page 2's request.
 *  - Single-page response (hasNextPage=false) makes exactly 1 request.
 */

import { describe, expect, it } from "vitest";
import { GithubSyncClient } from "../../src/outcomes/github/client.js";
import type { FetchFn } from "../../src/outcomes/github/client.js";

// ---------------------------------------------------------------------------
// Multi-page fake fetch
// ---------------------------------------------------------------------------

/**
 * Builds a FetchFn that returns successive page responses on each call.
 * Also records each parsed request body so we can assert cursor threading.
 */
function makePagedFetch(pages: unknown[]): { fn: FetchFn; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  let callIndex = 0;

  const fn: FetchFn = async (_input, init) => {
    const rawBody = (init as RequestInit | undefined)?.body;
    if (typeof rawBody === "string") {
      bodies.push(JSON.parse(rawBody) as Record<string, unknown>);
    }
    const page = pages[callIndex++] ?? pages[pages.length - 1];
    return {
      ok: true,
      status: 200,
      json: async () => page,
      headers: { get: () => null },
    } as unknown as Response;
  };

  return { fn, bodies };
}

// ---------------------------------------------------------------------------
// Helper: build a GraphQL reviewThreads page response
// ---------------------------------------------------------------------------

function gqlPage(
  nodes: Array<{ id: string; isResolved: boolean }>,
  hasNextPage: boolean,
  endCursor: string | null,
) {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage, endCursor },
            nodes,
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GithubSyncClient — getReviewThreads pagination", () => {
  it("accumulates threads across 2 pages and threads the cursor correctly", async () => {
    const page1Nodes = [
      { id: "t-1", isResolved: false },
      { id: "t-2", isResolved: true },
    ];
    const page2Nodes = [
      { id: "t-3", isResolved: false },
      { id: "t-4", isResolved: true },
    ];

    const { fn, bodies } = makePagedFetch([
      gqlPage(page1Nodes, true, "cursor-abc"),
      gqlPage(page2Nodes, false, null),
    ]);

    const client = new GithubSyncClient({ ok: true, data: "fake-token" }, fn);
    const result = await client.getReviewThreads("owner", "repo", 42);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // All 4 threads accumulated
    expect(result.data).toHaveLength(4);
    expect(result.data.map((t) => t.id)).toEqual(["t-1", "t-2", "t-3", "t-4"]);

    // Exactly 2 GraphQL calls made
    expect(bodies).toHaveLength(2);

    // First call: cursor is null (no pagination yet)
    expect((bodies[0]?.variables as Record<string, unknown>)?.cursor).toBeNull();

    // Second call: cursor is the endCursor from page 1
    expect((bodies[1]?.variables as Record<string, unknown>)?.cursor).toBe("cursor-abc");
  });

  it("makes exactly 1 request when the first page has hasNextPage=false", async () => {
    const { fn, bodies } = makePagedFetch([
      gqlPage([{ id: "t-1", isResolved: true }], false, null),
    ]);

    const client = new GithubSyncClient({ ok: true, data: "fake-token" }, fn);
    const result = await client.getReviewThreads("owner", "repo", 7);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toHaveLength(1);
    expect(bodies).toHaveLength(1);
  });
});
