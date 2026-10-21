/**
 * test/query/recommendations-perf-spans.test.ts — P0-U2b (M13) span coverage.
 *
 * recommendationsStateKey() and expireRecommendationDismissals() are wrapped
 * in perf-monitor spans. Oracle: the call count this test makes (1 each),
 * checked against the recorded span count on /api/perf — independent of the
 * span's own duration value.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getPerfSnapshot, resetSpans } from "../../src/daemon/perf-monitor.js";
import {
  expireRecommendationDismissals,
  recommendationsStateKey,
} from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
  resetSpans();
});

afterEach(() => {
  resetQueryDb();
  resetSpans();
  db.close();
});

it("records a recommendationsStateKey span on each call", () => {
  recommendationsStateKey();
  recommendationsStateKey();
  const span = getPerfSnapshot().spans?.recommendationsStateKey;
  expect(span?.count).toBe(2);
  expect(span?.lastMs).toBeGreaterThanOrEqual(0);
});

it("records an expireRecommendationDismissals span on each call", () => {
  expireRecommendationDismissals(new Date());
  const span = getPerfSnapshot().spans?.expireRecommendationDismissals;
  expect(span?.count).toBe(1);
  expect(span?.lastMs).toBeGreaterThanOrEqual(0);
});
