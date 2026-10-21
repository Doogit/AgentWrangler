import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ApplyArtifact,
  type ApplyAuthorization,
  ApplyFrameworkError,
  type ApplyFrameworkOptions,
  type ApplyPreview,
  createApplyFramework,
  hashApplyArtifact,
  hashFileContent,
} from "../../src/apply/artifact-framework.js";

let tmpDir: string;
let approvedRoot: string;
let targetPath: string;
const RECEIPT_SIGNING_KEY = "test-only-receipt-signing-key-32-bytes";

function artifact(overrides: Partial<ApplyArtifact> = {}): ApplyArtifact {
  const value: ApplyArtifact = {
    artifactRevisionId: "artifact:current",
    recommendationRevisionId: "revision:current",
    kind: "claude_md_rule",
    targetPath: "CLAUDE.md",
    expectedBaseHash: hashFileContent("header\nfooter\n"),
    operations: [{ match: "footer\n", replacement: "managed rule\nfooter\n" }],
    ...overrides,
  };
  return value;
}

function authorization(value: ApplyArtifact): ApplyAuthorization {
  return {
    authorizationId: "authorization:one",
    artifactRevisionId: value.artifactRevisionId,
    recommendationRevisionId: value.recommendationRevisionId,
    artifactHash: hashApplyArtifact(value),
    targetPath: path.join(approvedRoot, value.targetPath),
    activeArtifactRevisionId: value.artifactRevisionId,
    activeRecommendationRevisionId: value.recommendationRevisionId,
    secretClassification: {
      verdict: "NON_SECRET",
      artifactHash: hashApplyArtifact(value),
      policyVersion: "test-structural-v1",
    },
  };
}

function recomputePreviewId(preview: ApplyPreview): string {
  return hashFileContent(
    JSON.stringify({
      authorizationId: preview.authorizationId,
      artifactHash: preview.artifactHash,
      targetPath: preview.targetPath,
      baseHash: preview.baseHash,
      postHash: preview.postHash,
      changes: preview.changes,
    }),
  );
}

function testCommitIfUnchanged(
  temporaryPath: string,
  destinationPath: string,
  expectedHash: string,
): boolean {
  if (hashFileContent(fs.readFileSync(destinationPath)) !== expectedHash) return false;
  fs.renameSync(temporaryPath, destinationPath);
  return true;
}

function enabledFramework(overrides: Partial<ApplyFrameworkOptions> = {}) {
  return createApplyFramework({
    enabled: true,
    approvedRoots: [approvedRoot],
    commitIfUnchanged: testCommitIfUnchanged,
    receiptSigningKey: RECEIPT_SIGNING_KEY,
    ...overrides,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-hre-apply-"));
  approvedRoot = path.join(tmpDir, "workspace");
  targetPath = path.join(approvedRoot, "CLAUDE.md");
  fs.mkdirSync(approvedRoot, { recursive: true });
  fs.writeFileSync(targetPath, "header\nfooter\n", "utf8");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("HRE-4a artifact apply framework", () => {
  it("is default-off and preview does not mutate the target", () => {
    const value = artifact();
    const disabled = createApplyFramework({ approvedRoots: [approvedRoot] });
    expect(() => disabled.preview(value, authorization(value))).toThrowError(
      new ApplyFrameworkError("DISABLED", "artifact apply is disabled"),
    );

    const enabled = enabledFramework();
    const preview = enabled.preview(value, authorization(value));
    expect(preview).toMatchObject({
      artifactRevisionId: "artifact:current",
      recommendationRevisionId: "revision:current",
      baseHash: value.expectedBaseHash,
      changed: true,
    });
    expect(preview.changes).toEqual([
      { offset: 7, remove: "footer\n", insert: "managed rule\nfooter\n" },
    ]);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("header\nfooter\n");
  });

  it("requires authorization for the exact active artifact revision, recommendation revision, hash, and target", () => {
    const framework = enabledFramework();
    const value = artifact();
    const good = authorization(value);
    const mismatches: ApplyAuthorization[] = [
      { ...good, artifactRevisionId: "artifact:stale" },
      { ...good, recommendationRevisionId: "revision:stale" },
      { ...good, artifactHash: "0".repeat(64) },
      { ...good, targetPath: path.join(approvedRoot, "other.md") },
      { ...good, activeArtifactRevisionId: "artifact:stale" },
      { ...good, activeRecommendationRevisionId: "revision:stale" },
      {
        ...good,
        secretClassification: { ...good.secretClassification, artifactHash: "0".repeat(64) },
      },
    ];

    for (const stale of mismatches) {
      expect(() => framework.preview(value, stale)).toThrowError(
        expect.objectContaining({ code: "AUTHORIZATION_MISMATCH" }),
      );
    }
  });

  it("rejects traversal, targets outside approved roots, and symbolic-link targets", () => {
    const framework = enabledFramework();
    const outsidePath = path.join(tmpDir, "outside.md");
    fs.writeFileSync(outsidePath, "header\nfooter\n", "utf8");
    const traversal = artifact({ targetPath: "../outside.md" });
    expect(() => framework.preview(traversal, authorization(traversal))).toThrowError(
      expect.objectContaining({ code: "PATH_NOT_APPROVED" }),
    );

    const realDirectory = path.join(tmpDir, "real-directory");
    const linkedDirectory = path.join(approvedRoot, "linked-directory");
    fs.mkdirSync(realDirectory);
    fs.writeFileSync(path.join(realDirectory, "CLAUDE.md"), "header\nfooter\n", "utf8");
    fs.symlinkSync(realDirectory, linkedDirectory, "junction");
    const linked = artifact({ targetPath: path.join("linked-directory", "CLAUDE.md") });
    expect(() => framework.preview(linked, authorization(linked))).toThrowError(
      expect.objectContaining({ code: "SYMLINK_REJECTED" }),
    );
  });

  it("fails closed when the target changes between preview and apply", () => {
    const value = artifact();
    const framework = enabledFramework();
    const preview = framework.preview(value, authorization(value));
    fs.writeFileSync(targetPath, "newer user edit\n", "utf8");

    expect(() => framework.apply(value, authorization(value), preview)).toThrowError(
      expect.objectContaining({ code: "CONCURRENT_EDIT" }),
    );
    expect(fs.readFileSync(targetPath, "utf8")).toBe("newer user edit\n");
  });

  it("rechecks concurrent edits immediately before atomic replacement", () => {
    const value = artifact();
    const framework = enabledFramework({
      beforeCommit: () => fs.writeFileSync(targetPath, "racing edit\n", "utf8"),
    });
    const preview = framework.preview(value, authorization(value));

    expect(() => framework.apply(value, authorization(value), preview)).toThrowError(
      expect.objectContaining({ code: "CONCURRENT_EDIT" }),
    );
    expect(fs.readFileSync(targetPath, "utf8")).toBe("racing edit\n");
    expect(fs.readdirSync(approvedRoot).filter((name) => name.includes(".aw-tmp-"))).toEqual([]);
  });

  it("delegates the final comparison to the atomic commit adapter", () => {
    const value = artifact();
    const framework = enabledFramework({
      commitIfUnchanged: (temporaryPath, destinationPath, expectedHash) => {
        fs.writeFileSync(destinationPath, "last-moment edit\n", "utf8");
        return testCommitIfUnchanged(temporaryPath, destinationPath, expectedHash);
      },
    });
    const preview = framework.preview(value, authorization(value));

    expect(() => framework.apply(value, authorization(value), preview)).toThrowError(
      expect.objectContaining({ code: "CONCURRENT_EDIT" }),
    );
    expect(fs.readFileSync(targetPath, "utf8")).toBe("last-moment edit\n");
  });

  it("leaves the original intact when the atomic commit fails", () => {
    const value = artifact();
    const framework = enabledFramework({
      commitIfUnchanged: () => {
        throw new Error("simulated rename failure");
      },
    });
    const preview = framework.preview(value, authorization(value));

    expect(() => framework.apply(value, authorization(value), preview)).toThrowError(
      expect.objectContaining({ code: "ATOMIC_WRITE_FAILED" }),
    );
    expect(fs.readFileSync(targetPath, "utf8")).toBe("header\nfooter\n");
    expect(fs.readdirSync(approvedRoot).filter((name) => name.includes(".aw-tmp-"))).toEqual([]);
  });

  it("fails closed when no atomic commit adapter is configured", () => {
    const value = artifact();
    const framework = createApplyFramework({
      enabled: true,
      approvedRoots: [approvedRoot],
      receiptSigningKey: RECEIPT_SIGNING_KEY,
    });
    const preview = framework.preview(value, authorization(value));

    expect(() => framework.apply(value, authorization(value), preview)).toThrowError(
      expect.objectContaining({ code: "ATOMIC_WRITE_FAILED" }),
    );
    expect(fs.readFileSync(targetPath, "utf8")).toBe("header\nfooter\n");
    expect(fs.readdirSync(approvedRoot).filter((name) => name.includes(".aw-tmp-"))).toEqual([]);
  });

  it("recovers an authenticated rollback receipt after restart following a post-commit crash", () => {
    const value = artifact();
    const auth = authorization(value);
    const crashingFramework = enabledFramework({
      afterCommit: () => {
        throw new Error("simulated process interruption");
      },
    });
    const preview = crashingFramework.preview(value, auth);

    expect(() => crashingFramework.apply(value, auth, preview)).toThrowError(
      "simulated process interruption",
    );
    expect(fs.readFileSync(targetPath, "utf8")).toBe("header\nmanaged rule\nfooter\n");

    const restartedFramework = enabledFramework();
    const recovered = restartedFramework.apply(value, auth, preview);
    expect(recovered.status).toBe("ALREADY_APPLIED");
    expect(restartedFramework.rollback(recovered).status).toBe("ROLLED_BACK");
    expect(fs.readFileSync(targetPath, "utf8")).toBe("header\nfooter\n");
  });

  it("makes repeat apply and rollback idempotent without whole-file backup data", () => {
    const value = artifact();
    const auth = authorization(value);
    const framework = enabledFramework();
    const preview = framework.preview(value, auth);
    const applied = framework.apply(value, auth, preview);

    expect(applied.status).toBe("APPLIED");
    expect(applied.inverse).toEqual([{ offset: 7, remove: "managed rule\n", insert: "" }]);
    expect(JSON.stringify(applied.inverse)).not.toContain("header");
    expect(framework.apply(value, auth, preview).status).toBe("ALREADY_APPLIED");

    const restartedFramework = enabledFramework();
    expect(restartedFramework.rollback(applied).status).toBe("ROLLED_BACK");
    expect(fs.readFileSync(targetPath, "utf8")).toBe("header\nfooter\n");
    expect(restartedFramework.rollback(applied).status).toBe("ALREADY_ROLLED_BACK");
  });

  it("rejects modified previews and forged or modified rollback receipts", () => {
    const value = artifact();
    const auth = authorization(value);
    const framework = enabledFramework();
    const preview = framework.preview(value, auth);
    const changedPreview: ApplyPreview = {
      ...preview,
      changes: [{ offset: 0, remove: "header", insert: "tampered" }],
    };
    const forgedPreview = { ...changedPreview, previewId: recomputePreviewId(changedPreview) };
    expect(() => framework.apply(value, auth, forgedPreview)).toThrowError(
      expect.objectContaining({ code: "PREVIEW_MISMATCH" }),
    );

    const applied = framework.apply(value, auth, preview);
    expect(() => framework.rollback({ ...applied, receiptId: "forged" })).toThrowError(
      expect.objectContaining({ code: "AUTHORIZATION_MISMATCH" }),
    );
    expect(() =>
      framework.rollback({
        ...applied,
        inverse: [{ offset: 0, remove: "managed", insert: "tampered" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "AUTHORIZATION_MISMATCH" }));
    expect(fs.readFileSync(targetPath, "utf8")).toBe("header\nmanaged rule\nfooter\n");
  });

  it("surfaces rollback conflicts without overwriting a newer user edit", () => {
    const value = artifact();
    const auth = authorization(value);
    const framework = enabledFramework();
    const applied = framework.apply(value, auth, framework.preview(value, auth));
    fs.appendFileSync(targetPath, "user edit\n", "utf8");

    expect(() => framework.rollback(applied)).toThrowError(
      expect.objectContaining({ code: "ROLLBACK_CONFLICT" }),
    );
    expect(fs.readFileSync(targetPath, "utf8")).toContain("user edit");
  });

  it("rejects secret-bearing or whole-file inverse data", () => {
    fs.writeFileSync(targetPath, "api_key=secret-value\n", "utf8");
    const secret = artifact({
      kind: "config_diff",
      expectedBaseHash: hashFileContent("api_key=secret-value\n"),
      operations: [{ match: "secret-value", replacement: "rotated-value" }],
    });
    const framework = enabledFramework();
    expect(() => framework.preview(secret, authorization(secret))).toThrowError(
      expect.objectContaining({ code: "UNSAFE_INVERSE" }),
    );

    fs.writeFileSync(targetPath, "header\nfooter\n", "utf8");
    const wholeFile = artifact({
      operations: [{ match: "header\nfooter\n", replacement: "replacement\n" }],
    });
    expect(() => framework.preview(wholeFile, authorization(wholeFile))).toThrowError(
      expect.objectContaining({ code: "UNSAFE_INVERSE" }),
    );

    const secretReplacement = artifact({
      operations: [
        {
          match: "footer",
          // Joined at runtime so no literal key-shaped assignment sits in source (CI gitleaks flags it).
          replacement: [
            "api_key",
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
          ].join("="),
        },
      ],
    });
    expect(() =>
      framework.preview(secretReplacement, authorization(secretReplacement)),
    ).toThrowError(expect.objectContaining({ code: "UNSAFE_INVERSE" }));

    const partitionedWholeFile = artifact({
      operations: [
        { match: "header\n", replacement: "top\n" },
        { match: "footer\n", replacement: "bottom\n" },
      ],
    });
    expect(() =>
      framework.preview(partitionedWholeFile, authorization(partitionedWholeFile)),
    ).toThrowError(expect.objectContaining({ code: "UNSAFE_INVERSE" }));
  });
});
