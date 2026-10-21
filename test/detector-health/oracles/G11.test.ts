import path from "node:path";
import { describe, expect, it } from "vitest";
import { withCaseDb } from "../harness.js";
import { oracleG11 } from "./G11.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const ROOT = path.resolve(__dirname, "../../fixtures/detector-health/G11");
const run = (c: string) =>
  withCaseDb(
    { fixtureDir: path.join(ROOT, c), rowsFile: path.join(ROOT, `rows-${c}.json`) },
    NOW,
    (db) => oracleG11(db, NOW),
  );

describe("oracleG11 on the DH1 fixtures", () => {
  it("positive: one finding at exactly p90 (>=), tokens 180000 of a 20-item baseline", () => {
    const r = run("positive");
    expect(r.findings).toHaveLength(1);
    const q = Object.fromEntries((r.findings[0]?.quantities ?? []).map((x) => [x.name, x.value]));
    expect(q.item_tokens).toBe(180_000);
    expect(q.p90_tokens).toBe(180_000);
    expect(q.baseline_n).toBe(20);
    expect(r.findings[0]?.modeled_u).toBe(0); // excess over p90 is 0
  });
  for (const c of ["near-miss-count", "near-miss-window", "near-miss-p90", "near-miss-share"]) {
    it(`${c}: silent`, () => {
      expect(run(c).findings).toHaveLength(0);
    });
  }
});
