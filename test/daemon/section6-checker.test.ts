/** Independent Section 6 checker against the shared detector seed. */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_REQUIRED_DETECTOR_IDS,
  GOLDEN_DETECTOR_IDS,
  runSection6Checker,
} from "../../scripts/section6-checker.mjs";
import { openDb } from "../../src/db/open.js";

let scratchRoot: string;

function containsOnlyResults(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(containsOnlyResults);
}

beforeEach(() => {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-section6-checker-"));
});

afterEach(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

describe("section6-checker", () => {
  it("evaluates every golden detector and emits only boolean/numeric report values", () => {
    const dbPath = path.join(scratchRoot, "shared-seed.sqlite");
    childProcess.execFileSync(
      process.execPath,
      ["--import", "tsx/esm", "scripts/build-shared-seed.ts", dbPath],
      { cwd: path.resolve(import.meta.dirname, "../.."), stdio: "pipe" },
    );

    const db = openDb(dbPath);
    try {
      const report = runSection6Checker(db);

      for (const detectorId of GOLDEN_DETECTOR_IDS) {
        const result = report[detectorId];
        expect(result, `checker omitted ${detectorId}`).toBeDefined();
        expect(
          result.recommendation_count,
          `detector ${detectorId} produced no recommendation`,
        ).toBe(1);
        for (const rule of ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "SEC101"]) {
          expect(result[rule]).toBeTypeOf("boolean");
        }
        expect(result.R1, `${detectorId} needs its stable live rec id and title`).toBe(true);
        expect(result.R3, `${detectorId} needs a live category`).toBe(true);
        expect(result.artifact_count).toBeTypeOf("number");
        expect(result.metric_count).toBeTypeOf("number");
        expect(result.window_count).toBeTypeOf("number");
        expect(containsOnlyResults(result)).toBe(true);
      }
      for (const detectorId of ARTIFACT_REQUIRED_DETECTOR_IDS) {
        expect(report[detectorId].R4, `${detectorId} needs its generated artifact`).toBe(true);
      }

      // Independent signal: the checker must actually DISCRIMINATE, not just run.
      // A tautological key-coverage assertion (guaranteed by the checker's own
      // loop) proves nothing; these require real rule evaluation to hold. R7/R2/R6
      // are deliberately NOT asserted green for EVERY detector — A0's job is to
      // surface the reds (e.g. C9/D7 render prompt-only, so R7 is honestly false),
      // which Track A then fixes. Over-asserting all-green would fabricate the very
      // green the plan says the checker must expose as a gap.
      const passes = (rule: string) =>
        GOLDEN_DETECTOR_IDS.filter((detectorId) => report[detectorId][rule] === true).length;
      expect(passes("R2"), "no golden detector carried a metric+window pair (R2)").toBeGreaterThan(
        0,
      );
      expect(
        passes("R6"),
        "no golden detector carried a named before/after pair (R6)",
      ).toBeGreaterThan(0);
      expect(passes("R7"), "no golden detector carried rollback guidance (R7)").toBeGreaterThan(0);

      // Regression anchors on lanes whose live artifact is known to carry each
      // field — a real signal that would break if the snippet layer regressed.
      expect(report.B1.R6, "B1 cache lane lost its before/after pair").toBe(true);
      expect(report.B1.R7, "B1 cache snippet lost its rollback line").toBe(true);
      expect(report.C9.R7, "C9 friction snippet lost its rollback line").toBe(true);
      expect(report.D7.R7, "D7 loop-retry snippet lost its rollback line").toBe(true);
      expect(report.H1.R7, "H1 destructive-guard snippet lost its rollback line").toBe(true);

      // P6b: D7/D8 carry a metric map + window in the rendered evidence (R2). These
      // are the anti-oracle-collapse anchors — without them "green" would not fail
      // on the D7/D8 R2 reds A0 surfaced.
      expect(report.D7.R2, "D7 lost its metric+window evidence pair").toBe(true);
      expect(report.D8.R2, "D8 lost its metric+window evidence pair").toBe(true);

      // SEC-101 holds at the distribution boundary for every rendered artifact.
      for (const detectorId of GOLDEN_DETECTOR_IDS) {
        expect(report[detectorId].SEC101, `${detectorId} leaked prohibited artifact content`).toBe(
          true,
        );
      }
    } finally {
      db.close();
    }
  });
});
