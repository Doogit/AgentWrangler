// Read-only SQL runner for an audit folder. Usage: node query.mjs "SELECT ..."
// Opens ./db.sqlite (next to this file) readonly; accepts one SELECT / WITH / PRAGMA table_info(...) only.

import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const BETTER_SQLITE3 = "__AW_BETTER_SQLITE3__";
const MAX_ROWS = 200;

const sql = (process.argv[2] ?? "").trim().replace(/;+\s*$/, "");
if (sql === "") {
  console.error('usage: node query.mjs "SELECT ..."');
  process.exit(2);
}
// Strip string literals and comments before looking for a second statement or a write keyword.
const bare = sql
  .replace(/'(?:[^']|'')*'/g, "''")
  .replace(/"(?:[^"]|"")*"/g, '""')
  .replace(/--[^\n]*/g, " ")
  .replace(/\/\*[\s\S]*?\*\//g, " ");
const isPragma = /^pragma\s+table_info\s*\(\s*[\w"']+\s*\)$/i.test(bare);
const bad =
  /;|\b(insert|update|delete|drop|alter|create|attach|detach|vacuum|reindex|pragma|load_extension)\b/i.test(
    isPragma ? "" : bare,
  );
if (!(isPragma || /^(select|with)\b/i.test(bare)) || bad) {
  console.error(
    "rejected: only a single SELECT, WITH or PRAGMA table_info(...) statement is allowed",
  );
  process.exit(2);
}

const Database = createRequire(BETTER_SQLITE3)(BETTER_SQLITE3);
const here = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(here, "db.sqlite"), { readonly: true });
try {
  const stmt = db.prepare(sql);
  const rows = stmt.all().slice(0, MAX_ROWS + 1);
  const shown = rows.slice(0, MAX_ROWS);
  if (shown.length === 0) {
    console.log("(0 rows)");
  } else {
    const cols = Object.keys(shown[0]);
    const cell = (v) =>
      String(v === null ? "NULL" : v)
        .replace(/\s+/g, " ")
        .slice(0, 120);
    console.log(`| ${cols.join(" | ")} |`);
    console.log(`|${cols.map(() => "---").join("|")}|`);
    for (const r of shown) console.log(`| ${cols.map((c) => cell(r[c])).join(" | ")} |`);
    if (rows.length > MAX_ROWS) console.log(`(truncated at ${MAX_ROWS} rows)`);
  }
} catch (e) {
  console.error(`query failed: ${e.message}`);
  process.exit(1);
} finally {
  db.close();
}
