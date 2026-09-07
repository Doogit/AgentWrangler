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

/**
 * Return the timestamp encoded by a snapshot filename, or null for files this hook did
 * not create. Malformed .jsonl files are deliberately left alone by retention.
 */
function snapshotTimestamp(name) {
  const match = /-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-\d{6}\.jsonl$/.exec(
    name,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  const timestamp = Date.parse(
    `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`,
  );
  if (Number.isNaN(timestamp)) return null;
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day) &&
    parsed.getUTCHours() === Number(hour) &&
    parsed.getUTCMinutes() === Number(minute) &&
    parsed.getUTCSeconds() === Number(second) &&
    parsed.getUTCMilliseconds() === Number(millisecond)
    ? timestamp
    : null;
}

/** Prune oldest snapshots beyond the count cap, then beyond the total-byte cap. */
export function enforceRetention(dir, maxCount = MAX_COUNT, maxBytes = MAX_BYTES) {
  let entries;
  try {
    entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => {
        const full = path.join(dir, name);
        const timestamp = snapshotTimestamp(name);
        if (timestamp === null) return null;
        try {
          const stat = fs.statSync(full);
          if (!stat.isFile()) return null;
          return { full, name, size: stat.size, timestamp, mtimeMs: stat.mtimeMs };
        } catch {
          // A vanished or unreadable entry must not prevent pruning known snapshots.
          return null;
        }
      })
      .filter((entry) => entry !== null)
      .sort(
        (a, b) =>
          a.timestamp - b.timestamp || a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name),
      );
  } catch {
    return; // dir missing or unreadable — nothing to prune
  }

  let count = entries.length;
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const victim of entries) {
    if (count <= maxCount && total <= maxBytes) break;
    try {
      fs.rmSync(victim.full);
    } catch (error) {
      // A locked snapshot still counts. Try each later candidate at most once.
      if (error?.code !== "ENOENT") continue;
    }
    count -= 1;
    total -= victim.size;
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
