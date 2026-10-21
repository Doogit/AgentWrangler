import * as http from "node:http";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { runMigrations } from "../../src/db/migrate.js";
import { c1FindingDescriptor } from "../../src/detector/detectors/c1_tool_error_rate.js";
import { createFindingEnvelopeV2, findingIds } from "../../src/detector/privacy-contract.js";
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
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('fixture-ws', 'fixture-project', '2026-01-01T00:00:00.000Z')",
  ).run();
  const session = db.prepare(
    "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES (?, 'fixture-ws', 'fixture-transcript', 'RECONCILED')",
  );
  const turn = db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version) VALUES (?, ?, 'fixture-ws', ?, 'fixture-model', 'fixture-parser')",
  );
  for (const id of ["fixture-a", "fixture-b"]) {
    session.run(id);
    turn.run(`${id}-turn`, id, "2025-01-01T00:00:00.000Z");
    for (let index = 0; index < (id === "fixture-a" ? 12 : 1); index++) {
      const envelope = createFindingEnvelopeV2(
        {
          version: 2,
          rule_id: c1FindingDescriptor.rule_id,
          label: "TOOL_ERROR_RATE_OUTLIER",
          assessment: c1FindingDescriptor.defaults.assessment,
          routing: c1FindingDescriptor.defaults.routing,
          window: { from: "2024-12-31T00:00:00.000Z", to: "2025-01-02T00:00:00.000Z" },
          anchors: [
            {
              session_id: findingIds.session(id),
              message_id: findingIds.message(`${id}-turn`),
              timestamp: "2025-01-01T00:00:00.000Z",
            },
          ],
          impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
          verdict: { value: "SUPPORTED", method: "RULE" },
          metrics: {
            TOOL_CALL_COUNT: { kind: "COUNT", value: 10 },
            TOOL_ERROR_COUNT: { kind: "COUNT", value: 2 },
            TOOL_ERROR_RATE: { kind: "RATIO", value: 0.2 },
            CORPUS_CALL_COUNT: { kind: "COUNT", value: 20 },
            CORPUS_ERROR_COUNT: { kind: "COUNT", value: 2 },
            CORPUS_ERROR_RATE: { kind: "RATIO", value: 0.1 },
            RATE_MULTIPLE: { kind: "NUMBER", value: 2 },
          },
        },
        c1FindingDescriptor,
      );
      db.prepare(`INSERT INTO recommendations
      (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
       modeled_formula_json, evidence_json, target_metric, state, created_at,
       contract_version, contract_status, rule_id)
      VALUES (?, 'RULE', 'C1', ?, 'fixture-ws', ?, '{}', ?, ?, 'PROPOSED',
       '2025-01-01T00:00:00.000Z', 2, 'V2_VALIDATED', ?)`).run(
        `fixture-rec-${id}-${index}`,
        c1FindingDescriptor.presentation.category,
        c1FindingDescriptor.presentation.lever,
        JSON.stringify(envelope),
        c1FindingDescriptor.presentation.target_metric,
        c1FindingDescriptor.rule_id,
      );
    }
  }
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

describe("session diagnostics routes", () => {
  it.each(["diagnostics", "breakdown"])("rejects malformed %s ids", async (route) => {
    for (const id of ["", "bad%20id", "bad%2Fid", "%ZZ"]) {
      const response = await request(port, `/api/sessions/${id}/${route}`);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: "INVALID_QUERY" });
    }
  });

  it("returns empty diagnostics and null breakdown for an unknown session", async () => {
    const diagnostics = await request(port, "/api/sessions/fixture-missing/diagnostics");
    const breakdown = await request(port, "/api/sessions/fixture-missing/breakdown");
    expect(diagnostics.status).toBe(200);
    expect(diagnostics.body).toMatchObject({ data: [] });
    expect(breakdown.status).toBe(200);
    expect(breakdown.body).toMatchObject({ data: null });
  });

  it("returns only the requested session's old anchor with category and turn", async () => {
    const response = await request(port, "/api/sessions/fixture-a/diagnostics");
    expect(response.status).toBe(200);
    const data = (response.body as { data: Array<Record<string, unknown>> }).data;
    expect(data).toHaveLength(12);
    expect(
      data.every(
        (anchor) =>
          anchor.session_id === "fixture-a" &&
          anchor.message_id === "fixture-a-turn" &&
          anchor.turn_index === 0 &&
          anchor.category === "errors" &&
          anchor.label === "TOOL_ERROR_RATE_OUTLIER",
      ),
    ).toBe(true);
  });
});
