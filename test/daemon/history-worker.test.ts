/**
 * test/daemon/history-worker.test.ts — P0-U10 per-detector duration/
 * statement/rows-read counters for a history walk (audit §12.1 Stage 1).
 *
 * Exercises the counting pieces the worker thread uses (wrapDbForCounting +
 * createDetectorCountingHook from src/daemon/detector-counters.ts) through
 * the real runHistoryWalk, with stub detectors whose evaluate() reads a
 * table with a KNOWN row count. This is the same code path history-worker.ts
 * runs inside a worker thread; the only thing not exercised here is the
 * worker_threads postMessage plumbing itself.
 *
 * Oracle: the known row count(s) the test itself inserted and read.
 */

import { describe, expect, it } from "vitest";
import {
  createDetectorCountingHook,
  wrapDbForCounting,
} from "../../src/daemon/detector-counters.js";
import {
  formatDetectorPass,
  getPerfSnapshot,
  recordDetectorPass,
} from "../../src/daemon/perf-monitor.js";
import { runHistoryWalk } from "../../src/detector/engine.js";
import type { AnyDetector } from "../../src/detector/types.js";
import { migratedMemDb } from "../ingest/dbutil.js";

const NOW = new Date("2026-09-22T12:00:00.000Z");
const KNOWN_ROW_COUNT = 7;

function insertWorkspaces(db: ReturnType<typeof migratedMemDb>, count: number): void {
  const insert = db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
  );
  for (let i = 0; i < count; i++) {
    insert.run(`ws-${i}`, `ws-${i}`, "2026-01-01T00:00:00.000Z");
  }
}

function stubDetector(id: string, reads: number): AnyDetector {
  return {
    contractVersion: 1,
    id,
    name: `stub detector ${id}`,
    evaluate(db) {
      for (let i = 0; i < reads; i++) {
        db.prepare("SELECT workspace_id FROM workspaces").all();
      }
      return { fired: [], status: "ACTIVE", note: "stub" };
    },
  };
}

describe("history-walk detector counters (P0-U10)", () => {
  it("a stub detector reading a known row count reports that row count, a statement count and a duration on /api/perf", async () => {
    const db = migratedMemDb();
    try {
      insertWorkspaces(db, KNOWN_ROW_COUNT);

      const counts = wrapDbForCounting(db);
      const { hook, buildSnapshot } = createDetectorCountingHook(counts);
      const detector = stubDetector("STUB", 1);

      await runHistoryWalk(db, NOW, { detectors: [detector], detectorHook: hook });
      const snapshot = buildSnapshot();

      expect(snapshot.perDetector.STUB?.rows).toBe(KNOWN_ROW_COUNT);
      expect(snapshot.perDetector.STUB?.stmts).toBe(1);
      expect(snapshot.perDetector.STUB?.ms).toBeGreaterThanOrEqual(0);
      expect(snapshot.detectorCount).toBe(1);
      expect(snapshot.totalRows).toBe(KNOWN_ROW_COUNT);
      expect(snapshot.totalStmts).toBe(1);

      recordDetectorPass(snapshot);
      expect(getPerfSnapshot().detectors).toEqual(snapshot);

      const line = formatDetectorPass(snapshot);
      expect(line).toContain(`${KNOWN_ROW_COUNT} rows`);
      expect(line).toContain("STUB=");
    } finally {
      db.close();
    }
  });

  it("attributes counters separately per detector across a walk with more than one detector", async () => {
    const db = migratedMemDb();
    try {
      insertWorkspaces(db, 1);

      const counts = wrapDbForCounting(db);
      const { hook, buildSnapshot } = createDetectorCountingHook(counts);
      const detectorA = stubDetector("STUB_A", 1);
      const detectorB = stubDetector("STUB_B", 2);

      await runHistoryWalk(db, NOW, { detectors: [detectorA, detectorB], detectorHook: hook });
      const snapshot = buildSnapshot();

      expect(snapshot.perDetector.STUB_A?.stmts).toBe(1);
      expect(snapshot.perDetector.STUB_A?.rows).toBe(1);
      expect(snapshot.perDetector.STUB_B?.stmts).toBe(2);
      expect(snapshot.perDetector.STUB_B?.rows).toBe(2);
      expect(snapshot.detectorCount).toBe(2);
      expect(snapshot.totalStmts).toBe(3);
      expect(snapshot.totalRows).toBe(3);
    } finally {
      db.close();
    }
  });
});
