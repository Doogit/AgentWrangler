import * as http from "node:http";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { runMigrations } from "../../src/db/migrate.js";
import { resetPipelineStatus, setPipelineProgress } from "../../src/ingest/boot-progress.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";

function request(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

let db: Database.Database;
let server: http.Server;
let port: number;

beforeAll(async () => {
  db = new Database(":memory:");
  runMigrations(db);
  setQueryDb(db);
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-page', 'page', '2026-01-01T00:00:00.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES ('page-one', 'ws-page', 'fixture', 'RECONCILED')",
  ).run();
  db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version, cost_equiv_u) VALUES ('page-turn', 'page-one', 'ws-page', '2026-01-02T00:00:00.000Z', 'fixture-model', 'fixture-parser', 10)",
  ).run();
  server = createServer(db, 0, null);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetQueryDb();
  db.close();
});

describe("GET /api/hot-sessions/page", () => {
  it("reports aggregate history progress without row data", async () => {
    resetPipelineStatus();
    expect((await request(port, "/api/history-progress")).body).toEqual({
      complete: false,
      processing: false,
      failed: false,
      revision: "pending",
    });
    setPipelineProgress({
      phase: "done",
      files_total: 3,
      files_completed: 3,
      files_skipped: 0,
      files_with_new_data: 2,
      detector_runs: 1,
    });
    expect((await request(port, "/api/history-progress")).body).toEqual({
      complete: true,
      processing: false,
      failed: false,
      revision: "done:2:0:1",
    });
    resetPipelineStatus();
  });
  it("returns a filtered page with aggregate columns and Issues", async () => {
    const response = await request(port, "/api/hot-sessions/page?workspace=ws-page&q=page-");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      next_cursor: null,
      rows: [
        {
          session_id: "page-one",
          max_context_tokens: 0,
          issues: { top_driver: null, categories: [] },
        },
      ],
    });
  });

  it("leaves the legacy array route's shape unchanged (no issues field)", async () => {
    const response = await request(port, "/api/hot-sessions");
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect((response.body as Array<Record<string, unknown>>)[0]).not.toHaveProperty("issues");
  });

  it("rejects invalid page filters", async () => {
    for (const query of ["category=unknown", "q=%25", "cursor=!!!", "limit=0", "from=nope"]) {
      const response = await request(port, `/api/hot-sessions/page?${query}`);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: "INVALID_QUERY" });
    }
  });
});
