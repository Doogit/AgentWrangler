import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type ApplyArtifactKind = "config_diff" | "claude_md_rule";

export interface ApplyOperation {
  readonly match: string;
  readonly replacement: string;
}

export interface ApplyArtifact {
  readonly artifactRevisionId: string;
  readonly recommendationRevisionId: string;
  readonly kind: ApplyArtifactKind;
  readonly targetPath: string;
  readonly expectedBaseHash: string;
  readonly operations: readonly ApplyOperation[];
}

export interface ApplyAuthorization {
  readonly authorizationId: string;
  readonly artifactRevisionId: string;
  readonly recommendationRevisionId: string;
  readonly artifactHash: string;
  readonly targetPath: string;
  /** Current identities resolved by the authorization boundary at call time. */
  readonly activeArtifactRevisionId: string;
  readonly activeRecommendationRevisionId: string;
  /** Trusted authorization-bound output from the structural secret classifier. */
  readonly secretClassification: {
    readonly verdict: "NON_SECRET";
    readonly artifactHash: string;
    readonly policyVersion: string;
  };
}

export interface PreviewChange {
  readonly offset: number;
  readonly remove: string;
  readonly insert: string;
}

export interface ApplyPreview {
  readonly previewId: string;
  readonly authorizationId: string;
  readonly artifactRevisionId: string;
  readonly recommendationRevisionId: string;
  readonly artifactHash: string;
  readonly targetPath: string;
  readonly baseHash: string;
  readonly postHash: string;
  readonly changed: boolean;
  readonly changes: readonly PreviewChange[];
}

export interface OwnedInverseChange {
  readonly offset: number;
  readonly remove: string;
  readonly insert: string;
}

export interface ApplyReceipt {
  readonly receiptId: string;
  readonly receiptMac: string;
  readonly status: "APPLIED" | "ALREADY_APPLIED";
  readonly authorizationId: string;
  readonly artifactRevisionId: string;
  readonly recommendationRevisionId: string;
  readonly artifactHash: string;
  readonly targetPath: string;
  readonly baseHash: string;
  readonly postHash: string;
  /** Bounded, non-secret owned spans only. Never a whole-file backup. */
  readonly inverse: readonly OwnedInverseChange[];
}

export interface RollbackReceipt {
  readonly status: "ROLLED_BACK" | "ALREADY_ROLLED_BACK";
  readonly baseHash: string;
  readonly postHash: string;
}

export type ApplyFrameworkErrorCode =
  | "DISABLED"
  | "INVALID_ARTIFACT"
  | "AUTHORIZATION_MISMATCH"
  | "PATH_NOT_APPROVED"
  | "SYMLINK_REJECTED"
  | "TARGET_INVALID"
  | "STALE_BASE"
  | "PREVIEW_MISMATCH"
  | "CONCURRENT_EDIT"
  | "UNSAFE_INVERSE"
  | "ATOMIC_WRITE_FAILED"
  | "ROLLBACK_CONFLICT";

export class ApplyFrameworkError extends Error {
  constructor(
    readonly code: ApplyFrameworkErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApplyFrameworkError";
  }
}

export interface ApplyFrameworkOptions {
  readonly enabled?: boolean;
  readonly approvedRoots: readonly string[];
  /** Stable operator-owned key used to authenticate persisted rollback receipts. */
  readonly receiptSigningKey?: string | Buffer;
  /** Test seam used to prove the last-moment concurrent-edit check. */
  readonly beforeCommit?: (targetPath: string) => void;
  /** Test seam used to prove recovery after commit but before receipt return. */
  readonly afterCommit?: (targetPath: string) => void;
  /**
   * Platform adapter which MUST atomically and durably install temporaryPath
   * only when targetPath still has expectedHash. Return false on a compare
   * conflict and consume temporaryPath on success.
   * HRE-4a deliberately has no unsafe path-based rename fallback.
   */
  readonly commitIfUnchanged?: (
    temporaryPath: string,
    targetPath: string,
    expectedHash: string,
  ) => boolean;
}

const SHA256 = /^[a-f0-9]{64}$/;
const SECRET_MARKER =
  /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|password|passwd|private[_-]?key|secret)/i;
const SECRET_SHAPE = /(?:-----BEGIN [A-Z ]+PRIVATE KEY-----|\b[A-Za-z0-9+/=_-]{48,}\b)/;
const MAX_OWNED_INVERSE_BYTES = 4096;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashFileContent(content: string | Buffer): string {
  return sha256(content);
}

function canonicalArtifact(artifact: ApplyArtifact): string {
  return JSON.stringify({
    artifactRevisionId: artifact.artifactRevisionId,
    recommendationRevisionId: artifact.recommendationRevisionId,
    kind: artifact.kind,
    targetPath: artifact.targetPath.replaceAll("\\", "/"),
    expectedBaseHash: artifact.expectedBaseHash,
    operations: artifact.operations.map((operation) => ({
      match: operation.match,
      replacement: operation.replacement,
    })),
  });
}

export function hashApplyArtifact(artifact: ApplyArtifact): string {
  return sha256(canonicalArtifact(artifact));
}

function equalPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length) {
    const found = content.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + Math.max(needle.length, 1);
  }
  return count;
}

function minimalOwnedChange(
  offset: number,
  before: string,
  after: string,
): { changeOffset: number; removed: string; inserted: string } {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    changeOffset: offset + prefix,
    removed: before.slice(prefix, before.length - suffix),
    inserted: after.slice(prefix, after.length - suffix),
  };
}

interface MaterializedArtifact {
  readonly content: string;
  readonly changes: readonly PreviewChange[];
  readonly inverse: readonly OwnedInverseChange[];
}

function materialize(artifact: ApplyArtifact, base: string): MaterializedArtifact {
  if (artifact.operations.length === 0 || artifact.operations.length > 32) {
    throw new ApplyFrameworkError(
      "INVALID_ARTIFACT",
      "artifact operations must contain 1 to 32 edits",
    );
  }
  let content = base;
  const changes: PreviewChange[] = [];
  const inverse: OwnedInverseChange[] = [];
  let inverseBytes = 0;
  let restoredBytes = 0;
  let matchedBytes = 0;

  for (const operation of artifact.operations) {
    if (operation.match.length === 0 || operation.match === operation.replacement) {
      throw new ApplyFrameworkError("INVALID_ARTIFACT", "artifact edits must be non-empty changes");
    }
    if (countOccurrences(content, operation.match) !== 1) {
      throw new ApplyFrameworkError(
        "INVALID_ARTIFACT",
        "each artifact edit must match exactly one owned span",
      );
    }
    const offset = content.indexOf(operation.match);
    if (
      SECRET_MARKER.test(operation.match) ||
      SECRET_MARKER.test(operation.replacement) ||
      SECRET_SHAPE.test(operation.match) ||
      SECRET_SHAPE.test(operation.replacement) ||
      (offset === 0 && Buffer.byteLength(operation.match) === Buffer.byteLength(content))
    ) {
      throw new ApplyFrameworkError(
        "UNSAFE_INVERSE",
        "artifact inverse would contain secret-bearing or whole-file data",
      );
    }

    const owned = minimalOwnedChange(offset, operation.match, operation.replacement);
    inverseBytes += Buffer.byteLength(owned.removed) + Buffer.byteLength(owned.inserted);
    restoredBytes += Buffer.byteLength(owned.removed);
    matchedBytes += Buffer.byteLength(operation.match);
    if (
      inverseBytes > MAX_OWNED_INVERSE_BYTES ||
      restoredBytes >= Buffer.byteLength(base) ||
      matchedBytes >= Buffer.byteLength(base) ||
      SECRET_MARKER.test(owned.removed) ||
      SECRET_MARKER.test(owned.inserted) ||
      SECRET_SHAPE.test(owned.removed) ||
      SECRET_SHAPE.test(owned.inserted)
    ) {
      throw new ApplyFrameworkError(
        "UNSAFE_INVERSE",
        "artifact inverse exceeds the bounded non-secret owned-data contract",
      );
    }
    changes.push({ offset, remove: operation.match, insert: operation.replacement });
    inverse.unshift({
      offset: owned.changeOffset,
      remove: owned.inserted,
      insert: owned.removed,
    });
    content = `${content.slice(0, offset)}${operation.replacement}${content.slice(
      offset + operation.match.length,
    )}`;
  }
  return { content, changes, inverse };
}

interface TargetIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
}

function inspectTarget(targetPath: string, approvedRoots: readonly string[]): TargetIdentity {
  const lexicalTarget = path.resolve(targetPath);
  const root = approvedRoots.find((candidate) => isInside(lexicalTarget, candidate));
  if (root === undefined) {
    throw new ApplyFrameworkError("PATH_NOT_APPROVED", "target is outside approved roots");
  }

  const relative = path.relative(root, lexicalTarget);
  let cursor = root;
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      throw new ApplyFrameworkError("TARGET_INVALID", "target path does not exist", {
        cause: error,
      });
    }
    if (stat.isSymbolicLink()) {
      throw new ApplyFrameworkError(
        "SYMLINK_REJECTED",
        "symbolic links and junctions are not allowed",
      );
    }
  }

  const stat = fs.lstatSync(lexicalTarget);
  if (!stat.isFile()) {
    throw new ApplyFrameworkError("TARGET_INVALID", "target must be an existing regular file");
  }
  const canonical = fs.realpathSync.native(lexicalTarget);
  if (!isInside(canonical, root)) {
    throw new ApplyFrameworkError(
      "PATH_NOT_APPROVED",
      "canonical target is outside approved roots",
    );
  }
  return { path: canonical, device: stat.dev, inode: stat.ino, mode: stat.mode };
}

function readStableTarget(identity: TargetIdentity): string {
  const before = fs.lstatSync(identity.path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.dev !== identity.device ||
    before.ino !== identity.inode
  ) {
    throw new ApplyFrameworkError("CONCURRENT_EDIT", "target identity changed concurrently");
  }
  const content = fs.readFileSync(identity.path, "utf8");
  const after = fs.lstatSync(identity.path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
    throw new ApplyFrameworkError("CONCURRENT_EDIT", "target changed while it was being read");
  }
  return content;
}

function validateArtifact(artifact: ApplyArtifact): void {
  if (
    !artifact.artifactRevisionId ||
    !artifact.recommendationRevisionId ||
    !SHA256.test(artifact.expectedBaseHash) ||
    (artifact.kind !== "config_diff" && artifact.kind !== "claude_md_rule") ||
    !artifact.targetPath ||
    path.isAbsolute(artifact.targetPath)
  ) {
    throw new ApplyFrameworkError("INVALID_ARTIFACT", "artifact contract is invalid");
  }
}

function validateAuthorization(
  artifact: ApplyArtifact,
  authorization: ApplyAuthorization,
  targetPath: string,
): string {
  const artifactHash = hashApplyArtifact(artifact);
  if (
    !authorization.authorizationId ||
    authorization.artifactRevisionId !== artifact.artifactRevisionId ||
    authorization.recommendationRevisionId !== artifact.recommendationRevisionId ||
    authorization.artifactHash !== artifactHash ||
    authorization.activeArtifactRevisionId !== artifact.artifactRevisionId ||
    authorization.activeRecommendationRevisionId !== artifact.recommendationRevisionId ||
    authorization.secretClassification?.verdict !== "NON_SECRET" ||
    authorization.secretClassification.artifactHash !== artifactHash ||
    !authorization.secretClassification.policyVersion ||
    !equalPath(authorization.targetPath, targetPath)
  ) {
    throw new ApplyFrameworkError(
      "AUTHORIZATION_MISMATCH",
      "authorization does not match the exact artifact revision and target",
    );
  }
  return artifactHash;
}

function resolveAuthorizedTarget(
  artifact: ApplyArtifact,
  authorization: ApplyAuthorization,
  approvedRoots: readonly string[],
): TargetIdentity {
  const candidates = approvedRoots
    .map((root) => path.resolve(root, artifact.targetPath))
    .filter((candidate, index) => isInside(candidate, approvedRoots[index] as string));
  if (candidates.length === 0) {
    throw new ApplyFrameworkError("PATH_NOT_APPROVED", "target is outside approved roots");
  }
  const requestedTarget = candidates.find((candidate) =>
    equalPath(candidate, authorization.targetPath),
  );
  if (requestedTarget === undefined) {
    throw new ApplyFrameworkError(
      "AUTHORIZATION_MISMATCH",
      "authorization does not match the artifact target",
    );
  }
  return inspectTarget(requestedTarget, approvedRoots);
}

function applyOwnedInverse(content: string, inverse: readonly OwnedInverseChange[]): string {
  let next = content;
  for (const change of inverse) {
    if (next.slice(change.offset, change.offset + change.remove.length) !== change.remove) {
      throw new ApplyFrameworkError("ROLLBACK_CONFLICT", "owned rollback span was changed");
    }
    next = `${next.slice(0, change.offset)}${change.insert}${next.slice(
      change.offset + change.remove.length,
    )}`;
  }
  return next;
}

function inverseFromPreview(changes: readonly PreviewChange[]): readonly OwnedInverseChange[] {
  return [...changes].reverse().map((change) => {
    const owned = minimalOwnedChange(change.offset, change.remove, change.insert);
    return { offset: owned.changeOffset, remove: owned.inserted, insert: owned.removed };
  });
}

export interface ApplyFramework {
  preview(artifact: ApplyArtifact, authorization: ApplyAuthorization): ApplyPreview;
  apply(
    artifact: ApplyArtifact,
    authorization: ApplyAuthorization,
    preview: ApplyPreview,
  ): ApplyReceipt;
  rollback(receipt: ApplyReceipt): RollbackReceipt;
}

function canonicalReceipt(receipt: Omit<ApplyReceipt, "receiptMac">): string {
  return JSON.stringify({
    receiptId: receipt.receiptId,
    status: receipt.status,
    authorizationId: receipt.authorizationId,
    artifactRevisionId: receipt.artifactRevisionId,
    recommendationRevisionId: receipt.recommendationRevisionId,
    artifactHash: receipt.artifactHash,
    targetPath: receipt.targetPath,
    baseHash: receipt.baseHash,
    postHash: receipt.postHash,
    inverse: receipt.inverse.map((change) => ({
      offset: change.offset,
      remove: change.remove,
      insert: change.insert,
    })),
  });
}

function canonicalPreviewIdentity(preview: Omit<ApplyPreview, "previewId" | "changed">): string {
  return JSON.stringify({
    authorizationId: preview.authorizationId,
    artifactRevisionId: preview.artifactRevisionId,
    recommendationRevisionId: preview.recommendationRevisionId,
    artifactHash: preview.artifactHash,
    targetPath: preview.targetPath,
    baseHash: preview.baseHash,
    postHash: preview.postHash,
    changes: preview.changes.map((change) => ({
      offset: change.offset,
      remove: change.remove,
      insert: change.insert,
    })),
  });
}

export function createApplyFramework(options: ApplyFrameworkOptions): ApplyFramework {
  const enabled = options.enabled === true;
  const rootAliases = options.approvedRoots.map((root) => {
    const resolved = path.resolve(root);
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ApplyFrameworkError("SYMLINK_REJECTED", "approved roots must be real directories");
    }
    return { lexical: resolved, canonical: fs.realpathSync.native(resolved) };
  });
  const approvedRoots = rootAliases.map((root) => root.canonical);
  // Candidates are built from canonical roots, so the caller's authorization path must be too.
  // Only the approved-root prefix is rewritten (e.g. macOS /var -> /private/var); anything below
  // the root stays lexical so inspectTarget still rejects symlinks and junctions there.
  const withCanonicalTarget = (authorization: ApplyAuthorization): ApplyAuthorization => {
    const resolved = path.resolve(authorization.targetPath);
    const alias = rootAliases.find((root) => isInside(resolved, root.lexical));
    if (alias === undefined) return authorization;
    return {
      ...authorization,
      targetPath: path.join(alias.canonical, path.relative(alias.lexical, resolved)),
    };
  };
  if (approvedRoots.length === 0) {
    throw new ApplyFrameworkError("PATH_NOT_APPROVED", "at least one approved root is required");
  }
  const receiptSigningKey = options.receiptSigningKey;

  const requireReceiptSigningKey = (): string | Buffer => {
    if (receiptSigningKey === undefined || Buffer.byteLength(receiptSigningKey) < 32) {
      throw new ApplyFrameworkError(
        "AUTHORIZATION_MISMATCH",
        "a stable receipt signing key of at least 32 bytes is required",
      );
    }
    return receiptSigningKey;
  };

  const receiptMac = (receipt: Omit<ApplyReceipt, "receiptMac">): string =>
    createHmac("sha256", requireReceiptSigningKey())
      .update(canonicalReceipt(receipt))
      .digest("hex");

  const previewMac = (preview: Omit<ApplyPreview, "previewId" | "changed">): string =>
    createHmac("sha256", requireReceiptSigningKey())
      .update(canonicalPreviewIdentity(preview))
      .digest("hex");

  const verifyReceipt = (receipt: ApplyReceipt): boolean => {
    if (!SHA256.test(receipt.receiptMac)) return false;
    const { receiptMac: suppliedMac, ...unsigned } = receipt;
    const expectedMac = receiptMac(unsigned);
    return timingSafeEqual(Buffer.from(suppliedMac, "hex"), Buffer.from(expectedMac, "hex"));
  };

  const ensureEnabled = () => {
    if (!enabled) throw new ApplyFrameworkError("DISABLED", "artifact apply is disabled");
  };

  const atomicReplace = (identity: TargetIdentity, expectedHash: string, content: string): void => {
    const temporaryPath = path.join(
      path.dirname(identity.path),
      `.${path.basename(identity.path)}.aw-tmp-${randomUUID()}`,
    );
    let descriptor: number | null = null;
    let pendingError: unknown;
    try {
      descriptor = fs.openSync(temporaryPath, "wx", identity.mode & 0o777);
      fs.writeFileSync(descriptor, content, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;

      options.beforeCommit?.(identity.path);
      const currentIdentity = inspectTarget(identity.path, approvedRoots);
      const current = readStableTarget(currentIdentity);
      if (
        currentIdentity.device !== identity.device ||
        currentIdentity.inode !== identity.inode ||
        hashFileContent(current) !== expectedHash
      ) {
        throw new ApplyFrameworkError("CONCURRENT_EDIT", "target changed before atomic commit");
      }
      if (options.commitIfUnchanged === undefined) {
        throw new ApplyFrameworkError(
          "ATOMIC_WRITE_FAILED",
          "no atomic compare-and-swap adapter is configured",
        );
      }
      if (!options.commitIfUnchanged(temporaryPath, identity.path, expectedHash)) {
        throw new ApplyFrameworkError("CONCURRENT_EDIT", "target changed during atomic commit");
      }
      const installedIdentity = inspectTarget(identity.path, approvedRoots);
      if (hashFileContent(readStableTarget(installedIdentity)) !== hashFileContent(content)) {
        throw new ApplyFrameworkError(
          "ATOMIC_WRITE_FAILED",
          "atomic commit adapter did not install the expected content",
        );
      }
    } catch (error) {
      pendingError =
        error instanceof ApplyFrameworkError
          ? error
          : new ApplyFrameworkError("ATOMIC_WRITE_FAILED", "atomic target replacement failed", {
              cause: error,
            });
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && pendingError === undefined) {
          pendingError = new ApplyFrameworkError(
            "ATOMIC_WRITE_FAILED",
            "temporary file cleanup failed",
            { cause: error },
          );
        }
      }
    }
    if (pendingError !== undefined) throw pendingError;
  };

  const prepare = (artifact: ApplyArtifact, authorization: ApplyAuthorization) => {
    ensureEnabled();
    validateArtifact(artifact);
    const authorized = withCanonicalTarget(authorization);
    const identity = resolveAuthorizedTarget(artifact, authorized, approvedRoots);
    const artifactHash = validateAuthorization(artifact, authorized, identity.path);
    const base = readStableTarget(identity);
    const baseHash = hashFileContent(base);
    if (baseHash !== artifact.expectedBaseHash) {
      throw new ApplyFrameworkError("STALE_BASE", "artifact base hash is stale");
    }
    const materialized = materialize(artifact, base);
    return { identity, artifactHash, base, baseHash, materialized };
  };

  return {
    preview(artifact, authorization) {
      const prepared = prepare(artifact, authorization);
      const postHash = hashFileContent(prepared.materialized.content);
      const previewIdentity = {
        authorizationId: authorization.authorizationId,
        artifactRevisionId: artifact.artifactRevisionId,
        recommendationRevisionId: artifact.recommendationRevisionId,
        artifactHash: prepared.artifactHash,
        targetPath: prepared.identity.path,
        baseHash: prepared.baseHash,
        postHash,
        changes: prepared.materialized.changes,
      };
      return {
        ...previewIdentity,
        previewId: previewMac(previewIdentity),
        changed: prepared.baseHash !== postHash,
      };
    },

    apply(artifact, authorization, preview) {
      ensureEnabled();
      validateArtifact(artifact);
      const authorized = withCanonicalTarget(authorization);
      const identity = resolveAuthorizedTarget(artifact, authorized, approvedRoots);
      const artifactHash = validateAuthorization(artifact, authorized, identity.path);
      const current = readStableTarget(identity);
      const currentHash = hashFileContent(current);
      if (currentHash !== artifact.expectedBaseHash && currentHash !== preview.postHash) {
        throw new ApplyFrameworkError("CONCURRENT_EDIT", "target changed after preview");
      }
      const baseMaterialized =
        currentHash === artifact.expectedBaseHash ? materialize(artifact, current) : null;
      const postHash = baseMaterialized
        ? hashFileContent(baseMaterialized.content)
        : preview.postHash;
      const expectedPreviewId = previewMac({
        authorizationId: authorization.authorizationId,
        artifactRevisionId: artifact.artifactRevisionId,
        recommendationRevisionId: artifact.recommendationRevisionId,
        artifactHash,
        targetPath: identity.path,
        baseHash: artifact.expectedBaseHash,
        postHash,
        changes: preview.changes,
      });
      if (
        preview.previewId !== expectedPreviewId ||
        preview.authorizationId !== authorization.authorizationId ||
        preview.artifactRevisionId !== artifact.artifactRevisionId ||
        preview.recommendationRevisionId !== artifact.recommendationRevisionId ||
        preview.artifactHash !== artifactHash ||
        !equalPath(preview.targetPath, identity.path) ||
        preview.baseHash !== artifact.expectedBaseHash ||
        preview.postHash !== postHash
      ) {
        throw new ApplyFrameworkError(
          "PREVIEW_MISMATCH",
          "preview does not match this apply request",
        );
      }

      const materialized = baseMaterialized ?? {
        content: current,
        changes: preview.changes,
        inverse: inverseFromPreview(preview.changes),
      };
      const status = currentHash === postHash ? "ALREADY_APPLIED" : "APPLIED";
      requireReceiptSigningKey();
      if (status === "APPLIED") {
        atomicReplace(identity, currentHash, materialized.content);
        options.afterCommit?.(identity.path);
      }
      const unsignedReceipt: Omit<ApplyReceipt, "receiptMac"> = {
        receiptId: randomUUID(),
        status,
        authorizationId: authorization.authorizationId,
        artifactRevisionId: artifact.artifactRevisionId,
        recommendationRevisionId: artifact.recommendationRevisionId,
        artifactHash,
        targetPath: identity.path,
        baseHash: artifact.expectedBaseHash,
        postHash,
        inverse: materialized.inverse,
      };
      return { ...unsignedReceipt, receiptMac: receiptMac(unsignedReceipt) };
    },

    rollback(receipt) {
      ensureEnabled();
      if (!verifyReceipt(receipt)) {
        throw new ApplyFrameworkError(
          "AUTHORIZATION_MISMATCH",
          "rollback receipt was not issued by this framework or was modified",
        );
      }
      const identity = inspectTarget(receipt.targetPath, approvedRoots);
      const current = readStableTarget(identity);
      const currentHash = hashFileContent(current);
      if (currentHash === receipt.baseHash) {
        return {
          status: "ALREADY_ROLLED_BACK",
          baseHash: receipt.baseHash,
          postHash: receipt.postHash,
        };
      }
      if (currentHash !== receipt.postHash) {
        throw new ApplyFrameworkError(
          "ROLLBACK_CONFLICT",
          "target contains newer edits; rollback refused",
        );
      }
      const restored = applyOwnedInverse(current, receipt.inverse);
      if (hashFileContent(restored) !== receipt.baseHash) {
        throw new ApplyFrameworkError(
          "ROLLBACK_CONFLICT",
          "owned inverse did not restore base hash",
        );
      }
      atomicReplace(identity, currentHash, restored);
      return { status: "ROLLED_BACK", baseHash: receipt.baseHash, postHash: receipt.postHash };
    },
  };
}
