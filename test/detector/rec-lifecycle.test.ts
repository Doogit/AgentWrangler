import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { d9Detector } from "../../src/detector/detectors/d9_idle_background_session.js";
import { h1Detector } from "../../src/detector/detectors/h1_destructive_operations.js";
import { buildContext, runHistoryWalk } from "../../src/detector/engine.js";
import { dismissRecommendation, listRecommendations } from "../../src/query/api/recommendations.js";
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

function addSession(id: string, workspace: string, at: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
  ).run(workspace, workspace, at);
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state,
        turn_count, cost_equiv_u, hygiene_flags, user_turn_count)
     VALUES (?, ?, ?, ?, ?, 'RECONCILED', 1, 0, '[]', 0)`,
  ).run(id, workspace, `/fixture/${id}.jsonl`, at, at);
  db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version)
     VALUES (?, ?, ?, ?, 'synthetic', 'rec-lifecycle-test')`,
  ).run(`turn-${id}`, id, workspace, at);
}

function addFork(id: string, at: string): void {
  addSession(id, "ws-lifecycle", at);
  db.prepare(
    `INSERT INTO subagent_meta
       (agent_id, session_id, agent_type, tool_use_id, spawn_depth, description_len)
     VALUES (?, ?, 'fork', NULL, 1, 0)`,
  ).run(`agent-${id}`, id);
}

describe("F5 recommendation lifecycle", () => {
  it("retains a silent rec for two closed weeks, then retires it after three", async () => {
    addFork("s-old", "2026-09-20T10:00:00.000Z");
    await runHistoryWalk(db, NOW, { detectors: [d9Detector] });
    const original = db
      .prepare("SELECT rec_id FROM recommendations WHERE detector_id='D9'")
      .get() as {
      rec_id: string;
    };
    db.prepare("UPDATE subagent_meta SET agent_type='general-purpose'").run();

    await runHistoryWalk(db, new Date("2026-10-06T12:00:00.000Z"), {
      detectors: [d9Detector],
    });
    expect(
      (
        db.prepare("SELECT state FROM recommendations WHERE rec_id=?").get(original.rec_id) as {
          state: string;
        }
      ).state,
    ).toBe("PROPOSED");

    await runHistoryWalk(db, new Date("2026-10-13T12:00:00.000Z"), {
      detectors: [d9Detector],
    });
    expect(
      (
        db.prepare("SELECT state FROM recommendations WHERE rec_id=?").get(original.rec_id) as {
          state: string;
        }
      ).state,
    ).toBe("PROPOSED");

    await runHistoryWalk(db, new Date("2026-10-20T12:00:00.000Z"), {
      detectors: [d9Detector],
    });
    expect(
      (
        db.prepare("SELECT state FROM recommendations WHERE rec_id=?").get(original.rec_id) as {
          state: string;
        }
      ).state,
    ).toBe("RETIRED");
  });

  it("routes prior-window recommendations to history and leaves them out of ranked cards", async () => {
    addFork("s-prior", "2026-09-01T10:00:00.000Z");
    await runHistoryWalk(db, NOW, { detectors: [d9Detector] });
    const rec = db.prepare("SELECT rec_id FROM recommendations WHERE detector_id='D9'").get() as {
      rec_id: string;
    };
    const view = listRecommendations().data;
    expect(view?.history.some((card) => card.rec_id === rec.rec_id)).toBe(true);
    expect(view?.active.some((card) => card.rec_id === rec.rec_id)).toBe(false);
    expect(view?.active_groups.some((group) => JSON.stringify(group).includes(rec.rec_id))).toBe(
      false,
    );
  });

  it("removes a current-week rec from ranking when the latest walk no longer emits it", async () => {
    addFork("s-stopped", "2026-09-20T10:00:00.000Z");
    await runHistoryWalk(db, NOW, { detectors: [d9Detector] });
    const rec = db.prepare("SELECT rec_id FROM recommendations WHERE detector_id='D9'").get() as {
      rec_id: string;
    };
    db.prepare("UPDATE subagent_meta SET agent_type='general-purpose'").run();
    await runHistoryWalk(db, NOW, { detectors: [d9Detector] });
    const view = listRecommendations().data;
    expect(view?.history.some((card) => card.rec_id === rec.rec_id)).toBe(true);
    expect(view?.active.some((card) => card.rec_id === rec.rec_id)).toBe(false);
  });

  it("keeps a reopened rec in history when it does not fire in the current window", async () => {
    addFork("s-reopened", "2026-09-20T10:00:00.000Z");
    await runHistoryWalk(db, NOW, { detectors: [d9Detector] });
    const rec = db.prepare("SELECT rec_id FROM recommendations WHERE detector_id='D9'").get() as {
      rec_id: string;
    };
    db.prepare("UPDATE recommendations SET state='MEASURED_EFFECTIVE' WHERE rec_id=?").run(
      rec.rec_id,
    );
    db.prepare("UPDATE recommendations SET state='PROPOSED' WHERE rec_id=?").run(rec.rec_id);
    db.prepare("UPDATE subagent_meta SET agent_type='general-purpose'").run();
    await runHistoryWalk(db, NOW, { detectors: [d9Detector] });
    const view = listRecommendations().data;
    expect(view?.history.some((card) => card.rec_id === rec.rec_id)).toBe(true);
    expect(view?.active.some((card) => card.rec_id === rec.rec_id)).toBe(false);
    expect(view?.active_groups.some((group) => JSON.stringify(group).includes(rec.rec_id))).toBe(
      false,
    );
  });

  it("collapses five RM_RF sessions in one workspace to one recommendation", () => {
    const ctx = buildContext(NOW);
    for (let i = 0; i < 5; i++) {
      const id = `h1-${i}`;
      addSession(id, "ws-h1", "2026-09-20T10:00:00.000Z");
      db.prepare("UPDATE turns SET cost_equiv_u = ? WHERE session_id = ?").run((i + 1) * 100, id);
      db.prepare(
        `INSERT INTO ingest_metric_events
           (event_id, session_id, is_user_turn, is_compact_summary, is_api_error,
            is_interrupt, destructive_op, event_ts, is_sidechain)
         VALUES (?, ?, 0, 0, 0, 0, 'rm-rf', ?, 0)`,
      ).run(`event-${id}`, id, "2026-09-20T10:00:00.000Z");
    }
    db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, cost_equiv_u, parser_version)
       VALUES ('turn-h1-after', 'h1-0', 'ws-h1', '2026-09-20T11:00:00.000Z',
               'synthetic', 10000, 'rec-lifecycle-test')`,
    ).run();
    const fired = h1Detector.evaluate(db, ctx).fired;
    expect(fired).toHaveLength(1);
    expect(fired[0]?.payload.session_ids).toHaveLength(5);
    expect(fired[0]?.payload.metrics?.OPERATION_COUNT).toEqual({ kind: "COUNT", value: 5 });
    expect(fired[0]?.payload.estimate).toMatchObject({
      basis: "R",
      rank_value_u_per_wk: 75,
      summable: false,
    });
  });

  it("persists an expired dismiss as proposed and permits a second dismiss", async () => {
    addFork("s-current", "2026-09-20T10:00:00.000Z");
    await runHistoryWalk(db, NOW, { detectors: [d9Detector] });
    const rec = db.prepare("SELECT rec_id FROM recommendations WHERE detector_id='D9'").get() as {
      rec_id: string;
    };
    const nowMs = Date.now();
    dismissRecommendation(rec.rec_id, nowMs, new Date(nowMs + 1000).toISOString());
    expect(() => dismissRecommendation(rec.rec_id, nowMs + 2000)).not.toThrow();
    expect(
      (
        db.prepare("SELECT state FROM recommendations WHERE rec_id=?").get(rec.rec_id) as {
          state: string;
        }
      ).state,
    ).toBe("DISMISSED");
  });
});
