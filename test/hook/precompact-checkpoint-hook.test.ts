import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enforceRetention,
  snapshotName,
  writeCheckpoint,
} from "../../src/hook/precompact-checkpoint-hook.mjs";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));

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
  vi.restoreAllMocks();
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
      fs.writeFileSync(path.join(dir, `s-2026-01-0${i + 1}T00-00-00-000Z-000000.jsonl`), "x");
    }
    enforceRetention(dir, 2, Number.MAX_SAFE_INTEGER);
    const remaining = fs.readdirSync(dir).sort();
    expect(remaining).toHaveLength(2);
    // Newest two (highest-sorting names) survive.
    expect(remaining).toEqual([
      "s-2026-01-04T00-00-00-000Z-000000.jsonl",
      "s-2026-01-05T00-00-00-000Z-000000.jsonl",
    ]);
  });

  it("prunes oldest until under the total-byte cap", () => {
    const dir = tmpDir();
    for (let i = 0; i < 4; i += 1) {
      fs.writeFileSync(path.join(dir, `s-2026-01-0${i + 1}T00-00-00-000Z-000000.jsonl`), "aaaa"); // 4 bytes each
    }
    enforceRetention(dir, 100, 10); // 16 bytes total → prune down to ≤10 bytes (2 files)
    expect(fs.readdirSync(dir)).toHaveLength(2);
  });

  it("uses the encoded time rather than the session-id prefix for the count cap", () => {
    const dir = tmpDir();
    const oldest = "z-session-2026-01-01T00-00-00-000Z-000000.jsonl";
    const newest = "a-session-2026-01-02T00-00-00-000Z-000000.jsonl";
    fs.writeFileSync(path.join(dir, oldest), "x");
    fs.writeFileSync(path.join(dir, newest), "x");

    enforceRetention(dir, 1, Number.MAX_SAFE_INTEGER);

    expect(fs.readdirSync(dir)).toEqual([newest]);
  });

  it("uses the encoded time rather than the session-id prefix for the byte cap", () => {
    const dir = tmpDir();
    const oldest = "z-session-2026-01-01T00-00-00-000Z-000000.jsonl";
    const newest = "a-session-2026-01-02T00-00-00-000Z-000000.jsonl";
    fs.writeFileSync(path.join(dir, oldest), "aaaa");
    fs.writeFileSync(path.join(dir, newest), "bbbb");

    enforceRetention(dir, 20, 4);

    expect(fs.readdirSync(dir)).toEqual([newest]);
  });

  it("leaves malformed jsonl files outside the checkpoint retention set", () => {
    const dir = tmpDir();
    const malformed = "notes.jsonl";
    const snapshot = "s-2026-01-01T00-00-00-000Z-000000.jsonl";
    fs.writeFileSync(path.join(dir, malformed), "x");
    fs.writeFileSync(path.join(dir, snapshot), "x");

    enforceRetention(dir, 0, 0);

    expect(fs.readdirSync(dir)).toEqual([malformed]);
  });

  it("no-ops on a missing directory", () => {
    expect(() => enforceRetention(path.join(os.tmpdir(), "aw-nope-dir"))).not.toThrow();
  });

  it.each([
    { count: 2, bytes: Number.MAX_SAFE_INTEGER },
    { count: 20, bytes: 8 },
  ])("accounts for locked files under caps $count/$bytes", ({ count, bytes }) => {
    const dir = tmpDir();
    const files = Array.from({ length: 4 }, (_, i) =>
      path.join(dir, `s-2026-01-0${i + 1}T00-00-00-000Z-000000.jsonl`),
    );
    for (const file of files) fs.writeFileSync(file, "aaaa");
    const remove = fs.rmSync;
    vi.spyOn(fs, "rmSync").mockImplementation((file, options) => {
      if (file === files[0]) throw Object.assign(new Error("locked"), { code: "EPERM" });
      remove(file, options);
    });

    enforceRetention(dir, count, bytes);

    expect(fs.readdirSync(dir).sort()).toEqual(
      files.filter((_, index) => index === 0 || index === 3).map((file) => path.basename(file)),
    );
  });

  it("continues after a snapshot disappears during enumeration", () => {
    const dir = tmpDir();
    const files = Array.from({ length: 4 }, (_, i) =>
      path.join(dir, `s-2026-01-0${i + 1}T00-00-00-000Z-000000.jsonl`),
    );
    for (const file of files) fs.writeFileSync(file, "aaaa");
    const stat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((file, options) => {
      if (file === files[0]) {
        fs.rmSync(file);
        throw Object.assign(new Error("vanished"), { code: "ENOENT" });
      }
      return stat(file, options);
    }) as typeof fs.statSync);

    enforceRetention(dir, 2, 8);

    expect(fs.readdirSync(dir).sort()).toEqual(files.slice(2).map((file) => path.basename(file)));
  });

  it("stops after one attempt per candidate when every snapshot is locked", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "s-2026-01-01T00-00-00-000Z-000000.jsonl"), "x");
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw Object.assign(new Error("locked"), { code: "EPERM" });
    });

    enforceRetention(dir, 0, 0);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dir)).toHaveLength(1);
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
