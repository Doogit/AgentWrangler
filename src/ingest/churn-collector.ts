import { spawnSync } from "node:child_process";
import type { Db } from "../db/open.js";

const WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const PORCELAIN_HEADER = /^([0-9a-f]{40})\s/;

export type GitRunner = (args: string[]) => { status: number | null; stdout: string } | null;

export function collectSessionChurn(db: Db, opts: { now?: Date; git?: GitRunner } = {}): void {
  const now = opts.now ?? new Date();
  const measuredAt = now.toISOString();
  const sessions = db
    .prepare(
      `SELECT sessions.session_id, workspaces.repo_path
       FROM sessions
       LEFT JOIN workspaces ON workspaces.workspace_id = sessions.workspace_id`,
    )
    .all() as Array<{ session_id: string; repo_path: string | null }>;
  const authoredCommits = db.prepare(
    `SELECT DISTINCT commit_sha
     FROM tool_events
     WHERE session_id = ? AND commit_sha IS NOT NULL`,
  );
  const upsert = db.prepare(
    `INSERT INTO session_churn
       (session_id, status, window_days, authored_lines, churned_lines, churn_ratio,
        commit_count, commit_shas, measured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       status=excluded.status,
       window_days=excluded.window_days,
       authored_lines=excluded.authored_lines,
       churned_lines=excluded.churned_lines,
       churn_ratio=excluded.churn_ratio,
       commit_count=excluded.commit_count,
       commit_shas=excluded.commit_shas,
       measured_at=excluded.measured_at`,
  );

  for (const session of sessions) {
    if (session.repo_path === null || session.repo_path === "") {
      upsert.run(session.session_id, "NO_REPO", WINDOW_DAYS, 0, 0, null, 0, "[]", measuredAt);
      continue;
    }

    const git = createGitRunner(session.repo_path, opts.git);
    let authoredLines = 0;
    let churnedLines = 0;
    let immature = false;
    const maturedShas: string[] = [];
    const commits = authoredCommits.all(session.session_id) as Array<{ commit_sha: string }>;

    for (const { commit_sha: sha } of commits) {
      if (!SHA_PATTERN.test(sha) || git(["cat-file", "-e", `${sha}^{commit}`]) === null) continue;
      const merge = git(["rev-list", "--no-walk", "--merges", sha]);
      if (merge === null || merge.stdout.trim() !== "") continue;

      const timestamp = git(["show", "-s", "--format=%cI", sha]);
      if (timestamp === null) continue;
      const committedAt = new Date(timestamp.stdout.trim());
      if (Number.isNaN(committedAt.getTime())) continue;
      const horizonAt = new Date(committedAt.getTime() + WINDOW_DAYS * DAY_MS);
      if (horizonAt > now) {
        immature = true;
        continue;
      }

      const numstat = git(["show", "--numstat", "--no-renames", "--format=", sha]);
      if (numstat === null) continue;
      let authoredForCommit = 0;
      const touchedPaths = new Set<string>();
      for (const line of numstat.stdout.split(/\r?\n/)) {
        const [added, , filePath] = line.split("\t", 3);
        if (added === undefined || filePath === undefined || added === "-") continue;
        const count = Number(added);
        if (Number.isInteger(count) && count >= 0) {
          authoredForCommit += count;
          touchedPaths.add(filePath);
        }
      }

      const horizon = git([
        "rev-list",
        "-1",
        "--first-parent",
        `--before=${horizonAt.toISOString()}`,
        "HEAD",
      ]);
      if (horizon === null) continue;
      const horizonSha = horizon.stdout.trim();
      let survivedForCommit = authoredForCommit;
      if (horizonSha !== sha) {
        survivedForCommit = 0;
        for (const filePath of touchedPaths) {
          const blame = git(["blame", "-w", "--line-porcelain", horizonSha, "--", filePath]);
          if (blame === null) continue;
          for (const line of blame.stdout.split(/\r?\n/)) {
            if (PORCELAIN_HEADER.exec(line)?.[1]?.toLowerCase() === sha.toLowerCase()) {
              survivedForCommit += 1;
            }
          }
        }
      }

      authoredLines += authoredForCommit;
      churnedLines += Math.max(0, authoredForCommit - survivedForCommit);
      maturedShas.push(sha);
    }

    upsert.run(
      session.session_id,
      immature ? "PARTIAL" : "MEASURED",
      WINDOW_DAYS,
      authoredLines,
      churnedLines,
      authoredLines === 0 ? null : churnedLines / authoredLines,
      maturedShas.length,
      JSON.stringify(maturedShas),
      measuredAt,
    );
  }
}

function createGitRunner(repoPath: string, injected?: GitRunner): GitRunner {
  if (injected !== undefined) {
    return (args) => injected(["-C", repoPath, ...args]);
  }
  return (args) => {
    try {
      const result = spawnSync("git", ["-C", repoPath, ...args], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.error !== undefined || result.status !== 0) return null;
      return { status: result.status, stdout: result.stdout };
    } catch {
      return null;
    }
  };
}
