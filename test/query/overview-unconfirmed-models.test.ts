import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { noteUnconfirmedModels } from "../../src/ingest/pricing.js";
import { repriceTurns } from "../../src/ingest/reprice.js";
import { getGlobalOverview } from "../../src/query/api/overview.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";

let db: Database.Database;
const WINDOW = { from: "2026-01-02T00:00:00.000Z", to: "2026-01-05T00:00:00.000Z" };
const SEEN = "2026-01-03T00:00:00.000Z";

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

it("returns an unknown model recorded at ingest, and omits the field when there is none", () => {
  expect(getGlobalOverview(WINDOW).data?.unconfirmed_models).toBeUndefined();
  noteUnconfirmedModels(db, ["claude-opus-9", "claude-sonnet-5-5"], SEEN);
  expect(getGlobalOverview(WINDOW).data?.unconfirmed_models).toEqual([
    { model: "claude-opus-9", tier: "opus", first_seen: SEEN },
  ]);
});

it("filters stored keys against the current KNOWN_MODELS (known model not returned)", () => {
  const stamp = JSON.stringify({ tier: "sonnet-5", first_seen: SEEN });
  db.prepare("INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)").run(
    "unconfirmed_model:claude-sonnet-5-5",
    stamp,
    SEEN,
  );
  expect(getGlobalOverview(WINDOW).data?.unconfirmed_models).toBeUndefined();
});

it("reprice records unknown models from existing turns", () => {
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws', 'ws', ?)",
  ).run(SEEN);
  db.prepare(
    "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES ('s', 'ws', 'f', 'RECONCILED')",
  ).run();
  db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version)
     VALUES ('m', 's', 'ws', ?, 'claude-haiku-9', 'fixture')`,
  ).run(SEEN);
  repriceTurns(db, SEEN);
  expect(getGlobalOverview(WINDOW).data?.unconfirmed_models).toEqual([
    { model: "claude-haiku-9", tier: "haiku", first_seen: SEEN },
  ]);
});
