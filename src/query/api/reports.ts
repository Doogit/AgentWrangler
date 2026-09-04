/**
 * src/query/api/reports.ts — deterministic weekly report artifacts.
 *
 * Reports are bounded snapshots assembled from existing aggregate query APIs.
 * They never include transcript content or raw event data and are safe to run
 * unattended because they do not invoke an LLM or an external CLI.
 */

import type { Db } from "../../db/open.js";
import { setQueryDb } from "../db-context.js";
import { getSuccessRate } from "./outcomes.js";
import { getGlobalOverview } from "./overview.js";
import { listRecommendations } from "./recommendations.js";

export interface Report {
  report_id: string;
  kind: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  content_json: string;
}

interface WeeklyReportContent {
  spend: {
    cost_equiv_u: number;
    turns: number;
    turns_total: number;
    unpriced_turns: number;
  };
  top_recommendations: Array<{
    rec_id: string;
    modeled_savings_u_per_wk: number | null;
  }>;
  outcomes: {
    terminal_n: number;
    success_rate: number | null;
    clean_success_n: number;
    with_deferrals_n: number;
    no_ci_success_n: number;
    linkage_rate: number | null;
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function isoWeekBounds(now: Date): { period_start: string; period_end: string } {
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday),
  );
  return {
    period_start: start.toISOString(),
    period_end: new Date(start.getTime() + 7 * MS_PER_DAY).toISOString(),
  };
}

/** Generate or return the idempotent weekly report for the ISO week containing `now`. */
export function generateWeeklyReport(db: Db, now: Date = new Date()): Report {
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

  const content: WeeklyReportContent = {
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

export function listReports(db: Db): Report[] {
  return db.prepare("SELECT * FROM reports ORDER BY generated_at DESC").all() as Report[];
}

export function getReport(db: Db, id: string): Report | undefined {
  return db.prepare("SELECT * FROM reports WHERE report_id = ?").get(id) as Report | undefined;
}
