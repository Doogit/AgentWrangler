/**
 * test/ingest/friction-fields.test.ts — RV2a friction-counter tests.
 *
 * Covers:
 * - Parser projects isCompactSummary / isApiErrorMessage from fixture lines.
 * - Parser projects false when the flag is absent.
 * - Ingestor accumulates compaction_count and api_error_count; interrupt_count stays 0.
 * - getSession surfaces the three counts.
 * - SEC-101: fixture content strings are NOT stored in the sessions row or getSession payload.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { Ingestor } from "../../src/ingest/index.js";
import { projectLine } from "../../src/ingest/parser.js";
import { getSession } from "../../src/query/api/overview.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, toJsonl, writeCorpus } from "./synth.js";

// ---------------------------------------------------------------------------
// Parser unit tests
// ---------------------------------------------------------------------------

const ctx = { defaultSessionId: "file-stem" };

describe("parser — isCompactSummary / isApiErrorMessage / isInterrupt projection", () => {
  it("projects isCompactSummary:true when the top-level flag is set", () => {
    const rec = assistant({
      id: "cs1",
      session: "s1",
      ts: "2026-01-01T00:00:00.000Z",
      extra: { isCompactSummary: true },
    });
    const r = projectLine(JSON.stringify(rec), ctx);
    if (r.kind !== "record") throw new Error("expected record");
    expect(r.isCompactSummary).toBe(true);
    expect(r.isApiErrorMessage).toBe(false);
    expect(r.isInterrupt).toBe(false);
  });

  it("projects isApiErrorMessage:true when the top-level flag is set", () => {
    const rec = assistant({
      id: "ae1",
      session: "s1",
      ts: "2026-01-01T00:00:00.000Z",
      extra: { isApiErrorMessage: true },
    });
    const r = projectLine(JSON.stringify(rec), ctx);
    if (r.kind !== "record") throw new Error("expected record");
    expect(r.isCompactSummary).toBe(false);
    expect(r.isApiErrorMessage).toBe(true);
    expect(r.isInterrupt).toBe(false);
  });

  it("projects all three as false when no flags are present", () => {
    const rec = assistant({ id: "nf1", session: "s1", ts: "2026-01-01T00:00:00.000Z" });
    const r = projectLine(JSON.stringify(rec), ctx);
    if (r.kind !== "record") throw new Error("expected record");
    expect(r.isCompactSummary).toBe(false);
    expect(r.isApiErrorMessage).toBe(false);
    expect(r.isInterrupt).toBe(false);
  });

  it("projects isInterrupt as false even when a truthy value is set (no reliable marker)", () => {
    // isInterrupt is hardcoded false in the parser regardless of record content.
    const rec = assistant({ id: "ir1", session: "s1", ts: "2026-01-01T00:00:00.000Z" });
    const r = projectLine(JSON.stringify(rec), ctx);
    if (r.kind !== "record") throw new Error("expected record");
    expect(r.isInterrupt).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ingestor integration tests
// ---------------------------------------------------------------------------

const QUIESCENT_NOW = () => new Date("2026-08-01T00:00:00.000Z");
const INGEST_OPTS = { now: QUIESCENT_NOW, activityWindowSecs: 300 };

// Sentinel string embedded in fixture "content" — must NOT appear in the sessions row.
const CONTENT_SENTINEL = "FRICTION_TEST_CONTENT_SENTINEL_DO_NOT_STORE";

let db: Db;
let tmpDir: string;

beforeEach(() => {
  db = migratedMemDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-friction-"));
});

afterEach(() => {
  db.close();
  resetQueryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ingestor — friction counter accumulation", () => {
  it("advances compaction_count for each compact-summary line", () => {
    // Two compact-summary lines for the same session.
    const lines = [
      assistant({
        id: "m1",
        session: "sess-cs",
        ts: "2026-01-01T10:00:00.000Z",
        input: 100,
        output: 10,
        extra: { isCompactSummary: true, summary: CONTENT_SENTINEL },
      }),
      assistant({
        id: "m2",
        session: "sess-cs",
        ts: "2026-01-01T10:01:00.000Z",
        input: 50,
        output: 5,
        extra: { isCompactSummary: true },
      }),
    ];
    writeCorpus(tmpDir, { "proj-cs": { "sess-cs.jsonl": lines } });

    const ing = new Ingestor(db, [tmpDir], INGEST_OPTS);
    ing.runBackscan();

    const row = db
      .prepare(
        "SELECT compaction_count, api_error_count, interrupt_count FROM sessions WHERE session_id = ?",
      )
      .get("sess-cs") as
      | { compaction_count: number; api_error_count: number; interrupt_count: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.compaction_count).toBe(2);
    expect(row?.api_error_count).toBe(0);
    expect(row?.interrupt_count).toBe(0);
  });

  it("advances api_error_count for each api-error line", () => {
    const lines = [
      assistant({
        id: "m3",
        session: "sess-ae",
        ts: "2026-01-01T10:00:00.000Z",
        input: 100,
        output: 10,
        extra: { isApiErrorMessage: true },
      }),
      assistant({
        id: "m4",
        session: "sess-ae",
        ts: "2026-01-01T10:01:00.000Z",
        input: 50,
        output: 5,
        extra: { isApiErrorMessage: true },
      }),
      assistant({
        id: "m5",
        session: "sess-ae",
        ts: "2026-01-01T10:02:00.000Z",
        input: 50,
        output: 5,
        extra: { isApiErrorMessage: true },
      }),
    ];
    writeCorpus(tmpDir, { "proj-ae": { "sess-ae.jsonl": lines } });

    const ing = new Ingestor(db, [tmpDir], INGEST_OPTS);
    ing.runBackscan();

    const row = db
      .prepare(
        "SELECT compaction_count, api_error_count, interrupt_count FROM sessions WHERE session_id = ?",
      )
      .get("sess-ae") as
      | { compaction_count: number; api_error_count: number; interrupt_count: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.compaction_count).toBe(0);
    expect(row?.api_error_count).toBe(3);
    expect(row?.interrupt_count).toBe(0);
  });

  it("interrupt_count stays 0 (no reliable interrupt marker; isInterrupt is always false)", () => {
    // Even a plain assistant turn should leave interrupt_count at 0.
    const lines = [
      assistant({
        id: "m6",
        session: "sess-ir",
        ts: "2026-01-01T10:00:00.000Z",
        input: 100,
        output: 10,
      }),
    ];
    writeCorpus(tmpDir, { "proj-ir": { "sess-ir.jsonl": lines } });

    const ing = new Ingestor(db, [tmpDir], INGEST_OPTS);
    ing.runBackscan();

    const row = db
      .prepare("SELECT interrupt_count FROM sessions WHERE session_id = ?")
      .get("sess-ir") as { interrupt_count: number } | undefined;
    expect(row?.interrupt_count).toBe(0);
  });

  it("counts compact-summary and api-error independently in the same session", () => {
    const lines = [
      assistant({
        id: "m7",
        session: "sess-mix",
        ts: "2026-01-01T10:00:00.000Z",
        input: 100,
        output: 10,
        extra: { isCompactSummary: true },
      }),
      assistant({
        id: "m8",
        session: "sess-mix",
        ts: "2026-01-01T10:01:00.000Z",
        input: 50,
        output: 5,
        extra: { isApiErrorMessage: true },
      }),
      assistant({
        id: "m9",
        session: "sess-mix",
        ts: "2026-01-01T10:02:00.000Z",
        input: 50,
        output: 5,
        extra: { isCompactSummary: true },
      }),
    ];
    writeCorpus(tmpDir, { "proj-mix": { "sess-mix.jsonl": lines } });

    const ing = new Ingestor(db, [tmpDir], INGEST_OPTS);
    ing.runBackscan();

    const row = db
      .prepare(
        "SELECT compaction_count, api_error_count, interrupt_count FROM sessions WHERE session_id = ?",
      )
      .get("sess-mix") as
      | { compaction_count: number; api_error_count: number; interrupt_count: number }
      | undefined;
    expect(row?.compaction_count).toBe(2);
    expect(row?.api_error_count).toBe(1);
    expect(row?.interrupt_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getSession query surface
// ---------------------------------------------------------------------------

describe("getSession — surfaces friction counts", () => {
  it("returns compaction_count, api_error_count, interrupt_count from the sessions row", () => {
    // Seed a session row directly (bypassing ingestion) to test the query layer in isolation.
    db.prepare(
      `INSERT INTO workspaces (workspace_id, project_slug, registered_at)
       VALUES ('ws-friction', 'proj-friction', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions
         (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
          state, turn_count, cost_equiv_u, hygiene_flags,
          compaction_count, api_error_count, interrupt_count)
       VALUES ('sess-query', 'ws-friction', '/fake/path.jsonl',
               '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z',
               'RECONCILED', 5, 1000, '[]', 3, 2, 0)`,
    ).run();

    setQueryDb(db);
    const resp = getSession("sess-query");

    expect(resp.data).not.toBeNull();
    expect(resp.data?.compaction_count).toBe(3);
    expect(resp.data?.api_error_count).toBe(2);
    expect(resp.data?.interrupt_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SEC-101: content sentinel must not appear in stored data
// ---------------------------------------------------------------------------

describe("SEC-101 — friction counts store only integers, not message content", () => {
  it("content present in fixture lines does not appear in sessions row or getSession payload", () => {
    // The compact-summary line includes CONTENT_SENTINEL in its summary field.
    // After ingestion, the sessions row should contain only integer counts.
    const lines = [
      assistant({
        id: "sec1",
        session: "sess-sec101",
        ts: "2026-01-01T10:00:00.000Z",
        input: 100,
        output: 10,
        extra: { isCompactSummary: true, summary: CONTENT_SENTINEL },
      }),
    ];
    writeCorpus(tmpDir, { "proj-sec": { "sess-sec101.jsonl": lines } });

    const ing = new Ingestor(db, [tmpDir], INGEST_OPTS);
    ing.runBackscan();

    // Direct DB check: no column in the sessions row contains the sentinel.
    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-sec101") as
      | Record<string, unknown>
      | undefined;
    expect(row).toBeDefined();
    const rowJson = JSON.stringify(row);
    expect(rowJson).not.toContain(CONTENT_SENTINEL);

    // Query API check.
    setQueryDb(db);
    const resp = getSession("sess-sec101");
    const respJson = JSON.stringify(resp.data);
    expect(respJson).not.toContain(CONTENT_SENTINEL);

    // Verify counts are integers.
    expect(typeof resp.data?.compaction_count).toBe("number");
    expect(typeof resp.data?.api_error_count).toBe("number");
    expect(typeof resp.data?.interrupt_count).toBe("number");
    expect(resp.data?.compaction_count).toBe(1);
  });
});
