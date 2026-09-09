/** Synthetic browser acceptance only. No ingestion, operator DB, credentials or action execution. */
import { createServer } from "node:http";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { createHandler } from "../../src/daemon/http.ts";
import { setReady } from "../../src/daemon/readiness.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { setQueryDb } from "../../src/query/db-context.ts";
import { mockRecommendations } from "../../src/ui/api/fixtures.ts";

const db = new Database(":memory:");
db.pragma("foreign_keys = ON");
runMigrations(db);
setQueryDb(db);
const recent = new Date(Date.now() - 3_600_000).toISOString();
db.prepare(
  "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-1', 'synthetic-esf4', ?)",
).run(recent);
for (const [id, state] of [
  ["ses-esf4", "RECONCILED"],
  ["ses-live", "LIVE"],
]) {
  db.prepare(`INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
    VALUES (?, 'ws-1', 'synthetic-not-a-transcript', ?, ?, ?, 2, 50000, '[]')`).run(
    id,
    recent,
    recent,
    state,
  );
  for (let i = 0; i < 2; i++)
    db.prepare(`INSERT INTO turns (message_id, session_id, workspace_id, ts, model, cost_equiv_u, cost_claim, parser_version)
    VALUES (?, ?, 'ws-1', ?, 'synthetic', ?, 'LIST_EQUIV', 'synthetic')`).run(
      `${id}-${i}`,
      id,
      recent,
      i === 0 ? 50000 : null,
    );
}
for (let i = 0; i < 3; i++) {
  db.prepare(
    "INSERT INTO tool_events (event_id, session_id, ts, tool_name, result_bytes, exit_class) VALUES (?, 'ses-esf4', ?, 'Bash', 1, ?)",
  ).run(
    `test-${i}`,
    new Date(Date.parse(recent) + i * 1000).toISOString(),
    i === 2 ? "OK" : "TEST_FAIL",
  );
  db.prepare(
    "INSERT INTO tool_event_metadata (event_id, block_index, is_test_command) VALUES (?, 0, 1)",
  ).run(`test-${i}`);
}
setReady();
let handler;
const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const send = (status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (path === "/api/recommendations" && req.method === "GET") {
    send(200, mockRecommendations());
    return;
  }
  if (path === "/api/status") {
    send(200, { sessions: 2, turns: 4, files_seen: 0, files_parsed: 0, scan_state: "complete" });
    return;
  }
  const safeRead =
    /^(?:\/api\/(?:overview|workspaces|sessions|trends|cost-per-success|esf|work-records|token|ready))(?:\/|$)/.test(
      path,
    );
  const safeWrite = path.startsWith("/api/work-records");
  if (path.startsWith("/api/") && !(req.method === "GET" ? safeRead : safeWrite)) {
    send(503, { error: "Unavailable in the isolated synthetic browser fixture" });
    return;
  }
  handler(req, res);
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  handler = createHandler(db, port, resolve("dist/ui"), "synthetic-esf4-browser-token");
  console.log(`ESF4_SYNTHETIC_URL=http://127.0.0.1:${port}`);
});
process.on("SIGINT", () =>
  server.close(() => {
    db.close();
    process.exit(0);
  }),
);
