import type { Db } from "../../src/db/open.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const SYNTHETIC_WINDOW_FROM = "2026-01-01T00:00:00.000Z";
export const SYNTHETIC_WINDOW_TO = "2026-01-15T00:00:00.000Z";

/** Seed aggregate-only history. No transcript text, local paths, or repositories are created. */
export function seedSyntheticHistory(db: Db, turns: number): void {
  const sessions = Math.ceil(turns / 200);
  const workspaces = Math.min(10, sessions);
  const baseMs = Date.parse(SYNTHETIC_WINDOW_FROM);
  const timestampFor = (turn: number): string =>
    new Date(baseMs + Math.floor((turn * 14 * DAY_MS) / turns)).toISOString();
  const insertWorkspace = db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?,?,?)",
  );
  const insertSession = db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
      state, turn_count, cost_equiv_u, hygiene_flags) VALUES (?,?,?,?,?,?,?,?,'[]')`,
  );
  const insertTurn = db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
      input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
      cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
      provisional, parser_version) VALUES (?,?,?,?,?,0,?,?,?,?,0,0,NULL,NULL,?,'LIST_EQUIV',0,'synthetic-v1')`,
  );
  db.transaction(() => {
    for (let workspace = 0; workspace < workspaces; workspace += 1) {
      insertWorkspace.run(
        `synthetic-ws-${workspace}`,
        `synthetic-project-${workspace}`,
        SYNTHETIC_WINDOW_FROM,
      );
    }
    for (let session = 0; session < sessions; session += 1) {
      const workspace = session % workspaces;
      const firstTurn = session * 200;
      const turnsInSession = Math.min(200, turns - firstTurn);
      insertSession.run(
        `synthetic-session-${session}`,
        `synthetic-ws-${workspace}`,
        `synthetic://session-${session}`,
        timestampFor(firstTurn),
        timestampFor(firstTurn + turnsInSession - 1),
        "RECONCILED",
        turnsInSession,
        turnsInSession * 100,
      );
      for (let offset = 0; offset < turnsInSession; offset += 1) {
        const turn = firstTurn + offset;
        insertTurn.run(
          `synthetic-message-${turn}`,
          `synthetic-session-${session}`,
          `synthetic-ws-${workspace}`,
          timestampFor(turn),
          "synthetic-model",
          400,
          80,
          200,
          100,
          100,
        );
      }
    }
  })();
}
