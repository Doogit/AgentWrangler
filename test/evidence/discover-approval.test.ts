import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverScratchApprovalCandidate,
  encodeCheckoutRootSuggestion,
  parseDiscoverApprovalArgs,
} from "../../src/evidence/discover-approval.js";

let root: string;
let repositoryRoot: string;
let sourceDbPath: string;
let searchRoot: string;
let scratchDbPath: string;
let scratchStatePath: string;
let outputPath: string;

function createRepository(name: string, origin?: string): string {
  const checkout = path.join(searchRoot, name);
  fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
  const remote = origin === undefined ? "" : `[remote "origin"]\n\turl = ${origin}\n`;
  fs.writeFileSync(path.join(checkout, ".git", "config"), `[core]\n\tbare = false\n${remote}`);
  return fs.realpathSync.native(checkout);
}

function createDb(
  rows: Array<[string, string, string | null, string | null, string | null]>,
): void {
  const db = new Database(sourceDbPath);
  db.exec(`CREATE TABLE workspaces (
    workspace_id TEXT PRIMARY KEY,
    project_slug TEXT NOT NULL UNIQUE,
    repo_path TEXT,
    repo_owner TEXT,
    repo_name TEXT
  )`);
  const insert = db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)");
  for (const row of rows) insert.run(...row);
  db.close();
}

function input(overrides: Partial<Parameters<typeof discoverScratchApprovalCandidate>[0]> = {}) {
  return {
    sourceDbPath,
    scratchDbPath,
    scratchStatePath,
    searchRoots: [searchRoot],
    outputPath,
    maxEntries: 100,
    privateArtifactParentAcknowledged: true as const,
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-discover-approval-"));
  repositoryRoot = path.join(root, "tool-repository");
  sourceDbPath = path.join(root, "source.sqlite");
  searchRoot = path.join(root, "checkouts");
  scratchDbPath = path.join(root, "scratch", "db.sqlite");
  scratchStatePath = path.join(root, "scratch", "state");
  outputPath = path.join(root, "candidate.json");
  fs.mkdirSync(repositoryRoot);
  fs.mkdirSync(searchRoot);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("approval proposal discovery", () => {
  it("preserves complete mappings and adds exact path suggestions with deterministic aliases", async () => {
    const checkout = createRepository("unmapped", "https://github.com/Example/Unmapped.git");
    createDb([
      ["z-existing", "existing", null, "Owner", "Existing"],
      [encodeCheckoutRootSuggestion(checkout), "unmapped", checkout, null, null],
    ]);
    const result = await discoverScratchApprovalCandidate(input(), { repositoryRoot });
    expect(result).toMatchObject({
      mappedWorkspaceN: 2,
      existingMappingN: 1,
      suggestedMappingN: 1,
      unresolvedWorkspaceN: 0,
    });
    const candidate = JSON.parse(fs.readFileSync(outputPath, "utf8")) as {
      repositories: Array<Record<string, string>>;
    };
    expect(candidate.repositories).toEqual([
      {
        workspaceId: encodeCheckoutRootSuggestion(checkout),
        owner: "Example",
        repo: "Unmapped",
        reportAlias: "repo-001",
      },
      { workspaceId: "z-existing", owner: "Owner", repo: "Existing", reportAlias: "repo-002" },
    ]);
  });

  it("accepts GitHub SSH origins and rejects credential-bearing or non-GitHub origins", async () => {
    const ssh = createRepository("ssh", "git@github.com:owner/repo.git");
    const credentials = createRepository("credentials", "https://token@github.com/o/r.git");
    const other = createRepository("other", "https://example.com/o/r.git");
    createDb([
      [encodeCheckoutRootSuggestion(ssh), "ssh", null, null, null],
      [encodeCheckoutRootSuggestion(credentials), "credentials", null, null, null],
      [encodeCheckoutRootSuggestion(other), "other", null, null, null],
    ]);
    const result = await discoverScratchApprovalCandidate(input(), { repositoryRoot });
    expect(result).toMatchObject({ suggestedMappingN: 1, unresolvedWorkspaceN: 2 });
    expect(result.reasonCounts).toEqual({
      origin_credentials_present: 1,
      origin_non_github: 1,
    });
  });

  it("treats worktree pointer metadata outside the checkout as unresolved", async () => {
    const checkout = path.join(searchRoot, "worktree");
    const gitDir = path.join(root, "git-meta", "worktrees", "one");
    const commonDir = path.join(root, "git-meta");
    fs.mkdirSync(checkout);
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${gitDir}\n`);
    fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
    fs.writeFileSync(
      path.join(commonDir, "config"),
      '[include]\n  path = private-config\n[remote "origin"]\n  url = ssh://git@github.com/o/worktree.git\n',
    );
    const canonical = fs.realpathSync.native(checkout);
    createDb([
      [encodeCheckoutRootSuggestion(canonical), "worktree", null, null, null],
      ["existing", "existing", null, "o", "existing"],
    ]);
    const result = await discoverScratchApprovalCandidate(input(), { repositoryRoot });
    expect(result).toMatchObject({ suggestedMappingN: 0, unresolvedWorkspaceN: 1 });
    expect(result.reasonCounts).toEqual({ git_metadata_unsafe: 1 });
  });

  it("reports missing and malformed origins without exposing their values", async () => {
    const missing = createRepository("missing");
    const malformed = createRepository("malformed", "https://github.com/o/r.git?token=secret");
    createDb([
      [encodeCheckoutRootSuggestion(missing), "missing", null, null, null],
      [encodeCheckoutRootSuggestion(malformed), "malformed", null, null, null],
      ["existing", "existing", null, "o", "existing"],
    ]);
    const result = await discoverScratchApprovalCandidate(input(), { repositoryRoot });
    expect(result.reasonCounts).toEqual({ origin_missing: 1, origin_malformed: 1 });
  });

  it("does not follow directory symlinks during discovery", async () => {
    const externalRoot = path.join(root, "external");
    fs.mkdirSync(externalRoot);
    const checkout = path.join(externalRoot, "linked-repo");
    fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(checkout, ".git", "config"),
      '[remote "origin"]\n  url = https://github.com/o/linked.git\n',
    );
    fs.symlinkSync(externalRoot, path.join(searchRoot, "linked"), "junction");
    createDb([
      ["existing", "existing", null, "o", "existing"],
      [encodeCheckoutRootSuggestion(fs.realpathSync.native(checkout)), "linked", null, null, null],
    ]);
    const result = await discoverScratchApprovalCandidate(input(), { repositoryRoot });
    expect(result).toMatchObject({ suggestedMappingN: 0, unresolvedWorkspaceN: 1 });
    expect(result.reasonCounts).toEqual({ no_exact_path_match: 1 });
  });

  it("skips a queued descendant swapped to an external directory link", async () => {
    const queued = path.join(searchRoot, "queued");
    const externalRoot = path.join(root, "outside-sentinel");
    const externalCheckout = path.join(externalRoot, "nested-private-repo");
    fs.mkdirSync(queued);
    fs.mkdirSync(path.join(externalCheckout, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(externalCheckout, ".git", "config"),
      '[remote "origin"]\n  url = https://github.com/private-sentinel/outside.git\n',
    );
    const encodedExternal = encodeCheckoutRootSuggestion(fs.realpathSync.native(externalCheckout));
    createDb([
      ["existing", "existing", null, "o", "existing"],
      [encodedExternal, "outside", null, null, null],
    ]);
    let swapped = false;
    const result = await discoverScratchApprovalCandidate(input(), {
      repositoryRoot,
      testHooks: {
        beforeVisitDirectory(queuedPath) {
          if (queuedPath !== queued) return;
          fs.rmdirSync(queued);
          fs.symlinkSync(externalRoot, queued, process.platform === "win32" ? "junction" : "dir");
          swapped = true;
        },
      },
    });
    expect(swapped).toBe(true);
    expect(result).toMatchObject({ suggestedMappingN: 0, unresolvedWorkspaceN: 1 });
    expect(result.reasonCounts).toEqual({ no_exact_path_match: 1 });
    expect(JSON.stringify(result)).not.toContain("private-sentinel");
  });

  it("reports path-encoding collisions without guessing", async () => {
    const first = createRepository("a.b", "https://github.com/o/one.git");
    const second = createRepository("a-b", "https://github.com/o/two.git");
    expect(encodeCheckoutRootSuggestion(first)).toBe(encodeCheckoutRootSuggestion(second));
    createDb([
      ["existing", "existing", null, "o", "existing"],
      [encodeCheckoutRootSuggestion(first), "collision", null, null, null],
    ]);
    const result = await discoverScratchApprovalCandidate(input(), { repositoryRoot });
    expect(result).toMatchObject({ suggestedMappingN: 0, unresolvedWorkspaceN: 1 });
    expect(result.reasonCounts).toEqual({ path_encoding_collision: 1 });
  });

  it("withholds a suggestion when one encoded root matches multiple stored rows", async () => {
    const checkout = createRepository("shared", "https://github.com/o/shared.git");
    const encoded = encodeCheckoutRootSuggestion(checkout);
    createDb([
      [encoded, "first", null, null, null],
      ["second", encoded, null, null, null],
      ["existing", "existing", null, "o", "existing"],
    ]);
    const result = await discoverScratchApprovalCandidate(input(), { repositoryRoot });
    expect(result).toMatchObject({ suggestedMappingN: 0, unresolvedWorkspaceN: 2 });
    expect(result.reasonCounts).toEqual({ path_encoding_collision: 2 });
  });

  it("fails closed on traversal exhaustion and does not publish", async () => {
    fs.mkdirSync(path.join(searchRoot, "a", "b"), { recursive: true });
    createDb([["existing", "existing", null, "o", "existing"]]);
    await expect(
      discoverScratchApprovalCandidate(input({ maxEntries: 1 }), { repositoryRoot }),
    ).rejects.toThrow("discovery_traversal_bound_exhausted");
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("rejects overlapping canonical search roots", async () => {
    const child = path.join(searchRoot, "child");
    fs.mkdirSync(child);
    createDb([["existing", "existing", null, "o", "existing"]]);
    await expect(
      discoverScratchApprovalCandidate(input({ searchRoots: [searchRoot, child] }), {
        repositoryRoot,
      }),
    ).rejects.toThrow("discovery_search_roots_overlap");
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("rechecks query-only workspace metadata before candidate publication", async () => {
    createDb([["existing", "existing", null, "o", "existing"]]);
    await expect(
      discoverScratchApprovalCandidate(input(), {
        repositoryRoot,
        testHooks: {
          beforeCandidatePublication() {
            const writer = new Database(sourceDbPath);
            writer
              .prepare("UPDATE workspaces SET repo_name = 'changed' WHERE workspace_id='existing'")
              .run();
            writer.close();
          },
        },
      }),
    ).rejects.toThrow("discovery_source_changed");
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("retains the candidate when workspace metadata changes after publication", async () => {
    createDb([["existing", "existing", null, "o", "existing"]]);
    await expect(
      discoverScratchApprovalCandidate(input(), {
        repositoryRoot,
        testHooks: {
          afterCandidatePublication() {
            const writer = new Database(sourceDbPath);
            writer
              .prepare("UPDATE workspaces SET repo_name = 'changed' WHERE workspace_id='existing'")
              .run();
            writer.close();
          },
        },
      }),
    ).rejects.toThrow("discovery_source_changed_candidate_retained");
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it("refuses duplicate canonical repositories across workspaces", async () => {
    createDb([
      ["one", "one", null, "Owner", "Repo"],
      ["two", "two", null, "owner", "repo"],
    ]);
    await expect(discoverScratchApprovalCandidate(input(), { repositoryRoot })).rejects.toThrow(
      "approval_repository_duplicate",
    );
  });

  it("uses exact Windows/POSIX punctuation encoding and strict CLI inputs", () => {
    expect(encodeCheckoutRootSuggestion("C:\\Users\\Dev Name\\repo.one")).toBe(
      "C--Users-Dev-Name-repo-one",
    );
    expect(encodeCheckoutRootSuggestion("/home/dev/repo.one")).toBe("-home-dev-repo-one");
    expect(
      parseDiscoverApprovalArgs([
        "--source-db",
        "source",
        "--scratch-db",
        "scratch",
        "--scratch-state",
        "state",
        "--search-root",
        "one",
        "--search-root",
        "two",
        "--out",
        "candidate",
        "--max-entries",
        "42",
        "--acknowledge-private-parent",
      ]),
    ).toMatchObject({ searchRoots: ["one", "two"], maxEntries: 42 });
    expect(() => parseDiscoverApprovalArgs([])).toThrow("missing_required_cli_argument");
  });

  it("keeps CLI output aggregate-only and refuses output replacement", async () => {
    const checkout = createRepository("private-path", "https://github.com/private/private.git");
    createDb([[encodeCheckoutRootSuggestion(checkout), "private", checkout, null, null]]);
    const cli = path.resolve("src/evidence/discover-approval.ts");
    const args = [
      "--import",
      "tsx/esm",
      cli,
      "--source-db",
      sourceDbPath,
      "--scratch-db",
      scratchDbPath,
      "--scratch-state",
      scratchStatePath,
      "--search-root",
      searchRoot,
      "--out",
      outputPath,
      "--max-entries",
      "100",
      "--acknowledge-private-parent",
    ];
    const success = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(success.status, success.stderr).toBe(0);
    expect(JSON.parse(success.stdout)).toMatchObject({
      status: "SUGGESTIONS_CONFIRMATION_REQUIRED",
      suggestionHeuristicVersion: "claude-path-slug-suggestion-v1",
      suggestedMappingN: 1,
    });
    expect(success.stdout).not.toContain("private");
    expect(success.stdout).not.toContain(root);
    const refusal = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(refusal.status).toBe(1);
    expect(JSON.parse(refusal.stderr)).toEqual({
      status: "REFUSED",
      failure: "approval_output_already_exists",
    });
  });
});
