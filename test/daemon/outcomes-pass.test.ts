/**
 * test/daemon/outcomes-pass.test.ts — outcomes pass runner: skip-guard + deadline.
 *
 * Covers (M-batch task 4):
 *   - a hung pass is abandoned at the hard deadline, the running flag ALWAYS
 *     clears, and the NEXT poll runs to completion
 *   - concurrent run() while a pass is in flight returns skipped:true
 *   - a throwing pass body resolves non-fatally and still clears the flag
 *   - a step settling AFTER the deadline abandoned the pass and a successor
 *     poll completed does not crash (no unhandled rejection); its writes are
 *     the idempotent upserts and the successor pass is unaffected (review P2)
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createOutcomesPassRunner } from "../../src/daemon/outcomes-pass.js";
import type { OutcomesPassDeps } from "../../src/daemon/outcomes-pass.js";
import type { GithubClient } from "../../src/outcomes/github/client.js";
import type { TokenResult } from "../../src/outcomes/github/credential.js";

const OK_TOKEN: TokenResult = { ok: true, data: "fake-token" };

function makeStubClient(enabled: boolean, observePRHeadKey: () => void = () => {}): GithubClient {
  return {
    enabled,
    listPRs: async () => ({ ok: true, data: [] }),
    getPRHeadKey: async () => {
      observePRHeadKey();
      return { ok: true, data: null };
    },
    getCheckConclusion: async () => ({ ok: true, data: "NONE" }),
    listPRCommits: async () => ({ ok: true, data: [] }),
    listPullsForCommit: async () => ({ ok: true, data: [] }),
    getPRBody: async () => ({ ok: true, data: "" }),
    getPRDiff: async () => ({ ok: true, data: "" }),
    getReviewThreads: async () => ({ ok: true, data: [] }),
  };
}

function makeDeps(overrides: Partial<OutcomesPassDeps> = {}) {
  const calls: string[] = [];
  const deps: OutcomesPassDeps = {
    db: {} as never,
    probe: () => {
      calls.push("probe");
    },
    readToken: async () => OK_TOKEN,
    createClient: (tokenResult) => makeStubClient(tokenResult.ok),
    sync: async () => {
      calls.push("sync");
    },
    link: async () => {
      calls.push("link");
    },
    derive: () => {
      calls.push("derive");
    },
    findings: async () => {
      calls.push("findings");
    },
    log: () => {},
    error: () => {},
    ...overrides,
  };
  return { deps, calls };
}

describe("createOutcomesPassRunner — hard per-pass deadline", () => {
  it("does not invoke validation-only PR head-key reads during a normal daemon pass", async () => {
    let headKeyCalls = 0;
    const { deps } = makeDeps({
      createClient: (tokenResult) =>
        makeStubClient(tokenResult.ok, () => {
          headKeyCalls++;
        }),
    });

    const result = await createOutcomesPassRunner(deps).run();

    expect(result).toEqual({ skipped: false, disabled: false, aborted: false });
    expect(headKeyCalls).toBe(0);
  });

  it("abandons a hung pass at the deadline, clears the flag, and lets the next poll run", async () => {
    // FIRST token read never settles (= hung pass); later reads succeed.
    const never: Promise<TokenResult> = new Promise(() => {});
    let reads = 0;
    const { deps, calls } = makeDeps({
      readToken: () => {
        reads++;
        return reads === 1 ? never : Promise.resolve(OK_TOKEN);
      },
      deadlineMs: 20,
    });
    const runner = createOutcomesPassRunner(deps);

    const first = await runner.run();
    expect(first.aborted).toBe(true);
    expect(runner.isRunning).toBe(false); // flag cleared despite the hang

    // Next poll runs to completion end-to-end.
    const second = await runner.run();
    expect(second).toEqual({ skipped: false, disabled: false, aborted: false });
    expect(calls).toEqual(["probe", "probe", "sync", "link", "derive", "findings"]);
  });

  it("skips a concurrent poll while a pass is in flight", async () => {
    const gate: { resolve?: (t: TokenResult) => void } = {};
    const gatedToken = new Promise<TokenResult>((resolve) => {
      gate.resolve = resolve;
    });
    const { deps } = makeDeps({
      readToken: () => gatedToken,
    });
    const runner = createOutcomesPassRunner(deps);

    const inFlight = runner.run();
    expect(runner.isRunning).toBe(true);

    const overlapping = await runner.run();
    expect(overlapping.skipped).toBe(true);

    gate.resolve?.({ ok: false, reason: "github-token-unset" });
    const first = await inFlight;
    expect(first.disabled).toBe(true);
    expect(runner.isRunning).toBe(false);
  });

  it("a throwing pass body resolves non-fatally and clears the flag for the next poll", async () => {
    let attempt = 0;
    const { deps, calls } = makeDeps({
      sync: async () => {
        if (attempt === 0) {
          attempt++;
          throw new Error("gh exploded");
        }
        calls.push("sync");
      },
    });
    const runner = createOutcomesPassRunner(deps);

    const first = await runner.run(); // must RESOLVE (non-fatal), not reject
    expect(first.aborted).toBe(false);
    expect(runner.isRunning).toBe(false);

    const second = await runner.run();
    expect(second.aborted).toBe(false);
    expect(calls).toContain("sync");
  });
});

// ── Abandoned-pass interleaving (review P2) ──────────────────────────────────

describe("createOutcomesPassRunner — abandoned-pass interleaving", () => {
  it("a pass settling AFTER the deadline + successor start cannot crash or corrupt: its writes are the idempotent upserts and the successor completes", async () => {
    // Real in-memory SQLite so the "late write" is an actual idempotent upsert —
    // the same shape as every DB write in the real outcomes pass (see the safety
    // rationale in src/daemon/outcomes-pass.ts).
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE late_writes (id TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    const upsert = sqlite.prepare(
      "INSERT INTO late_writes (id, v) VALUES ('late', 1) ON CONFLICT(id) DO UPDATE SET v = v + 1",
    );

    // Pass #1 hangs inside sync; by the time we release it, the deadline has
    // abandoned the pass AND a successor poll has started AND finished.
    let releaseSync: (() => void) | undefined;
    let lateSettled: (() => void) | undefined;
    const lateDone = new Promise<void>((resolve) => {
      lateSettled = resolve;
    });
    let passes = 0;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const { deps } = makeDeps({
        db: sqlite as never,
        deadlineMs: 25,
        sync: async () => {
          passes++;
          if (passes === 1) {
            // Abandoned body: still pending at release time.
            await new Promise<void>((resolve) => {
              releaseSync = resolve;
            });
            upsert.run(); // late settlement applies the SAME idempotent upsert
            lateSettled?.();
          } else {
            // Successor pass applies the same upsert immediately.
            upsert.run();
          }
        },
      });
      const runner = createOutcomesPassRunner(deps);

      const first = await runner.run();
      expect(first.aborted).toBe(true); // deadline fired while sync hung
      expect(runner.isRunning).toBe(false); // flag cleared anyway

      // Successor poll starts and completes normally while pass #1 pends.
      const second = await runner.run();
      expect(second).toEqual({ skipped: false, disabled: false, aborted: false });

      // NOW the abandoned body settles.
      releaseSync?.();
      await lateDone;
      // Give any stray rejection a macrotask turn to surface.
      await new Promise((resolve) => setTimeout(resolve, 10));

      // No unhandled rejection → the late settlement did not crash the process
      // (vitest would also fail the run on an unhandled rejection).
      expect(unhandled).toEqual([]);
      expect(passes).toBe(2);
      // Both applications hit ONE row via the PRIMARY-KEY upsert: no duplicates,
      // no corruption from the interleaving. v=2 proves BOTH the timely and the
      // late application actually executed.
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM late_writes").get()).toEqual({ n: 1 });
      expect(sqlite.prepare("SELECT v FROM late_writes").get()).toEqual({ v: 2 });
    } finally {
      process.off("unhandledRejection", onUnhandled);
      sqlite.close();
    }
  });
});
