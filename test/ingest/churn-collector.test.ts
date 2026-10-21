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
// These integration cases spawn several real Git processes on Windows. Their
// assertions are functional, while the default timeout is sensitive to suite load.
const REAL_GIT_TEST_TIMEOUT_MS = 15_000;

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
  it("keeps the event loop available while a Git command is pending", async () => {
    const target = "a".repeat(40);
    seedSession("C:/synthetic-repo", target);
    let releaseGit = () => {};
    const gitGate = new Promise<void>((resolve) => {
      releaseGit = resolve;
    });
    let enteredGit = () => {};
    const gitEntered = new Promise<void>((resolve) => {
      enteredGit = resolve;
    });
    const git = async (args: string[]) => {
      enteredGit();
      await gitGate;
      return { status: 0, stdout: args[2] === "show" ? "2026-02-05T12:00:00.000Z" : target };
    };
    const collection = collectSessionChurn(db, {
      now: new Date("2026-02-10T12:00:00.000Z"),
      git,
    });
    let settled = false;
    void collection.finally(() => {
      settled = true;
    });
    try {
      await gitEntered;
      let tickRan = false;
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          tickRan = true;
          resolve();
        }),
      );
      expect(tickRan).toBe(true);
      expect(settled).toBe(false);
    } finally {
      releaseGit();
      await collection;
    }
  });

  it("makes no Git calls for an unchanged measured session on a second run", async () => {
    const target = "a".repeat(40);
    seedSession("C:/synthetic-repo", target);
    const calls: string[][] = [];
    const git = (args: string[]) => {
      calls.push(args);
      const command = args[2];
      const stdout =
        command === "show"
          ? args.includes("--numstat")
            ? "2\t0\tf.txt"
            : "2026-01-01T12:00:00.000Z"
          : command === "rev-list" && args.includes("--merges")
            ? ""
            : target;
      return { status: 0, stdout };
    };
    const now = new Date("2026-02-10T12:00:00.000Z");
    await collectSessionChurn(db, { now, git });
    expect(result().status).toBe("MEASURED");
    expect(calls.length).toBeGreaterThan(0);
    const measuredAt = db
      .prepare("SELECT measured_at FROM session_churn WHERE session_id = ?")
      .get("session-1") as { measured_at: string };
    calls.length = 0;
    await collectSessionChurn(db, { now: new Date("2026-02-11T12:00:00.000Z"), git });
    expect(calls).toEqual([]);
    expect(
      db.prepare("SELECT measured_at FROM session_churn WHERE session_id = ?").get("session-1"),
    ).toEqual(measuredAt);
  });

  it(
    "measures churn inside the 14-day window",
    async () => {
      const repo = createRepo();
      const start = "2026-01-01T12:00:00.000Z";
      const target = commitFile(repo, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], start);
      commitFile(repo, [101, 102, 103, 104, 5, 6, 7, 8, 9, 10], "2026-01-04T12:00:00.000Z");
      commitFile(repo, [201, 202, 203, 104, 5, 6, 7, 8, 9, 10], "2026-01-31T12:00:00.000Z");
      seedSession(repo, target);

      await collectSessionChurn(db, { now: new Date("2026-02-10T12:00:00.000Z") });

      expect(result()).toMatchObject({
        authored_lines: 10,
        churned_lines: 4,
        churn_ratio: 0.4,
        status: "MEASURED",
        commit_count: 1,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    "does not count edits made outside the 14-day window",
    async () => {
      const repo = createRepo();
      const target = commitFile(repo, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "2026-01-01T12:00:00.000Z");
      commitFile(repo, [101, 102, 103, 104, 5, 6, 7, 8, 9, 10], "2026-01-31T12:00:00.000Z");
      seedSession(repo, target);

      await collectSessionChurn(db, { now: new Date("2026-02-10T12:00:00.000Z") });

      expect(result()).toMatchObject({
        authored_lines: 10,
        churned_lines: 0,
        churn_ratio: 0,
        status: "MEASURED",
        commit_count: 1,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    "marks a session partial when its authored commit is immature",
    async () => {
      const repo = createRepo();
      const target = commitFile(repo, [1], "2026-02-05T12:00:00.000Z");
      seedSession(repo, target);

      await collectSessionChurn(db, { now: new Date("2026-02-10T12:00:00.000Z") });

      expect(result()).toMatchObject({
        status: "PARTIAL",
        authored_lines: 0,
        commit_count: 0,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    "records no-repo sessions without invoking Git",
    async () => {
      const repo = createRepo();
      const target = commitFile(repo, [1], "2026-01-01T12:00:00.000Z");
      seedSession(null, target);

      await collectSessionChurn(db, { now: new Date("2026-02-10T12:00:00.000Z") });

      expect(result()).toMatchObject({
        status: "NO_REPO",
        authored_lines: 0,
        churned_lines: 0,
        commit_count: 0,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
