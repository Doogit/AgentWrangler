import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSessionChurn } from "../../src/ingest/churn-collector.js";
import { migratedMemDb } from "./dbutil.js";

let db: Database.Database;
let tempDirs: string[];

beforeEach(() => {
  db = migratedMemDb();
  tempDirs = [];
});

afterEach(() => {
  db.close();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function createRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "aw-churn-"));
  tempDirs.push(repo);
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.name", "AgentWrangler Test"]);
  runGit(repo, ["config", "user.email", "test@example.invalid"]);
  return repo;
}

function runGit(repo: string, args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function commitFile(repo: string, lines: number[], date: string): string {
  fs.writeFileSync(path.join(repo, "f.txt"), `${lines.join("\n")}\n`, "utf8");
  runGit(repo, ["add", "f.txt"]);
  runGit(repo, ["commit", "-m", "fixture"], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return runGit(repo, ["rev-parse", "HEAD"]);
}

function seedSession(repoPath: string | null, sha: string): void {
  db.prepare(
    `INSERT INTO workspaces (workspace_id, project_slug, repo_path, registered_at)
     VALUES (?, ?, ?, ?)`,
  ).run("workspace-1", "project-1", repoPath, "2026-01-01T00:00:00.000Z");
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, state)
     VALUES (?, ?, ?, ?)`,
  ).run("session-1", "workspace-1", "session.jsonl", "RECONCILED");
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, commit_sha)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("event-1", "session-1", "2026-01-01T00:00:00.000Z", "Bash", sha);
}

function result(): {
  status: string;
  authored_lines: number;
  churned_lines: number;
  churn_ratio: number | null;
  commit_count: number;
} {
  return db.prepare("SELECT * FROM session_churn WHERE session_id = ?").get("session-1") as {
    status: string;
    authored_lines: number;
    churned_lines: number;
    churn_ratio: number | null;
    commit_count: number;
  };
}

describe("collectSessionChurn", () => {
  it("measures churn inside the 14-day window", () => {
    const repo = createRepo();
    const start = "2026-01-01T12:00:00.000Z";
    const target = commitFile(repo, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], start);
    commitFile(repo, [101, 102, 103, 104, 5, 6, 7, 8, 9, 10], "2026-01-04T12:00:00.000Z");
    commitFile(repo, [201, 202, 203, 104, 5, 6, 7, 8, 9, 10], "2026-01-31T12:00:00.000Z");
    seedSession(repo, target);

    collectSessionChurn(db, { now: new Date("2026-02-10T12:00:00.000Z") });

    expect(result()).toMatchObject({
      authored_lines: 10,
      churned_lines: 4,
      churn_ratio: 0.4,
      status: "MEASURED",
      commit_count: 1,
    });
  });

  it("does not count edits made outside the 14-day window", () => {
    const repo = createRepo();
    const target = commitFile(repo, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "2026-01-01T12:00:00.000Z");
    commitFile(repo, [101, 102, 103, 104, 5, 6, 7, 8, 9, 10], "2026-01-31T12:00:00.000Z");
    seedSession(repo, target);

    collectSessionChurn(db, { now: new Date("2026-02-10T12:00:00.000Z") });

    expect(result()).toMatchObject({
      authored_lines: 10,
      churned_lines: 0,
      churn_ratio: 0,
      status: "MEASURED",
      commit_count: 1,
    });
  });

  it("marks a session partial when its authored commit is immature", () => {
    const repo = createRepo();
    const target = commitFile(repo, [1], "2026-02-05T12:00:00.000Z");
    seedSession(repo, target);

    collectSessionChurn(db, { now: new Date("2026-02-10T12:00:00.000Z") });

    expect(result()).toMatchObject({
      status: "PARTIAL",
      authored_lines: 0,
      commit_count: 0,
    });
  });

  it("records no-repo sessions without invoking Git", () => {
    const repo = createRepo();
    const target = commitFile(repo, [1], "2026-01-01T12:00:00.000Z");
    seedSession(null, target);

    collectSessionChurn(db, { now: new Date("2026-02-10T12:00:00.000Z") });

    expect(result()).toMatchObject({
      status: "NO_REPO",
      authored_lines: 0,
      churned_lines: 0,
      commit_count: 0,
    });
  });
});
