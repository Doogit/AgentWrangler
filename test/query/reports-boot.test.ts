/**
 * test/query/reports-boot.test.ts — P0-U4 boot-path unit tests for
 * `generateWeeklyReport` (src/query/api/reports.ts).
 *
 * 1. When the report for the week already exists, the function must return
 *    immediately, before touching the recommendations builder at all. The
 *    independent oracle is `__recommendationsBuildCount()`
 *    (recommendations.ts:1317), which recommendations.ts increments on every
 *    completed `buildRecommendations()` call — never called or reasoned about
 *    by this test file itself.
 * 2. The new (recs-first) implementation must produce a byte-identical
 *    `content_json` to the OLD (pre-P0-U4) implementation, for a fixed clock
 *    and identically-seeded DB, when the given recs snapshot equals
 *    `listRecommendations()`'s own view. The oracle is a verbatim copy of the
 *    pre-change function kept below, run on its own DB instance — not the new
 *    function's own output.
 */

import { describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { getSuccessRate } from "../../src/query/api/outcomes.js";
import { getGlobalOverview } from "../../src/query/api/overview.js";
import {
  __recommendationsBuildCount,
  listRecommendations,
} from "../../src/query/api/recommendations.js";
import type { Report } from "../../src/query/api/reports.js";
import { generateWeeklyReport, isoWeekBounds } from "../../src/query/api/reports.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { seedValidatedRecommendation } from "../fixtures/recommendations.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2026-01-04T12:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function seedRecommendations(db: Db): void {
  for (let i = 1; i <= 6; i += 1) {
    seedValidatedRecommendation(db, {
      recId: `rec-boot-${i}`,
      scope: null,
      savings: i * 100,
      createdAt: `2026-01-0${i}T00:00:00.000Z`,
      facts: { scope: "global" },
    });
  }
}

/**
 * Verbatim copy of `generateWeeklyReport` as it stood BEFORE P0-U4 (always
 * calls `listRecommendations()`, no early-return guard). Kept here as the
 * byte-identical oracle for test 2, so the new implementation is graded
 * against the OLD behavior rather than against its own output.
 */
function generateWeeklyReportOld(db: Db, now: Date = new Date()): Report {
  setQueryDb(db);

  const { period_start, period_end } = isoWeekBounds(new Date(now.getTime() - 7 * MS_PER_DAY));
  const spendResponse = getGlobalOverview({ from: period_start, to: period_end });
  const recommendationsResponse = listRecommendations();
  const outcomesResponse = getSuccessRate();

  const spend = spendResponse.data;
  const recommendations = recommendationsResponse.data;
  const outcomes = outcomesResponse.data;

  const openRecommendations = [
    ...(recommendations?.active ?? []),
    ...(recommendations?.limit_warnings ?? []),
  ]
    .sort((a, b) => {
      const aSavings = a.modeled_savings_u_per_wk ?? Number.NEGATIVE_INFINITY;
      const bSavings = b.modeled_savings_u_per_wk ?? Number.NEGATIVE_INFINITY;
      if (aSavings !== bSavings) return bSavings - aSavings;
      return a.rec_id.localeCompare(b.rec_id);
    })
    .slice(0, 5)
    .map((rec) => ({
      rec_id: rec.rec_id,
      modeled_savings_u_per_wk: rec.modeled_savings_u_per_wk,
    }));

  const content = {
    spend: {
      cost_equiv_u: spend?.cost_equiv_u ?? 0,
      turns: spend?.turns ?? 0,
      turns_total: spend?.turns_total ?? 0,
      unpriced_turns: spend?.unpriced_turns ?? 0,
    },
    top_recommendations: openRecommendations,
    outcomes: {
      terminal_n: outcomes?.terminal_n ?? 0,
      success_rate: outcomes?.success_rate ?? null,
      clean_success_n: outcomes?.clean_success_n ?? 0,
      with_deferrals_n: outcomes?.with_deferrals_n ?? 0,
      no_ci_success_n: outcomes?.no_ci_success_n ?? 0,
      linkage_rate: outcomes?.linkage_rate ?? null,
    },
  };

  const reportId = `weekly-${period_start}`;
  db.prepare(
    `INSERT OR IGNORE INTO reports
       (report_id, kind, period_start, period_end, generated_at, content_json)
     VALUES (?, 'weekly', ?, ?, ?, ?)`,
  ).run(reportId, period_start, period_end, now.toISOString(), JSON.stringify(content));

  const report = db.prepare("SELECT * FROM reports WHERE report_id = ?").get(reportId) as
    | Report
    | undefined;
  if (report === undefined) throw new Error(`weekly report ${reportId} was not stored`);
  return report;
}

describe("generateWeeklyReport — P0-U4 early return", () => {
  it("does not touch the recommendations builder once the report is already stored", () => {
    const db = createInMemoryFixtureDb();
    setQueryDb(db);
    try {
      seedRecommendations(db);
      const recs = listRecommendations().data;
      if (recs === null) throw new Error("expected a non-null recommendations view");

      generateWeeklyReport(db, NOW, recs); // first call: stores the row
      const before = __recommendationsBuildCount();

      // Change the recommendations table so listRecommendations()'s own
      // state-key cache (recommendations.ts recStateKey) CANNOT explain a
      // flat build count below — only the early-return guard can. Without
      // it, this insert would force a real rebuild on the next call.
      seedValidatedRecommendation(db, {
        recId: "rec-boot-extra",
        scope: null,
        savings: 999,
        createdAt: "2026-01-06T00:00:00.000Z",
        facts: { scope: "global" },
      });

      generateWeeklyReport(db, NOW, recs); // second call: report already stored
      expect(__recommendationsBuildCount()).toBe(before);

      // Also true with no `recs` argument at all — the early-return guard
      // must run BEFORE the `recs ?? listRecommendations()` fallback, so an
      // omitted `recs` never reaches the builder once the report exists.
      generateWeeklyReport(db, NOW);
      expect(__recommendationsBuildCount()).toBe(before);
    } finally {
      resetQueryDb();
      db.close();
    }
  });
});

describe("generateWeeklyReport — P0-U4 byte-identical oracle", () => {
  it("produces content_json byte-identical to the pre-P0-U4 implementation", () => {
    const oldDb = createInMemoryFixtureDb();
    const newDb = createInMemoryFixtureDb();
    try {
      seedRecommendations(oldDb);
      seedRecommendations(newDb);

      setQueryDb(oldDb);
      const oldReport = generateWeeklyReportOld(oldDb, NOW);

      // The oracle's stated precondition: the snapshot passed to the new
      // function equals `listRecommendations()`'s own view on an identically
      // seeded, still-empty (no stored report yet) DB.
      setQueryDb(newDb);
      const recs = listRecommendations().data;
      if (recs === null) throw new Error("expected a non-null recommendations view");
      const newReport = generateWeeklyReport(newDb, NOW, recs);

      expect(newReport.content_json).toBe(oldReport.content_json);
    } finally {
      resetQueryDb();
      oldDb.close();
      newDb.close();
    }
  });
});
