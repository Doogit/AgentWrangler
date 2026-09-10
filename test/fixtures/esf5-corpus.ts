/** Fixed, aggregate-only ESF5 corpus. Never opens an operator database. */
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migrate.js";
import { runDetectors } from "../../src/detector/engine.js";

export const ESF5_FROM = "2026-08-01T00:00:00.000Z";
export const ESF5_AS_OF = "2026-08-15T00:00:00.000Z";
const AT = "2026-08-05T12:00:00.000Z";
export const ESF5_IDS = [
  "FX-RECOVER-18",
  "FX-RESEARCH-NC",
  "FX-SHARED-COST",
  "FX-LIVE-SPARSE",
  "FX-LOWCOST-REPAIR",
  "FX-ROLLBACK-MID",
  "FX-MIX-DRIFT",
  "FX-OVERLAP-14D",
  "FX-OVERLAP-SCOPED-14D",
  "FX-THRESHOLD-9-10",
  "FX-STATE-MAP",
] as const;

export function seedEsf5ResourceCorpus(db: Database.Database): void {
  function session(id: string, ws: string, cost: number | null, live = false, activity = true) {
    db.prepare(
      "INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?,?,?)",
    ).run(ws, ws, ESF5_FROM);
    db.prepare(`INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
      VALUES (?,?, 'synthetic-not-a-transcript', ?,?, ?,1,?,'[]')`).run(
      id,
      ws,
      AT,
      "2026-08-06T12:00:00.000Z",
      live ? "LIVE" : "RECONCILED",
      cost ?? 0,
    );
    db.prepare(`INSERT INTO turns (message_id, session_id, workspace_id, ts, model, cost_equiv_u, cost_claim, parser_version)
      VALUES (?,?,?,?, 'synthetic',?,'LIST_EQUIV','esf5-synthetic')`).run(
      `turn-${id}`,
      id,
      ws,
      AT,
      cost,
    );
    if (activity) event(id, 0, "OK", false);
  }
  function event(id: string, index: number, exit: string, test: boolean) {
    const eventId = `event-${id}-${index}`;
    const ts = new Date(Date.parse(AT) + index * 60_000).toISOString();
    db.prepare(`INSERT INTO tool_events (event_id, session_id, ts, tool_name, result_bytes, exit_class)
      VALUES (?,?,?,'Bash',1,?)`).run(eventId, id, ts, exit);
    db.prepare(`INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
      VALUES (?,?,?,?)`).run(eventId, `turn-${id}`, index, test ? 1 : 0);
  }
  for (let n = 1; n <= 18; n++) {
    const id = `ses-a${String(n).padStart(2, "0")}`;
    session(id, "ws-alpha", n <= 15 ? 50_000 : n === 16 ? 80_000 : null);
    if (n <= 6) {
      for (let i = 1; i <= 3; i++) event(id, i, "TEST_FAIL", true);
      if (n <= 3) event(id, 4, "OK", true);
    }
  }
  for (let n = 1; n <= 3; n++) session(`ses-al0${n}`, "ws-alpha", 10_000, true);
  for (let n = 1; n <= 5; n++) session(`ses-r0${n}`, "ws-research", 10_000, false, n < 5);
  session("ses-s01", "ws-shared", 110_000);
  for (let n = 1; n <= 3; n++) session(`ses-l0${n}`, "ws-live", 10_000, true);
  session("ses-l04", "ws-live", null);

  // Fixed persisted history is input to the real allocation/query implementation.
  // No generated result or recommendation evidence is substituted.
  for (const [id, ws, sid] of [
    ["00000000-0000-4000-8000-000000000001", "ws-shared", "ses-s01"],
    ["00000000-0000-4000-8000-000000000002", "ws-shared", "ses-s01"],
    ["00000000-0000-4000-8000-000000000003", "ws-live", "ses-l04"],
  ]) {
    db.prepare(`INSERT INTO work_records (work_record_id, workspace_id, created_at, updated_at, current_revision_no)
      VALUES (?,?,?,?,0)`).run(id, ws, ESF5_FROM, ESF5_FROM);
    db.prepare(`INSERT INTO work_record_revisions (work_record_id, revision_no, task_intent, outcome_state, repair_band, effort_band, feedback_source, recorded_at, mutation_id)
      VALUES (?,0,'IMPLEMENT','ACTIVE','UNREPORTED','UNREPORTED','NONE',?,?)`).run(
      id,
      ESF5_FROM,
      `create-${id}`,
    );
    db.prepare(`INSERT INTO work_record_session_links (work_record_id, session_id, linked_revision_no, linked_at, link_source, link_mutation_id)
      VALUES (?,?,0,?,'USER',?)`).run(id, sid, ESF5_FROM, `link-${id}`);
  }
  runDetectors(db, { now: new Date(ESF5_AS_OF), fromIso: ESF5_FROM, toIso: ESF5_AS_OF });
}

export function createEsf5Db(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  seedEsf5ResourceCorpus(db);
  return db;
}
