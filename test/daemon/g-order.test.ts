/**
 * G-Order — independent ranking-order gate against the shared detector seed.
 *
 * Builds the same shared seed section6-checker uses, produces the live
 * RecommendationsView, and asserts the B5 ranking contract via the independent
 * checkRankingOrder oracle (scripts/parity/golden-order.mjs). Fails RED until the
 * B5 spine sorts `active` by absolute $/wk DESC, pins H1, and demotes null-$/wk
 * recs to the friction lane.
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRankingOrder } from "../../scripts/parity/golden-order.mjs";
import { openDb } from "../../src/db/open.js";
import { listRecommendations } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";

let scratchRoot: string;

beforeEach(() => {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-g-order-"));
});

afterEach(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

describe("g-order", () => {
  it("detects a mixed-basis rank inversion without passing trivially", () => {
    const report = checkRankingOrder({
      active: [
        {
          modeled_savings_u_per_wk: 25,
          modeled_formula: { estimate: { basis: "R", rank_value_u_per_wk: 25 } },
        },
        {
          modeled_savings_u_per_wk: 100,
          modeled_formula: { estimate: { basis: "P", rank_value_u_per_wk: 100 } },
        },
      ],
    });

    expect(report.ranked_count, "fixture needs two rows to exercise ordering").toBe(2);
    expect(report.inversion_count, "R must share the rank-value scale with P").toBeGreaterThan(0);
    expect(report.ordered).toBe(false);
  });

  it("accepts correctly ordered mixed P/E/O/R rows with X rows last", () => {
    const report = checkRankingOrder({
      active: [
        {
          modeled_savings_u_per_wk: 100,
          modeled_formula: { estimate: { basis: "P", rank_value_u_per_wk: 100 } },
        },
        {
          modeled_savings_u_per_wk: 80,
          modeled_formula: { estimate: { basis: "E", rank_value_u_per_wk: 80 } },
        },
        {
          modeled_savings_u_per_wk: 60,
          modeled_formula: { estimate: { basis: "O", rank_value_u_per_wk: 60 } },
        },
        {
          modeled_savings_u_per_wk: 40,
          modeled_formula: { estimate: { basis: "R", rank_value_u_per_wk: 40 } },
        },
        {
          modeled_savings_u_per_wk: null,
          modeled_formula: { estimate: { basis: "X", rank_value_u_per_wk: null } },
        },
      ],
    });

    expect(report.inversion_count).toBe(0);
    expect(report.ordered).toBe(true);
  });

  it("detects an X-basis row placed above a rankable row", () => {
    const report = checkRankingOrder({
      active: [
        {
          modeled_savings_u_per_wk: null,
          modeled_formula: { estimate: { basis: "X", rank_value_u_per_wk: null } },
        },
        {
          modeled_savings_u_per_wk: 1,
          modeled_formula: { estimate: { basis: "P", rank_value_u_per_wk: 1 } },
        },
      ],
    });

    expect(report.inversion_count).toBeGreaterThan(0);
    expect(report.ordered).toBe(false);
  });

  it("ranks all proposed bases in active, including H1", () => {
    const dbPath = path.join(scratchRoot, "shared-seed.sqlite");
    childProcess.execFileSync(
      process.execPath,
      ["--import", "tsx/esm", "scripts/build-shared-seed.ts", dbPath],
      { cwd: path.resolve(import.meta.dirname, "../.."), stdio: "pipe" },
    );

    const db = openDb(dbPath);
    setQueryDb(db);
    try {
      const view = listRecommendations().data;
      if (view === null) throw new Error("null recommendations view");
      const report = checkRankingOrder(view);

      // The report is numeric/boolean only (SEC-101 safe).
      for (const value of Object.values(report)) {
        expect(typeof value === "number" || typeof value === "boolean").toBe(true);
      }

      // Ranked list carries real economic recs and is globally $/wk-ordered.
      // Require >=2 so the adjacent-inversion check is not vacuously satisfied by
      // a single-element list (the loop never runs when ranked_count < 2).
      expect(
        report.ranked_count,
        "ranked list needs >=2 entries to test ordering",
      ).toBeGreaterThanOrEqual(2);
      // P3.L-F: the real list is ordered by the $ each card shows (asserted below), not by the
      // detector rank_value that `checkRankingOrder().inversion_count` measures.
      // The legacy oracle still reports H1 in active as a violation of its old pin.
      expect(report.h1_in_ranked_count, "H1 must share the ranked list").toBeGreaterThan(0);
      expect(view.active.some((card) => card.detector_id === "H1")).toBe(true);
      expect(report.pinned_count).toBe(0);
      expect(report.pinned_non_h1_count, "a non-H1 rec leaked into the pinned slot").toBe(0);
      expect(report.friction_count).toBe(0);
      expect(report.friction_non_null_count, "a priced rec leaked into the friction lane").toBe(0);
      expect(report.friction_h1_count).toBe(0);
      // P3.L-F rule 2 (amended 2026-10-13): cards with a shown $ (descending), then the rest;
      // certification does not rank.
      const shown = (card: (typeof view.active)[number]): number => {
        const value =
          card.allocated_u_per_wk === null
            ? typeof card.reliability_u_per_wk === "number"
              ? card.reliability_u_per_wk
              : (card.modeled_savings_u_per_wk ?? 0) > 0 && card.estimate?.summable === false
                ? card.modeled_savings_u_per_wk // standalone lane (E1/E2)
                : null
            : (card.allocated_u_per_wk ?? card.modeled_savings_u_per_wk);
        return value ?? -Number.MAX_VALUE;
      };
      const shownOrder = view.active.map(shown);
      expect(shownOrder).toEqual([...shownOrder].sort((a, b) => b - a));
    } finally {
      resetQueryDb();
      db.close();
    }
  }, 30_000);
});
