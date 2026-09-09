import { randomUUID } from "node:crypto";
import type { IssuedOpaqueId, OpaqueIdKind } from "./types.js";
import { WorkRecordError } from "./types.js";

interface PendingId {
  kind: OpaqueIdKind;
  expiresAtMs: number;
}

/**
 * Bounded in-memory proof that request identifiers were minted by this daemon.
 * It stores only random IDs, kinds, and expirations; never request fields.
 */
export class DaemonIdIssuer {
  private readonly pending = new Map<string, PendingId>();
  private readonly claimed = new Map<string, PendingId>();

  constructor(
    private readonly ttlMs = 15 * 60_000,
    private readonly capacity = 2_048,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("DaemonIdIssuer requires a positive TTL and capacity");
    }
  }

  issue(kind: OpaqueIdKind): IssuedOpaqueId {
    this.prune();
    while (this.pending.size + this.claimed.size >= this.capacity) {
      const oldest = (this.pending.keys().next().value ?? this.claimed.keys().next().value) as
        | string
        | undefined;
      if (oldest === undefined) break;
      if (!this.pending.delete(oldest)) this.claimed.delete(oldest);
    }
    const id = randomUUID();
    const expiresAtMs = this.now() + this.ttlMs;
    this.pending.set(id, { kind, expiresAtMs });
    return { id, expires_at: new Date(expiresAtMs).toISOString() };
  }

  claim(id: string, kind: OpaqueIdKind): void {
    this.claimMany([{ id, kind }]);
  }

  /** Validate every claim before consuming any of them. */
  claimMany(ids: ReadonlyArray<{ id: string; kind: OpaqueIdKind }>): void {
    this.prune();
    const unique = new Set<string>();
    for (const { id, kind } of ids) {
      const pending = this.pending.get(id);
      if (unique.has(id) || pending === undefined || pending.kind !== kind) {
        throw new WorkRecordError(400, "INVALID_REQUEST", `unissued or expired ${kind} id`);
      }
      unique.add(id);
    }
    for (const { id } of ids) {
      const pending = this.pending.get(id);
      if (pending !== undefined) this.claimed.set(id, pending);
      this.pending.delete(id);
    }
  }

  /** Restore a claimed ID after a rolled-back transaction. */
  restore(id: string, kind: OpaqueIdKind): void {
    this.prune();
    const claimed = this.claimed.get(id);
    if (claimed !== undefined && claimed.kind === kind) {
      this.claimed.delete(id);
      this.pending.set(id, claimed);
    }
  }

  restoreMany(ids: ReadonlyArray<{ id: string; kind: OpaqueIdKind }>): void {
    for (const { id, kind } of ids) this.restore(id, kind);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, pending] of this.pending) {
      if (pending.expiresAtMs <= now) this.pending.delete(id);
    }
    for (const [id, claimed] of this.claimed) {
      if (claimed.expiresAtMs <= now) this.claimed.delete(id);
    }
  }
}
