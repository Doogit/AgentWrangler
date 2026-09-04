/**
 * test/query/reports.test.ts — deterministic weekly report artifacts.
 */

import * as http from "node:http";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { runMigrations } from "../../src/db/migrate.js";
import { generateWeeklyReport, getReport, listReports } from "../../src/query/api/reports.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2026-01-04T12:00:00.000Z");

let db: Database.Database;

function createEmptyDb(): Database.Database {
  const empty = new Database(":memory:");
  empty.pragma("foreign_keys = ON");
  runMigrations(empty);
  return empty;
}

function seedRecommendations(): void {
  const insert = db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, analysis_run_id, category, scope_workspace_id,
        lever, modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
        state, created_at, adopted_at, dismissed_until)
     VALUES (?, 'RULE', ?, NULL, 'CONTEXT', NULL, ?, ?, '{}', '{}', 'context_tokens',
             'PROPOSED', ?, NULL, NULL)`,
  );

  for (let i = 1; i <= 6; i += 1) {
    insert.run(`rec-report-${i}`, "D1", `Lever ${i}`, i * 100, `2026-01-0${i}T00:00:00.000Z`);
  }
}

interface TestResponse {
  status: number;
  body: string;
}

function request(port: number, path: string): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

describe("generateWeeklyReport", () => {
  it("returns spend, top recommendations, and outcomes aggregates only", () => {
    seedRecommendations();

    const report = generateWeeklyReport(db, NOW);
    const content = JSON.parse(report.content_json) as {
      spend: Record<string, unknown>;
      top_recommendations: Array<Record<string, unknown>>;
      outcomes: Record<string, unknown>;
    };

    expect(report.kind).toBe("weekly");
    expect(report.period_start).toBe("2025-12-22T00:00:00.000Z");
    expect(report.period_end).toBe("2025-12-29T00:00:00.000Z");
    expect(content.spend).toEqual({
      cost_equiv_u: 0,
      turns: 0,
      turns_total: 0,
      unpriced_turns: 0,
    });
    expect(content.top_recommendations).toEqual([
      { rec_id: "rec-report-6", modeled_savings_u_per_wk: 600 },
      { rec_id: "rec-report-5", modeled_savings_u_per_wk: 500 },
      { rec_id: "rec-report-4", modeled_savings_u_per_wk: 400 },
      { rec_id: "rec-report-3", modeled_savings_u_per_wk: 300 },
      { rec_id: "rec-report-2", modeled_savings_u_per_wk: 200 },
    ]);
    expect(Object.keys(content).sort()).toEqual(["outcomes", "spend", "top_recommendations"]);
    expect(Object.keys(content.outcomes).sort()).toEqual([
      "clean_success_n",
      "linkage_rate",
      "no_ci_success_n",
      "success_rate",
      "terminal_n",
      "with_deferrals_n",
    ]);
    expect(JSON.stringify(content)).not.toContain("evidence_json");
    expect(JSON.stringify(content)).not.toContain("modeled_formula_json");
  });

  it("uses the ISO week boundary as [period_start, period_end)", () => {
    const sunday = generateWeeklyReport(db, new Date("2026-08-23T23:59:59.999Z"));
    expect(sunday.period_start).toBe("2026-08-10T00:00:00.000Z");
    expect(sunday.period_end).toBe("2026-08-17T00:00:00.000Z");

    const monday = generateWeeklyReport(db, new Date("2026-08-24T00:00:00.000Z"));
    expect(monday.period_start).toBe("2026-08-17T00:00:00.000Z");
    expect(monday.period_end).toBe("2026-08-24T00:00:00.000Z");
  });

  it("is idempotent for the same ISO week", () => {
    const first = generateWeeklyReport(db, NOW);
    const second = generateWeeklyReport(db, new Date("2026-01-04T13:00:00.000Z"));

    expect(listReports(db)).toHaveLength(1);
    expect(second).toEqual(first);
    expect(getReport(db, first.report_id)).toEqual(first);
  });

  it("produces a valid empty digest", () => {
    db.close();
    db = createEmptyDb();
    setQueryDb(db);

    const report = generateWeeklyReport(db, NOW);
    expect(JSON.parse(report.content_json)).toEqual({
      spend: { cost_equiv_u: 0, turns: 0, turns_total: 0, unpriced_turns: 0 },
      top_recommendations: [],
      outcomes: {
        terminal_n: 0,
        success_rate: null,
        clean_success_n: 0,
        with_deferrals_n: 0,
        no_ci_success_n: 0,
        linkage_rate: null,
      },
    });
  });
});

describe("GET /api/reports", () => {
  it("returns 200", async () => {
    generateWeeklyReport(db, NOW);
    const server = createServer(db, 0, null);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("server not listening");
      const response = await request(address.port, "/api/reports");
      expect(response.status).toBe(200);
      const reports = JSON.parse(response.body) as Array<{ report_id: string }>;
      expect(reports).toHaveLength(1);

      const detail = await request(address.port, `/api/reports/${reports[0]?.report_id}`);
      expect(detail.status).toBe(200);
      expect(JSON.parse(detail.body)).toMatchObject({ report_id: reports[0]?.report_id });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
