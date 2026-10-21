import type { QueueRankKey } from "./ranking-policy.js";
import type { RANKING_POLICY_VERSION } from "./ranking-policy.js";

export interface QueueSnapshotRef {
  readonly compositionSnapshotId: string;
  readonly compositionVersion: number;
  readonly rankingPolicyVersion: typeof RANKING_POLICY_VERSION;
}

export interface QueueCursorV1 {
  readonly version: 1;
  readonly snapshot: QueueSnapshotRef;
  readonly after: QueueRankKey;
}

export type QueueCursorDecision =
  | { readonly kind: "VALID"; readonly after: QueueRankKey }
  | {
      readonly kind: "REFRESH_REQUIRED";
      readonly reason: "SNAPSHOT_CHANGED" | "SNAPSHOT_EXPIRED" | "POLICY_CHANGED";
    };

/** Cursor decoding/signing is transport work; this freezes logical stale-cursor behavior. */
export function validateQueueCursor(
  cursor: QueueCursorV1,
  current: QueueSnapshotRef,
  availableSnapshotIds: ReadonlySet<string>,
): QueueCursorDecision {
  if (cursor.snapshot.rankingPolicyVersion !== current.rankingPolicyVersion) {
    return { kind: "REFRESH_REQUIRED", reason: "POLICY_CHANGED" };
  }
  if (!availableSnapshotIds.has(cursor.snapshot.compositionSnapshotId)) {
    return { kind: "REFRESH_REQUIRED", reason: "SNAPSHOT_EXPIRED" };
  }
  if (
    cursor.snapshot.compositionSnapshotId !== current.compositionSnapshotId ||
    cursor.snapshot.compositionVersion !== current.compositionVersion
  ) {
    return { kind: "REFRESH_REQUIRED", reason: "SNAPSHOT_CHANGED" };
  }
  return { kind: "VALID", after: cursor.after };
}
