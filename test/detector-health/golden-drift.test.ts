/**
 * Drift guard: every detector id named in a golden-set `expect_fires` must have a manifest positive.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadManifests } from "./manifest.js";

// TODO(DH1a T3): the golden positives land with the T3 fixtures; T4 flips this to true.
const DH1A_FIXTURES_LANDED = true;

const GOLDEN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/parity/golden-set.json",
);

describe("detector health: golden drift", () => {
  it("every golden expect_fires id has a manifest positive", () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8")) as {
      sessions: Array<{ expect_fires?: string[] }>;
    };
    const goldenIds = [...new Set(golden.sessions.flatMap((s) => s.expect_fires ?? []))].sort();
    expect(goldenIds.length).toBeGreaterThan(0);
    if (!DH1A_FIXTURES_LANDED) return; // TODO(DH1a T3): skipped until fixtures land
    const have = new Set(loadManifests().map((c) => c.id));
    const missing = goldenIds.filter((id) => !have.has(id));
    expect(missing, `golden ids with no manifest positive: ${missing.join(", ")}`).toEqual([]);
  });
});
