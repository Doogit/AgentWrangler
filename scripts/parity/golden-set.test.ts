/**
 * scripts/parity/golden-set.test.ts
 *
 * Proves:
 * (a) loadGoldenSet parses a valid golden-set.json.
 * (b) loadGoldenSet fails CLOSED on structural violations.
 * (c) the checked-in golden-set.json is valid and non-trivial.
 * (d) a golden-set must-catch is threaded into the emitted scoresheet.
 *
 * Run with: npx vitest run --config scripts/parity/vitest.config.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGauge1 } from "./gauge1.js";
import { loadGoldenSet } from "./golden-set.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-golden-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeGolden(obj: unknown): string {
  const p = path.join(tmpDir, "golden.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe("loadGoldenSet — valid parse", () => {
  it("(a) parses a well-formed golden set", () => {
    const p = writeGolden({
      version: 1,
      frozen_at: "2026-09-21",
      sessions: [
        { session_id: "gs-b1-severe", must_catch: "flag the collapse", expect_fires: ["B1"] },
        { session_id: "gs-healthy-cache", must_catch: "recommend nothing", expect_fires: [] },
      ],
    });
    const golden = loadGoldenSet(p);
    expect(golden.version).toBe(1);
    expect(golden.frozen_at).toBe("2026-09-21");
    expect(golden.sessions).toHaveLength(2);
    expect(golden.sessions[0]?.expect_fires).toEqual(["B1"]);
  });

  it("(a) accepts an entry without expect_fires", () => {
    const p = writeGolden({ version: 1, sessions: [{ session_id: "s1", must_catch: "x" }] });
    const golden = loadGoldenSet(p);
    expect(golden.sessions[0]?.expect_fires).toBeUndefined();
    expect(golden.frozen_at).toBeUndefined();
  });
});

describe("loadGoldenSet — fails closed", () => {
  it("throws when the file is missing", () => {
    expect(() => loadGoldenSet(path.join(tmpDir, "nope.json"))).toThrow(/not found/);
  });

  it("throws on non-JSON", () => {
    const p = path.join(tmpDir, "bad.json");
    fs.writeFileSync(p, "{not json");
    expect(() => loadGoldenSet(p)).toThrow(/not valid JSON/);
  });

  it("throws when version is missing", () => {
    const p = writeGolden({ sessions: [{ session_id: "s1", must_catch: "x" }] });
    expect(() => loadGoldenSet(p)).toThrow(/numeric "version"/);
  });

  it("throws on an empty sessions array", () => {
    const p = writeGolden({ version: 1, sessions: [] });
    expect(() => loadGoldenSet(p)).toThrow(/non-empty "sessions"/);
  });

  it("throws when an entry lacks a must_catch", () => {
    const p = writeGolden({ version: 1, sessions: [{ session_id: "s1" }] });
    expect(() => loadGoldenSet(p)).toThrow(/non-empty "must_catch"/);
  });

  it("throws when an entry has an empty session_id", () => {
    const p = writeGolden({ version: 1, sessions: [{ session_id: "", must_catch: "x" }] });
    expect(() => loadGoldenSet(p)).toThrow(/non-empty "session_id"/);
  });

  it("throws on duplicate session_ids", () => {
    const p = writeGolden({
      version: 1,
      sessions: [
        { session_id: "dup", must_catch: "a" },
        { session_id: "dup", must_catch: "b" },
      ],
    });
    expect(() => loadGoldenSet(p)).toThrow(/duplicate session_id/);
  });

  it("throws on a non-string expect_fires entry", () => {
    const p = writeGolden({
      version: 1,
      sessions: [{ session_id: "s1", must_catch: "x", expect_fires: ["B1", 7] }],
    });
    expect(() => loadGoldenSet(p)).toThrow(/non-string "expect_fires"/);
  });
});

describe("checked-in golden-set.json", () => {
  it("(c) is valid and covers 15-25 sessions", () => {
    const golden = loadGoldenSet(path.join(HERE, "golden-set.json"));
    expect(golden.sessions.length).toBeGreaterThanOrEqual(15);
    expect(golden.sessions.length).toBeLessThanOrEqual(25);
    // Every entry has a real must-catch.
    for (const e of golden.sessions) {
      expect(e.must_catch.length, `${e.session_id} must_catch empty`).toBeGreaterThan(0);
    }
  });
});

describe("must-catch threads into the scoresheet", () => {
  it("(d) writes the golden must_catch into the emitted scoresheet", async () => {
    // Minimal DB with one session + one rec.
    const dbPath = path.join(tmpDir, "t.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        first_turn_at TEXT, last_turn_at TEXT, turn_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE turns (message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_5m INTEGER NOT NULL DEFAULT 0,
        cache_write_1h INTEGER NOT NULL DEFAULT 0, cache_write_other INTEGER NOT NULL DEFAULT 0,
        context_tokens INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, result_bytes INTEGER,
        tool_error_class TEXT, tool_error_classifier_version TEXT, bash_command_family TEXT,
        interrupt_kind TEXT, interrupt_classifier_version TEXT);
      CREATE TABLE ingest_metric_events (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        classifier_label TEXT, destructive_op TEXT);
      CREATE TABLE recommendations (rec_id TEXT PRIMARY KEY, detector_id TEXT, scope_workspace_id TEXT,
        state TEXT NOT NULL DEFAULT 'PROPOSED', modeled_savings_u_per_wk INTEGER, target_metric TEXT,
        created_at TEXT NOT NULL);
      CREATE TABLE context_inventory (probe_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        component TEXT NOT NULL, tokens INTEGER NOT NULL, probed_at TEXT NOT NULL);
    `);
    db.prepare(
      "INSERT INTO sessions (session_id, workspace_id, turn_count) VALUES (?, ?, ?)",
    ).run("s1", "ws1", 1);
    db.prepare(
      "INSERT INTO turns (message_id, session_id, cache_read_tokens) VALUES (?, ?, ?)",
    ).run("m1", "s1", 100);
    db.close();

    const outDir = path.join(tmpDir, "out");
    const results = await runGauge1({
      dbPath,
      goldenSessionIds: ["s1"],
      outDir,
      promptArmEnabled: false,
      _promptArmFn: vi.fn(),
      mustCatchBySession: { s1: "flag the thing" },
    });

    const parsed = JSON.parse(
      fs.readFileSync(results[0]?.scoresheet_path ?? "", "utf8"),
    ) as { scoresheet: { must_catch: string | null; must_catch_hit: boolean | null } };
    expect(parsed.scoresheet.must_catch).toBe("flag the thing");
    expect(parsed.scoresheet.must_catch_hit).toBeNull();
  });

  it("(d) leaves must_catch null when none is supplied (ad-hoc --sessions)", async () => {
    const dbPath = path.join(tmpDir, "t2.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        first_turn_at TEXT, last_turn_at TEXT, turn_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE turns (message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_5m INTEGER NOT NULL DEFAULT 0,
        cache_write_1h INTEGER NOT NULL DEFAULT 0, cache_write_other INTEGER NOT NULL DEFAULT 0,
        context_tokens INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, result_bytes INTEGER,
        tool_error_class TEXT, tool_error_classifier_version TEXT, bash_command_family TEXT,
        interrupt_kind TEXT, interrupt_classifier_version TEXT);
      CREATE TABLE ingest_metric_events (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        classifier_label TEXT, destructive_op TEXT);
      CREATE TABLE recommendations (rec_id TEXT PRIMARY KEY, detector_id TEXT, scope_workspace_id TEXT,
        state TEXT NOT NULL DEFAULT 'PROPOSED', modeled_savings_u_per_wk INTEGER, target_metric TEXT,
        created_at TEXT NOT NULL);
      CREATE TABLE context_inventory (probe_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        component TEXT NOT NULL, tokens INTEGER NOT NULL, probed_at TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO sessions (session_id, workspace_id, turn_count) VALUES (?, ?, ?)").run(
      "s1",
      "ws1",
      1,
    );
    db.close();

    const results = await runGauge1({
      dbPath,
      goldenSessionIds: ["s1"],
      outDir: path.join(tmpDir, "out2"),
      promptArmEnabled: false,
      _promptArmFn: vi.fn(),
    });
    const parsed = JSON.parse(
      fs.readFileSync(results[0]?.scoresheet_path ?? "", "utf8"),
    ) as { scoresheet: { must_catch: string | null } };
    expect(parsed.scoresheet.must_catch).toBeNull();
  });
});
