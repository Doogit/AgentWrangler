/**
 * test/outcomes/s3b-linker-batch.test.ts — P0-U13 S3b: the linker's per-PR REST
 * fallback (commits + body for work items off this pass's page) is batched
 * through aliased GraphQL.
 *
 * Independent oracles: call counts derive from the injected world (120 work
 * items, batch size 50 => 3 calls); expected links are hand-written from the
 * trailers planted in the world; the REST-fallback result is produced by running
 * the SAME world through a client with the batch method hidden (today's path).
 * Synthetic owner/repo only.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GithubClient } from "../../src/outcomes/github/client.js";
import { GhCliClient } from "../../src/outcomes/github/gh-cli-client.js";
import { linkSessions } from "../../src/outcomes/linker.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";
import { GhWorld, mergedPR, openPR, ts } from "./gh-world.js";
import { OWNER, REPO, mapWorkspace } from "./s3-scenario.js";

const TRAILER = "Claude-Session: https://claude.ai/code/session_sess-a1";
const N = 120;
const B = 50;

let db: Database.Database;

function makeDb(): Database.Database {
  const handle = createInMemoryFixtureDb();
  mapWorkspace(handle);
  handle
    .prepare(
      `INSERT OR IGNORE INTO tool_events (event_id, session_id, ts, tool_name)
       VALUES ('te-s3b-a1', 'sess-a1', '2026-01-01T00:00:00Z', 'Bash')`,
    )
    .run();
  return handle;
}

function addWorkItem(handle: Database.Database, n: number, state = "MERGED"): void {
  handle
    .prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES (?, 'ws-alpha', ?, ?, '2026-09-01T00:00:00.000Z')`,
    )
    .run(`gh:${OWNER}/${REPO}#${n}`, n, state);
}

/** 120 merged PRs; sess-a1's trailer is in #7's commit and #113's body; #50 has 150 commits. */
function world120(): GhWorld {
  const world = new GhWorld();
  const repo = world.repo(OWNER, REPO);
  for (let i = 1; i <= N; i++) {
    let over = {};
    if (i === 7) over = { commits: [{ sha: "c-7-0", message: `x\n\n${TRAILER}` }] };
    if (i === 113) over = { body: `Body\n\n${TRAILER}\n` };
    if (i === 50) {
      // 150 commits: the trailer sits at index 120, past the 100-commit cap.
      over = {
        commits: Array.from({ length: 150 }, (_, k) => ({
          sha: `c-50-${k}`,
          message: k === 120 ? `late\n\n${TRAILER}` : "plain",
        })),
      };
    }
    repo.prs.push(mergedPR(i, ts(i), over));
  }
  return world;
}

function seedAll(handle: Database.Database): void {
  for (let i = 1; i <= N; i++) addWorkItem(handle, i);
}

const EXPECTED_LINKS = [
  { session_id: "sess-a1", work_item_id: `gh:${OWNER}/${REPO}#113`, method: "TRAILER" },
  { session_id: "sess-a1", work_item_id: `gh:${OWNER}/${REPO}#7`, method: "TRAILER" },
];

function links(handle: Database.Database): unknown[] {
  return handle
    .prepare(
      "SELECT session_id, work_item_id, method FROM session_work_links ORDER BY session_id, work_item_id",
    )
    .all();
}

function storedReads(handle: Database.Database): unknown[] {
  return handle
    .prepare("SELECT key, value FROM user_config WHERE key LIKE 'gh_pr_reads:%' ORDER BY key")
    .all();
}

const TOKEN = { ok: true as const, data: "tok" };

function batchClient(world: GhWorld): GithubClient {
  return new GhCliClient(TOKEN, world.runner());
}

/** Today's path: the same client with the batched read hidden. */
function restOnlyClient(world: GhWorld): GithubClient {
  const c = new GhCliClient(TOKEN, world.runner());
  return {
    enabled: c.enabled,
    listPRs: c.listPRs.bind(c),
    getPRHeadKey: c.getPRHeadKey.bind(c),
    getCheckConclusion: c.getCheckConclusion.bind(c),
    listPRCommits: c.listPRCommits.bind(c),
    listPullsForCommit: c.listPullsForCommit.bind(c),
    getPRBody: c.getPRBody.bind(c),
    getPRDiff: c.getPRDiff.bind(c),
    getReviewThreads: c.getReviewThreads.bind(c),
  };
}

beforeEach(() => {
  db = makeDb();
  seedAll(db);
});

afterEach(() => {
  db.close();
});

describe("P0-U13 S3b — linker fallback batched through aliased GraphQL", () => {
  it("120 off-page work items cost ceil(120/B) batch calls and zero per-PR reads; links equal the REST fallback", async () => {
    const world = world120();
    await linkSessions(db, batchClient(world));
    expect(world.counts.graphqlReads).toBe(Math.ceil(N / B));
    expect(world.readBatchSizes).toEqual([50, 50, 20]);
    expect(world.counts.listPRCommits).toBe(0);
    expect(world.counts.getPRBody).toBe(0);
    expect(links(db)).toEqual(EXPECTED_LINKS);

    // Oracle: today's per-PR REST path over the same world on a fresh DB.
    const restDb = makeDb();
    seedAll(restDb);
    const restWorld = world120();
    await linkSessions(restDb, restOnlyClient(restWorld));
    expect(restWorld.counts.listPRCommits).toBe(N);
    expect(restWorld.counts.getPRBody).toBe(N);
    expect(links(restDb)).toEqual(EXPECTED_LINKS);
    expect(storedReads(db)).toEqual(storedReads(restDb));
    restDb.close();
  });

  it("persists gh_pr_reads so a second pass makes no batch and no per-PR call", async () => {
    const world = world120();
    await linkSessions(db, batchClient(world));
    expect(storedReads(db)).toHaveLength(N);
    world.reset();
    await linkSessions(db, batchClient(world));
    expect(world.counts.graphqlReads).toBe(0);
    expect(world.perPrReads()).toBe(0);
    expect(links(db)).toEqual(EXPECTED_LINKS);
  });

  it("a PR the batch returns null for falls back to per-PR REST, with no crash and no wrong link", async () => {
    const world = world120();
    const repo = world.repo(OWNER, REPO);
    repo.prs = repo.prs.filter((p) => p.number !== 30); // deleted on GitHub
    await linkSessions(db, batchClient(world));
    expect(world.counts.graphqlReads).toBe(3);
    expect(world.log.filter((l) => l.kind === "listPRCommits").map((l) => l.ref)).toEqual(["30"]);
    expect(world.log.filter((l) => l.kind === "getPRBody").map((l) => l.ref)).toEqual(["30"]);
    expect(links(db)).toEqual(EXPECTED_LINKS);
    // The failed REST read is not persisted (retried next pass).
    expect(storedReads(db)).toHaveLength(N - 1);
  });

  it("a failed batch falls back to per-PR REST for its PRs; later batches still run", async () => {
    const world = world120();
    world.failReads = true;
    await linkSessions(db, batchClient(world));
    expect(world.counts.graphqlReads).toBe(3);
    expect(world.counts.listPRCommits).toBe(N);
    expect(world.counts.getPRBody).toBe(N);
    expect(links(db)).toEqual(EXPECTED_LINKS);
  });

  it("a 401 stops batching for the repo and is not retried per PR (REST would be denied too)", async () => {
    const world = world120();
    world.failReadsHttp = 401;
    await linkSessions(db, batchClient(world));
    expect(world.counts.graphqlReads).toBe(1);
    expect(world.perPrReads()).toBe(0);
    expect(links(db)).toEqual([]);
    expect(storedReads(db)).toEqual([]);
  });

  it("a stdout-limit batch is halved and retried, still with zero per-PR reads", async () => {
    const world = world120();
    world.maxReadBatchBeforeStdoutLimit = 25;
    await linkSessions(db, batchClient(world));
    expect(world.readBatchSizes).toEqual([50, 25, 25, 50, 25, 25, 20]);
    expect(world.perPrReads()).toBe(0);
    expect(links(db)).toEqual(EXPECTED_LINKS);
  });

  it("keeps the 100-commit cap: a trailer past commit 100 does not link and only 100 SHAs are stored", async () => {
    const world = world120();
    await linkSessions(db, batchClient(world));
    const row = db
      .prepare("SELECT value FROM user_config WHERE key = ?")
      .get(`gh_pr_reads:gh:${OWNER}/${REPO}#50`) as { value: string };
    const stored = JSON.parse(row.value) as { shas: string[]; trailerIds: string[] };
    expect(stored.shas).toHaveLength(100);
    expect(stored.shas).toContain("c-50-99");
    expect(stored.shas).not.toContain("c-50-100");
    expect(stored.trailerIds).toEqual([]);
    expect(links(db)).not.toContainEqual(
      expect.objectContaining({ work_item_id: `gh:${OWNER}/${REPO}#50` }),
    );
  });

  it("an OPEN work item joins the batch, is not persisted, and is re-read every pass", async () => {
    const world = world120();
    world.repo(OWNER, REPO).prs.push(openPR(121, ts(121)));
    addWorkItem(db, 121, "OPEN");
    await linkSessions(db, batchClient(world));
    expect(world.counts.graphqlReads).toBe(3); // 121 PRs / 50
    expect(world.perPrReads()).toBe(0);
    expect(storedReads(db)).toHaveLength(N);
    world.reset();
    await linkSessions(db, batchClient(world));
    expect(world.readBatchSizes).toEqual([1]);
    expect(world.perPrReads()).toBe(0);
  });
});
