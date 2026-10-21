import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../../src/db/open.js";
import { CERTIFICATION } from "../../src/detector/certification.js";
import { recommendationTemplate } from "../../src/detector/privacy-contract.js";
import { confidenceTierFor, listRecommendations } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";

vi.mock("../../src/detector/certification.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/detector/certification.js")>();
  return { ...actual, CERTIFICATION: { ...actual.CERTIFICATION } };
});

let scratchRoot: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-rec-cert-"));
  const dbPath = path.join(scratchRoot, "shared-seed.sqlite");
  childProcess.execFileSync(
    process.execPath,
    ["--import", "tsx/esm", "scripts/build-shared-seed.ts", dbPath],
    { cwd: path.resolve(import.meta.dirname, "../.."), stdio: "pipe" },
  );
  db = openDb(dbPath);
  setQueryDb(db);
});

afterEach(() => {
  CERTIFICATION.D2 = { status: "UNVERIFIED" };
  resetQueryDb();
  db?.close();
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

function activeCards() {
  const view = listRecommendations().data;
  if (view === null) throw new Error("null recommendations view");
  return view.active;
}

function setEstimate(recId: string, basis: "P" | "E" | "X", rankValue: number | null) {
  db.prepare("UPDATE recommendations SET modeled_formula_json = ? WHERE rec_id = ?").run(
    JSON.stringify({
      model: "synthetic",
      inputs: {},
      estimate: { basis, rank_value_u_per_wk: rankValue },
    }),
    recId,
  );
}

function insertD2Recommendation(): string {
  const templateId = "D2_LONG_FULL_CONTEXT";
  const definition = recommendationTemplate(templateId);
  if (!definition) throw new Error("missing D2 recommendation template");
  const seed = db
    .prepare("SELECT * FROM recommendations WHERE contract_version = 1 LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  if (!seed) throw new Error("shared seed has no V1 recommendation to clone");

  const recId = "synthetic-d2-certification";
  const evidence = JSON.parse(seed.evidence_json as string) as Record<string, unknown>;
  const seedFacts = evidence.facts as Record<string, unknown>;
  const row: Record<string, unknown> = {
    ...seed,
    rec_id: recId,
    detector_id: "D2",
    category: definition.category,
    lever: definition.lever,
    target_metric: definition.target_metric,
    contract_version: 1,
    template_id: templateId,
    rule_id: null,
    evidence_json: JSON.stringify({
      version: 1,
      template_id: templateId,
      facts: {
        session_ids: seedFacts.session_ids,
        qualifying_session_count: 3,
        qualifying_turn_count: 453,
        raw_context_average_tokens_per_turn: 180_001,
        cap_weighted_burn_tokens_per_week: 1_000,
        cache_read_tokens_per_week: 1_000,
        cap_read_coefficient: 0.1,
      },
    }),
    modeled_formula_json: JSON.stringify({ model: "synthetic", inputs: {} }),
    modeled_savings_u_per_wk: 330,
    state: "PROPOSED",
  };
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO recommendations (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((column) => row[column]));
  return recId;
}

describe("recommendation certification tiers", () => {
  it("marks every active card unverified with today's registry", () => {
    const cards = activeCards();
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.certification).toBe("UNVERIFIED");
      expect(card.confidence_tier).toBe("UNVERIFIED");
    }
  });

  // Review 3 B5: D2's reduction is measured; its assumptions (split cadence, summary size) do not
  // scale the saving linearly, so a D2 P estimate is a point, not a [330, 700] range.
  it("gives a D2 P estimate a point range and an X estimate no range", () => {
    const recId = insertD2Recommendation();
    const d2 = activeCards().find((card) => card.detector_id === "D2");
    expect(d2).toBeDefined();

    setEstimate(recId, "P", 330);
    expect(activeCards().find((card) => card.rec_id === recId)?.range_u_per_wk).toEqual([330, 330]);

    setEstimate(recId, "X", null);
    expect(activeCards().find((card) => card.rec_id === recId)?.range_u_per_wk).toBeNull();
  });

  // Amended 2026-10-13 (operator): certification no longer ranks; order is by shown $ only.
  it("sorts a certified assumed D2 below a higher-value unverified card", () => {
    const recId = insertD2Recommendation();
    const cards = activeCards();
    const d2 = cards.find((card) => card.detector_id === "D2");
    const other = cards.find((card) => card.detector_id !== "D2");
    expect(d2).toBeDefined();
    expect(other).toBeDefined();
    if (!other) throw new Error("shared seed has no other active recommendation");

    setEstimate(recId, "E", 330);
    setEstimate(other.rec_id, "P", 1_000);
    CERTIFICATION.D2 = {
      status: "CERTIFIED",
      evidence: {
        c1: "synthetic",
        c2: "synthetic",
        c4: "synthetic",
        c5a: "synthetic",
        liveRunDate: "synthetic",
        sha: "synthetic",
        operatorSignOff: "synthetic",
        claudeCodeVersionRange: "synthetic",
      },
    };

    const ranked = activeCards();
    const certified = ranked.find((card) => card.rec_id === recId);
    const unverified = ranked.find((card) => card.rec_id === other.rec_id);
    expect(certified?.certification).toBe("CERTIFIED");
    expect(certified?.confidence_tier).toBe("ESTIMATED");
    expect(unverified?.certification).toBe("UNVERIFIED");
    expect(ranked.findIndex((card) => card.rec_id === recId)).toBeGreaterThan(
      ranked.findIndex((card) => card.rec_id === other.rec_id),
    );
  });

  // P3.F: a detector certified with C1 ESTIMATED (no quantity oracle) must not read "Verified",
  // even when it has no ASSUMED constants.
  it("shows Estimated, not Verified, for a detector certified without a C1 oracle", () => {
    const evidence = {
      c1: "synthetic",
      c2: "synthetic",
      c4: "synthetic",
      c5a: "synthetic",
      liveRunDate: "synthetic",
      sha: "synthetic",
      operatorSignOff: "synthetic",
      claudeCodeVersionRange: "synthetic",
    };
    expect(confidenceTierFor({ status: "UNVERIFIED" }, false)).toBe("UNVERIFIED");
    expect(confidenceTierFor(undefined, true)).toBe("UNVERIFIED");
    expect(confidenceTierFor({ status: "CERTIFIED", evidence }, false)).toBe("VERIFIED");
    expect(confidenceTierFor({ status: "CERTIFIED", evidence }, true)).toBe("ESTIMATED");
    expect(
      confidenceTierFor(
        { status: "CERTIFIED", evidence: { ...evidence, c1Estimated: true } },
        false,
      ),
    ).toBe("ESTIMATED");
  });
});
