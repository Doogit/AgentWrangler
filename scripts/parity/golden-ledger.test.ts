/**
 * scripts/parity/golden-ledger.test.ts (P3.L L9)
 *
 * Rebuilds the ledger on a scratch copy of the shared seed (`.verify-seed/seed.sqlite`) at
 * 2026-09-28T00:00:00.000Z, takes the figures from the independent SQL oracle, and asserts they equal
 * the frozen `golden-ledger.json`. A missing seed or golden fails with the command that makes it.
 *
 * Run with: npx vitest run --config scripts/parity/vitest.config.ts scripts/parity/golden-ledger.test.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import type { Db } from "../../src/db/open.js";
import { writeLedgerDaily } from "../../src/detector/ledger-daily.js";
import { goldenWindows } from "./ledger-sql-oracle.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AS_OF = "2026-09-28T00:00:00.000Z";
const GOLDEN = path.join(HERE, "golden-ledger.json");

/** The seed lives in the root checkout; a worktree under `<root>/.worktrees/<slug>` reaches it from there. */
function seedPath(): string {
  const repo = path.resolve(HERE, "..", "..");
  const marker = `${path.sep}.worktrees${path.sep}`;
  const root = repo.includes(marker) ? repo.slice(0, repo.indexOf(marker)) : repo;
  return path.join(root, ".verify-seed", "seed.sqlite");
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-golden-ledger-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("golden-ledger", () => {
  it("the oracle's SQL figures on the seed equal golden-ledger.json", () => {
    const seed = seedPath();
    if (!fs.existsSync(seed))
      throw new Error(`Seed DB missing at ${seed}. Build it with: node scripts/dashboard-seed.mjs`);
    if (!fs.existsSync(GOLDEN))
      throw new Error(
        `golden-ledger not frozen yet (${GOLDEN}). Freeze it with: npx tsx scripts/parity/ledger-sql-oracle.ts --db <seed copy with ledger> --as-of ${AS_OF} --emit-golden scripts/parity/golden-ledger.json`,
      );
    const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8")) as {
      version: number;
      source: string;
      as_of: string;
      windows: Record<string, { tile_u: number; causes: Record<string, number> }>;
    };
    expect(golden.version).toBe(1);
    expect(golden.source).toBe("seed");
    expect(golden.as_of).toBe(AS_OF);

    const copy = path.join(tmp, "seed-copy.sqlite");
    const source = new Database(seed, { readonly: true, fileMustExist: true });
    source.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    source.close();
    const db = new Database(copy) as unknown as Db;
    try {
      runMigrations(db);
      writeLedgerDaily(db, new Date(AS_OF));
      expect(goldenWindows(db, AS_OF)).toEqual(golden.windows);
    } finally {
      db.close();
    }
  });
});
