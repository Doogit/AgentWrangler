/**
 * DH2: every registered silence probe reads > 0 on its detector's DH1 positive fixture.
 */

import { describe, expect, it } from "vitest";
import { withCaseDb } from "./harness.js";
import { loadManifests } from "./manifest.js";
import { PROBES } from "./probes/index.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const cases = new Map(loadManifests().map((c) => [c.id, c]));

describe("detector health: silence probes (DH2)", () => {
  for (const [id, probe] of Object.entries(PROBES)) {
    it(`${id} probe reads > 0 on its positive fixture`, () => {
      const c = cases.get(id);
      if (!c) throw new Error(`no DH1 manifest for ${id}`);
      const r = withCaseDb(c.positive, NOW, (db) => probe(db, NOW));
      expect(r.candidates, JSON.stringify(r)).toBeGreaterThan(0);
      expect(r.qualifying, JSON.stringify(r)).toBeGreaterThan(0);
    }, 60_000);
  }

  it("prints probe coverage", () => {
    console.log(`DH2 probes ${Object.keys(PROBES).length}/${cases.size}`);
  });
});
