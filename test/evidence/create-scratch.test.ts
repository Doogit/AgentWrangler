import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Bytes, sha256File } from "../../src/evidence/common/canonical.js";
import { openQueryOnlyDb } from "../../src/evidence/common/sqlite.js";
import {
  SCRATCH_APPROVAL_VERSION,
  SCRATCH_PREPARATION_VERSION,
  type ScratchPreparationManifest,
  createApprovedScratchCopy,
  parseCreateScratchArgs,
} from "../../src/evidence/create-scratch.js";

const CREATED_AT = new Date("2026-08-26T20:00:00.000Z");
let root: string;
let repositoryRoot: string;
let sourceDbPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-create-scratch-"));
  repositoryRoot = path.join(root, "repository");
  sourceDbPath = path.join(root, "source.sqlite");
  fs.mkdirSync(repositoryRoot);

  const source = new Database(sourceDbPath);
  source.pragma("journal_mode = WAL");
  source.exec(`
    CREATE TABLE workspaces (
      workspace_id TEXT PRIMARY KEY,
      repo_path TEXT,
      repo_owner TEXT,
      repo_name TEXT
    );
    CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO proof (value) VALUES ('source-remains-intact');
  `);
  const insert = source.prepare(
    "INSERT INTO workspaces (workspace_id, repo_owner, repo_name) VALUES (?, ?, ?)",
  );
  insert.run("ws-zeta", "private-owner-z", "private-repo-z");
  insert.run("ws-unmapped", null, null);
  insert.run("ws-alpha", "private-owner-a", "private-repo-a");
  source.close();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function paths() {
  const approved = path.join(root, "approved");
  const base = {
    sourceDbPath,
    scratchDbPath: path.join(approved, "db.sqlite"),
    scratchStatePath: path.join(approved, "state"),
  };
  const approvalManifestPath = path.join(root, "approval.json");
  const approvalBytes = JSON.stringify({
    version: SCRATCH_APPROVAL_VERSION,
    ...base,
    repositories: [
      {
        workspaceId: "ws-zeta",
        owner: "private-owner-z",
        repo: "private-repo-z",
        reportAlias: "repo-002",
      },
      {
        workspaceId: "ws-alpha",
        owner: "private-owner-a",
        repo: "private-repo-a",
        reportAlias: "repo-001",
      },
    ],
    privateArtifactParentAcknowledged: true,
  });
  fs.writeFileSync(approvalManifestPath, approvalBytes, "utf8");
  return {
    ...base,
    approvalManifestPath,
    approvalSha256: sha256Bytes(approvalBytes),
  };
}

describe("strict create-scratch CLI contract", () => {
  it("requires each known path flag exactly once", () => {
    expect(
      parseCreateScratchArgs([
        "--source-db",
        "source",
        "--scratch-db",
        "scratch",
        "--scratch-state",
        "state",
        "--approval-manifest",
        "approval",
        "--approval-sha256",
        "a".repeat(64),
      ]),
    ).toEqual({
      sourceDbPath: "source",
      scratchDbPath: "scratch",
      scratchStatePath: "state",
      approvalManifestPath: "approval",
      approvalSha256: "a".repeat(64),
    });
    expect(() => parseCreateScratchArgs([])).toThrow("missing_required_cli_argument");
    expect(() => parseCreateScratchArgs(["--source-db", "source", "--unknown", "x"])).toThrow(
      "unknown_cli_argument",
    );
    expect(() =>
      parseCreateScratchArgs([
        "--source-db",
        "one",
        "--source-db",
        "two",
        "--scratch-db",
        "scratch",
        "--scratch-state",
        "state",
      ]),
    ).toThrow("duplicate_cli_argument");
  });

  it("runs the real entrypoint with aggregate-only stdout", () => {
    const input = paths();
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        path.join(process.cwd(), "src/evidence/create-scratch.ts"),
        "--source-db",
        input.sourceDbPath,
        "--scratch-db",
        input.scratchDbPath,
        "--scratch-state",
        input.scratchStatePath,
        "--approval-manifest",
        input.approvalManifestPath,
        "--approval-sha256",
        input.approvalSha256,
      ],
      { cwd: process.cwd(), encoding: "utf8", windowsHide: true },
    );

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output.status).toBe("CREATED");
    expect(output.mappedWorkspaceN).toBe(2);
    expect(result.stdout).not.toContain("private-owner");
    expect(result.stdout).not.toContain("private-repo");
    expect(result.stdout).not.toContain(root);
    expect(result.stderr).toBe("");
  });
});

describe("approved online scratch backup", () => {
  it("applies a confirmed mapping only to the scratch copy", async () => {
    const input = paths();
    const writer = new Database(sourceDbPath);
    writer
      .prepare("UPDATE workspaces SET repo_path = 'operator-path' WHERE workspace_id='ws-unmapped'")
      .run();
    writer.close();
    const sourceBefore = await sha256File(sourceDbPath);
    const approval = JSON.parse(fs.readFileSync(input.approvalManifestPath, "utf8")) as {
      repositories: Array<Record<string, string>>;
    };
    approval.repositories.push({
      workspaceId: "ws-unmapped",
      owner: "suggested-owner",
      repo: "suggested-repo",
      reportAlias: "repo-003",
    });
    const bytes = JSON.stringify(approval);
    fs.writeFileSync(input.approvalManifestPath, bytes, "utf8");

    await createApprovedScratchCopy(
      { ...input, approvalSha256: sha256Bytes(bytes) },
      { repositoryRoot, now: CREATED_AT },
    );

    const scratch = openQueryOnlyDb(input.scratchDbPath);
    const source = openQueryOnlyDb(sourceDbPath);
    try {
      expect(
        scratch
          .prepare(
            "SELECT repo_path, repo_owner, repo_name FROM workspaces WHERE workspace_id='ws-unmapped'",
          )
          .get(),
      ).toEqual({
        repo_path: "operator-path",
        repo_owner: "suggested-owner",
        repo_name: "suggested-repo",
      });
      expect(
        source
          .prepare(
            "SELECT repo_path, repo_owner, repo_name FROM workspaces WHERE workspace_id='ws-unmapped'",
          )
          .get(),
      ).toEqual({ repo_path: "operator-path", repo_owner: null, repo_name: null });
    } finally {
      scratch.close();
      source.close();
    }
    expect(await sha256File(sourceDbPath)).toBe(sourceBefore);
  });

  it("rolls back the complete mapping overlay when any addition fails", async () => {
    const input = paths();
    const writer = new Database(sourceDbPath);
    writer
      .prepare(
        "INSERT INTO workspaces (workspace_id, repo_owner, repo_name) VALUES (?, NULL, NULL)",
      )
      .run("ws-unmapped-2");
    writer.close();
    const approval = JSON.parse(fs.readFileSync(input.approvalManifestPath, "utf8")) as {
      repositories: Array<Record<string, string>>;
    };
    approval.repositories.push(
      { workspaceId: "ws-unmapped", owner: "owner-1", repo: "repo-1", reportAlias: "repo-003" },
      { workspaceId: "ws-unmapped-2", owner: "owner-2", repo: "repo-2", reportAlias: "repo-004" },
    );
    const bytes = JSON.stringify(approval);
    fs.writeFileSync(input.approvalManifestPath, bytes, "utf8");

    await expect(
      createApprovedScratchCopy(
        { ...input, approvalSha256: sha256Bytes(bytes) },
        {
          repositoryRoot,
          now: CREATED_AT,
          testHooks: {
            duringMappingOverlay(updatedN) {
              if (updatedN === 1) throw new Error("injected");
            },
          },
        },
      ),
    ).rejects.toThrow("repository_overlay_failed_partial_retained");
    const partial = path.join(
      path.dirname(input.scratchDbPath),
      fs
        .readdirSync(path.dirname(input.scratchDbPath))
        .find((name) => name.endsWith(".partial")) as string,
    );
    const retained = openQueryOnlyDb(partial);
    try {
      expect(
        retained.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE repo_owner IS NOT NULL").get(),
      ).toEqual({ n: 2 });
    } finally {
      retained.close();
    }
  });

  it("publishes a standalone overlaid database from DELETE journal mode", async () => {
    const writer = new Database(sourceDbPath);
    expect(writer.pragma("journal_mode = DELETE", { simple: true })).toBe("delete");
    writer.close();
    const input = paths();
    const approval = JSON.parse(fs.readFileSync(input.approvalManifestPath, "utf8")) as {
      repositories: Array<Record<string, string>>;
    };
    approval.repositories.push({
      workspaceId: "ws-unmapped",
      owner: "delete-owner",
      repo: "delete-repo",
      reportAlias: "repo-003",
    });
    const bytes = JSON.stringify(approval);
    fs.writeFileSync(input.approvalManifestPath, bytes, "utf8");
    await createApprovedScratchCopy(
      { ...input, approvalSha256: sha256Bytes(bytes) },
      { repositoryRoot, now: CREATED_AT },
    );
    expect(fs.existsSync(`${input.scratchDbPath}-wal`)).toBe(false);
    const scratch = openQueryOnlyDb(input.scratchDbPath);
    try {
      expect(
        scratch.prepare("SELECT repo_owner FROM workspaces WHERE workspace_id='ws-unmapped'").get(),
      ).toEqual({ repo_owner: "delete-owner" });
    } finally {
      scratch.close();
    }
  });

  it("refuses unknown, conflicting, and omitted live mappings", async () => {
    const cases: Array<{
      mutate: (repositories: Array<Record<string, string>>) => void;
      code: string;
    }> = [
      {
        mutate: (repositories) =>
          repositories.push({
            workspaceId: "unknown",
            owner: "o",
            repo: "r",
            reportAlias: "repo-003",
          }),
        code: "repository_allowlist_unknown_workspace_partial_retained",
      },
      {
        mutate: (repositories) => {
          const alpha = repositories.find((entry) => entry.workspaceId === "ws-alpha");
          if (alpha !== undefined) alpha.owner = "conflict";
        },
        code: "repository_allowlist_not_exact_partial_retained",
      },
      {
        mutate: (repositories) => repositories.splice(0, 1),
        code: "repository_allowlist_not_exact_partial_retained",
      },
    ];
    for (const testCase of cases) {
      const input = paths();
      const approval = JSON.parse(fs.readFileSync(input.approvalManifestPath, "utf8")) as {
        repositories: Array<Record<string, string>>;
      };
      testCase.mutate(approval.repositories);
      const bytes = JSON.stringify(approval);
      fs.writeFileSync(input.approvalManifestPath, bytes, "utf8");
      await expect(
        createApprovedScratchCopy(
          { ...input, approvalSha256: sha256Bytes(bytes) },
          { repositoryRoot, now: CREATED_AT },
        ),
      ).rejects.toThrow(testCase.code);
      for (const name of fs.readdirSync(path.dirname(input.scratchDbPath))) {
        if (name.endsWith(".partial"))
          fs.rmSync(path.join(path.dirname(input.scratchDbPath), name));
      }
    }
  });

  it("creates a verified identity, private aliased map, and preparation manifest", async () => {
    const input = paths();
    const result = await createApprovedScratchCopy(input, { repositoryRoot, now: CREATED_AT });

    expect(result).toMatchObject({ mappedWorkspaceN: 2 });
    expect(result.scratchDbSha256).toBe(await sha256File(input.scratchDbPath));
    expect(JSON.stringify(result)).not.toContain("private-owner");
    expect(JSON.stringify(result)).not.toContain(root);

    const repoMap = JSON.parse(
      fs.readFileSync(path.join(input.scratchStatePath, "repo-map.json"), "utf8"),
    ) as Array<{ workspaceId: string; owner: string; repo: string; reportAlias: string }>;
    expect(repoMap).toEqual([
      {
        workspaceId: "ws-alpha",
        owner: "private-owner-a",
        repo: "private-repo-a",
        reportAlias: "repo-001",
      },
      {
        workspaceId: "ws-zeta",
        owner: "private-owner-z",
        repo: "private-repo-z",
        reportAlias: "repo-002",
      },
    ]);
    expect(new Set(repoMap.map(({ reportAlias }) => reportAlias)).size).toBe(repoMap.length);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(input.scratchStatePath, "preparation-manifest.json"), "utf8"),
    ) as ScratchPreparationManifest;
    expect(manifest).toMatchObject({
      version: SCRATCH_PREPARATION_VERSION,
      createdAt: CREATED_AT.toISOString(),
      source: { access: "explicit-readonly-online-backup" },
      scratch: {
        sha256: result.scratchDbSha256,
        integrity: "ok",
        publication: "atomic-hard-link-no-replace",
      },
      repositoryMap: { sha256: result.repoMapSha256, mappedWorkspaceN: 2 },
      state: { cleanup: "manual-only" },
      backup: { remainingPages: 0 },
      approval: {
        sha256: input.approvalSha256,
        privateArtifactParentAcknowledged: true,
      },
    });
    expect(result.privateArtifactBoundary).toBe(
      process.platform === "win32"
        ? "WINDOWS_INHERITED_PARENT_ACL_ACKNOWLEDGED"
        : "POSIX_OWNER_ONLY_MODES_REQUESTED",
    );

    const copy = openQueryOnlyDb(input.scratchDbPath);
    try {
      expect(copy.prepare("SELECT value FROM proof").get()).toEqual({
        value: "source-remains-intact",
      });
      expect(
        copy.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get(),
      ).toBeUndefined();
    } finally {
      copy.close();
    }
    const source = openQueryOnlyDb(sourceDbPath);
    try {
      expect(source.prepare("SELECT COUNT(*) AS n FROM proof").get()).toEqual({ n: 1 });
    } finally {
      source.close();
    }
  });

  it("refuses pre-existing scratch/state paths before opening the source", async () => {
    const input = paths();
    fs.mkdirSync(path.dirname(input.scratchDbPath), { recursive: true });
    fs.writeFileSync(input.scratchDbPath, "occupied", "utf8");
    await expect(
      createApprovedScratchCopy(input, { repositoryRoot, now: CREATED_AT }),
    ).rejects.toThrow("scratch_already_exists");

    fs.rmSync(input.scratchDbPath);
    fs.mkdirSync(input.scratchStatePath);
    await expect(
      createApprovedScratchCopy(input, { repositoryRoot, now: CREATED_AT }),
    ).rejects.toThrow("scratch_state_already_exists");
  });

  it("fails closed on a partial repository mapping and emits no state", async () => {
    const writer = new Database(sourceDbPath);
    writer
      .prepare(
        "INSERT INTO workspaces (workspace_id, repo_owner, repo_name) VALUES ('ws-partial', 'owner', NULL)",
      )
      .run();
    writer.close();
    const input = paths();
    await expect(
      createApprovedScratchCopy(input, { repositoryRoot, now: CREATED_AT }),
    ).rejects.toThrow("partial_repository_mapping_partial_retained");
    expect(fs.existsSync(input.scratchDbPath)).toBe(false);
    expect(
      fs.readdirSync(path.dirname(input.scratchDbPath)).some((name) => name.endsWith(".partial")),
    ).toBe(true);
    expect(fs.existsSync(input.scratchStatePath)).toBe(false);
  });

  it("rejects approval extras, digest changes, path changes, acknowledgement gaps, and inferred mappings", async () => {
    const cases: Array<{ mutate: (value: Record<string, unknown>) => void; code: string }> = [
      {
        mutate: (value) => {
          value.extra = true;
        },
        code: "approval_manifest_unknown_or_missing_key",
      },
      {
        mutate: (value) => {
          value.scratchDbPath = path.join(root, "other.sqlite");
        },
        code: "approval_path_binding_mismatch",
      },
      {
        mutate: (value) => {
          value.privateArtifactParentAcknowledged = false;
        },
        code: "private_artifact_parent_not_acknowledged",
      },
      {
        mutate: (value) => {
          (value.repositories as unknown[]).pop();
        },
        code: "repository_allowlist_not_exact_partial_retained",
      },
    ];
    for (const testCase of cases) {
      const input = paths();
      const value = JSON.parse(fs.readFileSync(input.approvalManifestPath, "utf8")) as Record<
        string,
        unknown
      >;
      testCase.mutate(value);
      const bytes = JSON.stringify(value);
      fs.writeFileSync(input.approvalManifestPath, bytes, "utf8");
      await expect(
        createApprovedScratchCopy(
          { ...input, approvalSha256: sha256Bytes(bytes) },
          { repositoryRoot, now: CREATED_AT },
        ),
      ).rejects.toThrow(testCase.code);
      for (const name of fs.existsSync(path.dirname(input.scratchDbPath))
        ? fs.readdirSync(path.dirname(input.scratchDbPath))
        : []) {
        if (name.endsWith(".partial"))
          fs.rmSync(path.join(path.dirname(input.scratchDbPath), name));
      }
    }
    const digest = paths();
    await expect(
      createApprovedScratchCopy(
        { ...digest, approvalSha256: "0".repeat(64) },
        { repositoryRoot, now: CREATED_AT },
      ),
    ).rejects.toThrow("approval_sha256_mismatch");
  });

  it("publishes without replacement and retains the verified partial when the target races", async () => {
    const input = paths();
    await expect(
      createApprovedScratchCopy(input, {
        repositoryRoot,
        now: CREATED_AT,
        testHooks: { beforePublish: () => fs.writeFileSync(input.scratchDbPath, "racer", "utf8") },
      }),
    ).rejects.toThrow("scratch_publish_target_exists_partial_retained");
    expect(fs.readFileSync(input.scratchDbPath, "utf8")).toBe("racer");
    expect(
      fs.readdirSync(path.dirname(input.scratchDbPath)).some((name) => name.endsWith(".partial")),
    ).toBe(true);
  });

  it("refuses a same-size mutation between verification and publication", async () => {
    const input = paths();
    await expect(
      createApprovedScratchCopy(input, {
        repositoryRoot,
        now: CREATED_AT,
        testHooks: {
          beforePublish: (partialDbPath) => {
            const descriptor = fs.openSync(partialDbPath, "r+");
            try {
              const firstByte = Buffer.alloc(1);
              fs.readSync(descriptor, firstByte, 0, 1, 0);
              firstByte[0] = (firstByte[0] ?? 0) ^ 0xff;
              fs.writeSync(descriptor, firstByte, 0, 1, 0);
            } finally {
              fs.closeSync(descriptor);
            }
          },
        },
      }),
    ).rejects.toThrow("published_scratch_sha_mismatch_partial_and_scratch_retained");
    expect(fs.existsSync(input.scratchDbPath)).toBe(true);
    expect(
      fs.readdirSync(path.dirname(input.scratchDbPath)).some((name) => name.endsWith(".partial")),
    ).toBe(true);
  });

  it("surfaces a raced state directory while retaining the published scratch and state", async () => {
    const input = paths();
    await expect(
      createApprovedScratchCopy(input, {
        repositoryRoot,
        now: CREATED_AT,
        testHooks: {
          beforeState: () => {
            fs.mkdirSync(input.scratchStatePath, { recursive: true });
            fs.writeFileSync(path.join(input.scratchStatePath, "racer"), "retained", "utf8");
          },
        },
      }),
    ).rejects.toThrow("scratch_state_create_failed_scratch_published_state_may_be_retained");
    expect(fs.existsSync(input.scratchDbPath)).toBe(true);
    expect(fs.readFileSync(path.join(input.scratchStatePath, "racer"), "utf8")).toBe("retained");
  });

  it("surfaces a state write failure with published scratch and partial state retained", async () => {
    const input = paths();
    await expect(
      createApprovedScratchCopy(input, {
        repositoryRoot,
        now: CREATED_AT,
        testHooks: {
          beforeManifestWrite: () => {
            fs.writeFileSync(
              path.join(input.scratchStatePath, "preparation-manifest.json"),
              "racer",
              "utf8",
            );
          },
        },
      }),
    ).rejects.toThrow("manifest_write_failed_scratch_published_state_retained");
    expect(fs.existsSync(input.scratchDbPath)).toBe(true);
    expect(fs.existsSync(path.join(input.scratchStatePath, "repo-map.json"))).toBe(true);
    expect(
      fs.readFileSync(path.join(input.scratchStatePath, "preparation-manifest.json"), "utf8"),
    ).toBe("racer");
  });

  it("refuses a changed source identity after backup and attests the verified identity", async () => {
    const input = paths();
    await expect(
      createApprovedScratchCopy(input, {
        repositoryRoot,
        now: CREATED_AT,
        testHooks: {
          afterBackup: () => {
            fs.renameSync(sourceDbPath, `${sourceDbPath}.old`);
            fs.writeFileSync(sourceDbPath, "replacement", "utf8");
          },
        },
      }),
    ).rejects.toThrow("source_identity_changed_partial_retained");
    expect(fs.existsSync(input.scratchDbPath)).toBe(false);
  });

  it("refuses a WAL-only source mapping change immediately before publication", async () => {
    const input = paths();
    let liveWriter: Database.Database | undefined;
    try {
      await expect(
        createApprovedScratchCopy(input, {
          repositoryRoot,
          now: CREATED_AT,
          testHooks: {
            beforePublish() {
              liveWriter = new Database(sourceDbPath);
              liveWriter.pragma("wal_autocheckpoint = 0");
              liveWriter
                .prepare(
                  "UPDATE workspaces SET repo_name='changed-in-wal' WHERE workspace_id='ws-alpha'",
                )
                .run();
            },
          },
        }),
      ).rejects.toThrow("source_mapping_changed_partial_retained");
    } finally {
      liveWriter?.close();
    }
    expect(fs.existsSync(input.scratchDbPath)).toBe(false);
    expect(
      fs.readdirSync(path.dirname(input.scratchDbPath)).some((name) => name.endsWith(".partial")),
    ).toBe(true);
  });
});
