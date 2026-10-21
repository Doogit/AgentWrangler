/**
 * test/db/stmt-cache.test.ts — P0-U5 prepared-statement cache.
 *
 * `.raw()`, `.pluck()`, `.expand()` and `.safeIntegers()` mutate a Statement, and a re-entrant
 * `.iterate()` throws "This statement is busy executing". A cached (shared) statement must never
 * be put in those modes, so the lint-style test rejects `prep(...)` chained into them anywhere in src/.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { prep } from "../../src/db/stmt-cache.js";

const SRC = path.resolve(import.meta.dirname, "../../src");

// `prep(` ... matching `)` ... `.raw(` etc. (whitespace/newlines allowed). Parentheses inside the
// prep(...) argument list are balanced by scanning, not by a regex, so SQL text cannot fool it.
const BANNED = /^\s*\.\s*(raw|pluck|expand|safeIntegers|iterate)\s*\(/;

function findBannedPrepChains(text: string): number[] {
  const hits: number[] = [];
  const re = /\bprep\s*\(/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    let quote: string | null = null;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i] as string;
      if (quote !== null) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    if (BANNED.test(text.slice(i))) hits.push(text.slice(0, m.index).split("\n").length);
  }
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("P0-U5 test 2: prep()", () => {
  it("returns the same Statement for the same SQL on the same db, a different one on another db", () => {
    const a = new Database(":memory:");
    const b = new Database(":memory:");
    try {
      for (const d of [a, b]) d.exec("CREATE TABLE t (x INTEGER)");
      const s1 = prep(a, "SELECT x FROM t WHERE x = ?");
      expect(prep(a, "SELECT x FROM t WHERE x = ?")).toBe(s1);
      expect(prep(a, "SELECT x FROM t WHERE x > ?")).not.toBe(s1);
      expect(prep(b, "SELECT x FROM t WHERE x = ?")).not.toBe(s1);
      a.prepare("INSERT INTO t VALUES (?)").run(7);
      expect(prep(a, "SELECT x FROM t WHERE x = ?").get(7)).toEqual({ x: 7 });
      expect(prep(a, "SELECT x FROM t WHERE x = ?").get(8)).toBeUndefined();
    } finally {
      a.close();
      b.close();
    }
  });

  it("lint: the checker flags raw/pluck/expand/safeIntegers/iterate chained off prep()", () => {
    for (const m of ["raw", "pluck", "expand", "safeIntegers", "iterate"]) {
      expect(findBannedPrepChains(`const r = prep(db, "SELECT (1)").${m}(true);`), m).toHaveLength(
        1,
      );
      expect(
        findBannedPrepChains(`prep(db,\n  \`SELECT 1\`,\n)\n  .${m}()`),
        `${m} multiline`,
      ).toHaveLength(1);
    }
    expect(findBannedPrepChains(`prep(db, "SELECT 1").get()`)).toEqual([]);
    expect(findBannedPrepChains(`prep(db, "SELECT ') .raw(' ").all()`)).toEqual([]);
  });

  it("lint: no source file chains a mode-changing call off prep()", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      for (const line of findBannedPrepChains(fs.readFileSync(f, "utf8"))) {
        offenders.push(`${path.relative(SRC, f)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("hot-path callers use prep(): tail offsets, /api/status, and the flagged Overview statements", () => {
    const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf8");
    expect(read("ingest/tail.ts")).toMatch(/prep\(\s*db,\s*"SELECT byte_offset/);
    expect(read("ingest/tail.ts")).toMatch(/prep\(\s*db,\s*`INSERT INTO ingest_offsets/);
    expect(read("daemon/router.ts")).toMatch(
      /prep\(\s*_?db,\s*"SELECT COUNT\(\*\) AS count FROM sessions"\)/,
    );
    expect(read("query/spend.ts")).toMatch(
      /prep\(\s*db,\s*"SELECT COUNT\(\*\) AS n FROM sessions WHERE state = 'LIVE'/,
    );
    expect(read("query/api/overview.ts")).toMatch(
      /prep\(\s*db,\s*"SELECT DISTINCT workspace_id AS id FROM sessions WHERE state = 'LIVE'/,
    );
    expect(read("query/api/overview.ts")).toMatch(
      /prep\(\s*db,\s*"SELECT 1 FROM sessions WHERE workspace_id = \? AND state = 'LIVE'/,
    );
  });
});
