/**
 * src/daemon/instance-lock.ts — P3-U8 R-8: one daemon per DB.
 *
 * `<db>.lock` holds the owner's pid, created with O_EXCL. A lock whose pid is no longer running
 * (a killed daemon) is taken over; a live one is reported so the second daemon can exit before it
 * opens the DB.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type InstanceLock = { ok: true; release(): void } | { ok: false; pid: number };

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireInstanceLock(dbPath: string): InstanceLock {
  const lockPath = `${dbPath}.lock`;
  // Write the pid to a private file, then hard-link it into place: the lock never exists empty, so
  // a concurrent starter can't read a half-written lock and take it over as stale.
  const tmpPath = `${lockPath}.${process.pid}`;
  // First run on a fresh machine: the DB directory (~/.agentwrangler) doesn't exist yet.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(tmpPath, String(process.pid));
  try {
    return tryAcquire(lockPath, tmpPath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

function tryAcquire(lockPath: string, tmpPath: string): InstanceLock {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.linkSync(tmpPath, lockPath);
      return {
        ok: true,
        release() {
          try {
            if (fs.readFileSync(lockPath, "utf8") === String(process.pid)) fs.unlinkSync(lockPath);
          } catch {
            // Already gone.
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const pid = Number.parseInt(fs.readFileSync(lockPath, "utf8"), 10);
    if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) return { ok: false, pid };
    fs.rmSync(lockPath, { force: true }); // stale: its owner is gone
  }
  throw new Error(`could not take the instance lock ${lockPath}`);
}
