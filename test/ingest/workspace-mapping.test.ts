/**
 * test/ingest/workspace-mapping.test.ts — workspace-to-GitHub mapping tests.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ingestor } from "../../src/ingest/ingestor.js";
import {
  backfillDiscoveredCwd,
  parseRemoteUrl,
  resolveWorkspaceMappings,
} from "../../src/ingest/workspace-mapping.js";
import { migratedMemDb } from "./dbutil.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE workspaces (
      workspace_id TEXT PRIMARY KEY,
      project_slug TEXT NOT NULL UNIQUE,
      repo_path TEXT,
      repo_owner TEXT,
      repo_name TEXT,
      discovered_cwd TEXT,
      registered_at TEXT NOT NULL
    )
  `);
});

afterEach(() => db.close());

describe("parseRemoteUrl", () => {
  it.each([
    ["git@github.com:Owner/Repo.git", { owner: "Owner", repo: "Repo" }],
    ["https://github.com/Owner/Repo.git", { owner: "Owner", repo: "Repo" }],
    ["git@github.com:Owner/Repo", { owner: "Owner", repo: "Repo" }],
    ["https://github.com/Owner/Repo", { owner: "Owner", repo: "Repo" }],
  ])("parses %s", (url, expected) => {
    expect(parseRemoteUrl(url)).toEqual(expected);
  });

  it("returns null for a non-GitHub remote", () => {
    expect(parseRemoteUrl("git@gitlab.com:Owner/Repo.git")).toBeNull();
  });
});

describe("resolveWorkspaceMappings", () => {
  it("reports only mappings newly resolved during this call", async () => {
    db.prepare(
      `INSERT INTO workspaces
         (workspace_id, project_slug, discovered_cwd, registered_at)
       VALUES (?, ?, ?, ?)`,
    ).run("workspace-1", "project-1", "C:/repo-1", "2026-08-29T00:00:00Z");
    const readRemote = vi.fn(() => "git@github.com:Owner/Repo.git");

    expect(await resolveWorkspaceMappings(db, { readRemote })).toBe(1);
    expect(await resolveWorkspaceMappings(db, { readRemote })).toBe(0);

    db.prepare(
      `INSERT INTO workspaces
         (workspace_id, project_slug, discovered_cwd, registered_at)
       VALUES (?, ?, ?, ?)`,
    ).run("workspace-2", "project-2", "C:/repo-2", "2026-08-29T00:00:00Z");
    const noRemote = vi.fn(() => null);

    expect(await resolveWorkspaceMappings(db, { readRemote: noRemote })).toBe(0);
  });

  it("fills repo path and GitHub identity from discovered cwd", async () => {
    db.prepare(
      `INSERT INTO workspaces
         (workspace_id, project_slug, discovered_cwd, registered_at)
       VALUES (?, ?, ?, ?)`,
    ).run("workspace-1", "project-1", "C:/repo-1", "2026-08-29T00:00:00Z");
    const readRemote = vi.fn(() => "git@github.com:Owner/Repo.git");

    await resolveWorkspaceMappings(db, { readRemote });

    expect(
      db
        .prepare("SELECT repo_path, repo_owner, repo_name FROM workspaces WHERE workspace_id=?")
        .get("workspace-1"),
    ).toEqual({ repo_path: "C:/repo-1", repo_owner: "Owner", repo_name: "Repo" });
    expect(readRemote).toHaveBeenCalledTimes(1);
    expect(readRemote).toHaveBeenCalledWith("C:/repo-1");
  });

  it("leaves a manual repo owner untouched", async () => {
    db.prepare(
      `INSERT INTO workspaces
         (workspace_id, project_slug, repo_path, repo_owner, repo_name, discovered_cwd, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "workspace-2",
      "project-2",
      "C:/manual-repo",
      "ManualOwner",
      "ManualRepo",
      "C:/transcript-cwd",
      "2026-08-29T00:00:00Z",
    );
    const readRemote = vi.fn(() => "git@github.com:Other/Repo.git");

    await resolveWorkspaceMappings(db, { readRemote });

    expect(
      db
        .prepare("SELECT repo_path, repo_owner, repo_name FROM workspaces WHERE workspace_id=?")
        .get("workspace-2"),
    ).toEqual({ repo_path: "C:/manual-repo", repo_owner: "ManualOwner", repo_name: "ManualRepo" });
    expect(readRemote).not.toHaveBeenCalled();
  });

  it("keeps identity null when the checkout has no remote", async () => {
    db.prepare(
      `INSERT INTO workspaces
         (workspace_id, project_slug, discovered_cwd, registered_at)
       VALUES (?, ?, ?, ?)`,
    ).run("workspace-3", "project-3", "C:/repo-3", "2026-08-29T00:00:00Z");
    const unresolved = new Set<string>();
    const readRemote = vi.fn(() => null);

    await resolveWorkspaceMappings(db, { readRemote, unresolved });
    await resolveWorkspaceMappings(db, { readRemote, unresolved });

    expect(
      db
        .prepare("SELECT repo_path, repo_owner, repo_name FROM workspaces WHERE workspace_id=?")
        .get("workspace-3"),
    ).toEqual({ repo_path: "C:/repo-3", repo_owner: null, repo_name: null });
    expect(readRemote).toHaveBeenCalledTimes(1);
  });

  it("skips a workspace after a non-GitHub remote", async () => {
    db.prepare(
      `INSERT INTO workspaces
         (workspace_id, project_slug, discovered_cwd, registered_at)
       VALUES (?, ?, ?, ?)`,
    ).run("workspace-4", "project-4", "C:/repo-4", "2026-08-29T00:00:00Z");
    const unresolved = new Set<string>();
    const readRemote = vi.fn(() => "git@gitlab.com:Owner/Repo.git");

    await resolveWorkspaceMappings(db, { readRemote, unresolved });
    await resolveWorkspaceMappings(db, { readRemote, unresolved });

    expect(
      db
        .prepare("SELECT repo_owner, repo_name FROM workspaces WHERE workspace_id=?")
        .get("workspace-4"),
    ).toEqual({ repo_owner: null, repo_name: null });
    expect(readRemote).toHaveBeenCalledTimes(1);
  });
});

describe("Ingestor discovery mapping callback", () => {
  it("fires only for new mappings and swallows callback errors", async () => {
    vi.useFakeTimers();
    const ingestDb = migratedMemDb();
    let handle: { stop(): void } | undefined;
    try {
      ingestDb
        .prepare(
          `INSERT INTO workspaces
             (workspace_id, project_slug, discovered_cwd, registered_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run("workspace-1", "project-1", "C:/repo-1", "2026-08-29T00:00:00Z");
      const onNewMappings = vi.fn();
      const ingestor = new Ingestor(ingestDb, [], {
        discoveryIntervalMs: 1000,
        readRemote: () => "git@github.com:Owner/Repo.git",
        onNewMappings,
        now: () => new Date("2026-08-29T00:00:00Z"),
      });
      handle = ingestor.startTail();

      await vi.advanceTimersByTimeAsync(1000);
      expect(onNewMappings).toHaveBeenCalledOnce();
      expect(onNewMappings).toHaveBeenCalledWith(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(onNewMappings).toHaveBeenCalledOnce();

      handle.stop();
      handle = undefined;
      ingestDb
        .prepare(
          `INSERT INTO workspaces
             (workspace_id, project_slug, discovered_cwd, registered_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run("workspace-2", "project-2", "C:/repo-2", "2026-08-29T00:00:00Z");
      const throwingCallback = vi.fn(() => {
        throw new Error("callback boom");
      });
      const throwingIngestor = new Ingestor(ingestDb, [], {
        discoveryIntervalMs: 1000,
        readRemote: () => "git@github.com:Owner/Repo.git",
        onNewMappings: throwingCallback,
        now: () => new Date("2026-08-29T00:00:00Z"),
      });
      handle = throwingIngestor.startTail();

      // A throwing callback must not reject the tick (an unhandled throw here fails the test).
      await vi.advanceTimersByTimeAsync(1000);
      expect(throwingCallback).toHaveBeenCalledOnce();
      expect(throwingCallback).toHaveBeenCalledWith(1);
    } finally {
      handle?.stop();
      ingestDb.close();
      vi.useRealTimers();
    }
  });

  // RB7: a slow git lookup must not hold the discovery tick (it used to spawnSync per workspace).
  it("does not block the tick on a slow remote lookup and never overlaps lookups", async () => {
    vi.useFakeTimers();
    const ingestDb = migratedMemDb();
    let handle: { stop(): void } | undefined;
    try {
      ingestDb
        .prepare(
          `INSERT INTO workspaces
             (workspace_id, project_slug, discovered_cwd, registered_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run("workspace-1", "project-1", "C:/repo-1", "2026-08-29T00:00:00Z");
      let release: (url: string) => void = () => {};
      const readRemote = vi.fn(
        () =>
          new Promise<string | null>((resolve) => {
            release = resolve;
          }),
      );
      const onNewMappings = vi.fn();
      const ingestor = new Ingestor(ingestDb, [], {
        discoveryIntervalMs: 1000,
        readRemote,
        onNewMappings,
        now: () => new Date("2026-08-29T00:00:00Z"),
      });
      handle = ingestor.startTail();

      // Three ticks while the first lookup is still pending: the tick returns, no second lookup.
      await vi.advanceTimersByTimeAsync(3000);
      expect(readRemote).toHaveBeenCalledOnce();
      expect(onNewMappings).not.toHaveBeenCalled();

      release("git@github.com:Owner/Repo.git");
      await vi.advanceTimersByTimeAsync(0);
      expect(onNewMappings).toHaveBeenCalledWith(1);
      expect(
        ingestDb
          .prepare("SELECT repo_owner FROM workspaces WHERE workspace_id=?")
          .get("workspace-1"),
      ).toEqual({ repo_owner: "Owner" });
    } finally {
      handle?.stop();
      ingestDb.close();
      vi.useRealTimers();
    }
  });
});

describe("backfillDiscoveredCwd", () => {
  const insert = (slug: string, cwd: string | null) =>
    db
      .prepare(
        `INSERT INTO workspaces (workspace_id, project_slug, discovered_cwd, registered_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(slug, slug, cwd, "2026-08-29T00:00:00Z");
  const cwdOf = (slug: string) =>
    (
      db.prepare("SELECT discovered_cwd FROM workspaces WHERE project_slug=?").get(slug) as {
        discovered_cwd: string | null;
      }
    ).discovered_cwd;

  it("fills discovered_cwd for workspaces that lack it", () => {
    insert("proj-a", null);
    const readCwd = vi.fn(() => "C:/Users/dev/proj-a");

    backfillDiscoveredCwd(db, [{ filePath: "a.jsonl", projectSlug: "proj-a" }], readCwd);

    expect(cwdOf("proj-a")).toBe("C:/Users/dev/proj-a");
    expect(readCwd).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite an existing discovered_cwd", () => {
    insert("proj-b", "C:/already/set");
    const readCwd = vi.fn(() => "C:/should/not/apply");

    backfillDiscoveredCwd(db, [{ filePath: "b.jsonl", projectSlug: "proj-b" }], readCwd);

    expect(cwdOf("proj-b")).toBe("C:/already/set");
    expect(readCwd).not.toHaveBeenCalled();
  });

  it("reads at most one cwd-bearing file per workspace and skips null reads", () => {
    insert("proj-c", null);
    const readCwd = vi
      .fn<(filePath: string) => string | null>()
      .mockReturnValueOnce(null) // first file yields no cwd
      .mockReturnValueOnce("C:/Users/dev/proj-c"); // second does

    backfillDiscoveredCwd(
      db,
      [
        { filePath: "c1.jsonl", projectSlug: "proj-c" },
        { filePath: "c2.jsonl", projectSlug: "proj-c" },
        { filePath: "c3.jsonl", projectSlug: "proj-c" },
      ],
      readCwd,
    );

    expect(cwdOf("proj-c")).toBe("C:/Users/dev/proj-c");
    // Stops after the first successful read — never touches the third file.
    expect(readCwd).toHaveBeenCalledTimes(2);
  });

  it("does not re-read a file whose head had no cwd on a later tick", () => {
    insert("proj-x", null);
    const readCwd = vi.fn<(filePath: string) => string | null>(() => null);
    const noCwd = new Set<string>();
    const files = [
      { filePath: "x1.jsonl", projectSlug: "proj-x" },
      { filePath: "x2.jsonl", projectSlug: "proj-x" },
    ];

    backfillDiscoveredCwd(db, files, readCwd, noCwd);
    backfillDiscoveredCwd(db, files, readCwd, noCwd);
    backfillDiscoveredCwd(
      db,
      [...files, { filePath: "x3.jsonl", projectSlug: "proj-x" }],
      readCwd,
      noCwd,
    );

    expect(readCwd.mock.calls.map((c) => c[0])).toEqual(["x1.jsonl", "x2.jsonl", "x3.jsonl"]);
    expect(cwdOf("proj-x")).toBeNull();
  });
});
