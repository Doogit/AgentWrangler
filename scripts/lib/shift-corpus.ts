/**
 * Copy a JSONL corpus and shift every line's `timestamp` so the newest turn lands
 * one day before `now`. Pure w.r.t. the source (never modified); non-parseable
 * lines pass through verbatim. Shared by build-shared-seed.ts and the detector-health harness.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** All *.jsonl files under `dir`, as absolute paths. */
function listJsonl(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsonl(full));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/** Parse a line's `timestamp` (ISO) to epoch ms, or null if absent/unparseable. */
function lineTs(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const ts = JSON.parse(trimmed)?.timestamp;
    if (typeof ts !== "string") return null;
    const ms = Date.parse(ts);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * Write a shifted copy of every *.jsonl under `srcDir` into `destDir`, preserving
 * relative paths. Newest timestamp lands at `now − 1 day`. Throws if no line has a timestamp.
 */
export function shiftCorpus(srcDir: string, destDir: string, now: Date | number): { shiftMs: number } {
  const files = listJsonl(srcDir);

  // Pass 1: newest timestamp across the whole corpus.
  let maxTs = Number.NEGATIVE_INFINITY;
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const ms = lineTs(line);
      if (ms !== null && ms > maxTs) maxTs = ms;
    }
  }
  if (!Number.isFinite(maxTs)) {
    throw new Error("shiftCorpus: no timestamped fixture lines found");
  }

  const nowMs = typeof now === "number" ? now : now.getTime();
  const shiftMs = nowMs - 24 * 60 * 60 * 1000 - maxTs;

  // Pass 2: write the shifted copy.
  for (const file of files) {
    const dest = path.join(destDir, path.relative(srcDir, file));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const shifted = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line; // preserve blank / trailing lines
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          return line; // preserve the deliberate broken-JSON fixture verbatim
        }
        if (typeof obj.timestamp === "string") {
          const ms = Date.parse(obj.timestamp);
          if (!Number.isNaN(ms)) obj.timestamp = new Date(ms + shiftMs).toISOString();
        }
        return JSON.stringify(obj);
      })
      .join("\n");
    fs.writeFileSync(dest, shifted);
  }
  return { shiftMs };
}
