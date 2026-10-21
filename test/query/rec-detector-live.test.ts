/**
 * test/query/rec-detector-live.test.ts — P4 open item (b): detector_status_live.
 *
 * Verifies that after runHistoryWalk writes W0 statuses to detector_status_live,
 * listRecommendations reads from that table instead of re-evaluating detectors.
 *
 * Four behaviours under test:
 *   1. Equivalence oracle  — strip returned by listRecommendations deep-equals
 *      getDetectorStatuses (same shape, order, statuses, notes).
 *   2. No re-evaluation    — __detectorStatusComputeCount() does not increment
 *      after a walk, even when a new turn is inserted between calls.
 *   3. Fallback            — empty table falls through to cachedDetectorStatuses
 *      (compute count increments, strip is still non-empty).
 *   4. Subset walk         — a walk run with opts.detectors = [singleDetector]
 *      only replaces that detector's row; unrelated rows are preserved.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { d9Detector } from "../../src/detector/detectors/d9_idle_background_session.js";
import { getDetectorStatuses, runHistoryWalk } from "../../src/detector/index.js";
import {
  __detectorStatusComputeCount,
  listRecommendations,
} from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { migratedMemDb } from "../ingest/dbutil.js";

const NOW = new Date("2026-09-22T12:00:00.000Z");

let db: Database.Database;

beforeEach(() => {
  db = migratedMemDb();
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

/** Insert a workspace + session + turn in W0 so d9Detector fires. */
function seedW0Turn(id: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
  ).run(`ws-${id}`, `ws-${id}`, "2026-01-01T00:00:00.000Z");
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags, user_turn_count)
     VALUES (?, ?, ?, ?, ?, 'RECONCILED', 1, 0, '[]', 0)`,
  ).run(
    `sess-${id}`,
    `ws-${id}`,
    `/fixture/${id}.jsonl`,
    "2026-09-20T10:00:00.000Z",
    "2026-09-20T10:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version)
     VALUES (?, ?, ?, ?, 'synthetic', 'rec-detector-live-test')`,
  ).run(`msg-${id}`, `sess-${id}`, `ws-${id}`, "2026-09-20T10:00:00.000Z");
  // Register the session as having at least one fork so d9 can fire.
  db.prepare(
    `INSERT INTO subagent_meta
       (agent_id, session_id, agent_type, tool_use_id, spawn_depth, description_len)
     VALUES (?, ?, 'fork', NULL, 1, 0)`,
  ).run(`agent-${id}`, `sess-${id}`);
}

describe("detector_status_live equivalence oracle", () => {
  it("strip returned by listRecommendations matches getDetectorStatuses after a walk", async () => {
    seedW0Turn("a");
    await runHistoryWalk(db, NOW);

    const view = listRecommendations().data;
    const live = getDetectorStatuses(db, { now: NOW });

    expect(view?.detectors).toBeDefined();
    expect(view?.detectors.length).toBeGreaterThan(0);
    // Same length, same order, same shape.
    expect(view?.detectors).toEqual(
      live.map((d) => ({
        detector_id: d.detector_id,
        name: d.name,
        status: d.status,
        note: d.note,
      })),
    );
  });
});

describe("unregistered detector rows", () => {
  it("omits a persisted row whose detector is no longer registered", async () => {
    seedW0Turn("r");
    await runHistoryWalk(db, NOW);
    db.prepare(
      `INSERT INTO detector_status_live (detector_id, ordinal, name, status, note, evaluated_at)
       VALUES ('ZZ_REMOVED', 0, 'removed', 'ACTIVE', '', ?)`,
    ).run(NOW.toISOString());

    const ids = listRecommendations().data?.detectors.map((d) => d.detector_id) ?? [];
    expect(ids).not.toContain("ZZ_REMOVED");
    expect(ids).toEqual(getDetectorStatuses(db, { now: NOW }).map((d) => d.detector_id));
  });
});

describe("no re-evaluation after walk", () => {
  it("does not increment compute count when the table is populated", async () => {
    seedW0Turn("b");
    await runHistoryWalk(db, NOW);

    // Prime: read once to verify it works (goes through the live path, NOT cachedDetectorStatuses).
    listRecommendations();
    const before = __detectorStatusComputeCount();

    // A new turn does NOT advance the counter — the live table is the source.
    db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version)
       VALUES ('extra-msg', 'sess-b', 'ws-b', '2026-09-21T10:00:00.000Z', 'synthetic', 'test')`,
    ).run();
    listRecommendations();

    expect(__detectorStatusComputeCount()).toBe(before);
  });
});

describe("fallback to cachedDetectorStatuses", () => {
  it("increments compute count and returns non-empty strip when table is empty", () => {
    // No walk run — table is empty. Should fall back to cachedDetectorStatuses.
    const before = __detectorStatusComputeCount();
    const view = listRecommendations().data;

    expect(view?.detectors.length).toBeGreaterThan(0);
    expect(__detectorStatusComputeCount()).toBe(before + 1);
  });
});

describe("subset walk only replaces its own rows", () => {
  it("a walk with opts.detectors = [d9Detector] only updates d9's row; others are untouched", async () => {
    seedW0Turn("c");
    // Full walk first — populate all detector rows.
    await runHistoryWalk(db, NOW);

    // Record the rows NOT owned by d9.
    const before = (
      db
        .prepare("SELECT detector_id, status FROM detector_status_live WHERE detector_id != 'D9'")
        .all() as Array<{ detector_id: string; status: string }>
    ).sort((a, b) => a.detector_id.localeCompare(b.detector_id));

    expect(before.length).toBeGreaterThan(0);

    // Subset walk with only d9Detector.
    await runHistoryWalk(db, NOW, { detectors: [d9Detector] });

    // Non-d9 rows must be unchanged.
    const after = (
      db
        .prepare("SELECT detector_id, status FROM detector_status_live WHERE detector_id != 'D9'")
        .all() as Array<{ detector_id: string; status: string }>
    ).sort((a, b) => a.detector_id.localeCompare(b.detector_id));

    expect(after).toEqual(before);

    // The d9 row should exist (it was written by the subset walk).
    const d9Row = db
      .prepare("SELECT detector_id FROM detector_status_live WHERE detector_id = 'D9'")
      .get() as { detector_id: string } | undefined;
    expect(d9Row).toBeDefined();
  });
});
