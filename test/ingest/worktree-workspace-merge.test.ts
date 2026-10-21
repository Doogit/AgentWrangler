/**
 * test/ingest/worktree-workspace-merge.test.ts — worktree sessions belong to their repo.
 *
 * Claude Code gives a session started in `<repo>/.worktrees/<x>` its own slug dir. Discovery
 * maps it to the repo's workspace; the boot merge moves rows an older daemon filed under
 * the worktree slug. Oracle: ingesting the same files under the repo slug.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { discoverFiles, workspaceSlugFor } from "../../src/ingest/discovery.js";
import { Ingestor } from "../../src/ingest/index.js";
import { mergeWorktreeWorkspaces } from "../../src/ingest/worktree-workspace-merge.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, toJsonl, userPrompt } from "./synth.js";

const OPTS = { now: () => new Date("2026-08-01T00:00:00.000Z"), activityWindowSecs: 300 };
const REPO = "C--Users-dev-Documents-GitHub-Repo";
const WORKTREE = `${REPO}--worktrees-fix-thing`;
const S_REPO = "aaaaaaaa-0000-4000-8000-000000000001";
const S_WT = "bbbbbbbb-0000-4000-8000-000000000002";

function transcript(session: string, prefix: string): string {
  return toJsonl([
    userPrompt({ session, ts: "2026-01-05T10:00:00.000Z" }),
    assistant({ id: `${prefix}1`, session, ts: "2026-01-05T10:00:05.000Z", cw1h: 50_000 }),
  ]);
}

function snapshot(db: Db) {
  const all = (sql: string) => db.prepare(sql).all();
  return {
    workspaces: all("SELECT workspace_id FROM workspaces ORDER BY 1"),
    sessions: all("SELECT session_id, workspace_id, turn_count FROM sessions ORDER BY 1"),
    turns: all("SELECT message_id, workspace_id FROM turns ORDER BY 1"),
  };
}

describe("workspaceSlugFor", () => {
  it("maps worktree slugs to the repo slug and leaves others alone", () => {
    expect(workspaceSlugFor(WORKTREE)).toBe(REPO);
    expect(workspaceSlugFor(`${REPO}--claude-worktrees-agent-1`)).toBe(REPO);
    expect(workspaceSlugFor(REPO)).toBe(REPO);
    expect(workspaceSlugFor("C--Users-dev-worktrees-app")).toBe("C--Users-dev-worktrees-app");
  });
});

describe("worktree workspace merge", () => {
  let root: string;
  let repoFile: string;
  let wtFile: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-wt-"));
    fs.mkdirSync(path.join(root, REPO));
    fs.mkdirSync(path.join(root, WORKTREE));
    repoFile = path.join(root, REPO, `${S_REPO}.jsonl`);
    wtFile = path.join(root, WORKTREE, `${S_WT}.jsonl`);
    fs.writeFileSync(repoFile, transcript(S_REPO, "r"));
    fs.writeFileSync(wtFile, transcript(S_WT, "w"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("discovery files worktree transcripts under the repo", () => {
    expect(discoverFiles([root]).map((f) => f.projectSlug)).toEqual([REPO, REPO]);
  });

  it("moves rows filed under a worktree slug to the repo, idempotently", () => {
    const oracle = migratedMemDb();
    const o = new Ingestor(oracle, [root], OPTS);
    o.ingestFile(repoFile, REPO);
    o.ingestFile(wtFile, REPO);

    const db = migratedMemDb();
    const ingestor = new Ingestor(db, [root], OPTS);
    ingestor.ingestFile(repoFile, REPO);
    ingestor.ingestFile(wtFile, WORKTREE); // what an older daemon stored

    expect(mergeWorktreeWorkspaces(db)).toBe(1);
    expect(snapshot(db)).toEqual(snapshot(oracle));
    expect(mergeWorktreeWorkspaces(db)).toBe(0);
  });
});
