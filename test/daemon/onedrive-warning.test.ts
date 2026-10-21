/**
 * test/daemon/onedrive-warning.test.ts — P3-U8 (D12): warn when the DB is in a OneDrive-synced folder.
 *
 * Oracle: synthetic fixture paths and env roots, never a real OneDrive install. The spawned case
 * proves the line reaches the boot log (--smoke boots, migrates and exits).
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isolatedEnvironment } from "../../scripts/benchmark/production-daemon-profile.js";
import { oneDriveWarning } from "../../src/daemon/config.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-onedrive-"));
  roots.push(root);
  return root;
}

describe("oneDriveWarning", () => {
  const base = path.resolve(os.tmpdir(), "aw-fixture");

  it("warns for a DB under a OneDrive env root (any of the three names, any case)", () => {
    const synced = path.join(base, "Synced");
    const db = path.join(synced, ".agentwrangler", "db.sqlite");
    for (const name of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
      expect(oneDriveWarning(db, { [name]: synced })).toMatch(/OneDrive-synced folder/);
    }
    if (process.platform === "win32") {
      expect(oneDriveWarning(db.toUpperCase(), { OneDrive: synced })).not.toBeNull();
    }
  });

  it("warns for a path segment starting with OneDrive, with no env set", () => {
    const db = path.join(base, "OneDrive - Contoso", "db.sqlite");
    expect(oneDriveWarning(db, {})).toContain(path.resolve(db));
  });

  it("does not warn for an unsynced path, or a sibling that only shares the root's prefix", () => {
    const synced = path.join(base, "Synced");
    expect(oneDriveWarning(path.join(base, "home", "db.sqlite"), { OneDrive: synced })).toBeNull();
    expect(
      oneDriveWarning(path.join(`${synced}Other`, "db.sqlite"), { OneDrive: synced }),
    ).toBeNull();
    expect(oneDriveWarning(path.join(base, "MyOneDrive", "db.sqlite"), {})).toBeNull();
  });
});

const ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/daemon/index.ts",
);

function smokeBoot(root: string, dbPath: string, extra: NodeJS.ProcessEnv) {
  return childProcess.spawnSync(process.execPath, ["--import", "tsx/esm", ENTRY, "--smoke"], {
    env: { ...isolatedEnvironment(root, dbPath), ...extra },
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
}

describe("spawned daemon — boot log", () => {
  it("logs the warning once for a DB under a synthetic OneDrive root, and not otherwise", () => {
    const root = tmpRoot();
    const synced = path.join(root, "Synced");
    fs.mkdirSync(synced, { recursive: true });
    const warned = smokeBoot(root, path.join(synced, "db.sqlite"), { OneDrive: synced });
    expect(warned.status).toBe(0);
    expect(warned.stderr.match(/OneDrive-synced folder/g)).toHaveLength(1);

    const plain = smokeBoot(root, path.join(root, "db.sqlite"), { OneDrive: synced });
    expect(plain.status).toBe(0);
    expect(`${plain.stdout}${plain.stderr}`).not.toMatch(/OneDrive-synced folder/);
  }, 90_000);
});
