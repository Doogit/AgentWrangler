import * as http from "node:http";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { runMigrations } from "../../src/db/migrate.js";

let db: Database.Database;
let server: http.Server;
let port: number;
beforeAll(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-http', 'synthetic', '2026-08-01T00:00:00.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES ('session-http', 'ws-http', 'synthetic.jsonl', 'RECONCILED')",
  ).run();
  const insert = db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, model, cost_equiv_u, parser_version) VALUES (?, 'session-http', 'ws-http', ?, 'synthetic', ?, 'p1')",
  );
  for (let i = 0; i < 203; i++)
    insert.run(`turn-${i}`, "2026-08-05T12:00:00.000Z", i < 200 ? 10 : null);
  insert.run("end-boundary", "2026-08-06T00:00:00.000Z", 50);
  server = createServer(db, 0, null, "synthetic-observation-token");
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    }),
  );
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});
function read(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += String(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }));
      })
      .on("error", reject);
  });
}
describe("ESF observation HTTP contracts", () => {
  it("returns the complete session aggregate and frozen envelope", async () => {
    const response = await read("/api/esf/session-observations/session-http");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: { resource: { unpriced_turn_count: 3, priced_turn_count: 201, priced_cost_u: 2050 } },
      meta: {
        metric_definition_version: "esf-1",
        drilldown_ids: { session_id: "session-http" },
        qualification: { unpriced_turns: 3 },
      },
    });
  });
  it("returns a missing-session response rather than a fabricated zero", async () => {
    expect(await read("/api/esf/session-observations/missing")).toMatchObject({
      status: 404,
      body: { data: null, meta: { n: 0, claim_kind: "N_A" } },
    });
  });
  it("keeps the selected half-open bounds and excludes the end-boundary turn", async () => {
    const response = await read(
      "/api/esf/observations?workspace_id=ws-http&from=2026-08-05T00:00:00.000Z&to=2026-08-06T00:00:00.000Z",
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: { resource: { priced_cost_u: 2000, unpriced_turn_count: 3 } },
      meta: { window: { from: "2026-08-05T00:00:00.000Z", to: "2026-08-06T00:00:00.000Z" } },
    });
  });
});
