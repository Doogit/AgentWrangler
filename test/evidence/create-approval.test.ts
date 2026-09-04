import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Bytes } from "../../src/evidence/common/canonical.js";
import {
  buildScratchApprovalManifest,
  createScratchApprovalCandidate,
  parseCreateScratchApprovalArgs,
} from "../../src/evidence/create-approval.js";

let root: string;
let repositoryRoot: string;
let sourceDbPath: string;
let scratchDbPath: string;
let scratchStatePath: string;
let outputPath: string;

const repositories = [
  { workspaceId: "workspace-z", owner: "owner-z", repo: "repo-z", reportAlias: "repo-002" },
  { workspaceId: "workspace-a", owner: "owner-a", repo: "repo-a", reportAlias: "repo-001" },
];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-create-approval-"));
  repositoryRoot = path.join(root, "repository");
  sourceDbPath = path.join(root, "not-a-sqlite-database.txt");
  scratchDbPath = path.join(root, "evidence", "db.sqlite");
  scratchStatePath = path.join(root, "evidence", "state");
  outputPath = path.join(root, "approval-candidate.json");
  fs.mkdirSync(repositoryRoot);
  fs.writeFileSync(sourceDbPath, "proof that the source is never opened as SQLite", "utf8");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function input(overrides: Record<string, unknown> = {}) {
  return {
    sourceDbPath,
    scratchDbPath,
    scratchStatePath,
    repositoriesJson: JSON.stringify(repositories),
    outputPath,
    privateArtifactParentAcknowledged: true,
    ...overrides,
  } as Parameters<typeof createScratchApprovalCandidate>[0];
}

describe("scratch approval candidate builder", () => {
  it("builds deterministic exact-schema canonical bytes in binary workspace order", async () => {
    const result = await createScratchApprovalCandidate(input(), { repositoryRoot });
    const expected = buildScratchApprovalManifest({
      sourceDbPath: fs.realpathSync.native(sourceDbPath),
      scratchDbPath,
      scratchStatePath,
      repositories,
      privateArtifactParentAcknowledged: true,
    });
    expect(expected.repositories.map(({ workspaceId }) => workspaceId)).toEqual([
      "workspace-a",
      "workspace-z",
    ]);
    const expectedBytes = `${canonicalJson(expected)}\n`;
    expect(fs.readFileSync(outputPath, "utf8")).toBe(expectedBytes);
    expect(Object.keys(JSON.parse(expectedBytes)).sort()).toEqual([
      "privateArtifactParentAcknowledged",
      "repositories",
      "scratchDbPath",
      "scratchStatePath",
      "sourceDbPath",
      "version",
    ]);
    expect(result).toEqual({ sha256: sha256Bytes(expectedBytes), mappedWorkspaceN: 2 });

    const secondOutput = path.join(root, "approval-candidate-2.json");
    const reversed = [...repositories].reverse();
    const second = await createScratchApprovalCandidate(
      input({ repositoriesJson: JSON.stringify(reversed), outputPath: secondOutput }),
      { repositoryRoot },
    );
    expect(fs.readFileSync(secondOutput)).toEqual(fs.readFileSync(outputPath));
    expect(second.sha256).toBe(result.sha256);
  });

  it("strictly rejects extras, missing fields, duplicates, and empty allowlists", () => {
    const cases: Array<[unknown, string]> = [
      [[], "approval_repository_allowlist_invalid"],
      [[{ ...repositories[0], extra: true }], "approval_repository_unknown_or_missing_key"],
      [[{ workspaceId: "w", owner: "o", repo: "r" }], "approval_repository_unknown_or_missing_key"],
      [
        [repositories[0], { ...repositories[1], workspaceId: "workspace-z" }],
        "approval_workspace_duplicate",
      ],
      [
        [repositories[0], { ...repositories[1], reportAlias: "repo-002" }],
        "approval_report_alias_duplicate",
      ],
      [
        [repositories[0], { ...repositories[1], owner: "OWNER-Z", repo: "REPO-Z" }],
        "approval_repository_duplicate",
      ],
      [[{ ...repositories[0], owner: 1 }], "approval_owner_invalid"],
    ];
    for (const [candidate, code] of cases) {
      expect(() =>
        buildScratchApprovalManifest({
          sourceDbPath,
          scratchDbPath,
          scratchStatePath,
          repositories: candidate,
          privateArtifactParentAcknowledged: true,
        }),
      ).toThrow(code);
    }
  });

  it("rejects prototype, control, and path-like report aliases", () => {
    for (const reportAlias of [
      "__proto__",
      "constructor",
      "prototype",
      "../private",
      "folder/name",
      "folder\\name",
      ".hidden",
      "repo..private",
      "repo\u0000private",
    ]) {
      expect(() =>
        buildScratchApprovalManifest({
          sourceDbPath,
          scratchDbPath,
          scratchStatePath,
          repositories: [{ ...repositories[0], reportAlias }],
          privateArtifactParentAcknowledged: true,
        }),
      ).toThrow("approval_report_alias_invalid");
    }
    const prototypeKey = JSON.parse(
      '[{"workspaceId":"w","owner":"o","repo":"r","reportAlias":"a","__proto__":1}]',
    ) as unknown;
    expect(() =>
      buildScratchApprovalManifest({
        sourceDbPath,
        scratchDbPath,
        scratchStatePath,
        repositories: prototypeKey,
        privateArtifactParentAcknowledged: true,
      }),
    ).toThrow("approval_repository_unknown_or_missing_key");
  });

  it("requires explicit acknowledgement and every exact CLI input", () => {
    const args = [
      "--source-db",
      "source",
      "--scratch-db",
      "scratch",
      "--scratch-state",
      "state",
      "--repositories",
      "[]",
      "--out",
      "approval",
      "--acknowledge-private-parent",
    ];
    expect(parseCreateScratchApprovalArgs(args)).toEqual({
      sourceDbPath: "source",
      scratchDbPath: "scratch",
      scratchStatePath: "state",
      repositoriesJson: "[]",
      outputPath: "approval",
      privateArtifactParentAcknowledged: true,
    });
    expect(() => parseCreateScratchApprovalArgs(args.slice(0, -1))).toThrow(
      "private_artifact_parent_not_acknowledged",
    );
    expect(() => parseCreateScratchApprovalArgs([...args, "--out", "other"])).toThrow(
      "duplicate_cli_argument",
    );
    expect(() => parseCreateScratchApprovalArgs([...args, "--approval", "yes"])).toThrow(
      "unknown_cli_argument",
    );
  });

  it("refuses repository outputs and does not replace existing or raced output", async () => {
    await expect(
      createScratchApprovalCandidate(
        input({ outputPath: path.join(repositoryRoot, "approval.json") }),
        { repositoryRoot },
      ),
    ).rejects.toThrow("approval_output_inside_repository");

    fs.writeFileSync(outputPath, "operator-owned", "utf8");
    await expect(createScratchApprovalCandidate(input(), { repositoryRoot })).rejects.toThrow(
      "approval_output_already_exists",
    );
    expect(fs.readFileSync(outputPath, "utf8")).toBe("operator-owned");

    fs.unlinkSync(outputPath);
    await expect(
      createScratchApprovalCandidate(input(), {
        repositoryRoot,
        testHooks: {
          beforePublish(candidatePath) {
            fs.writeFileSync(candidatePath, "raced-operator-owned", { flag: "wx" });
          },
        },
      }),
    ).rejects.toThrow("approval_output_race_lost_candidate_retained");
    expect(fs.readFileSync(outputPath, "utf8")).toBe("raced-operator-owned");
    expect(fs.readdirSync(root).some((name) => name.endsWith(".candidate"))).toBe(true);
  });

  it("refuses a same-byte temporary-path swap instead of accepting a mutable alias", async () => {
    const externalPath = path.join(root, "externally-mutable.json");
    await expect(
      createScratchApprovalCandidate(input(), {
        repositoryRoot,
        testHooks: {
          beforePublish(_candidatePath, temporaryPath) {
            fs.writeFileSync(externalPath, fs.readFileSync(temporaryPath), { flag: "wx" });
            fs.unlinkSync(temporaryPath);
            fs.linkSync(externalPath, temporaryPath);
          },
        },
      }),
    ).rejects.toThrow("approval_output_identity_mismatch_output_and_candidate_retained");

    expect(fs.existsSync(outputPath)).toBe(true);
    fs.writeFileSync(externalPath, "externally-mutated", "utf8");
    expect(fs.readFileSync(outputPath, "utf8")).toBe("externally-mutated");
    expect(fs.readdirSync(root).some((name) => name.endsWith(".candidate"))).toBe(true);
  });

  it("refuses a same-byte output-path swap after reading the published descriptor", async () => {
    const externalPath = path.join(root, "post-read-mutable.json");
    await expect(
      createScratchApprovalCandidate(input(), {
        repositoryRoot,
        testHooks: {
          afterPublishedRead(candidatePath) {
            fs.writeFileSync(externalPath, fs.readFileSync(candidatePath), { flag: "wx" });
            fs.unlinkSync(candidatePath);
            fs.linkSync(externalPath, candidatePath);
          },
        },
      }),
    ).rejects.toThrow("approval_output_final_identity_mismatch_output_and_candidate_retained");

    fs.writeFileSync(externalPath, "post-read-mutation", "utf8");
    expect(fs.readFileSync(outputPath, "utf8")).toBe("post-read-mutation");
    expect(fs.readdirSync(root).some((name) => name.endsWith(".candidate"))).toBe(true);
  });

  it("emits only aggregate candidate status and aggregate refusal details", () => {
    const cli = path.resolve("src/evidence/create-approval.ts");
    const success = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        cli,
        "--source-db",
        sourceDbPath,
        "--scratch-db",
        scratchDbPath,
        "--scratch-state",
        scratchStatePath,
        "--repositories",
        JSON.stringify(repositories),
        "--out",
        outputPath,
        "--acknowledge-private-parent",
      ],
      { encoding: "utf8" },
    );
    expect(success.status).toBe(0);
    expect(success.stderr).toBe("");
    expect(JSON.parse(success.stdout)).toEqual({
      status: "CANDIDATE_CONFIRMATION_REQUIRED",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      mappedWorkspaceN: 2,
    });
    expect(success.stdout).not.toContain(root);
    expect(success.stdout).not.toContain("owner-a");

    const failure = spawnSync(process.execPath, ["--import", "tsx/esm", cli], {
      encoding: "utf8",
    });
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe("");
    expect(JSON.parse(failure.stderr)).toEqual({
      status: "REFUSED",
      failure: "missing_required_cli_argument",
    });
    expect(failure.stderr).not.toContain(root);
  });
});
