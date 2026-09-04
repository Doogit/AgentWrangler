/**
 * Claude Code PreCompact hook: snapshot the transcript before compaction discards
 * detail. Copies the transcript to ~/.agentwrangler/checkpoints/<session>-<ts>.jsonl
 * (mode 0o600), enforces a retention cap by count and total bytes, and ALWAYS exits 0
 * so it can never block compaction. No package dependencies.
 *
 * Known gap (GH #13572): PreCompact may not fire on a manual `/compact`. No fallback in
 * v1 — this covers auto-compaction, which is the lossy path that matters most.
 *
 * SEC-101: snapshots live under the user-profile checkpoints dir (local runtime, never
 * committed). The hook writes no transcript content to stdout/stderr.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_COUNT = 20;
const MAX_BYTES = 500 * 1024 * 1024; // 500 MiB across all snapshots

// Monotonic counter so two firings in the same millisecond get distinct filenames
// that still sort in write order (the timestamp dominates; this breaks same-ms ties).
let snapshotCounter = 0;

/** The directory snapshots are written to (overridable for tests). */
export function checkpointDir() {
  return process.env.AW_CHECKPOINT_DIR ?? path.join(os.homedir(), ".agentwrangler", "checkpoints");
}

/** Filename-safe snapshot name for a session at a given time. */
export function snapshotName(sessionId, now) {
  snapshotCounter = (snapshotCounter + 1) % 1_000_000;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${encodeURIComponent(sessionId)}-${stamp}-${String(snapshotCounter).padStart(6, "0")}.jsonl`;
}

/**
 * Copy the transcript into `dir` with mode 0o600. Returns the snapshot path, or null if
 * the transcript is missing/unreadable (a missing transcript is not an error to report).
 */
export function writeCheckpoint(transcriptPath, sessionId, dir, now = new Date()) {
  if (typeof transcriptPath !== "string" || !fs.existsSync(transcriptPath)) return null;
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, snapshotName(sessionId, now));
  fs.copyFileSync(transcriptPath, dest);
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    // chmod is a no-op boundary on Windows; the user-profile ACL is the equivalent guard.
  }
  return dest;
}

/** Prune oldest snapshots beyond the count cap, then beyond the total-byte cap. */
export function enforceRetention(dir, maxCount = MAX_COUNT, maxBytes = MAX_BYTES) {
  let entries;
  try {
    entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort() // timestamp-derived names sort chronologically
      .map((name) => {
        const full = path.join(dir, name);
        return { full, size: fs.statSync(full).size };
      });
  } catch {
    return; // dir missing or unreadable — nothing to prune
  }

  const removeOldest = () => {
    const victim = entries.shift();
    if (!victim) return;
    try {
      fs.rmSync(victim.full);
    } catch {
      // A locked or already-removed snapshot is not worth failing for.
    }
  };

  while (entries.length > maxCount) removeOldest();
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  while (entries.length > 0 && total > maxBytes) {
    total -= entries[0].size;
    removeOldest();
  }
}

/** True when running under CI / headless automation, where the hook must no-op. */
function inCI() {
  const ci = process.env.CI;
  return typeof ci === "string" && ci !== "" && ci !== "false" && ci !== "0";
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  });
}

async function main() {
  if (inCI()) return;
  try {
    const input = JSON.parse(await readStdin());
    const sessionId = typeof input?.session_id === "string" ? input.session_id : "unknown";
    const transcriptPath = input?.transcript_path;
    const dir = checkpointDir();
    if (writeCheckpoint(transcriptPath, sessionId, dir)) enforceRetention(dir);
  } catch {
    // Never block compaction, never emit noise.
  }
}

const invoked =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) void main();
