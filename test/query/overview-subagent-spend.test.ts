import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { getGlobalOverview } from "../../src/query/api/overview.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { overviewSectionSchemas } from "../../src/shared/schemas/overview-view.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  setQueryDb(db);
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws', 'ws', '2026-01-01T00:00:00.000Z')",
  ).run();
  for (const id of ["a", "b", "c", "old"]) {
    db.prepare(
      "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES (?, 'ws', 'fixture', 'RECONCILED')",
    ).run(id);
  }
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

function turn(
  id: string,
  session: string,
  ts: string,
  model: string,
  cost: number | null,
  sidechain: boolean,
) {
  db.prepare(`INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version, cost_equiv_u, is_sidechain)
    VALUES (?, ?, 'ws', ?, ?, 'fixture', ?, ?)`).run(
    id,
    session,
    ts,
    model,
    cost,
    sidechain ? 1 : 0,
  );
}

it("counts window spend, distinct sidechain sessions, and model families from hand-picked turns", () => {
  turn("a-main", "a", "2026-01-03T00:00:00.000Z", "claude-sonnet", 8_000_000, false);
  turn("a-side", "a", "2026-01-03T01:00:00.000Z", "claude-sonnet", 2_000_000, true);
  turn("a-side-2", "a", "2026-01-03T02:00:00.000Z", "claude-opus", 3_000_000, true);
  turn("b-side", "b", "2026-01-04T00:00:00.000Z", "claude-haiku", 5_000_000, true);
  turn("c-main", "c", "2026-01-04T01:00:00.000Z", "claude-opus", 2_000_000, false);
  turn("old-side", "old", "2026-01-01T00:00:00.000Z", "claude-opus", 99_000_000, true);
  expect(
    getGlobalOverview({ from: "2026-01-02T00:00:00.000Z", to: "2026-01-05T00:00:00.000Z" }).data
      ?.subagent_spend,
  ).toEqual({
    total_cost_u: 20_000_000,
    sidechain_cost_u: 10_000_000,
    share: 0.5,
    sessions_with_sidechain_spend: 2,
    sessions_in_window: 3,
    haiku_sidechain_turns: 1,
    by_model_family: [
      { family: "Haiku", cost_u: 5_000_000 },
      { family: "Opus", cost_u: 3_000_000 },
      { family: "Sonnet", cost_u: 2_000_000 },
    ],
  });
});

it("an empty window's kpis payload passes the kpis schema with zero turns", () => {
  turn("old-side", "old", "2026-01-01T00:00:00.000Z", "claude-opus", 99_000_000, true);
  const data = getGlobalOverview({
    from: "2030-01-01T00:00:00.000Z",
    to: "2030-01-02T00:00:00.000Z",
  }).data;
  expect(overviewSectionSchemas.kpis.safeParse(data).success).toBe(true);
  expect(data?.turns).toBe(0);
  expect(data?.unpriced_turns).toBe(0);
});

it("a sidechain family whose turns are all unpriced reports cost 0, not null", () => {
  turn("a-side", "a", "2026-01-03T01:00:00.000Z", "claude-sonnet", 2_000_000, true);
  turn("b-side", "b", "2026-01-04T00:00:00.000Z", "claude-mystery", null, true);
  const data = getGlobalOverview({
    from: "2026-01-02T00:00:00.000Z",
    to: "2026-01-05T00:00:00.000Z",
  }).data;
  expect(data?.subagent_spend?.by_model_family).toEqual([
    { family: "Sonnet", cost_u: 2_000_000 },
    { family: "Other", cost_u: 0 },
  ]);
  expect(overviewSectionSchemas.kpis.safeParse(data).success).toBe(true);
});
