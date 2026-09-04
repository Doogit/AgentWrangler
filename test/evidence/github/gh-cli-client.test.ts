import { describe, expect, it } from "vitest";
import {
  EVIDENCE_DIFF_MAX_BYTES,
  EvidenceGhCliClient,
} from "../../../src/evidence/github/gh-cli-client.js";
import type { GhRunResult, GhRunner } from "../../../src/outcomes/github/gh-cli-client.js";

interface RecordedCall {
  args: string[];
  input?: string;
  token: string | null;
  maxStdoutBytes?: number;
}

function makeRunner(handler: (call: RecordedCall, index: number) => Partial<GhRunResult>): {
  runner: GhRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: GhRunner = async (args, opts) => {
    const call: RecordedCall = {
      args,
      token: opts.token,
      ...(opts.input === undefined ? {} : { input: opts.input }),
      ...(opts.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: opts.maxStdoutBytes }),
    };
    calls.push(call);
    return {
      ok: true,
      stdout: "",
      stderr: "",
      code: 0,
      ...handler(call, calls.length - 1),
    };
  };
  return { runner, calls };
}

function threadPage(
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: { reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes } },
      },
    },
  });
}

describe("EvidenceGhCliClient disabled boundary", () => {
  it("spawns zero child processes for every method", async () => {
    const { runner, calls } = makeRunner(() => ({ stdout: "should-not-run" }));
    const client = new EvidenceGhCliClient({ ok: false, reason: "unset" }, runner);

    await expect(client.getPRHeadKey("o", "r", 1)).resolves.toEqual({
      ok: false,
      reason: "EVIDENCE_GITHUB_DISABLED",
    });
    await expect(
      client.listMergedPRs([{ owner: "o", repo: "r", reportAlias: "A" }], "2026-08-26T00:00:00Z"),
    ).resolves.toEqual({ ok: false, reason: "EVIDENCE_GITHUB_DISABLED" });
    await client.getPRBody("o", "r", 1);
    await client.getPRDiff("o", "r", 1);
    await client.getReviewThreads("o", "r", 1);
    expect(calls).toHaveLength(0);
  });
});

describe("EvidenceGhCliClient R3 head projection", () => {
  it("uses only the PR endpoint and immediately returns the existing privacy projection", async () => {
    const rawRef = "secret/operator/branch";
    const { runner, calls } = makeRunner(() => ({
      stdout: JSON.stringify({ head: { ref: rawRef }, body: "not consumed" }),
    }));
    const result = await new EvidenceGhCliClient(
      { ok: true, data: "token-secret" },
      runner,
    ).getPRHeadKey("owner", "repo", 27);

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(rawRef);
    expect(calls).toEqual([{ args: ["api", "repos/owner/repo/pulls/27"], token: "token-secret" }]);
    expect(JSON.stringify(calls[0]?.args)).not.toContain("token-secret");
  });

  it("fails closed for missing or non-string head.ref without returning payload content", async () => {
    const { runner } = makeRunner(() => ({ stdout: JSON.stringify({ head: {}, secret: "raw" }) }));
    await expect(
      new EvidenceGhCliClient({ ok: true, data: "tok" }, runner).getPRHeadKey("o", "r", 1),
    ).resolves.toEqual({ ok: false, reason: "EVIDENCE_GITHUB_PAYLOAD_INVALID" });
  });
});

describe("EvidenceGhCliClient merged inventory", () => {
  it("uses the exact closed/updated-desc query, stops on the first empty page, filters asOf, and canonically sorts", async () => {
    const pages = new Map<string, unknown[]>([
      [
        "A:1",
        [
          { number: 9, merged_at: "2026-08-27T00:00:00Z" },
          { number: 3, merged_at: "2026-08-25T00:00:00Z" },
          { number: 1, merged_at: null },
        ],
      ],
      ["A:2", []],
      ["b:1", [{ number: 10, merged_at: "2026-08-24T00:00:00Z" }]],
      ["b:2", []],
    ]);
    const { runner, calls } = makeRunner((call) => {
      const path = call.args[1] ?? "";
      const alias = path.includes("/alpha/") ? "A" : "b";
      const page = new URLSearchParams(path.split("?")[1]).get("page");
      return { stdout: JSON.stringify(pages.get(`${alias}:${page}`)) };
    });
    const result = await new EvidenceGhCliClient({ ok: true, data: "tok" }, runner).listMergedPRs(
      [
        { owner: "z", repo: "beta", reportAlias: "b" },
        { owner: "a", repo: "alpha", reportAlias: "A" },
      ],
      "2026-08-26T00:00:00Z",
    );

    expect(result).toEqual({
      ok: true,
      data: [
        { reportAlias: "A", number: 3, mergedAt: "2026-08-25T00:00:00Z" },
        { reportAlias: "b", number: 10, mergedAt: "2026-08-24T00:00:00Z" },
      ],
    });
    expect(calls.map((call) => call.args)).toEqual([
      ["api", "repos/a/alpha/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1"],
      ["api", "repos/a/alpha/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=2"],
      ["api", "repos/z/beta/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1"],
      ["api", "repos/z/beta/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=2"],
    ]);
  });

  it("rejects malformed or partial rows", async () => {
    for (const row of [
      { merged_at: null },
      { number: 1 },
      { number: 1, merged_at: false },
      { number: 1, merged_at: "2026-02-30T00:00:00Z" },
    ]) {
      const { runner } = makeRunner(() => ({ stdout: JSON.stringify([row]) }));
      const result = await new EvidenceGhCliClient({ ok: true, data: "tok" }, runner).listMergedPRs(
        [{ owner: "o", repo: "r", reportAlias: "A" }],
        "2026-08-26T00:00:00Z",
      );
      expect(result).toEqual({ ok: false, reason: "EVIDENCE_GITHUB_PAYLOAD_INVALID" });
    }
  });

  it("refuses duplicate and conflicting PR rows", async () => {
    for (const [second, reason] of [
      [{ number: 1, merged_at: "2026-08-25T00:00:00Z" }, "EVIDENCE_GITHUB_DUPLICATE"],
      [{ number: 1, merged_at: null }, "EVIDENCE_GITHUB_DUPLICATE_CONFLICT"],
    ] as const) {
      const { runner } = makeRunner(() => ({
        stdout: JSON.stringify([{ number: 1, merged_at: "2026-08-25T00:00:00Z" }, second]),
      }));
      await expect(
        new EvidenceGhCliClient({ ok: true, data: "tok" }, runner).listMergedPRs(
          [{ owner: "o", repo: "r", reportAlias: "A" }],
          "2026-08-26T00:00:00Z",
        ),
      ).resolves.toEqual({ ok: false, reason });
    }
  });

  it("fails on a page command error and refuses a non-empty page 1000", async () => {
    const failed = makeRunner(() => ({ ok: false, stderr: "sensitive", code: 1 }));
    await expect(
      new EvidenceGhCliClient({ ok: true, data: "tok" }, failed.runner).listMergedPRs(
        [{ owner: "o", repo: "r", reportAlias: "A" }],
        "2026-08-26T00:00:00Z",
      ),
    ).resolves.toEqual({ ok: false, reason: "EVIDENCE_GITHUB_COMMAND_FAILED" });

    const capped = makeRunner((_call, index) => ({
      stdout: JSON.stringify([{ number: index + 1, merged_at: null }]),
    }));
    await expect(
      new EvidenceGhCliClient({ ok: true, data: "tok" }, capped.runner).listMergedPRs(
        [{ owner: "o", repo: "r", reportAlias: "A" }],
        "2026-08-26T00:00:00Z",
      ),
    ).resolves.toEqual({ ok: false, reason: "EVIDENCE_GITHUB_PAGINATION_LIMIT" });
    expect(capped.calls).toHaveLength(1_000);
  });

  it("compares fractional asOf timestamps without millisecond truncation", async () => {
    const responses = [
      [
        { number: 2, merged_at: "2026-08-26T00:00:00.000000002Z" },
        { number: 1, merged_at: "2026-08-26T00:00:00.000000001Z" },
      ],
      [],
    ];
    const { runner } = makeRunner((_call, index) => ({
      stdout: JSON.stringify(responses[index]),
    }));
    await expect(
      new EvidenceGhCliClient({ ok: true, data: "tok" }, runner).listMergedPRs(
        [{ owner: "o", repo: "r", reportAlias: "A" }],
        "2026-08-26T00:00:00.000000001Z",
      ),
    ).resolves.toEqual({
      ok: true,
      data: [
        {
          reportAlias: "A",
          number: 1,
          mergedAt: "2026-08-26T00:00:00.000000001Z",
        },
      ],
    });
  });
});

describe("EvidenceGhCliClient COND projections", () => {
  it("strictly preserves body string|null and rejects missing or wrong body", async () => {
    for (const body of ["", "body", null] as const) {
      const { runner } = makeRunner(() => ({ stdout: JSON.stringify({ body }) }));
      await expect(
        new EvidenceGhCliClient({ ok: true, data: "tok" }, runner).getPRBody("o", "r", 2),
      ).resolves.toEqual({ ok: true, data: body });
    }
    for (const payload of [{}, { body: 0 }]) {
      const { runner } = makeRunner(() => ({ stdout: JSON.stringify(payload) }));
      await expect(
        new EvidenceGhCliClient({ ok: true, data: "tok" }, runner).getPRBody("o", "r", 2),
      ).resolves.toEqual({ ok: false, reason: "EVIDENCE_GITHUB_PAYLOAD_INVALID" });
    }
  });

  it("returns exact diff text with only the approved media-type request", async () => {
    const diff = "diff --git a/a b/a\n+TODO\n";
    const { runner, calls } = makeRunner(() => ({ stdout: diff }));
    await expect(
      new EvidenceGhCliClient({ ok: true, data: "tok" }, runner).getPRDiff("o", "r", 7),
    ).resolves.toEqual({ ok: true, data: diff });
    expect(calls[0]?.args).toEqual([
      "api",
      "repos/o/r/pulls/7",
      "-H",
      "Accept: application/vnd.github.diff",
    ]);
    expect(calls[0]?.maxStdoutBytes).toBe(EVIDENCE_DIFF_MAX_BYTES);
  });

  it("maps streamed diff overflow to a stable privacy-safe refusal", async () => {
    const { runner } = makeRunner(() => ({
      ok: false,
      stdout: "",
      stderr: "raw-content-must-not-escape",
      code: null,
      failure: "stdout-limit",
    }));
    await expect(
      new EvidenceGhCliClient({ ok: true, data: "tok" }, runner).getPRDiff("o", "r", 7),
    ).resolves.toEqual({ ok: false, reason: "EVIDENCE_GITHUB_RESPONSE_TOO_LARGE" });
  });
});

describe("EvidenceGhCliClient review thread pagination", () => {
  it("validates pages, forwards cursors, and returns binary-id ordering", async () => {
    const { runner, calls } = makeRunner((_call, index) => ({
      stdout:
        index === 0
          ? threadPage([{ id: "b", isResolved: false }], true, "C1")
          : threadPage([{ id: "A", isResolved: true }]),
    }));
    const result = await new EvidenceGhCliClient(
      { ok: true, data: "tok" },
      runner,
    ).getReviewThreads("o", "r", 3);

    expect(result).toEqual({
      ok: true,
      data: [
        { id: "A", isResolved: true },
        { id: "b", isResolved: false },
      ],
    });
    expect(calls[0]?.args).toEqual(["api", "graphql", "--input", "-"]);
    expect(JSON.parse(calls[1]?.input ?? "{}").variables.cursor).toBe("C1");
  });

  it("rejects malformed or partial pageInfo/nodes", async () => {
    const payloads: unknown[] = [
      {},
      { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } },
      JSON.parse(threadPage([{ id: "x" }])),
      JSON.parse(threadPage([{ id: "x", isResolved: "false" }])),
      { errors: "not-an-array" },
    ];
    for (const payload of payloads) {
      const { runner } = makeRunner(() => ({ stdout: JSON.stringify(payload) }));
      await expect(
        new EvidenceGhCliClient({ ok: true, data: "tok" }, runner).getReviewThreads("o", "r", 1),
      ).resolves.toEqual({ ok: false, reason: "EVIDENCE_GITHUB_PAYLOAD_INVALID" });
    }
  });

  it("fails closed on a page command error without exposing stderr", async () => {
    const { runner } = makeRunner(() => ({
      ok: false,
      stderr: "credential-shaped-sensitive-content",
      code: 1,
    }));
    await expect(
      new EvidenceGhCliClient({ ok: true, data: "tok" }, runner).getReviewThreads("o", "r", 1),
    ).resolves.toEqual({ ok: false, reason: "EVIDENCE_GITHUB_COMMAND_FAILED" });
  });

  it("refuses null and repeated continuation cursors", async () => {
    const nullCursor = makeRunner(() => ({ stdout: threadPage([], true, null) }));
    await expect(
      new EvidenceGhCliClient({ ok: true, data: "tok" }, nullCursor.runner).getReviewThreads(
        "o",
        "r",
        1,
      ),
    ).resolves.toEqual({ ok: false, reason: "EVIDENCE_GITHUB_CURSOR_INVALID" });

    const repeated = makeRunner(() => ({ stdout: threadPage([], true, "same") }));
    await expect(
      new EvidenceGhCliClient({ ok: true, data: "tok" }, repeated.runner).getReviewThreads(
        "o",
        "r",
        1,
      ),
    ).resolves.toEqual({ ok: false, reason: "EVIDENCE_GITHUB_CURSOR_INVALID" });
    expect(repeated.calls).toHaveLength(2);
  });

  it("refuses duplicate and conflicting thread states", async () => {
    for (const [second, reason] of [
      [{ id: "t", isResolved: false }, "EVIDENCE_GITHUB_DUPLICATE"],
      [{ id: "t", isResolved: true }, "EVIDENCE_GITHUB_DUPLICATE_CONFLICT"],
    ] as const) {
      const { runner } = makeRunner(() => ({
        stdout: threadPage([{ id: "t", isResolved: false }, second]),
      }));
      await expect(
        new EvidenceGhCliClient({ ok: true, data: "tok" }, runner).getReviewThreads("o", "r", 1),
      ).resolves.toEqual({ ok: false, reason });
    }
  });

  it("enforces the review-thread page cap", async () => {
    const { runner, calls } = makeRunner((_call, index) => ({
      stdout: threadPage([], true, `C${index + 1}`),
    }));
    await expect(
      new EvidenceGhCliClient({ ok: true, data: "tok" }, runner).getReviewThreads("o", "r", 1),
    ).resolves.toEqual({ ok: false, reason: "EVIDENCE_GITHUB_PAGINATION_LIMIT" });
    expect(calls).toHaveLength(1_000);
  });
});

describe("EvidenceGhCliClient command scope", () => {
  it("rejects path/query injection before invoking the runner", async () => {
    const { runner, calls } = makeRunner(() => ({ stdout: "{}" }));
    const client = new EvidenceGhCliClient({ ok: true, data: "tok" }, runner);
    await expect(client.getPRBody("owner/other", "repo", 1)).resolves.toEqual({
      ok: false,
      reason: "EVIDENCE_GITHUB_REQUEST_INVALID",
    });
    await expect(client.getPRDiff("owner", "repo?state=all", 1)).resolves.toEqual({
      ok: false,
      reason: "EVIDENCE_GITHUB_REQUEST_INVALID",
    });
    expect(calls).toHaveLength(0);
  });
});
