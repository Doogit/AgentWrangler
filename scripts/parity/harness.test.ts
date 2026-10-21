/**
 * scripts/parity/harness.test.ts
 *
 * Proves:
 * (a) A packet built from allow-listed columns succeeds.
 * (b) Adding a non-allow-listed column is REFUSED (SEC-101).
 * (c) The prompt arm makes no external call when the opt-in flag is off.
 *
 * Run with: npx vitest run --config scripts/parity/vitest.config.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGauge1 } from "./gauge1.js";
import { RUBRIC } from "./rubric.js";
import { ALL_ALLOWED_FIELDS, buildSafePacket } from "./sec101-allow-list.js";

// ─── helpers ────────────────────────────────────────────────────────────────

/** Build a minimal in-memory SQLite DB matching gauge1.ts's query surface. */
function makeTestDb(tmpDir: string): string {
  const dbPath = path.join(tmpDir, "test.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      session_id     TEXT PRIMARY KEY,
      workspace_id   TEXT NOT NULL,
      first_turn_at  TEXT,
      last_turn_at   TEXT,
      turn_count     INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE turns (
      message_id       TEXT PRIMARY KEY,
      session_id       TEXT NOT NULL,
      cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_write_5m      INTEGER NOT NULL DEFAULT 0,
      cache_write_1h      INTEGER NOT NULL DEFAULT 0,
      cache_write_other   INTEGER NOT NULL DEFAULT 0,
      context_tokens      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tool_events (
      event_id    TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      result_bytes INTEGER,
      tool_error_class              TEXT,
      tool_error_classifier_version TEXT,
      bash_command_family           TEXT,
      interrupt_kind                TEXT,
      interrupt_classifier_version  TEXT
    );
    CREATE TABLE ingest_metric_events (
      event_id         TEXT PRIMARY KEY,
      session_id       TEXT NOT NULL,
      classifier_label TEXT,
      destructive_op   TEXT
    );
    CREATE TABLE recommendations (
      rec_id                   TEXT PRIMARY KEY,
      detector_id              TEXT,
      scope_workspace_id       TEXT,
      state                    TEXT NOT NULL DEFAULT 'PROPOSED',
      modeled_savings_u_per_wk INTEGER,
      target_metric            TEXT,
      created_at               TEXT NOT NULL
    );
    CREATE TABLE context_inventory (
      probe_id     TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      component    TEXT NOT NULL,
      tokens       INTEGER NOT NULL,
      probed_at    TEXT NOT NULL
    );
  `);

  db.prepare(
    "INSERT INTO sessions (session_id, workspace_id, first_turn_at, last_turn_at, turn_count) " +
      "VALUES (?, ?, ?, ?, ?)",
  ).run("sess-g1-001", "ws-001", "2026-09-01T00:00:00Z", "2026-09-01T01:00:00Z", 10);

  db.prepare(
    "INSERT INTO turns (message_id, session_id, cache_read_tokens, cache_write_5m, " +
      "cache_write_1h, cache_write_other, context_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("msg-001", "sess-g1-001", 5000, 2000, 1000, 0, 25000);

  db.prepare(
    "INSERT INTO tool_events (event_id, session_id, result_bytes) VALUES (?, ?, ?)",
  ).run("ev-001", "sess-g1-001", 12345);

  // Friction evidence (closed-enum labels only) for the widened packet.
  const insTool = db.prepare(
    "INSERT INTO tool_events (event_id, session_id, tool_error_class, tool_error_classifier_version, " +
      "bash_command_family, interrupt_kind, interrupt_classifier_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insTool.run("ev-e1", "sess-g1-001", "NOT_FOUND", "tool-error-1", null, null, null);
  insTool.run("ev-e2", "sess-g1-001", "STALE_STRING", "tool-error-1", null, null, null);
  insTool.run("ev-b1", "sess-g1-001", null, null, "BASH_GIT", null, null);
  insTool.run("ev-i1", "sess-g1-001", null, null, null, "PURE_INTERRUPT", "interrupt-1");
  const insEvt = db.prepare(
    "INSERT INTO ingest_metric_events (event_id, session_id, classifier_label, destructive_op) VALUES (?, ?, ?, ?)",
  );
  insEvt.run("me-d1", "sess-g1-001", "hook-block", null);
  insEvt.run("me-d2", "sess-g1-001", "deny-rule", null);
  insEvt.run("me-x1", "sess-g1-001", null, "rm-rf");

  db.prepare(
    "INSERT INTO recommendations (rec_id, detector_id, scope_workspace_id, state, " +
      "modeled_savings_u_per_wk, target_metric, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("rec-D8-ws-001-abc123", "D8", "ws-001", "PROPOSED", 500, "cache_efficiency_ratio", "2026-09-01T00:30:00Z");

  db.prepare(
    "INSERT INTO context_inventory (probe_id, workspace_id, component, tokens, probed_at) " +
      "VALUES (?, ?, ?, ?, ?)",
  ).run("probe-001", "ws-001", "CLAUDE_MD", 8000, "2026-09-01T00:00:00Z");

  db.close();
  return dbPath;
}

// ─── test state ─────────────────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-parity-test-"));
  dbPath = makeTestDb(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── (a) allow-listed packet succeeds ───────────────────────────────────────

describe("SEC-101 safe-packet enforcement", () => {
  it("(a) allows a packet containing only allow-listed fields", () => {
    const row: Record<string, unknown> = {
      session_id: "sess-test-001",
      workspace_id: "ws-test-001",
      window_start: "2026-01-01T00:00:00Z",
      window_end: "2026-01-02T00:00:00Z",
      turn_count: 42,
      tool_result_bytes_total: 99_000,
      tool_event_count: 7,
      cache_read_tokens_total: 50_000,
      cache_write_tokens_total: 12_000,
    };

    // Pre-condition: every key must be in the allow-list.
    for (const k of Object.keys(row)) {
      expect(ALL_ALLOWED_FIELDS.has(k), `"${k}" should be in ALL_ALLOWED_FIELDS`).toBe(true);
    }

    const packet = buildSafePacket(row);
    expect(packet).toEqual(row);
  });

  it("(b) REFUSES a packet containing a non-allow-listed column", () => {
    const row: Record<string, unknown> = {
      session_id: "sess-test-002",
      workspace_id: "ws-test-002",
      // Non-allow-listed: arbitrary column that could carry content
      transcript_text: "some transcript content",
    };

    expect(() => buildSafePacket(row)).toThrow(/SEC-101.*"transcript_text".*allow-list/);
  });

  it("(b) REFUSES a packet with any field not in the frozen allow-list", () => {
    const violations = [
      "raw_output",
      "tool_result_content",
      "prompt_text",
      "conversation_body",
      "arbitrary_field",
    ];

    for (const field of violations) {
      expect(
        () => buildSafePacket({ session_id: "s", [field]: "value" }),
        `field "${field}" should be refused`,
      ).toThrow(/SEC-101/);
    }
  });
});

// ─── friction counts (2026-09-21 widening) enter the packet ──────────────────

describe("Gauge 1 friction widening — closed-enum counts in the packet", () => {
  it("stages friction counts and every packet field stays allow-listed", async () => {
    const outDir = path.join(tmpDir, "out-friction");
    const results = await runGauge1({
      dbPath,
      goldenSessionIds: ["sess-g1-001"],
      outDir,
      promptArmEnabled: false,
      _promptArmFn: vi.fn(),
    });

    const fields = results[0]?.packet.fields ?? {};
    for (const k of Object.keys(fields)) {
      expect(ALL_ALLOWED_FIELDS.has(k), `packet field "${k}" must be allow-listed`).toBe(true);
    }
    // Per-class error counts, bash family, interrupt kind, denials, destructive op.
    expect(fields["tool_error_count"]).toBe(2);
    expect(fields["err_NOT_FOUND"]).toBe(1);
    expect(fields["err_STALE_STRING"]).toBe(1);
    expect(fields["err_PATCH_FAILED"]).toBe(0);
    expect(fields["bashfail_BASH_GIT"]).toBe(1);
    expect(fields["interrupt_count"]).toBe(1);
    expect(fields["intr_PURE_INTERRUPT"]).toBe(1);
    expect(fields["denial_count"]).toBe(2);
    expect(fields["denial_hook_block"]).toBe(1);
    expect(fields["denial_deny_rule"]).toBe(1);
    expect(fields["destructive_op_count"]).toBe(1);
  });
});

// ─── Rubric is frozen ────────────────────────────────────────────────────────

describe("RUBRIC is frozen (§6 7-point checklist)", () => {
  it("has exactly 7 items", () => {
    expect(RUBRIC).toHaveLength(7);
  });

  it("ids are R1–R7 in order", () => {
    expect(RUBRIC.map((r) => r.id)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7"]);
  });

  it("every item has a non-empty label and description", () => {
    for (const item of RUBRIC) {
      expect(item.label.length, `${item.id} label empty`).toBeGreaterThan(0);
      expect(item.description.length, `${item.id} description empty`).toBeGreaterThan(0);
    }
  });
});

// ─── (c) prompt arm opt-in enforcement ──────────────────────────────────────

describe("Gauge 1 prompt arm — opt-in enforcement", () => {
  it("(c) does NOT call the arm function when promptArmEnabled is false (default)", async () => {
    const mockArm = vi.fn();
    const outDir = path.join(tmpDir, "out-no-arm");

    await runGauge1({
      dbPath,
      goldenSessionIds: ["sess-g1-001"],
      outDir,
      promptArmEnabled: false,
      _promptArmFn: mockArm,
    });

    expect(mockArm).not.toHaveBeenCalled();

    // Scoresheet file should exist with the frozen rubric.
    const scoresheetPath = path.join(outDir, "scoresheet-sess-g1-001.json");
    expect(fs.existsSync(scoresheetPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(scoresheetPath, "utf8")) as { rubric: unknown[] };
    expect(parsed.rubric).toHaveLength(7);
  });

  it("(c) DOES call the arm function when promptArmEnabled is true", async () => {
    const mockArm = vi.fn().mockResolvedValue(undefined);
    const outDir = path.join(tmpDir, "out-with-arm");

    await runGauge1({
      dbPath,
      goldenSessionIds: ["sess-g1-001"],
      outDir,
      promptArmEnabled: true,
      _promptArmFn: mockArm,
    });

    expect(mockArm).toHaveBeenCalledOnce();
    // The mock was called with the safe packet for sess-g1-001.
    const [packet] = mockArm.mock.calls[0] as [{ session_id: string; fields: Record<string, unknown> }];
    expect(packet.session_id).toBe("sess-g1-001");
    // Packet must not contain non-allow-listed fields.
    for (const k of Object.keys(packet.fields)) {
      expect(ALL_ALLOWED_FIELDS.has(k), `packet field "${k}" should be in allow-list`).toBe(true);
    }
  });

  it("(c) scoresheet includes rubric and engine rec metadata for the session", async () => {
    const outDir = path.join(tmpDir, "out-scoresheet");

    const results = await runGauge1({
      dbPath,
      goldenSessionIds: ["sess-g1-001"],
      outDir,
      promptArmEnabled: false,
      _promptArmFn: vi.fn(),
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.engine_recs).toHaveLength(1);
    expect(results[0]?.engine_recs[0]?.rec_id).toBe("rec-D8-ws-001-abc123");

    type ScoresheetFile = {
      rubric: Array<{ id: string }>;
      scoresheet: { rubric_marks: Record<string, string> };
      engine_recs_count: number;
    };
    const parsed = JSON.parse(
      fs.readFileSync(results[0]?.scoresheet_path ?? "", "utf8"),
    ) as ScoresheetFile;
    expect(parsed.rubric).toHaveLength(7);
    expect(parsed.scoresheet.rubric_marks["R1"]).toBe("PENDING");
    expect(parsed.engine_recs_count).toBe(1);
  });
});
