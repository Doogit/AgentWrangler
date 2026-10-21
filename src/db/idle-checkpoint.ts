/**
 * src/db/idle-checkpoint.ts — restart the WAL once the database has been write-idle (P0-U5).
 *
 * Auto-checkpoints never reset a file that readers keep pinned. One `wal_checkpoint(RESTART)` after
 * >= 60 s with no write copies every frame back and makes the next write start the WAL over, without
 * competing with ingest. RESTART leaves the file as is; the first commit after it starts the WAL
 * over and SQLite then trims the -wal to `journal_size_limit` (64 MiB, src/db/open.ts), so the file
 * stays on disk at min(high-water, 64 MiB).
 *
 * Not TRUNCATE: a 0-byte -wal makes every later write extend the file, and on Windows an extending
 * write blocks behind the checkpoint worker's flush of it (seconds on a slow disk). Writes that land
 * inside the kept size overwrite in place and do not wait.
 *
 * Write detection is cheap and needs no hooks: `total_changes()` covers this connection's writes and
 * `PRAGMA data_version` changes when ANOTHER connection (e.g. the history worker) commits.
 */

import type { Db } from "./open.js";

export const IDLE_CHECKPOINT_MS = 60_000;

export interface IdleCheckpointer {
  /** Call periodically. Returns true when it ran a RESTART checkpoint on this call. */
  tick(): boolean;
}

export function createIdleCheckpointer(
  db: Db,
  idleMs: number = IDLE_CHECKPOINT_MS,
): IdleCheckpointer {
  const changes = db.prepare("SELECT total_changes()").pluck();
  const signature = (): string =>
    `${changes.get() as number}:${db.pragma("data_version", { simple: true }) as number}`;
  let lastSig = signature();
  let lastWriteAt = Date.now();
  let checkpointed = false;
  return {
    tick(): boolean {
      const now = Date.now();
      const sig = signature();
      if (sig !== lastSig) {
        lastSig = sig;
        lastWriteAt = now;
        checkpointed = false;
        return false;
      }
      if (checkpointed || now - lastWriteAt < idleMs) return false;
      // RESTART waits for readers; never let it sit in the 5 s busy handler on the main thread.
      const prevTimeout = db.pragma("busy_timeout", { simple: true }) as number;
      db.pragma("busy_timeout = 0");
      let busy = 1;
      try {
        const row = db.pragma("wal_checkpoint(RESTART)") as Array<{ busy: number }>;
        busy = row[0]?.busy ?? 1;
      } catch {
        // SQLITE_BUSY thrown instead of a busy row: retry next tick.
      } finally {
        db.pragma(`busy_timeout = ${prevTimeout}`);
      }
      if (busy !== 0) return false; // retry on the next tick
      checkpointed = true;
      return true;
    },
  };
}
