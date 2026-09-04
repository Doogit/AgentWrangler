import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/open.js";
import {
  CONTEXT_HISTORY_RETENTION_VERSION,
  DEFAULT_CONTEXT_HISTORY_RETENTION_POLICY,
  compactContextHistory,
  inspectContextHistoryRetention,
} from "../../src/detector/context-history-retention.js";
import { AFTER_WINDOW_DAYS, runMeasurementPass } from "../../src/detector/measurement.js";
import { adoptRecommendation } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createFixtureDb, createInMemoryFixtureDb } from "../fixtures/seed.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-26T12:00:00.000Z");
const SOURCE = { workspaceId: "ws-alpha", component: "CLAUDE_MD", fileRef: "/private/a|b.json" };

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare("DELETE FROM recommendation_effects").run();
  db.prepare("DELETE FROM recommendations").run();
  db.prepare("DELETE FROM context_inventory_history").run();
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

function addWorkspace(target: Database.Database, id: string): void {
  target
    .prepare(
      `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
       VALUES (?, ?, ?)`,
    )
    .run(id, `retention-${id}`, NOW.toISOString());
}

function addHistory(
  target: Database.Database,
  source: typeof SOURCE,
  observedAt: Date | string,
  suffix: string,
  tokens = 1000,
): number {
  addWorkspace(target, source.workspaceId);
  const result = target
    .prepare(
      `INSERT INTO context_inventory_history
         (workspace_id, component, file_ref, file_hash, tokens, attribution_version, observed_at)
       VALUES (?, ?, ?, ?, ?, 'chars4-v1', ?)`,
    )
    .run(
      source.workspaceId,
      source.component,
      source.fileRef,
      `hash-${suffix}`,
      tokens,
      typeof observedAt === "string" ? observedAt : observedAt.toISOString(),
    );
  return Number(result.lastInsertRowid);
}

interface OpenRecOptions {
  source?: typeof SOURCE;
  adoptedAt?: Date;
  beforeFrom?: Date;
  beforeTo?: Date;
  afterFrom?: Date;
  afterTo?: Date;
  state?: "ADOPTED" | "MEASURING";
  legacy?: boolean;
  evidenceJson?: string;
  effectMeasuredAt?: Date;
  omitEffect?: boolean;
}

function addOpenRec(target: Database.Database, recId: string, options: OpenRecOptions = {}): void {
  const source = options.source ?? SOURCE;
  const adoptedAt = options.adoptedAt ?? new Date(NOW.getTime() - 120 * DAY);
  const beforeFrom = options.beforeFrom ?? new Date(adoptedAt.getTime() - 10 * DAY);
  const beforeTo = options.beforeTo ?? adoptedAt;
  const afterFrom = options.afterFrom ?? adoptedAt;
  const afterTo = options.afterTo ?? new Date(adoptedAt.getTime() + 14 * DAY);
  target
    .prepare(
      `INSERT INTO recommendations
         (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
          modeled_formula_json, evidence_json, target_metric, state, created_at, adopted_at)
       VALUES (?, 'RULE', ?, 'CONTEXT', ?, 'test', '{}', ?, ?, ?, ?, ?)`,
    )
    .run(
      recId,
      options.legacy === true ? "legacy" : "D1",
      source.workspaceId,
      options.evidenceJson ??
        JSON.stringify({ component: source.component, file_ref: source.fileRef }),
      options.legacy === true ? `CONTEXT_TOKENS:${source.component}` : "avg_context_per_turn",
      options.state ?? "MEASURING",
      adoptedAt.toISOString(),
      adoptedAt.toISOString(),
    );
  if (options.omitEffect === true) return;
  target
    .prepare(
      `INSERT INTO recommendation_effects
         (rec_id, measured_at, before_from, before_to, after_from, after_to, verdict)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      recId,
      (options.effectMeasuredAt ?? adoptedAt).toISOString(),
      beforeFrom.toISOString(),
      beforeTo.toISOString(),
      afterFrom.toISOString(),
      afterTo.toISOString(),
    );
}

function addProposedSourceRec(
  target: Database.Database,
  recId: string,
  source: typeof SOURCE,
  createdAt: Date,
  legacy = false,
): void {
  target
    .prepare(
      `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
        modeled_formula_json, evidence_json, target_metric, state, created_at)
       VALUES (?, 'RULE', ?, 'CONTEXT', ?, 'test', '{}', ?, ?, 'PROPOSED', ?)`,
    )
    .run(
      recId,
      legacy ? "legacy" : "D1",
      source.workspaceId,
      JSON.stringify({ component: source.component, file_ref: source.fileRef }),
      legacy ? `CONTEXT_TOKENS:${source.component}` : "avg_context_per_turn",
      createdAt.toISOString(),
    );
}

function readMeasurementOutcomes(target: Database.Database, recIds: string[]): unknown {
  return recIds.map((recId) => ({
    rec_id: recId,
    state: (
      target.prepare("SELECT state FROM recommendations WHERE rec_id = ?").get(recId) as {
        state: string;
      }
    ).state,
    effect: target
      .prepare(
        `SELECT before_value, after_value, delta_pct, verdict
           FROM recommendation_effects WHERE rec_id = ?`,
      )
      .get(recId),
  }));
}

function ids(target = db): number[] {
  return (
    target.prepare("SELECT id FROM context_inventory_history ORDER BY id").all() as Array<{
      id: number;
    }>
  ).map((row) => row.id);
}

function totalChanges(target = db): number {
  return (target.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
}

describe("context history retention planner", () => {
  it("exports the versioned 90-day/64-row default policy", () => {
    expect(CONTEXT_HISTORY_RETENTION_VERSION).toBe("context-history-retention-v1");
    expect(DEFAULT_CONTEXT_HISTORY_RETENTION_POLICY).toEqual({
      maxAgeDays: 90,
      maxUnprotectedRowsPerSource: 64,
    });
  });

  it("intersects age and count across 100+ rows and returns deterministic IDs", () => {
    for (let age = 110; age >= 0; age--) {
      addHistory(db, SOURCE, new Date(NOW.getTime() - age * DAY), `age-${age}`);
    }
    const beforeChanges = totalChanges();
    const first = inspectContextHistoryRetention(db, NOW);
    const second = inspectContextHistoryRetention(db, NOW);

    expect(first.ok).toBe(true);
    expect(first.candidate_ids).toEqual(second.candidate_ids);
    expect(first.summary).toMatchObject({
      source_n: 1,
      rows_before: 111,
      latest_protected_n: 1,
      recent_retained_n: 90,
      count_retained_n: 64,
      delete_candidate_n: 46,
      rows_deleted: 0,
      rows_after: 111,
    });
    expect(first.candidate_ids).toEqual([...first.candidate_ids].sort((a, b) => a - b));
    expect(totalChanges()).toBe(beforeChanges);
    expect(ids()).toHaveLength(111);
  });

  it("ranks independent structural sources and resolves tied timestamps by id", () => {
    // These tuples collide under a naive `${workspace}|${component}|${file}` key.
    const collidingA = { workspaceId: "ws|OTHER", component: "OTHER", fileRef: "y" };
    const collidingB = { workspaceId: "ws", component: "OTHER", fileRef: "OTHER|y" };
    addWorkspace(db, collidingA.workspaceId);
    addWorkspace(db, collidingB.workspaceId);
    const old = new Date(NOW.getTime() - 200 * DAY);
    const a1 = addHistory(db, collidingA, old, "a1");
    const a2 = addHistory(db, collidingA, old, "a2");
    const b1 = addHistory(db, collidingB, old, "b1");
    const result = inspectContextHistoryRetention(db, NOW, {
      maxAgeDays: 90,
      maxUnprotectedRowsPerSource: 0,
    });

    expect(result.summary.source_n).toBe(2);
    expect(result.candidate_ids).toEqual([a1]);
    expect(result.candidate_ids).not.toContain(a2);
    expect(result.candidate_ids).not.toContain(b1);
  });

  it("retains an old latest row and valid future rows", () => {
    const old = addHistory(db, SOURCE, new Date(NOW.getTime() - 200 * DAY), "old");
    const future1 = addHistory(db, SOURCE, new Date(NOW.getTime() + DAY), "future-1");
    const future2 = addHistory(db, SOURCE, new Date(NOW.getTime() + 2 * DAY), "future-2");
    const result = inspectContextHistoryRetention(db, NOW, {
      maxAgeDays: 90,
      maxUnprotectedRowsPerSource: 64,
    });
    expect(result.candidate_ids).toEqual([old]);
    expect(result.candidate_ids).not.toContain(future1);
    expect(result.candidate_ids).not.toContain(future2);
  });

  it("caps 66 future rows at latest plus 64 unprotected rows", () => {
    const futureIds: number[] = [];
    for (let day = 1; day <= 66; day++) {
      futureIds.push(addHistory(db, SOURCE, new Date(NOW.getTime() + day * DAY), `future-${day}`));
    }
    const result = inspectContextHistoryRetention(db, NOW);
    expect(result.ok).toBe(true);
    expect(result.candidate_ids).toEqual([futureIds[0]]);
    expect(result.summary).toMatchObject({
      rows_before: 66,
      latest_protected_n: 1,
      recent_retained_n: 65,
      count_retained_n: 64,
      delete_candidate_n: 1,
    });
  });

  it("protects the baseline and more than 64 rows in one open window", () => {
    const adoptedAt = new Date(NOW.getTime() - 120 * DAY);
    const baseline = addHistory(db, SOURCE, new Date(adoptedAt.getTime() - DAY), "baseline");
    const windowIds: number[] = [];
    for (let i = 1; i <= 70; i++) {
      windowIds.push(addHistory(db, SOURCE, new Date(adoptedAt.getTime() + i * 60_000), `w-${i}`));
    }
    const latest = addHistory(db, SOURCE, new Date(adoptedAt.getTime() + 20 * DAY), "latest");
    addOpenRec(db, "rec-open-many", { adoptedAt });

    const result = inspectContextHistoryRetention(db, NOW, {
      maxAgeDays: 1,
      maxUnprotectedRowsPerSource: 0,
    });
    expect(result.ok).toBe(true);
    expect(result.summary.open_window_protected_n).toBe(71);
    expect(result.candidate_ids).not.toContain(baseline);
    for (const id of windowIds) expect(result.candidate_ids).not.toContain(id);
    expect(result.candidate_ids).not.toContain(latest);
  });

  it("unions overlapping legacy and D1 windows while completed effects are unprotected", () => {
    const adoptedAt = new Date(NOW.getTime() - 120 * DAY);
    const rows = Array.from({ length: 8 }, (_, index) =>
      addHistory(db, SOURCE, new Date(adoptedAt.getTime() + index * DAY), `overlap-${index}`),
    );
    addOpenRec(db, "rec-one", {
      adoptedAt,
    });
    addOpenRec(db, "rec-two", {
      adoptedAt: new Date(adoptedAt.getTime() + 2 * DAY),
      beforeFrom: adoptedAt,
      beforeTo: new Date(adoptedAt.getTime() + 2 * DAY),
      afterFrom: new Date(adoptedAt.getTime() + 2 * DAY),
      afterTo: new Date(adoptedAt.getTime() + 6 * DAY),
      legacy: true,
    });
    db.prepare(
      `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
        modeled_formula_json, evidence_json, target_metric, state, created_at, adopted_at)
       VALUES ('completed', 'RULE', 'D1', 'CONTEXT', ?, 'test', '{}', ?,
               'avg_context_per_turn', 'MEASURED_EFFECTIVE', ?, ?)`,
    ).run(
      SOURCE.workspaceId,
      JSON.stringify({ component: SOURCE.component, file_ref: SOURCE.fileRef }),
      adoptedAt.toISOString(),
      adoptedAt.toISOString(),
    );
    db.prepare(
      `INSERT INTO recommendation_effects
       (rec_id, measured_at, before_from, before_to, after_from, after_to, verdict)
       VALUES ('completed', ?, ?, ?, ?, ?, 'EFFECTIVE')`,
    ).run(
      adoptedAt.toISOString(),
      adoptedAt.toISOString(),
      adoptedAt.toISOString(),
      adoptedAt.toISOString(),
      new Date(adoptedAt.getTime() + 14 * DAY).toISOString(),
    );

    const result = inspectContextHistoryRetention(db, NOW, {
      maxAgeDays: 1,
      maxUnprotectedRowsPerSource: 0,
    });
    for (const protectedId of rows.slice(0, 7)) {
      expect(result.candidate_ids).not.toContain(protectedId);
    }
    expect(result.candidate_ids).not.toContain(rows[7]); // latest only
  });

  it("does not protect rows solely for a completed effect", () => {
    const adoptedAt = new Date(NOW.getTime() - 120 * DAY);
    const completedWindowRow = addHistory(
      db,
      SOURCE,
      new Date(adoptedAt.getTime() + DAY),
      "completed-window",
    );
    addHistory(db, SOURCE, new Date(adoptedAt.getTime() + 20 * DAY), "completed-latest");
    db.prepare(
      `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
        modeled_formula_json, evidence_json, target_metric, state, created_at, adopted_at)
       VALUES ('completed-only', 'RULE', 'D1', 'CONTEXT', ?, 'test', '{}', ?,
               'avg_context_per_turn', 'MEASURED_EFFECTIVE', ?, ?)`,
    ).run(
      SOURCE.workspaceId,
      JSON.stringify({ component: SOURCE.component, file_ref: SOURCE.fileRef }),
      adoptedAt.toISOString(),
      adoptedAt.toISOString(),
    );
    db.prepare(
      `INSERT INTO recommendation_effects
       (rec_id, measured_at, before_from, before_to, after_from, after_to, verdict)
       VALUES ('completed-only', ?, ?, ?, ?, ?, 'EFFECTIVE')`,
    ).run(
      adoptedAt.toISOString(),
      adoptedAt.toISOString(),
      adoptedAt.toISOString(),
      adoptedAt.toISOString(),
      new Date(adoptedAt.getTime() + 14 * DAY).toISOString(),
    );
    const result = inspectContextHistoryRetention(db, NOW, {
      maxAgeDays: 1,
      maxUnprotectedRowsPerSource: 0,
    });
    expect(result.candidate_ids).toContain(completedWindowRow);
    expect(result.summary.open_window_protected_n).toBe(0);
  });

  it.each([
    "missing",
    "ambiguous",
    "stale",
    "evidence",
    "window",
    "window-shape",
    "adopted",
    "ordering",
  ])("fails closed for %s open-effect corruption", (kind) => {
    addHistory(db, SOURCE, new Date(NOW.getTime() - 200 * DAY), "deletable");
    addHistory(db, SOURCE, new Date(NOW.getTime() - 190 * DAY), "latest");
    const adoptedAt = new Date(NOW.getTime() - 120 * DAY);
    const badOptions: OpenRecOptions = {
      adoptedAt,
      omitEffect: kind === "missing",
      effectMeasuredAt: kind === "stale" ? new Date(adoptedAt.getTime() + DAY) : adoptedAt,
    };
    if (kind === "evidence") badOptions.evidenceJson = "{";
    addOpenRec(db, "bad-rec", badOptions);
    if (kind === "ambiguous") {
      db.prepare(
        `INSERT INTO recommendation_effects
           (rec_id, measured_at, before_from, before_to, after_from, after_to, verdict)
           VALUES ('bad-rec', ?, ?, ?, ?, ?, NULL)`,
      ).run(
        new Date(adoptedAt.getTime() + DAY).toISOString(),
        adoptedAt.toISOString(),
        adoptedAt.toISOString(),
        adoptedAt.toISOString(),
        new Date(adoptedAt.getTime() + 14 * DAY).toISOString(),
      );
    }
    if (kind === "window") {
      db.prepare("UPDATE recommendation_effects SET after_to = ? WHERE rec_id = 'bad-rec'").run(
        "2026-01-01 00:00:00",
      );
    }
    if (kind === "window-shape") {
      db.prepare("UPDATE recommendation_effects SET after_to = ? WHERE rec_id = 'bad-rec'").run(
        new Date(adoptedAt.getTime() + 15 * DAY).toISOString(),
      );
    }
    if (kind === "adopted") {
      db.prepare("UPDATE recommendations SET adopted_at = ? WHERE rec_id = 'bad-rec'").run(
        "2026-01-01 00:00:00",
      );
    }
    if (kind === "ordering") {
      db.prepare("UPDATE recommendation_effects SET before_to = ? WHERE rec_id = 'bad-rec'").run(
        new Date(adoptedAt.getTime() + DAY).toISOString(),
      );
    }
    const before = ids();
    const inspected = inspectContextHistoryRetention(db, NOW);
    const compacted = compactContextHistory(db, NOW);
    expect(inspected).toMatchObject({
      ok: false,
      candidate_ids: [],
      summary: { failure_class: "invalid_open_effect", malformed_open_effect_n: 1 },
    });
    expect(compacted).toMatchObject({
      ok: false,
      summary: { rows_deleted: 0, failure_class: "invalid_open_effect" },
    });
    expect(ids()).toEqual(before);
  });

  it("rejects malformed history timestamps, invalid clocks, and invalid policies without writes", () => {
    addHistory(db, SOURCE, "not-an-instant", "bad-time");
    const before = ids();
    expect(inspectContextHistoryRetention(db, NOW)).toMatchObject({
      ok: false,
      candidate_ids: [],
      summary: { failure_class: "invalid_history_row" },
    });
    expect(compactContextHistory(db, new Date("invalid"))).toMatchObject({
      ok: false,
      summary: { rows_deleted: 0, failure_class: "invalid_clock" },
    });
    expect(
      compactContextHistory(db, NOW, { maxAgeDays: 0, maxUnprotectedRowsPerSource: -1 }),
    ).toMatchObject({ ok: false, summary: { rows_deleted: 0, failure_class: "invalid_policy" } });
    expect(ids()).toEqual(before);
  });

  it("rejects an empty source identity in history before selecting candidates", () => {
    addHistory(db, SOURCE, new Date(NOW.getTime() - 200 * DAY), "empty-source");
    db.prepare("UPDATE context_inventory_history SET file_ref = ''").run();
    expect(inspectContextHistoryRetention(db, NOW)).toMatchObject({
      ok: false,
      candidate_ids: [],
      summary: { failure_class: "invalid_history_row", delete_candidate_n: 0 },
    });
  });

  it.each([
    ["missing component", { file_ref: SOURCE.fileRef }],
    ["missing file_ref", { component: SOURCE.component }],
    ["non-string component", { component: 42, file_ref: SOURCE.fileRef }],
    ["non-string file_ref", { component: SOURCE.component, file_ref: 42 }],
    ["empty component", { component: "", file_ref: SOURCE.fileRef }],
    ["empty file_ref", { component: SOURCE.component, file_ref: "" }],
    ["invalid component", { component: "NOT_ALLOWED", file_ref: SOURCE.fileRef }],
  ])("fails closed for %s D1 evidence", (_label, evidence) => {
    addHistory(db, SOURCE, new Date(NOW.getTime() - 200 * DAY), "evidence-old");
    addHistory(db, SOURCE, new Date(NOW.getTime() - 190 * DAY), "evidence-latest");
    addOpenRec(db, "bad-evidence-rec", { evidenceJson: JSON.stringify(evidence) });
    const before = ids();

    const inspected = inspectContextHistoryRetention(db, NOW, {
      maxAgeDays: 1,
      maxUnprotectedRowsPerSource: 0,
    });
    const compacted = compactContextHistory(db, NOW, {
      maxAgeDays: 1,
      maxUnprotectedRowsPerSource: 0,
    });

    expect(inspected).toMatchObject({
      ok: false,
      candidate_ids: [],
      summary: { delete_candidate_n: 0, failure_class: "invalid_open_effect" },
    });
    expect(compacted).toMatchObject({
      ok: false,
      summary: { rows_deleted: 0, failure_class: "invalid_open_effect" },
    });
    expect(ids()).toEqual(before);
  });

  it("ignores malformed evidence on an unknown open handler", () => {
    const candidate = addHistory(db, SOURCE, new Date(NOW.getTime() - 200 * DAY), "unknown-old");
    addHistory(db, SOURCE, new Date(NOW.getTime() - 190 * DAY), "unknown-latest");
    db.prepare(
      `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
        modeled_formula_json, evidence_json, target_metric, state, created_at, adopted_at)
       VALUES ('unknown-handler', 'RULE', 'DX', 'CONTEXT', ?, 'test', '{}', '{',
               'future_metric', 'MEASURING', ?, ?)`,
    ).run(SOURCE.workspaceId, NOW.toISOString(), NOW.toISOString());

    const inspected = inspectContextHistoryRetention(db, NOW, {
      maxAgeDays: 1,
      maxUnprotectedRowsPerSource: 0,
    });
    expect(inspected).toMatchObject({
      ok: true,
      candidate_ids: [candidate],
      summary: { malformed_open_effect_n: 0, open_window_protected_n: 0 },
    });
    expect(
      compactContextHistory(db, NOW, { maxAgeDays: 1, maxUnprotectedRowsPerSource: 0 }),
    ).toMatchObject({ ok: true, summary: { rows_deleted: 1, rows_after: 1 } });
  });

  it("keeps aggregate output privacy-safe and omits candidate IDs from summaries", () => {
    addHistory(db, SOURCE, new Date(NOW.getTime() - 200 * DAY), "secret-hash");
    addHistory(db, SOURCE, new Date(NOW.getTime() - 190 * DAY), "latest");
    addOpenRec(db, "secret-rec-id");
    const result = inspectContextHistoryRetention(db, NOW, {
      maxAgeDays: 1,
      maxUnprotectedRowsPerSource: 0,
    });
    const aggregate = JSON.stringify(result.summary);
    expect(result.candidate_ids).toHaveLength(1);
    expect(aggregate).not.toContain(SOURCE.fileRef);
    expect(aggregate).not.toContain(SOURCE.workspaceId);
    expect(aggregate).not.toContain("secret-hash");
    expect(aggregate).not.toContain("secret-rec-id");
    expect(result.summary).not.toHaveProperty("candidate_ids");
  });
});

describe("context history compaction", () => {
  it("deletes the exact plan and is idempotent at the same injected clock", () => {
    for (let age = 70; age >= 0; age--) {
      addHistory(db, SOURCE, new Date(NOW.getTime() - age * DAY), `idempotent-${age}`);
    }
    const policy = { maxAgeDays: 90, maxUnprotectedRowsPerSource: 4 };
    const plan = inspectContextHistoryRetention(db, NOW, policy);
    const first = compactContextHistory(db, NOW, policy);
    const second = compactContextHistory(db, NOW, policy);
    expect(first).toMatchObject({
      ok: true,
      summary: { rows_deleted: plan.candidate_ids.length, rows_after: 5 },
    });
    expect(second).toMatchObject({
      ok: true,
      summary: { rows_before: 5, delete_candidate_n: 0, rows_deleted: 0, rows_after: 5 },
    });
  });

  it("pins the 500-ID boundary and successfully compacts 501 candidates across chunks", () => {
    const old = new Date(NOW.getTime() - 200 * DAY);
    for (let index = 0; index < 501; index++) {
      addHistory(db, SOURCE, old, `exact-500-${index}`);
    }
    const policy = { maxAgeDays: 1, maxUnprotectedRowsPerSource: 0 };
    const exact = inspectContextHistoryRetention(db, NOW, policy);
    expect(exact.candidate_ids).toHaveLength(500);
    expect(compactContextHistory(db, NOW, policy)).toMatchObject({
      ok: true,
      summary: { delete_candidate_n: 500, rows_deleted: 500, rows_after: 1 },
    });

    db.prepare("DELETE FROM context_inventory_history").run();
    for (let index = 0; index < 502; index++) {
      addHistory(db, SOURCE, old, `over-500-${index}`);
    }
    const over = inspectContextHistoryRetention(db, NOW, policy);
    expect(over.candidate_ids).toHaveLength(501);
    expect(compactContextHistory(db, NOW, policy)).toMatchObject({
      ok: true,
      summary: { delete_candidate_n: 501, rows_deleted: 501, rows_after: 1 },
    });
  });

  it("rolls back first-chunk deletes when a later chunk candidate fails", () => {
    const old = new Date(NOW.getTime() - 200 * DAY);
    for (let index = 0; index < 502; index++) {
      addHistory(db, SOURCE, old, `later-failure-${index}`);
    }
    const policy = { maxAgeDays: 1, maxUnprotectedRowsPerSource: 0 };
    const plan = inspectContextHistoryRetention(db, NOW, policy);
    expect(plan.candidate_ids).toHaveLength(501);
    const laterChunkId = plan.candidate_ids[500];
    if (laterChunkId === undefined) throw new Error("expected a candidate in the second chunk");
    const before = ids();
    db.exec(
      `CREATE TRIGGER retention_fail_later BEFORE DELETE ON context_inventory_history
       WHEN OLD.id = ${laterChunkId}
       BEGIN SELECT RAISE(ABORT, 'later chunk failure'); END`,
    );

    expect(compactContextHistory(db, NOW, policy)).toMatchObject({
      ok: false,
      summary: { rows_deleted: 0, rows_after: 502, failure_class: "database_error" },
    });
    expect(ids()).toEqual(before);
  });

  it("rolls back a deletion error and an injected latest/count invariant failure", () => {
    const old = addHistory(db, SOURCE, new Date(NOW.getTime() - 200 * DAY), "old");
    const latest = addHistory(db, SOURCE, new Date(NOW.getTime() - 190 * DAY), "latest");
    const policy = { maxAgeDays: 1, maxUnprotectedRowsPerSource: 0 };
    db.exec(
      `CREATE TRIGGER retention_block BEFORE DELETE ON context_inventory_history
       BEGIN SELECT RAISE(ABORT, 'fixture deletion failure'); END`,
    );
    expect(compactContextHistory(db, NOW, policy)).toMatchObject({
      ok: false,
      summary: { rows_deleted: 0, rows_after: 2, failure_class: "database_error" },
    });
    expect(ids()).toEqual([old, latest]);
    db.exec("DROP TRIGGER retention_block");

    db.exec(
      `CREATE TRIGGER retention_extra AFTER DELETE ON context_inventory_history
       BEGIN DELETE FROM context_inventory_history WHERE id = ${latest}; END`,
    );
    expect(compactContextHistory(db, NOW, policy)).toMatchObject({
      ok: false,
      summary: { rows_deleted: 0, rows_after: 2, failure_class: "row_count_invariant" },
    });
    expect(ids()).toEqual([old, latest]);
  });

  it("fails closed when a second connection cannot acquire the immediate lock", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentwrangler-retention-lock-"));
    const dbPath = path.join(dir, "fixture.sqlite");
    const first = createFixtureDb(dbPath);
    const second = openDb(dbPath);
    try {
      first.prepare("DELETE FROM context_inventory_history").run();
      addHistory(first, SOURCE, new Date(NOW.getTime() - 200 * DAY), "locked-old");
      addHistory(first, SOURCE, new Date(NOW.getTime() - 190 * DAY), "locked-latest");
      second.pragma("busy_timeout = 0");
      first.exec("BEGIN IMMEDIATE");
      const result = compactContextHistory(second, NOW, {
        maxAgeDays: 1,
        maxUnprotectedRowsPerSource: 0,
      });
      expect(result).toMatchObject({
        ok: false,
        summary: { rows_deleted: 0, failure_class: "database_error" },
      });
      first.exec("ROLLBACK");
      expect(ids(first)).toHaveLength(2);
    } finally {
      if (first.inTransaction) first.exec("ROLLBACK");
      second.close();
      first.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves measurement with a baseline and more than 64 open-window observations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentwrangler-retention-many-twins-"));
    const dbA = createFixtureDb(path.join(dir, "before.sqlite"));
    const dbB = createFixtureDb(path.join(dir, "after.sqlite"));
    const adoptedMs = NOW.getTime() - 30 * DAY;
    const measuredAt = new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * DAY);
    try {
      for (const target of [dbA, dbB]) {
        target.prepare("DELETE FROM recommendation_effects").run();
        target.prepare("DELETE FROM recommendations").run();
        target.prepare("DELETE FROM context_inventory_history").run();
        addHistory(target, SOURCE, new Date(adoptedMs - 100 * DAY), "many-noise", 2000);
        addHistory(target, SOURCE, new Date(adoptedMs - DAY), "many-baseline", 1000);
        addProposedSourceRec(target, "many-rec", SOURCE, new Date(adoptedMs));
        setQueryDb(target);
        adoptRecommendation("many-rec", adoptedMs);
        resetQueryDb();
        for (let minute = 1; minute <= 70; minute++) {
          addHistory(
            target,
            SOURCE,
            new Date(adoptedMs + minute * 60_000),
            `many-after-${minute}`,
            1000 - minute * 10,
          );
        }
      }

      expect(
        compactContextHistory(dbB, measuredAt, {
          maxAgeDays: 1,
          maxUnprotectedRowsPerSource: 0,
        }),
      ).toMatchObject({ ok: true, summary: { rows_deleted: 1, open_window_protected_n: 71 } });
      runMeasurementPass(dbA, measuredAt, { force: true });
      runMeasurementPass(dbB, measuredAt, { force: true });
      expect(readMeasurementOutcomes(dbB, ["many-rec"])).toEqual(
        readMeasurementOutcomes(dbA, ["many-rec"]),
      );
      expect(readMeasurementOutcomes(dbB, ["many-rec"])).toMatchObject([
        {
          state: "MEASURED_EFFECTIVE",
          effect: { before_value: 1000, after_value: 300, verdict: "EFFECTIVE" },
        },
      ]);
    } finally {
      resetQueryDb();
      dbA.close();
      dbB.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves both measurements across overlapping D1 and legacy windows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentwrangler-retention-overlap-twins-"));
    const dbA = createFixtureDb(path.join(dir, "before.sqlite"));
    const dbB = createFixtureDb(path.join(dir, "after.sqlite"));
    const firstAdoptedMs = NOW.getTime() - 40 * DAY;
    const secondAdoptedMs = firstAdoptedMs + 2 * DAY;
    const measuredAt = new Date(secondAdoptedMs + (AFTER_WINDOW_DAYS + 1) * DAY);
    try {
      for (const target of [dbA, dbB]) {
        target.prepare("DELETE FROM recommendation_effects").run();
        target.prepare("DELETE FROM recommendations").run();
        target.prepare("DELETE FROM context_inventory_history").run();
        addHistory(target, SOURCE, new Date(firstAdoptedMs - 100 * DAY), "overlap-noise", 2000);
        addHistory(target, SOURCE, new Date(firstAdoptedMs - DAY), "overlap-baseline", 1000);
        addProposedSourceRec(target, "overlap-d1", SOURCE, new Date(firstAdoptedMs));
        setQueryDb(target);
        adoptRecommendation("overlap-d1", firstAdoptedMs);
        resetQueryDb();
        addHistory(target, SOURCE, new Date(firstAdoptedMs + DAY), "overlap-day-1", 900);

        addProposedSourceRec(target, "overlap-legacy", SOURCE, new Date(secondAdoptedMs), true);
        setQueryDb(target);
        adoptRecommendation("overlap-legacy", secondAdoptedMs);
        resetQueryDb();
        addHistory(target, SOURCE, new Date(firstAdoptedMs + 3 * DAY), "overlap-day-3", 700);
        addHistory(target, SOURCE, new Date(firstAdoptedMs + 10 * DAY), "overlap-day-10", 400);
        addHistory(target, SOURCE, new Date(firstAdoptedMs + 15 * DAY), "overlap-day-15", 300);
      }

      expect(
        compactContextHistory(dbB, measuredAt, {
          maxAgeDays: 1,
          maxUnprotectedRowsPerSource: 0,
        }),
      ).toMatchObject({ ok: true, summary: { rows_deleted: 1 } });
      runMeasurementPass(dbA, measuredAt, { force: true });
      runMeasurementPass(dbB, measuredAt, { force: true });
      const recIds = ["overlap-d1", "overlap-legacy"];
      expect(readMeasurementOutcomes(dbB, recIds)).toEqual(readMeasurementOutcomes(dbA, recIds));
      expect(readMeasurementOutcomes(dbB, recIds)).toMatchObject([
        {
          rec_id: "overlap-d1",
          state: "MEASURED_EFFECTIVE",
          effect: { before_value: 1000, after_value: 400, verdict: "EFFECTIVE" },
        },
        {
          rec_id: "overlap-legacy",
          state: "MEASURED_EFFECTIVE",
          effect: { before_value: 900, after_value: 300, verdict: "EFFECTIVE" },
        },
      ]);
    } finally {
      resetQueryDb();
      dbA.close();
      dbB.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves D1 baseline, after value, state, and verdict in twin temporary databases", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentwrangler-retention-twins-"));
    const dbA = createFixtureDb(path.join(dir, "before.sqlite"));
    const dbB = createFixtureDb(path.join(dir, "after.sqlite"));
    const adoptedMs = NOW.getTime() - 30 * DAY;
    const measuredAt = new Date(adoptedMs + (AFTER_WINDOW_DAYS + 1) * DAY);
    try {
      for (const target of [dbA, dbB]) {
        target.prepare("DELETE FROM recommendation_effects").run();
        target.prepare("DELETE FROM recommendations").run();
        target.prepare("DELETE FROM context_inventory_history").run();
        addHistory(target, SOURCE, new Date(adoptedMs - 100 * DAY), "noise", 2000);
        addHistory(target, SOURCE, new Date(adoptedMs - DAY), "baseline", 1000);
        target
          .prepare(
            `INSERT INTO recommendations
             (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
              modeled_formula_json, evidence_json, target_metric, state, created_at)
             VALUES ('twin-rec', 'RULE', 'D1', 'CONTEXT', ?, 'test', '{}', ?,
                     'avg_context_per_turn', 'PROPOSED', ?)`,
          )
          .run(
            SOURCE.workspaceId,
            JSON.stringify({ component: SOURCE.component, file_ref: SOURCE.fileRef }),
            new Date(adoptedMs).toISOString(),
          );
        setQueryDb(target);
        adoptRecommendation("twin-rec", adoptedMs);
        resetQueryDb();
        addHistory(target, SOURCE, new Date(adoptedMs + DAY), "after", 400);
      }

      const compacted = compactContextHistory(dbB, measuredAt, {
        maxAgeDays: 1,
        maxUnprotectedRowsPerSource: 0,
      });
      expect(compacted.ok).toBe(true);
      runMeasurementPass(dbA, measuredAt, { force: true });
      runMeasurementPass(dbB, measuredAt, { force: true });
      const readOutcome = (target: Database.Database) => ({
        rec: target.prepare("SELECT state FROM recommendations WHERE rec_id = 'twin-rec'").get(),
        effect: target
          .prepare(
            `SELECT before_value, after_value, delta_pct, verdict
               FROM recommendation_effects WHERE rec_id = 'twin-rec'`,
          )
          .get(),
      });
      expect(readOutcome(dbB)).toEqual(readOutcome(dbA));
      expect(readOutcome(dbB)).toMatchObject({
        rec: { state: "MEASURED_EFFECTIVE" },
        effect: { before_value: 1000, after_value: 400, verdict: "EFFECTIVE" },
      });
    } finally {
      resetQueryDb();
      dbA.close();
      dbB.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
