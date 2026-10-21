/**
 * DH1c pipeline trace: every positive fixture runs through the daemon's detector pass and
 * read paths. `DH_TRACE_OUT=<file>` writes the per-detector trace as JSON.
 */

import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { withCaseDb } from "./harness.js";
import { loadManifests } from "./manifest.js";
import { type PipelineTrace, tracePipeline } from "./pipeline.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const cases = loadManifests();

/** Known drops (DH1c report 2026-10-13). A fix must remove its entry; a new drop fails. */
const KNOWN_DROPS: Record<string, string> = {
  C9: "not visible", // no-$ safety card lands only in below_floor
};

/**
 * Money sanity flags per detector on its positive fixture (DH1c report 2026-10-13). $0 alone is
 * not a failure; any change to a detector's flags turns RED so it is looked at.
 */
const KNOWN_MONEY_FLAGS: Record<string, string[]> = {
  // F8: the positives sit 1 byte past the threshold, so 0 avoidable tokens and $0 is correct.
  A1: ["$0 on a fired finding"],
  A2: ["$0 on a fired finding"],
  // F6: by design, the C5 card is a count with an advisory CEU floor and makes no $/wk claim.
  C5: ["no figure computed"],
  // F5: modeled $ needs a calibrated bytes/token ratio; the fixture has none, so only the rank range.
  D12: ["figure computed but card shows Not estimated"],
  // F7: both interrupt cards share one recovery turn, which has one owner; the other card is $0.
  D14: ["$0 upper bound on a fired finding"],
  // F5: the positive sits exactly at p90 (180,000), so 0 excess tokens and no figure (as F8).
  G11: ["no figure computed"],
};

/** Diagnostics causes a positive reaches that still read "Not estimated" (F9). */
const KNOWN_UNPRICED_CAUSES: Record<string, string[]> = {
  // The fixture has no calibrated bytes/token ratio, so no modeled figure (see D12 above).
  D12: ["SUBAGENTS_COST_MORE_THAN_RETURN"],
};

describe("detector health: pipeline trace (DH1c)", () => {
  const traces: PipelineTrace[] = [];

  for (const c of cases) {
    it(`${c.id} positive reaches Recs or Diagnostics`, async () => {
      const t = await withCaseDb(c.positive, NOW, (db) => tracePipeline(db, c.id, NOW));
      traces.push(t);
      expect(t.drop, `${c.id}: ${JSON.stringify(t)}`).toBe(KNOWN_DROPS[c.id] ?? null);
      expect(t.sanity, `${c.id} money: ${JSON.stringify(t.money)}`).toEqual(
        KNOWN_MONEY_FLAGS[c.id] ?? [],
      );
      // F9: a cause the positive reaches shows $ unless listed here.
      expect(
        t.diag_causes.filter((cause) => !t.diag_priced.includes(cause)),
        `${c.id} unpriced Diagnostics causes`,
      ).toEqual(KNOWN_UNPRICED_CAUSES[c.id] ?? []);
    }, 60_000);
  }

  it("seeded faults show as drops", async () => {
    const d1 = cases.find((c) => c.id === "D1");
    if (!d1) throw new Error("D1 manifest missing");
    const deleted = await withCaseDb(d1.positive, NOW, (db) =>
      tracePipeline(db, "D1", NOW, (d) => {
        d.prepare("DELETE FROM recommendations WHERE detector_id = 'D1'").run();
      }),
    );
    expect(deleted.drop).toBe("no rec row");
    const zeroed = await withCaseDb(d1.positive, NOW, (db) =>
      tracePipeline(db, "D1", NOW, (d) => {
        d.prepare(
          "UPDATE recommendations SET modeled_savings_u_per_wk = 0 WHERE detector_id = 'D1'",
        ).run();
      }),
    );
    expect(zeroed.sanity.length, JSON.stringify(zeroed.money)).toBeGreaterThan(0);
    const nearMiss = d1.near_misses[0];
    if (!nearMiss) throw new Error("D1 near miss missing");
    const silent = await withCaseDb(nearMiss, NOW, (db) => tracePipeline(db, "D1", NOW));
    expect(silent.drop).toMatch(/^detector pass: /);
  }, 60_000);

  afterAll(() => {
    const out = process.env.DH_TRACE_OUT;
    if (out) fs.writeFileSync(out, JSON.stringify(traces, null, 2));
  });
});
