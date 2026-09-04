import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ApprovedEvidenceInput,
  loadApprovedEvidenceInput,
  publishApprovedOutput,
} from "../../../src/evidence/common/approved-input.js";
import { readFileIdentity } from "../../../src/evidence/common/boundary.js";
import { sha256Bytes, sha256File } from "../../../src/evidence/common/canonical.js";
import {
  SCRATCH_APPROVAL_VERSION,
  SCRATCH_PREPARATION_VERSION,
} from "../../../src/evidence/create-scratch.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-approved-input-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(): Promise<ApprovedEvidenceInput> {
  const fixtureRoot = fs.mkdtempSync(path.join(root, "case-"));
  const repositoryRoot = path.join(fixtureRoot, "repository");
  const scratchStatePath = path.join(fixtureRoot, "approved", "state");
  const liveDbPath = path.join(fixtureRoot, "live.sqlite");
  const scratchDbPath = path.join(fixtureRoot, "approved", "scratch.sqlite");
  const repoMapPath = path.join(scratchStatePath, "repo-map.json");
  const approvalManifestPath = path.join(fixtureRoot, "approval.json");
  const preparationManifestPath = path.join(scratchStatePath, "preparation-manifest.json");
  fs.mkdirSync(repositoryRoot);
  fs.mkdirSync(scratchStatePath, { recursive: true });

  // Deliberately not SQLite: loading must only resolve/stat this known live path.
  fs.writeFileSync(liveDbPath, "live-file-must-never-be-opened-or-read", "utf8");
  const scratch = new Database(scratchDbPath);
  scratch.exec(
    "CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO proof (value) VALUES ('ok')",
  );
  scratch.close();

  const repositories = [
    { workspaceId: "workspace-a", owner: "owner-a", repo: "repo-a", reportAlias: "repo-001" },
    { workspaceId: "workspace-b", owner: "owner-b", repo: "repo-b", reportAlias: "repo-002" },
  ];
  const repoMapBytes = `${JSON.stringify(repositories)}\n`;
  fs.writeFileSync(repoMapPath, repoMapBytes, "utf8");
  const repoMapSha256 = sha256Bytes(repoMapBytes);

  const approvalBytes = JSON.stringify({
    version: SCRATCH_APPROVAL_VERSION,
    sourceDbPath: liveDbPath,
    scratchDbPath,
    scratchStatePath,
    repositories,
    privateArtifactParentAcknowledged: true,
  });
  fs.writeFileSync(approvalManifestPath, approvalBytes, "utf8");
  const approvalManifestSha256 = sha256Bytes(approvalBytes);
  const scratchDbSha256 = await sha256File(scratchDbPath);
  const preparationBytes = JSON.stringify({
    version: SCRATCH_PREPARATION_VERSION,
    createdAt: "2026-08-26T20:00:00.000Z",
    approval: {
      version: SCRATCH_APPROVAL_VERSION,
      sha256: approvalManifestSha256,
      privateArtifactParentAcknowledged: true,
    },
    source: {
      path: liveDbPath,
      identity: readFileIdentity(liveDbPath),
      access: "explicit-readonly-online-backup",
    },
    scratch: {
      path: scratchDbPath,
      identity: readFileIdentity(scratchDbPath),
      sha256: scratchDbSha256,
      integrity: "ok",
      publication: "atomic-hard-link-no-replace",
    },
    state: {
      path: scratchStatePath,
      cleanup: "manual-only",
      privateArtifactBoundary:
        process.platform === "win32"
          ? "WINDOWS_INHERITED_PARENT_ACL_ACKNOWLEDGED"
          : "POSIX_OWNER_ONLY_MODES_REQUESTED",
    },
    repositoryMap: { file: "repo-map.json", sha256: repoMapSha256, mappedWorkspaceN: 2 },
    backup: { totalPages: 1, remainingPages: 0 },
    prohibitedOperations: [
      "migrations",
      "github-reads",
      "transcript-reads",
      "reset-replay-vacuum-prune-delete",
    ],
  });
  fs.writeFileSync(preparationManifestPath, preparationBytes, "utf8");
  return {
    approvalManifestPath,
    approvalManifestSha256,
    preparationManifestPath,
    preparationManifestSha256: sha256Bytes(preparationBytes),
    scratchDbPath,
    scratchDbSha256,
    scratchVerificationPath: path.join(scratchStatePath, "scratch-verification.sqlite"),
    scratchStatePath,
    repoMapPath,
    repoMapSha256,
    liveDbPath,
    repositoryRoot,
  };
}

function rewriteJson(filePath: string, mutate: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  mutate(value);
  const bytes = JSON.stringify(value);
  fs.writeFileSync(filePath, bytes, "utf8");
  return sha256Bytes(bytes);
}

describe("approved evidence input", () => {
  it("loads the exact digest-bound bundle while the live path is not a readable SQLite database", async () => {
    const input = await fixture();
    const loaded = await loadApprovedEvidenceInput(input);
    expect(loaded.repositories.map(({ reportAlias }) => reportAlias)).toEqual([
      "repo-001",
      "repo-002",
    ]);
    expect(fs.readFileSync(input.liveDbPath, "utf8")).toBe(
      "live-file-must-never-be-opened-or-read",
    );
    expect(fs.existsSync(loaded.scratchVerificationPath)).toBe(true);
    expect(readFileIdentity(loaded.scratchVerificationPath)).toEqual(
      readFileIdentity(loaded.approvedScratchDbPath),
    );
    const verified = loaded.openVerifiedScratchDb();
    try {
      expect(verified.prepare("SELECT value FROM proof").get()).toEqual({ value: "ok" });
      expect(verified.pragma("query_only", { simple: true })).toBe(1);
    } finally {
      verified.close();
    }
  });

  it("refuses direct, junction, and hard-link JSON aliases before consuming live bytes", async () => {
    for (const mode of ["direct", "junction", "hardlink"] as const) {
      const input = await fixture();
      if (mode === "direct") {
        input.approvalManifestPath = input.liveDbPath;
      } else if (mode === "junction") {
        const aliasDirectory = path.join(path.dirname(input.liveDbPath), "live-parent-alias");
        fs.symlinkSync(path.dirname(input.liveDbPath), aliasDirectory, "junction");
        input.approvalManifestPath = path.join(aliasDirectory, path.basename(input.liveDbPath));
      } else {
        fs.rmSync(input.approvalManifestPath);
        fs.linkSync(input.liveDbPath, input.approvalManifestPath);
      }
      input.approvalManifestSha256 = sha256Bytes("live-file-must-never-be-opened-or-read");
      const reads: string[] = [];
      await expect(
        loadApprovedEvidenceInput(input, {
          onJsonDescriptorRead: (kind) => reads.push(kind),
        }),
      ).rejects.toThrow("approval_manifest_aliases_live_db");
      expect(reads).toEqual([]);
    }
  });

  it("strictly refuses missing and extra manifest keys", async () => {
    for (const mutate of [
      (value: Record<string, unknown>) => {
        value.unapproved = true;
      },
      (value: Record<string, unknown>) => {
        Reflect.deleteProperty(value, "backup");
      },
    ]) {
      const input = await fixture();
      input.preparationManifestSha256 = rewriteJson(input.preparationManifestPath, mutate);
      await expect(loadApprovedEvidenceInput(input)).rejects.toThrow(
        "preparation_manifest_unknown_or_missing_key",
      );
    }
  });

  it("refuses supplied and cross-manifest digest mismatches", async () => {
    const supplied = await fixture();
    supplied.approvalManifestSha256 = "0".repeat(64);
    await expect(loadApprovedEvidenceInput(supplied)).rejects.toThrow(
      "approval_manifest_sha256_mismatch",
    );

    const bound = await fixture();
    bound.preparationManifestSha256 = rewriteJson(bound.preparationManifestPath, (value) => {
      (value.approval as Record<string, unknown>).sha256 = "1".repeat(64);
    });
    await expect(loadApprovedEvidenceInput(bound)).rejects.toThrow(
      "preparation_digest_binding_mismatch",
    );
  });

  it("refuses path bindings, hard-link identity aliases, and repository-map mismatches", async () => {
    const pathMismatch = await fixture();
    pathMismatch.preparationManifestSha256 = rewriteJson(
      pathMismatch.preparationManifestPath,
      (value) => {
        (value.scratch as Record<string, unknown>).path = pathMismatch.liveDbPath;
      },
    );
    await expect(loadApprovedEvidenceInput(pathMismatch)).rejects.toThrow(
      "approved_path_binding_mismatch",
    );

    const hardlink = await fixture();
    fs.rmSync(hardlink.scratchDbPath);
    fs.linkSync(hardlink.liveDbPath, hardlink.scratchDbPath);
    await expect(loadApprovedEvidenceInput(hardlink)).rejects.toThrow("scratch_aliases_live_db");

    const mapMismatch = await fixture();
    const repoMap = JSON.parse(fs.readFileSync(mapMismatch.repoMapPath, "utf8")) as Array<
      Record<string, unknown>
    >;
    const firstEntry = repoMap[0];
    if (firstEntry === undefined) throw new Error("fixture_repository_map_empty");
    firstEntry.reportAlias = "repo-999";
    const bytes = JSON.stringify(repoMap);
    fs.writeFileSync(mapMismatch.repoMapPath, bytes, "utf8");
    mapMismatch.repoMapSha256 = sha256Bytes(bytes);
    mapMismatch.preparationManifestSha256 = rewriteJson(
      mapMismatch.preparationManifestPath,
      (value) => {
        (value.repositoryMap as Record<string, unknown>).sha256 = mapMismatch.repoMapSha256;
      },
    );
    await expect(loadApprovedEvidenceInput(mapMismatch)).rejects.toThrow(
      "repository_map_content_mismatch",
    );
  });

  it("refuses corrupt scratch databases and artifacts inside the repository", async () => {
    const corrupt = await fixture();
    fs.writeFileSync(corrupt.scratchDbPath, "not sqlite", "utf8");
    corrupt.scratchDbSha256 = await sha256File(corrupt.scratchDbPath);
    corrupt.preparationManifestSha256 = rewriteJson(corrupt.preparationManifestPath, (value) => {
      const scratch = value.scratch as Record<string, unknown>;
      scratch.sha256 = corrupt.scratchDbSha256;
      scratch.identity = readFileIdentity(corrupt.scratchDbPath);
    });
    await expect(loadApprovedEvidenceInput(corrupt)).rejects.toThrow(
      "scratch_db_integrity_failed_scratch_verification_retained",
    );
    expect(fs.existsSync(corrupt.scratchVerificationPath)).toBe(true);

    const inside = await fixture();
    const insidePath = path.join(inside.repositoryRoot, "repo-map.json");
    fs.copyFileSync(inside.repoMapPath, insidePath);
    inside.repoMapPath = insidePath;
    await expect(loadApprovedEvidenceInput(inside)).rejects.toThrow(
      "approved_artifact_inside_repository",
    );
  });

  it("requires a known live path and an existing approved state directory", async () => {
    const unknownLive = await fixture();
    unknownLive.liveDbPath = path.join(root, "missing-live.sqlite");
    await expect(loadApprovedEvidenceInput(unknownLive)).rejects.toThrow("live_db_path_unknown");

    const missingState = await fixture();
    fs.renameSync(missingState.scratchStatePath, `${missingState.scratchStatePath}-moved`);
    await expect(loadApprovedEvidenceInput(missingState)).rejects.toThrow(
      "scratch_state_missing_or_not_directory",
    );
  });

  it("publishes only nonexistent safe direct-child output paths with verified bytes", async () => {
    const loaded = await loadApprovedEvidenceInput(await fixture());
    const output = path.join(loaded.scratchStatePath, "packet.json");
    const published = publishApprovedOutput(loaded, output, "private packet bytes");
    expect(published).toMatchObject({ path: output, sha256: sha256Bytes("private packet bytes") });
    expect(fs.readFileSync(output, "utf8")).toBe("private packet bytes");
    expect(readFileIdentity(output)).toEqual(published.identity);
    expect(
      fs.readdirSync(loaded.scratchStatePath).some((name) => name.startsWith(".evidence-output-")),
    ).toBe(false);
    expect(() => publishApprovedOutput(loaded, output, "replacement")).toThrow(
      "output_already_exists",
    );
    expect(() =>
      publishApprovedOutput(
        loaded,
        path.join(loaded.scratchStatePath, "nested", "packet.json"),
        "bytes",
      ),
    ).toThrow("output_parent_invalid");
    expect(() => publishApprovedOutput(loaded, path.join(root, "escaped.json"), "bytes")).toThrow(
      "output_not_direct_state_child",
    );
  });

  it("never replaces a raced output and retains its complete temporary artifact", async () => {
    const loaded = await loadApprovedEvidenceInput(await fixture());
    const output = path.join(loaded.scratchStatePath, "raced-packet.json");
    expect(() =>
      publishApprovedOutput(loaded, output, "approved bytes", {
        beforePublishLink: () => fs.writeFileSync(output, "racer", "utf8"),
      }),
    ).toThrow("output_already_exists_temporary_retained");
    expect(fs.readFileSync(output, "utf8")).toBe("racer");
    const retained = fs
      .readdirSync(loaded.scratchStatePath)
      .filter((name) => name.startsWith(".evidence-output-"));
    expect(retained).toHaveLength(1);
    const retainedName = retained[0];
    if (retainedName === undefined) throw new Error("retained_output_temporary_missing");
    expect(fs.readFileSync(path.join(loaded.scratchStatePath, retainedName), "utf8")).toBe(
      "approved bytes",
    );
  });

  it("classifies failures after output linking with both artifacts retained", async () => {
    const loaded = await loadApprovedEvidenceInput(await fixture());
    const output = path.join(loaded.scratchStatePath, "linked-packet.json");
    expect(() =>
      publishApprovedOutput(loaded, output, "approved bytes", {
        afterPublishLink: () => {
          throw new Error("injected_post_link_failure");
        },
      }),
    ).toThrow("output_unexpected_failure_temporary_and_output_retained");
    expect(fs.readFileSync(output, "utf8")).toBe("approved bytes");
    expect(
      fs
        .readdirSync(loaded.scratchStatePath)
        .filter((name) => name.startsWith(".evidence-output-")),
    ).toHaveLength(1);
  });

  it("refuses dangling leaves and Windows-unsafe leaf spellings", async () => {
    const loaded = await loadApprovedEvidenceInput(await fixture());
    const dangling = path.join(loaded.scratchStatePath, "dangling.json");
    const missingTarget = path.join(root, "missing-target");
    fs.mkdirSync(missingTarget);
    fs.symlinkSync(missingTarget, dangling, "junction");
    fs.rmSync(missingTarget, { recursive: true });
    expect(() => publishApprovedOutput(loaded, dangling, "bytes")).toThrow("output_already_exists");
    for (const leaf of ["CON.json", "packet.json:stream", "packet.json.", "packet.json "]) {
      expect(() =>
        publishApprovedOutput(loaded, path.join(loaded.scratchStatePath, leaf), "bytes"),
      ).toThrow("output_leaf_unsafe");
    }
  });

  it("refuses scratch-path swaps before verification without reading the replacement", async () => {
    const input = await fixture();
    const original = `${input.scratchDbPath}.original`;
    await expect(
      loadApprovedEvidenceInput(input, {
        beforeScratchVerificationLink: () => {
          fs.renameSync(input.scratchDbPath, original);
          fs.linkSync(input.liveDbPath, input.scratchDbPath);
        },
      }),
    ).rejects.toThrow("scratch_verification_identity_mismatch_scratch_verification_retained");
    expect(fs.existsSync(input.scratchVerificationPath)).toBe(true);
    expect(fs.readFileSync(input.liveDbPath, "utf8")).toBe(
      "live-file-must-never-be-opened-or-read",
    );
  });

  it("continues on the retained object when the approved scratch leaf changes after linking", async () => {
    const input = await fixture();
    const original = `${input.scratchDbPath}.original`;
    const loaded = await loadApprovedEvidenceInput(input, {
      afterScratchVerificationLink: () => {
        fs.renameSync(input.scratchDbPath, original);
        fs.linkSync(input.liveDbPath, input.scratchDbPath);
      },
    });
    expect(readFileIdentity(loaded.scratchVerificationPath)).toEqual(readFileIdentity(original));
    expect(fs.readFileSync(input.liveDbPath, "utf8")).toBe(
      "live-file-must-never-be-opened-or-read",
    );
  });

  it("classifies unexpected post-link scratch failures with the verification artifact retained", async () => {
    const input = await fixture();
    await expect(
      loadApprovedEvidenceInput(input, {
        afterScratchVerificationLink: () => {
          throw new Error("injected_post_link_failure");
        },
      }),
    ).rejects.toThrow("scratch_verification_unexpected_failure_scratch_verification_retained");
    expect(fs.existsSync(input.scratchVerificationPath)).toBe(true);
  });

  it("opens campaign clones only from the private snapshot after both pathnames change", async () => {
    const input = await fixture();
    const loaded = await loadApprovedEvidenceInput(input);
    fs.renameSync(input.scratchDbPath, `${input.scratchDbPath}.attested`);
    fs.renameSync(input.scratchVerificationPath, `${input.scratchVerificationPath}.attested`);
    fs.linkSync(input.liveDbPath, input.scratchDbPath);
    fs.linkSync(input.liveDbPath, input.scratchVerificationPath);

    const verified = loaded.openVerifiedScratchDb();
    try {
      expect(verified.prepare("SELECT value FROM proof").get()).toEqual({ value: "ok" });
      expect(verified.pragma("query_only", { simple: true })).toBe(1);
    } finally {
      verified.close();
    }
  });

  it("refuses verification-leaf swaps without consuming live bytes", async () => {
    for (const { hookName, expectedIntegrityN } of [
      { hookName: "beforeScratchVerificationOpen", expectedIntegrityN: 0 },
      { hookName: "beforeSnapshotIntegrity", expectedIntegrityN: 1 },
    ] as const) {
      const input = await fixture();
      const retained = `${input.scratchVerificationPath}.${hookName}`;
      let integrityN = 0;
      await expect(
        loadApprovedEvidenceInput(input, {
          [hookName]: () => {
            fs.renameSync(input.scratchVerificationPath, retained);
            fs.linkSync(input.liveDbPath, input.scratchVerificationPath);
          },
          afterSnapshotIntegrity: () => integrityN++,
        }),
      ).rejects.toThrow("scratch_verification_identity");
      expect(integrityN).toBe(expectedIntegrityN);
      expect(fs.existsSync(retained)).toBe(true);
      expect(fs.readFileSync(input.liveDbPath, "utf8")).toBe(
        "live-file-must-never-be-opened-or-read",
      );
    }
  });
});
