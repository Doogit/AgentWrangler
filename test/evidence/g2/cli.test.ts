import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type {
  Cond1AggregateScore,
  Cond1CorpusManifest,
  Cond1SealedKey,
} from "../../../src/evidence/cond1/types.js";
import type { G2Artifacts } from "../../../src/evidence/g2/cli.js";
import { runG2JudgeCli } from "../../../src/evidence/g2/cli.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const key: Cond1SealedKey = {
  version: "cond1-sealed-key-v1",
  campaignId: `cond1-${"a".repeat(32)}`,
  randomizationSeed: "b".repeat(64),
  answerCanonicalSha256: "c".repeat(64),
  answers: [
    {
      findingAlias: "alias-1",
      extractor: "E2",
      extractorVersion: "e2",
      sourceFindingId: "source-1",
      corpusPrKey: "pr-1",
      evidenceSufficient: true,
      projectionFailure: null,
    },
  ],
};

const manifest = {} as Cond1CorpusManifest;

const fakeArtifacts: G2Artifacts = {
  packetEntries: [{ findingAlias: "alias-1", evidenceKind: "REVIEW_THREAD_STATE", evidence: {} }],
  key,
  manifest,
  corpusManifestFileSha256: "d".repeat(64),
  seed: [{ findingAlias: "alias-1", label: "CONFIRMED" }],
};

const fakeScore = {
  campaign: "COND1_FINDINGS_PRECISION" as const,
  overallStatus: "PASS" as const,
  extractors: {
    E1: {
      extractor: "E1" as const,
      corpusPrN: 10,
      emittedN: 0,
      requiredAdjudicationN: 0,
      adjudicatedN: 0,
      truePositiveN: 0,
      falsePositiveN: 0,
      uncertainN: 0,
      unadjudicatedN: 0,
      precisionNumerator: 0,
      precisionDenominator: 0,
      precision: null,
      threshold: 0.8 as const,
      sparse: false,
      status: "DATA_INSUFFICIENT" as const,
      limitation: "INCOMPLETE_ADJUDICATION" as const,
    },
    E2: {
      extractor: "E2" as const,
      corpusPrN: 10,
      emittedN: 1,
      requiredAdjudicationN: 1,
      adjudicatedN: 1,
      truePositiveN: 1,
      falsePositiveN: 0,
      uncertainN: 0,
      unadjudicatedN: 0,
      precisionNumerator: 1,
      precisionDenominator: 1,
      precision: 1.0,
      threshold: 0.8 as const,
      sparse: false,
      status: "PASS" as const,
      limitation: "NONE" as const,
    },
    E3: {
      extractor: "E3" as const,
      corpusPrN: 10,
      emittedN: 0,
      requiredAdjudicationN: 0,
      adjudicatedN: 0,
      truePositiveN: 0,
      falsePositiveN: 0,
      uncertainN: 0,
      unadjudicatedN: 0,
      precisionNumerator: 0,
      precisionDenominator: 0,
      precision: null,
      threshold: 0.8 as const,
      sparse: false,
      status: "DATA_INSUFFICIENT" as const,
      limitation: "INCOMPLETE_ADJUDICATION" as const,
    },
  },
} as Cond1AggregateScore;

// ---------------------------------------------------------------------------
// DB helpers (mirrors pipeline.test.ts pattern)
// ---------------------------------------------------------------------------

function createDb(optIn: boolean): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE review_findings (
      finding_id TEXT PRIMARY KEY,
      source TEXT,
      human_state TEXT,
      confidence REAL
    );
    CREATE TABLE user_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO review_findings (finding_id, source) VALUES ('source-1', 'SEED');
  `);
  if (optIn) {
    db.exec(`INSERT INTO user_config (key, value) VALUES ('g2_claude_judge_opt_in', 'true');`);
  }
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runG2JudgeCli", () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("prints plan and returns 0 when --execute is absent", async () => {
    const db = createDb(false);
    databases.push(db);

    let judgeCallCount = 0;
    const outputs: string[] = [];

    const code = await runG2JudgeCli([], {
      db,
      judge: async () => {
        judgeCallCount++;
        return { ok: false as const, reason: "should not be called" };
      },
      loadArtifacts: () => {
        throw new Error("loadArtifacts should not be called in plan mode");
      },
      stdout: (l) => outputs.push(l),
    });

    expect(code).toBe(0);
    expect(judgeCallCount).toBe(0);
    expect(outputs.join("\n")).toContain("ADJUDICATE");
    expect(outputs.join("\n")).toContain("g2_claude_judge_opt_in");
  });

  it("refuses when opt-in is not set — no judge call, no DB write", async () => {
    const db = createDb(false);
    databases.push(db);

    let judgeCallCount = 0;
    let loadCalled = false;
    const errors: string[] = [];

    const code = await runG2JudgeCli(["--execute"], {
      db,
      judge: async () => {
        judgeCallCount++;
        return { ok: false as const, reason: "should not be called" };
      },
      loadArtifacts: () => {
        loadCalled = true;
        return fakeArtifacts;
      },
      stderr: (l) => errors.push(l),
    });

    expect(code).toBe(1);
    expect(judgeCallCount).toBe(0);
    expect(loadCalled).toBe(false);
    expect(errors.join("\n")).toContain("g2_claude_judge_opt_in");

    // No DB writes
    const rows = db
      .prepare("SELECT human_state FROM review_findings WHERE human_state IS NOT NULL")
      .all();
    expect(rows).toHaveLength(0);
  });

  it("rejects a below-floor seed up front — no judge call, no DB write (default minSeedN)", async () => {
    const db = createDb(true);
    databases.push(db);

    let judgeCallCount = 0;
    const errors: string[] = [];

    // fakeArtifacts.seed has 1 finding; the default G2_MIN_SEED_N floor is 8, and
    // no pipelineDeps.minSeedN override is passed, so this must be rejected.
    const code = await runG2JudgeCli(["--execute"], {
      db,
      judge: async () => {
        judgeCallCount++;
        return {
          ok: true as const,
          verdict: "CONFIRMED" as const,
          confidence: 0.9,
          rationaleTag: "x",
        };
      },
      loadArtifacts: () => fakeArtifacts,
      stderr: (l) => errors.push(l),
      pipelineDeps: { scorer: () => fakeScore },
    });

    expect(code).toBe(1);
    expect(judgeCallCount).toBe(0);
    expect(errors.join("\n")).toContain("INVALID_SEED");
    const rows = db
      .prepare("SELECT human_state FROM review_findings WHERE human_state IS NOT NULL")
      .all();
    expect(rows).toHaveLength(0);
  });

  it("calls pipeline and prints SCORED when opted in and calibration passes", async () => {
    const db = createDb(true);
    databases.push(db);

    const outputs: string[] = [];

    const code = await runG2JudgeCli(["--execute"], {
      db,
      judge: async () => ({
        ok: true as const,
        verdict: "CONFIRMED" as const,
        confidence: 0.9,
        rationaleTag: "supports",
      }),
      loadArtifacts: () => fakeArtifacts,
      stdout: (l) => outputs.push(l),
      pipelineDeps: { scorer: () => fakeScore, minSeedN: 1 },
    });

    expect(code).toBe(0);
    const out = outputs.join("\n");
    expect(out).toContain("status: SCORED");
    expect(out).toContain("overallStatus: PASS");
    expect(out).toContain("E2");

    // SEC-101: rationale text must not appear in printed output
    expect(out).not.toContain("supports");
    expect(out).not.toContain("rationaleTag");
  });

  it("prints BLOCKED_LOW_KAPPA and returns 1 when calibration fails", async () => {
    const db = createDb(true);
    databases.push(db);

    const outputs: string[] = [];
    let scored = false;

    const code = await runG2JudgeCli(["--execute"], {
      db,
      // Judge always says REJECTED; seed says CONFIRMED → κ = 0 < 0.6
      judge: async () => ({
        ok: true as const,
        verdict: "REJECTED" as const,
        confidence: 0.5,
        rationaleTag: "negated",
      }),
      loadArtifacts: () => fakeArtifacts,
      stdout: (l) => outputs.push(l),
      pipelineDeps: {
        scorer: () => {
          scored = true;
          return fakeScore;
        },
        minSeedN: 1,
      },
    });

    expect(code).toBe(1);
    expect(scored).toBe(false);
    const out = outputs.join("\n");
    expect(out).toContain("BLOCKED_LOW_KAPPA");
    expect(out).toContain("Auto-labeling was skipped");

    // No DB writes
    const row = db
      .prepare("SELECT human_state FROM review_findings WHERE finding_id = 'source-1'")
      .get() as { human_state: string | null } | undefined;
    expect(row?.human_state).toBeNull();
  });

  it("SEC-101: no rationale text written to review_findings after SCORED run", async () => {
    const db = createDb(true);
    databases.push(db);

    await runG2JudgeCli(["--execute"], {
      db,
      judge: async () => ({
        ok: true as const,
        verdict: "CONFIRMED" as const,
        confidence: 0.95,
        rationaleTag: "secret_rationale",
      }),
      loadArtifacts: () => fakeArtifacts,
      stdout: () => {},
      pipelineDeps: { scorer: () => fakeScore, minSeedN: 1 },
    });

    // The review_findings table must not contain rationaleTag or rationale text
    const row = db
      .prepare(
        "SELECT finding_id, human_state, confidence, source FROM review_findings WHERE finding_id = 'source-1'",
      )
      .get() as { finding_id: string; human_state: string; confidence: number; source: string };

    expect(row.human_state).toBe("CONFIRMED");
    expect(row.source).toBe("LLM");
    // confidence is a number, not rationale text
    expect(typeof row.confidence).toBe("number");

    // The raw DB content should not contain "secret_rationale"
    const allRows = db.prepare("SELECT * FROM review_findings").all() as Record<string, unknown>[];
    const serialized = JSON.stringify(allRows);
    expect(serialized).not.toContain("secret_rationale");
  });
});
