/**
 * DH4 seeded faults (spec-detector-health.md §3 DH4): a detector mutant, a probe that can't fire and an oracle
 * UNPROVEN must each render red. The "live" DB is C2's positive fixture after one history walk.
 */

import { describe, expect, it } from "vitest";
import { buildRows, renderReport } from "../../scripts/detector-health/health-report.js";
import { runHistoryWalk } from "../../src/detector/engine.js";
import { DETECTORS } from "../../src/detector/registry.js";
import type { AnyDetector } from "../../src/detector/types.js";
import { withCaseDb } from "./harness.js";
import { loadManifests } from "./manifest.js";
import { PROBES } from "./probes/index.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");

const c2 = DETECTORS.find((d) => d.id === "C2") as AnyDetector;
const mutant: AnyDetector = {
  ...c2,
  evaluate: () => ({ fired: [], status: "INACTIVE", note: "mutant never fires" }),
};

describe("DH4 health report: seeded faults", () => {
  it("renders the mutant, the dead probe and the UNPROVEN oracle red; the control is not", async () => {
    const live = loadManifests().find((c) => c.id === "C2");
    if (!live) throw new Error("C2 manifest missing");
    const rows = await withCaseDb(live.positive, NOW, async (db) => {
      await runHistoryWalk(db, NOW);
      return buildRows(db, NOW, {
        ids: ["C2", "C3", "C5", "C11"],
        detectors: DETECTORS.map((d) => (d.id === "C2" ? mutant : d)),
        probes: {
          ...PROBES,
          C3: () => ({ candidates: 0, qualifying: 0, gates: [], note: "dead" }),
        },
        oracles: { C5: "UNPROVEN", C11: "PASS" },
      });
    });
    const row = (id: string) => rows.find((r) => r.id === id);

    expect(row("C2")?.fixtureFires.level).toBe("red");
    expect(row("C2")?.overall).toBe("red");
    expect(row("C3")?.probe.level).toBe("red");
    expect(row("C3")?.probe.text).toContain("can't fire");
    expect(row("C3")?.overall).toBe("red");
    expect(row("C5")?.oracle.level).toBe("red");
    expect(row("C5")?.overall).toBe("red");

    const control = row("C11");
    expect(control?.fixtureFires.level).toBe("green");
    expect(control?.nearMissSilent.level).toBe("green");
    expect(control?.probe.text).toMatch(/^fixture q=\d+/);
    expect(control?.oracle.level).toBe("green");

    const md = renderReport(rows, NOW, [NOW]);
    expect(md.match(/^\| (C2|C3|C5) \| RED \|/gm)).toHaveLength(3);
  }, 120_000);
});
