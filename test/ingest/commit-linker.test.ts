import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCommitLinks } from "../../src/ingest/commit-linker.js";
import { readEnrichmentEpoch } from "../../src/ingest/enrichment-epoch.js";
import { migratedMemDb } from "./dbutil.js";

let db: Database.Database;
let repo: string;
const REAL_GIT_TEST_TIMEOUT_MS = 15_000;
// Long after every fixture ts, so each row is in a closed ledger window.
const NOW = new Date("2026-03-01T00:00:00.000Z");

beforeEach(() => {
  db = migratedMemDb();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "aw-link-"));
  runGit(["init"]);
  runGit(["config", "user.name", "AgentWrangler Test"]);
  runGit(["config", "user.email", "test@example.invalid"]);
  db.prepare(
    `INSERT INTO workspaces (workspace_id, project_slug, repo_path, registered_at)
     VALUES ('w', 'p', ?, '2026-01-01T00:00:00.000Z')`,
  ).run(repo);
  for (const s of ["s1", "s2"]) {
    db.prepare(
      "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES (?, 'w', ?, 'RECONCILED')",
    ).run(s, `${s}.jsonl`);
  }
});

afterEach(() => {
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

function runGit(args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  if (r.error !== undefined || r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

let n = 0;
function commitAt(date: string): string {
  fs.writeFileSync(path.join(repo, "f.txt"), `${++n}\n`, "utf8");
  runGit(["add", "f.txt"]);
  runGit(["commit", "-q", "-m", "fixture"], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return runGit(["rev-parse", "HEAD"]);
}

function event(
  id: string,
  ts: string,
  command: string,
  opts: { session?: string; sha?: string | null; exit?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class, commit_sha)
     VALUES (?, ?, ?, 'Bash', ?, ?)`,
  ).run(id, opts.session ?? "s1", ts, opts.exit === undefined ? "OK" : opts.exit, opts.sha ?? null);
  db.prepare(
    "INSERT INTO tool_event_content (event_id, content_json, content_included) VALUES (?, json_object('command', ?), 1)",
  ).run(id, command);
}

const shaOf = (id: string): string | null =>
  (db.prepare("SELECT commit_sha FROM tool_events WHERE event_id = ?").pluck().get(id) as
    | string
    | null) ?? null;

describe("resolveCommitLinks (O-3)", () => {
  it(
    "expands a short sha to the full sha",
    async () => {
      const full = commitAt("2026-01-05T10:00:05Z");
      event("e1", "2026-01-05T10:00:00.000Z", "git commit -m x", { sha: full.slice(0, 7) });
      await resolveCommitLinks(db, { now: NOW });
      expect(shaOf("e1")).toBe(full);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    "links a -q commit that is the only commit before the session's next tool call",
    async () => {
      commitAt("2026-01-05T09:00:00Z"); // before the window
      const full = commitAt("2026-01-05T10:00:20Z");
      commitAt("2026-01-05T10:05:00Z"); // after the next tool call
      event("e1", "2026-01-05T10:00:00.000Z", 'git -C "wt" commit -q -m x');
      event("e2", "2026-01-05T10:01:00.000Z", "ls");
      const before = readEnrichmentEpoch(db);
      await resolveCommitLinks(db, { now: NOW });
      expect(shaOf("e1")).toBe(full);
      expect(shaOf("e2")).toBeNull();
      expect(readEnrichmentEpoch(db)).not.toBe(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    "skips a -q commit when two commits fall in its window",
    async () => {
      commitAt("2026-01-05T10:00:10Z");
      commitAt("2026-01-05T10:00:20Z");
      event("e1", "2026-01-05T10:00:00.000Z", "git commit -q -m x");
      await resolveCommitLinks(db, { now: NOW });
      expect(shaOf("e1")).toBeNull();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    "skips a commit two sessions could both have made, and never reuses a linked sha",
    async () => {
      commitAt("2026-01-05T10:00:10Z");
      const linked = commitAt("2026-01-06T10:00:10Z");
      event("a", "2026-01-05T10:00:00.000Z", "git commit -q -m x", { session: "s1" });
      event("b", "2026-01-05T10:00:05.000Z", "git commit -q -m y", { session: "s2" });
      event("c", "2026-01-06T10:00:00.000Z", "git commit -m z", { session: "s1", sha: linked });
      event("d", "2026-01-06T10:00:01.000Z", "git commit -q -m w", { session: "s2" });
      await resolveCommitLinks(db, { now: NOW });
      expect([shaOf("a"), shaOf("b"), shaOf("d")]).toEqual([null, null, null]);
      expect(shaOf("c")).toBe(linked);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    "retries a call whose result had not landed while its window was open",
    async () => {
      const full = commitAt("2026-01-05T10:00:20Z");
      db.prepare(
        "INSERT INTO tool_events (event_id, session_id, ts, tool_name) VALUES ('old', 's1', '2026-01-04T00:00:00.000Z', 'Read')",
      ).run();
      event("e1", "2026-01-05T10:00:00.000Z", "git commit -q -m x", { exit: null });
      await resolveCommitLinks(db, { now: new Date("2026-01-05T10:01:00.000Z") });
      expect(shaOf("e1")).toBeNull();
      db.prepare("UPDATE tool_events SET exit_class = 'OK' WHERE event_id = 'e1'").run();
      await resolveCommitLinks(db, { now: NOW });
      expect(shaOf("e1")).toBe(full);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    "ignores failed commits and non-commit git commands",
    async () => {
      commitAt("2026-01-05T10:00:10Z");
      event("e1", "2026-01-05T10:00:00.000Z", "git commit -q -m x", { exit: "ERROR" });
      event("e2", "2026-01-05T10:00:01.000Z", "git log --grep commit");
      await resolveCommitLinks(db, { now: NOW });
      expect([shaOf("e1"), shaOf("e2")]).toEqual([null, null]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
