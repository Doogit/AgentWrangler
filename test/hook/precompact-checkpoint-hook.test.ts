import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  enforceRetention,
  snapshotName,
  writeCheckpoint,
} from "../../src/hook/precompact-checkpoint-hook.mjs";

const HOOK_PATH = fileURLToPath(
  new URL("../../src/hook/precompact-checkpoint-hook.mjs", import.meta.url),
);

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-checkpoint-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeCheckpoint", () => {
  it("copies the transcript into a named snapshot", () => {
    const dir = tmpDir();
    const transcript = path.join(dir, "src.jsonl");
    fs.writeFileSync(transcript, '{"a":1}\n');

    const dest = writeCheckpoint(transcript, "session_abc", path.join(dir, "out"));
    expect(dest).not.toBeNull();
    expect(fs.existsSync(dest as string)).toBe(true);
    expect(path.basename(dest as string)).toContain("session_abc");
    expect(fs.readFileSync(dest as string, "utf8")).toBe('{"a":1}\n');
  });

  it("creates snapshots with mode 0o600 on POSIX", () => {
    if (process.platform === "win32") return; // ACL boundary, not chmod, on Windows
    const dir = tmpDir();
    const transcript = path.join(dir, "src.jsonl");
    fs.writeFileSync(transcript, "x");
    const dest = writeCheckpoint(transcript, "s", path.join(dir, "out")) as string;
    expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
  });

  it("returns null when the transcript is missing (no snapshot, no throw)", () => {
    const dir = tmpDir();
    expect(writeCheckpoint(path.join(dir, "nope.jsonl"), "s", path.join(dir, "out"))).toBeNull();
    expect(writeCheckpoint(undefined, "s", path.join(dir, "out"))).toBeNull();
  });

  it("produces distinct filenames for two rapid firings", () => {
    const dir = tmpDir();
    const transcript = path.join(dir, "src.jsonl");
    fs.writeFileSync(transcript, "x");
    const out = path.join(dir, "out");
    const now = new Date();
    const a = snapshotName("s", now);
    const b = snapshotName("s", now);
    expect(a).not.toBe(b);
    writeCheckpoint(transcript, "s", out);
    writeCheckpoint(transcript, "s", out);
    expect(fs.readdirSync(out)).toHaveLength(2);
  });
});

describe("enforceRetention", () => {
  it("prunes oldest snapshots beyond the count cap", () => {
    const dir = tmpDir();
    for (let i = 0; i < 5; i += 1) {
      fs.writeFileSync(path.join(dir, `s-2026-01-0${i}.jsonl`), "x");
    }
    enforceRetention(dir, 2, Number.MAX_SAFE_INTEGER);
    const remaining = fs.readdirSync(dir).sort();
    expect(remaining).toHaveLength(2);
    // Newest two (highest-sorting names) survive.
    expect(remaining).toEqual(["s-2026-01-03.jsonl", "s-2026-01-04.jsonl"]);
  });

  it("prunes oldest until under the total-byte cap", () => {
    const dir = tmpDir();
    for (let i = 0; i < 4; i += 1) {
      fs.writeFileSync(path.join(dir, `s-2026-01-0${i}.jsonl`), "aaaa"); // 4 bytes each
    }
    enforceRetention(dir, 100, 10); // 16 bytes total → prune down to ≤10 bytes (2 files)
    expect(fs.readdirSync(dir)).toHaveLength(2);
  });

  it("no-ops on a missing directory", () => {
    expect(() => enforceRetention(path.join(os.tmpdir(), "aw-nope-dir"))).not.toThrow();
  });
});

describe("precompact hook end-to-end (spawned)", () => {
  function run(payload: unknown, env: Record<string, string>): number {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, CI: "", ...env },
    });
    expect(result.status).toBe(0); // always exit 0
    expect(result.stdout).toBe(""); // never emits output
    return result.status ?? 0;
  }

  it("snapshots a valid payload and exits 0", () => {
    const dir = tmpDir();
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(transcript, "line\n");
    const out = path.join(dir, "checkpoints");
    run({ session_id: "session_xyz", transcript_path: transcript }, { AW_CHECKPOINT_DIR: out });
    const files = fs.readdirSync(out);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("session_xyz");
  });

  it("no-ops under CI", () => {
    const dir = tmpDir();
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(transcript, "line\n");
    const out = path.join(dir, "checkpoints");
    run({ session_id: "s", transcript_path: transcript }, { AW_CHECKPOINT_DIR: out, CI: "1" });
    expect(fs.existsSync(out)).toBe(false);
  });

  it("exits 0 with no snapshot when transcript_path is unreadable", () => {
    const dir = tmpDir();
    const out = path.join(dir, "checkpoints");
    run(
      { session_id: "s", transcript_path: path.join(dir, "gone.jsonl") },
      { AW_CHECKPOINT_DIR: out },
    );
    expect(fs.existsSync(out)).toBe(false);
  });
});
