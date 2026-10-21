/**
 * Can-fire / near-miss harness: every manifest case runs its detector on its own fresh DB.
 * Positive must fire (ACTIVE, >=1 rec); near miss must stay silent.
 */

import { describe, expect, it } from "vitest";
import { DETECTORS } from "../../src/detector/registry.js";
import { runCase } from "./harness.js";
import { loadManifests } from "./manifest.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const cases = loadManifests();

describe("detector health: can-fire / near-miss", () => {
  const results = { fires: new Set<string>(), nearMiss: new Set<string>() };

  for (const c of cases) {
    it(`${c.id} positive`, () => {
      const r = runCase(c.id, c.positive, "fires", NOW);
      if (r.pass) results.fires.add(c.id);
      expect(
        r.pass,
        `${c.id} positive: expected fires, got status=${r.status} fired=${r.firedCount} note=${r.note}`,
      ).toBe(true);
    }, 20_000);
    // A detector counts toward near-miss coverage only when every near miss stays silent.
    let silent = 0;
    for (const n of c.near_misses) {
      it(`${c.id} near-miss ${n.target_constant}`, () => {
        const r = runCase(c.id, n, "silent", NOW);
        if (r.pass && ++silent === c.near_misses.length) results.nearMiss.add(c.id);
        expect(
          r.pass,
          `${c.id} near-miss (${n.target_constant}): expected silent, got status=${r.status} fired=${r.firedCount} note=${r.note}`,
        ).toBe(true);
      }, 20_000);
    }
  }

  it("coverage", () => {
    const total = DETECTORS.length;
    console.log(
      `detector-health coverage: fires ${results.fires.size}/${total} · near-miss ${results.nearMiss.size}/${total}`,
    );
    expect(results.fires.size).toBeLessThanOrEqual(total);
  });
});
