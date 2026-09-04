/**
 * test/ui/no-sql-in-ui.test.ts — the UI issues no SQL and imports no DB driver.
 *
 * SEC / architecture invariant: all data access goes through the typed API
 * client; src/ui/** must never contain SQL or import better-sqlite3. This guard
 * walks the UI source tree and fails on any violation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(__dirname, "../../src/ui");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SELECT_FROM = /\bSELECT\b[\s\S]*?\bFROM\b/i;
const INSERT_INTO = /\bINSERT\s+INTO\b/i;
const PREPARE_CALL = /\.prepare\s*\(/;
// Match an actual import/require of the driver, not the string in a comment.
const SQLITE_IMPORT = /(?:from|require\(\s*)["'][^"']*better-sqlite3/;

describe("no SQL in the UI bundle", () => {
  const files = walk(UI_ROOT);

  it("finds UI source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no UI file contains SQL or imports a SQLite driver", () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf-8");
      if (SELECT_FROM.test(src)) violations.push(`${file}: SELECT…FROM`);
      if (INSERT_INTO.test(src)) violations.push(`${file}: INSERT INTO`);
      if (PREPARE_CALL.test(src)) violations.push(`${file}: .prepare(`);
      if (SQLITE_IMPORT.test(src)) violations.push(`${file}: better-sqlite3 import`);
    }
    expect(violations).toEqual([]);
  });
});
