/**
 * test/daemon/sec101.test.ts — SEC-101 CI assertion.
 *
 * Opens a migrated database and asserts that NO column name in ANY table
 * contains a content-bearing word as a standalone underscore-delimited token.
 *
 * This is the structural enforcement of SEC-101:
 * "No content-bearing columns exist in this schema."
 *
 * Matching strategy: split each column name by underscore and check whether
 * any resulting token EXACTLY equals one of the blocked words (case-insensitive).
 * This avoids false positives from compound metadata names like "context_tokens"
 * (con-text contains "text" as a substring, but is clearly metadata).
 *
 * Blocked tokens (exact word match after split):
 *   text, content, body, prompt, response, raw
 *
 * This test must run against a real migration apply so that future schema
 * additions are automatically caught.
 */

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";

/**
 * Content-bearing word tokens. A column name whose underscore-split parts
 * include any of these exactly (case-insensitive) is a violation.
 */
const BLOCKED_TOKENS = new Set(["text", "content", "body", "prompt", "response", "raw"]);

/**
 * Allowlist: column names reviewed and confirmed as metadata despite matching
 * a blocked token. Each entry requires a justification comment.
 *
 * "prompt_version" (analysis_runs): version identifier for the Tier 2 prompt
 *   template (e.g. "v1.2"). Stores a version string, NOT the prompt content.
 *   Data Model v2 §1 DDL verbatim.
 *
 * "content_included" (analysis_runs): INTEGER 0/1 boolean flag indicating
 *   whether content was explicitly included in a Tier 2 evidence pack per
 *   SEC-104 opt-in. Stores a flag, NOT the content itself.
 *   Data Model v2 §1 DDL verbatim.
 */
// "content_json" is a bounded aggregate-only weekly digest, not transcript content.
const ALLOWLIST = new Set<string>(["prompt_version", "content_included", "content_json"]);

function hasBlockedToken(columnName: string): string | null {
  const parts = columnName.toLowerCase().split("_");
  for (const part of parts) {
    if (BLOCKED_TOKENS.has(part) && !ALLOWLIST.has(columnName)) {
      return part;
    }
  }
  return null;
}

let db: Database.Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterAll(() => {
  db.close();
});

describe("SEC-101: no content-bearing column names", () => {
  it("schema has been migrated (sanity check)", () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);

    expect(tables.length).toBeGreaterThan(5);
  });

  it("no column name contains a content-bearing token", () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);

    const violations: string[] = [];

    for (const table of tables) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        type: string;
      }>;

      for (const col of cols) {
        const blocked = hasBlockedToken(col.name);
        if (blocked !== null) {
          violations.push(`${table}.${col.name}  (blocked token: "${blocked}")`);
        }
      }
    }

    if (violations.length > 0) {
      expect.fail(
        `SEC-101 violation — column names containing content-bearing tokens:\n${violations.map((v) => `  ${v}`).join("\n")}\n\nColumn names must use only metadata-safe words (sizes, ids, hashes, timestamps, counts). Rename the column or add it to ALLOWLIST with justification.`,
      );
    }
  });
});
