/**
 * test/query/settings.test.ts — Settings store + API wrapper (WP4).
 *
 * Covers:
 *   - applySettingsUpdate persists limit_tokens / scan_roots to user_config
 *   - Values survive a DB close + reopen (on-disk DB required)
 *   - validateScanRoots rejects non-absolute, nonexistent, and file-not-dir
 *   - Setting limit then reading back flips null → value
 *   - resetDatabase sets last_reset_at and empties data tables
 *   - resetDatabase preserves user_config rows
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/open.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import {
  RESET_DATA_TABLES,
  RESET_PRESERVED_TABLES,
  applySettingsUpdate,
  clearHealthInstance,
  getSettingsData,
  resetDatabase,
  validateScanRoots,
} from "../../src/query/settings-store.js";
import { createFixtureDb, createInMemoryFixtureDb, seedFixtureDb } from "../fixtures/seed.js";

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
  clearHealthInstance();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-settings-test-"));
});

afterEach(() => {
  resetQueryDb();
  db.close();
  // Clean up any on-disk DBs created in this test
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// validateScanRoots
// ---------------------------------------------------------------------------

describe("validateScanRoots", () => {
  it("returns null for an empty list (nothing to validate)", () => {
    expect(validateScanRoots([])).toBeNull();
  });

  it("rejects a relative path (not absolute)", () => {
    const err = validateScanRoots(["relative/path"]);
    expect(err).not.toBeNull();
    expect(err).toMatch(/not an absolute path/i);
  });

  it("rejects a nonexistent absolute path", () => {
    const err = validateScanRoots([path.join(os.tmpdir(), "aw-nonexistent-99999")]);
    expect(err).not.toBeNull();
    expect(err).toMatch(/does not exist/i);
  });

  it("rejects a path that exists but is a file, not a directory", () => {
    const filePath = path.join(tmpDir, "not-a-dir.txt");
    fs.writeFileSync(filePath, "x");
    const err = validateScanRoots([filePath]);
    expect(err).not.toBeNull();
    expect(err).toMatch(/not a directory/i);
  });

  it("accepts a valid absolute directory", () => {
    expect(validateScanRoots([tmpDir])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSettingsData - quarantine pointers
// ---------------------------------------------------------------------------

describe("getSettingsData - quarantine pointers", () => {
  it("returns an empty quarantine list when no parse failures exist", () => {
    expect(getSettingsData(db).quarantine_rows).toEqual([]);
  });

  it("projects only safe pointer fields in deterministic newest-first order and caps at 100", () => {
    const insert = db.prepare(
      `INSERT INTO ingest_quarantine
       (q_id, file_path, line_no, error_class, parser_version, seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 101; i += 1) {
      const secondsAgo = i === 0 ? 102 : Math.max(0, i - 2);
      insert.run(
        `q-${String(i).padStart(3, "0")}`,
        `/safe/failure-${i}.jsonl`,
        i + 1,
        "MalformedJson",
        "parser-test",
        new Date(Date.UTC(2026, 7, 27, 12, 0, 0) - secondsAgo * 1_000).toISOString(),
      );
    }

    const rows = getSettingsData(db).quarantine_rows;

    expect(rows).toHaveLength(100);
    expect(rows[0]).toEqual({
      file_path: "/safe/failure-2.jsonl",
      line_no: 3,
      error_class: "MalformedJson",
      seen_at: "2026-08-27T12:00:00.000Z",
    });
    expect(rows.at(-1)?.file_path).toBe("/safe/failure-100.jsonl");
    expect(rows.some((row) => row.file_path === "/safe/failure-0.jsonl")).toBe(false);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "error_class",
      "file_path",
      "line_no",
      "seen_at",
    ]);
    expect(JSON.stringify(rows)).not.toContain("parser-test");
  });
});

// ---------------------------------------------------------------------------
// getSettingsData - workspace mapping transient state
// ---------------------------------------------------------------------------

describe("getSettingsData - workspace mapping transient state", () => {
  it("marks mapped workspaces false and blank workspaces true", () => {
    db.prepare("UPDATE workspaces SET repo_owner = ?, repo_name = ? WHERE workspace_id = ?").run(
      "acme",
      "alpha",
      "ws-alpha",
    );

    const mappings = getSettingsData(db).workspace_mappings;
    expect(mappings.find((w) => w.workspace_id === "ws-alpha")?.is_transient).toBe(false);
    expect(mappings.find((w) => w.workspace_id === "ws-beta")?.is_transient).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getSettingsData - mapping_reason for still-unmapped (transient) workspaces
// ---------------------------------------------------------------------------

describe("getSettingsData - mapping_reason", () => {
  function reasonFor(workspaceId: string): string | undefined {
    return getSettingsData(db).workspace_mappings.find((w) => w.workspace_id === workspaceId)
      ?.mapping_reason;
  }

  it("says no cwd when neither repo_path nor discovered_cwd is known", () => {
    expect(reasonFor("ws-beta")).toBe("No working directory recorded in transcripts yet.");
  });

  it("says dir missing when the recorded path no longer exists", () => {
    db.prepare("UPDATE workspaces SET discovered_cwd = ? WHERE workspace_id = ?").run(
      path.join(tmpDir, "gone-away"),
      "ws-beta",
    );
    expect(reasonFor("ws-beta")).toBe("Working directory no longer exists locally.");
  });

  it("says no remote when the checkout exists but has no GitHub canonical", () => {
    db.prepare("UPDATE workspaces SET repo_path = ? WHERE workspace_id = ?").run(tmpDir, "ws-beta");
    expect(reasonFor("ws-beta")).toBe("No GitHub remote detected for this checkout.");
  });

  it("omits the reason once a canonical is mapped", () => {
    db.prepare("UPDATE workspaces SET repo_owner = ?, repo_name = ? WHERE workspace_id = ?").run(
      "acme",
      "alpha",
      "ws-alpha",
    );
    expect(reasonFor("ws-alpha")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applySettingsUpdate — persists to user_config
// ---------------------------------------------------------------------------

describe("applySettingsUpdate", () => {
  it("persists limit_tokens from null to a value", () => {
    const before = getSettingsData(db);
    expect(before.limit_tokens).toBeNull();

    applySettingsUpdate(db, { limit_tokens: 5_000_000 });
    const after = getSettingsData(db);
    expect(after.limit_tokens).toBe(5_000_000);
  });

  it("persists scan_roots override", () => {
    applySettingsUpdate(db, { scan_roots: [tmpDir] });
    const after = getSettingsData(db);
    expect(after.scan_roots).toEqual([tmpDir]);
  });

  it("throws on invalid scan_roots path — not a silent no-op", () => {
    expect(() => applySettingsUpdate(db, { scan_roots: ["relative/bad/path"] })).toThrow(
      /not an absolute path/i,
    );
  });

  it("does not persist any field when scan_roots validation fails (transaction rolled back)", () => {
    const before = getSettingsData(db);
    try {
      applySettingsUpdate(db, {
        limit_tokens: 99_000_000,
        scan_roots: ["bad/path"],
      });
    } catch {
      // expected
    }
    const after = getSettingsData(db);
    expect(after.limit_tokens).toBe(before.limit_tokens);
  });
});

// ---------------------------------------------------------------------------
// applySettingsUpdate — survives DB restart (on-disk)
// ---------------------------------------------------------------------------

describe("applySettingsUpdate — survives DB restart", () => {
  it("persisted limit_tokens and scan_roots are readable after close + reopen", () => {
    const dbPath = path.join(tmpDir, "persist-test.db");
    let diskDb = createFixtureDb(dbPath);

    applySettingsUpdate(diskDb, { limit_tokens: 12_345_678, scan_roots: [tmpDir] });
    diskDb.close();

    // Reopen as a fresh connection
    diskDb = openDb(dbPath);
    const after = getSettingsData(diskDb);
    diskDb.close();

    expect(after.limit_tokens).toBe(12_345_678);
    expect(after.scan_roots).toEqual([tmpDir]);
  });
});

// ---------------------------------------------------------------------------
// resetDatabase
// ---------------------------------------------------------------------------

describe("resetDatabase", () => {
  it("sets last_reset_at to a recent ISO timestamp", () => {
    const before = Date.now();
    const result = resetDatabase(db);
    const after = Date.now();

    expect(result.last_reset_at).not.toBeNull();
    const ts = new Date(result.last_reset_at as string).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("empties the turns table (data table is wiped)", () => {
    // Fixture has 10 turns
    const countBefore = (db.prepare("SELECT COUNT(*) as n FROM turns").get() as { n: number }).n;
    expect(countBefore).toBeGreaterThan(0);

    resetDatabase(db);

    const countAfter = (db.prepare("SELECT COUNT(*) as n FROM turns").get() as { n: number }).n;
    expect(countAfter).toBe(0);
  });

  it("empties the sessions table", () => {
    resetDatabase(db);
    const count = (db.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it("empties the workspaces table", () => {
    resetDatabase(db);
    const count = (db.prepare("SELECT COUNT(*) as n FROM workspaces").get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it("preserves user_config rows (limit_tokens key survives reset)", () => {
    // Set a limit first
    applySettingsUpdate(db, { limit_tokens: 7_777_777 });

    resetDatabase(db);

    // limit_tokens row should still exist in user_config
    const row = db.prepare("SELECT value FROM user_config WHERE key = 'limit_tokens'").get() as
      | { value: string }
      | undefined;
    expect(row).not.toBeUndefined();
    expect(row?.value).toBe("7777777");
  });

  it("returns workspace_mappings as empty after reset", () => {
    const result = resetDatabase(db);
    expect(result.workspace_mappings).toEqual([]);
  });

  it("preserves schema_migrations rows", () => {
    const countBefore = (
      db.prepare("SELECT COUNT(*) as n FROM schema_migrations").get() as { n: number }
    ).n;
    resetDatabase(db);
    const countAfter = (
      db.prepare("SELECT COUNT(*) as n FROM schema_migrations").get() as { n: number }
    ).n;
    expect(countAfter).toBe(countBefore);
    expect(countAfter).toBeGreaterThan(0);
  });

  it("preserves pricing_snapshots (seeded reference data, not ingested)", () => {
    const before = (
      db.prepare("SELECT COUNT(*) as n FROM pricing_snapshots").get() as { n: number }
    ).n;
    expect(before).toBeGreaterThan(0);
    resetDatabase(db);
    const after = (db.prepare("SELECT COUNT(*) as n FROM pricing_snapshots").get() as { n: number })
      .n;
    expect(after).toBe(before);
  });

  it("empties every table in RESET_DATA_TABLES", () => {
    resetDatabase(db);
    for (const table of RESET_DATA_TABLES) {
      const n = (db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;
      expect(n, `${table} should be empty after reset`).toBe(0);
    }
  });

  it("deletes tool-event metadata before its parent event", () => {
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name)
       VALUES ('reset-event', 'sess-a1', '2026-01-01T00:00:00Z', 'Read')`,
    ).run();
    db.prepare(
      `INSERT INTO tool_event_metadata
         (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
       VALUES ('reset-event', 'hash-only', 'msg-a1-1', 0, 0)`,
    ).run();

    expect(RESET_DATA_TABLES.indexOf("tool_event_metadata")).toBeLessThan(
      RESET_DATA_TABLES.indexOf("tool_events"),
    );
    expect(() => resetDatabase(db)).not.toThrow();
    const metadata = db.prepare("SELECT COUNT(*) AS n FROM tool_event_metadata").get() as {
      n: number;
    };
    expect(metadata.n).toBe(0);
  });

  it("deletes branch keys before their parent work items", () => {
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:owner/repo#reset', 'ws-alpha', 99, 'OPEN', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO work_item_branch_keys
         (work_item_id, head_ref_key, normalization_version, synced_at)
       VALUES ('gh:owner/repo#reset', ?, 'branch-v1', '2026-01-01T00:00:00Z')`,
    ).run("a".repeat(64));

    expect(RESET_DATA_TABLES.indexOf("work_item_branch_keys")).toBeLessThan(
      RESET_DATA_TABLES.indexOf("work_items"),
    );
    expect(() => resetDatabase(db)).not.toThrow();
    const keys = db.prepare("SELECT COUNT(*) AS n FROM work_item_branch_keys").get() as {
      n: number;
    };
    expect(keys.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reset table-list drift guard
// ---------------------------------------------------------------------------

describe("resetDatabase table-list drift guard", () => {
  it("wipe list + preserved list exactly partition the schema's tables", () => {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    const preserved = new Set<string>(RESET_PRESERVED_TABLES);
    const expectedWiped = tables.filter((t) => !preserved.has(t)).sort();

    // Every non-preserved schema table must be in the wipe list, and vice versa.
    // A new migration that adds a data table without updating RESET_DATA_TABLES
    // (or a preserved table wrongly added to the wipe list) fails here.
    expect([...RESET_DATA_TABLES].sort()).toEqual(expectedWiped);
  });

  it("preserved and wiped lists do not overlap", () => {
    const wiped = new Set<string>(RESET_DATA_TABLES);
    for (const t of RESET_PRESERVED_TABLES) {
      expect(wiped.has(t), `${t} must not be in the wipe list`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Workspace-mapping validation (never a silent no-op)
// ---------------------------------------------------------------------------

describe("applySettingsUpdate — workspace mappings", () => {
  it("persists a valid mapping (repo_path + owner/repo canonical)", () => {
    applySettingsUpdate(db, {
      workspace_mappings: [
        { workspace_id: "ws-alpha", repo_path: "/checkout/alpha", repo_canonical: "acme/alpha" },
      ],
    });
    const m = getSettingsData(db).workspace_mappings.find((w) => w.workspace_id === "ws-alpha");
    expect(m?.repo_path).toBe("/checkout/alpha");
    expect(m?.repo_canonical).toBe("acme/alpha");
  });

  it("throws on a malformed repo_canonical (no slash) — not a silent null coercion", () => {
    expect(() =>
      applySettingsUpdate(db, {
        workspace_mappings: [{ workspace_id: "ws-alpha", repo_canonical: "noslash" }],
      }),
    ).toThrow(/owner\/repo/i);
  });

  it("throws on a leading-slash repo_canonical (empty owner)", () => {
    expect(() =>
      applySettingsUpdate(db, {
        workspace_mappings: [{ workspace_id: "ws-alpha", repo_canonical: "/repo" }],
      }),
    ).toThrow(/owner\/repo/i);
  });

  it("throws on an unknown workspace_id instead of silently updating 0 rows", () => {
    expect(() =>
      applySettingsUpdate(db, {
        workspace_mappings: [{ workspace_id: "does-not-exist", repo_canonical: "acme/x" }],
      }),
    ).toThrow(/unknown workspace/i);
  });

  it("allows clearing repo_canonical with null", () => {
    applySettingsUpdate(db, {
      workspace_mappings: [{ workspace_id: "ws-alpha", repo_canonical: null }],
    });
    const m = getSettingsData(db).workspace_mappings.find((w) => w.workspace_id === "ws-alpha");
    expect(m?.repo_canonical).toBeNull();
  });

  it("re-saving identical mapping values does not spuriously throw (no-op UPDATE reports changes>=1)", () => {
    const mapping = {
      workspace_id: "ws-alpha",
      repo_path: "/checkout/alpha",
      repo_canonical: "acme/alpha",
    };
    applySettingsUpdate(db, { workspace_mappings: [mapping] });
    // Second identical save must not be treated as an unknown-workspace no-op.
    expect(() => applySettingsUpdate(db, { workspace_mappings: [mapping] })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getSettingsData resilience
// ---------------------------------------------------------------------------

describe("getSettingsData — corrupt persisted scan_roots", () => {
  it("degrades to daemon defaults instead of throwing on non-JSON scan_roots", () => {
    db.prepare(
      `INSERT INTO user_config (key, value, updated_at) VALUES ('scan_roots', 'not-json', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(new Date().toISOString());

    expect(() => getSettingsData(db)).not.toThrow();
    expect(Array.isArray(getSettingsData(db).scan_roots)).toBe(true);
  });

  it("degrades to daemon defaults when scan_roots is valid JSON but not an array", () => {
    db.prepare(
      `INSERT INTO user_config (key, value, updated_at) VALUES ('scan_roots', '5', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(new Date().toISOString());

    expect(() => getSettingsData(db)).not.toThrow();
    expect(Array.isArray(getSettingsData(db).scan_roots)).toBe(true);
  });
});
