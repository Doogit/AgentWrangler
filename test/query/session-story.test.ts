/**
 * test/query/session-story.test.ts — GET /api/sessions/:id/story.
 *
 * Spec (written before the code): the story names what the session did (title, first
 * typed prompt, repo-relative files touched, commits), where the money went (spend by
 * chain × model, a headline that flags premium-model subagents with a Sonnet 5 re-price
 * estimate), one lane per chain, every turn, and tool errors grouped by error text.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commandHead,
  errorSignature,
  getSessionStory,
  prettyModel,
  repoRelative,
} from "../../src/query/api/session-story.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

describe("session story helpers", () => {
  it("formats model ids", () => {
    expect(prettyModel("claude-opus-4-8")).toBe("Opus 4.8");
    expect(prettyModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });
  it("takes the command head of the first non-cd step", () => {
    expect(commandHead("cd x && npm run test -- a")).toBe("npm run test");
    expect(commandHead("git commit -m 'a; b'")).toBe("git commit");
    expect(commandHead("ls -la")).toBe("ls");
  });
  it("normalizes error text so repeats group together", () => {
    expect(errorSignature("Exit code 1\nError: timeout after 3000ms")).toBe(
      errorSignature("Exit code 2\nError: timeout after 5000ms"),
    );
  });
  it("makes paths repo-relative and drops worktree prefixes", () => {
    expect(repoRelative("C:\\r\\.worktrees\\b\\src\\a.ts", "C:\\r")).toBe("src/a.ts");
    expect(repoRelative("C:/r/src/a.ts", "C:\\r")).toBe("src/a.ts");
    expect(repoRelative("D:/other/x.md", "C:\\r")).toBe("D:/other/x.md");
  });
});

describe("getSessionStory", () => {
  let db: Database.Database;
  let dir: string;
  beforeEach(() => {
    db = createInMemoryFixtureDb();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-story-"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(transcript: string | null) {
    const file = path.join(dir, "s1.jsonl");
    if (transcript !== null) fs.writeFileSync(file, transcript);
    db.prepare(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at, repo_path) VALUES ('w','w','2026-01-01',?)",
    ).run(dir);
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state,
         turn_count, cost_equiv_u, hygiene_flags, title)
       VALUES ('s1','w',?,'2026-01-01T00:00:00Z','2026-01-01T01:00:00Z','RECONCILED',3,100,'[]','Fix it')`,
    ).run(file);
    const turn = db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id,
         input_tokens, output_tokens, cache_read_tokens, cost_equiv_u, parser_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'t')`,
    );
    turn.run(
      "m1",
      "s1",
      "w",
      "2026-01-01T00:00:00Z",
      "claude-opus-4-8",
      0,
      null,
      10,
      10,
      1000,
      20_000_000,
    );
    turn.run(
      "m2",
      "s1",
      "w",
      "2026-01-01T00:10:00Z",
      "claude-opus-4-8",
      1,
      "a1",
      10,
      10_000,
      1_000_000,
      80_000_000,
    );
    db.prepare(
      "INSERT INTO subagent_meta (agent_id, session_id, agent_type) VALUES ('a1','s1','Explore')",
    ).run();
    const ev = db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class, commit_sha) VALUES (?,?,?,?,?,?)",
    );
    ev.run("e1", "s1", "2026-01-01T00:11:00Z", "Bash", "ERROR", null);
    ev.run("e2", "s1", "2026-01-01T00:12:00Z", "Bash", "ERROR", null);
    ev.run("e3", "s1", "2026-01-01T00:13:00Z", "Bash", "OK", "abc1234");
    db.prepare(
      "INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command) VALUES ('e1','m2',0,0)",
    ).run();
    const content = db.prepare(
      "INSERT INTO tool_event_content (event_id, content_json) VALUES (?,?)",
    );
    content.run("e1", JSON.stringify({ command: "npm test", error: "Exit code 1\nFAIL 3 tests" }));
    content.run(
      "e2",
      JSON.stringify({ command: "cd x && npm test", error: "Exit code 1\nFAIL 7 tests" }),
    );
  }

  it("tells where the money went and what the session did", async () => {
    const lines = [
      { type: "user", isMeta: true, message: { content: "<local-command-caveat>" } },
      { type: "user", message: { content: "Please fix the login bug" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: path.join(dir, "src", "a.ts") } },
          ],
        },
      },
    ];
    seed(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const story = await getSessionStory(db, "s1");
    expect(story).not.toBeNull();
    if (story === null) return;

    expect(story.title).toBe("Fix it");
    expect(story.first_prompt).toBe("Please fix the login bug");
    expect(story.files_touched).toEqual([{ path: "src/a.ts", edits: 1 }]);
    expect(story.commits).toEqual([{ sha: "abc1234", ts: "2026-01-01T00:13:00Z" }]);
    expect(story.total_cost_u).toBe(100_000_000);
    expect(story.headline?.text).toBe(
      "80% of this session's cost was subagents running on Opus 4.8.",
    );
    // Same tokens at Sonnet 5 list prices: 10×2 + 10000×10 + 1e6×0.2 = 300,020 µUSD.
    expect(story.headline?.savings_u).toBe(80_000_000 - 300_020);
    expect(story.lanes.map((l) => [l.lane_id, l.label])).toEqual([
      ["main", "Main"],
      ["a1", "Explore"],
    ]);
    expect(story.turns.map((t) => t.error)).toEqual([false, true]);
    expect(story.error_groups).toHaveLength(1);
    expect(story.error_groups[0]).toMatchObject({ tool: "Bash", command: "npm test", count: 2 });
  });

  it("degrades when the transcript is gone", async () => {
    seed(null);
    const story = await getSessionStory(db, "s1");
    expect(story?.transcript_available).toBe(false);
    expect(story?.first_prompt).toBeNull();
    expect(story?.files_touched).toEqual([]);
  });

  it("returns null for an unknown session", async () => {
    expect(await getSessionStory(db, "nope")).toBeNull();
  });
});
