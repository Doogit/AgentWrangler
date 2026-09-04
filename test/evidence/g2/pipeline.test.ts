import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type {
  Cond1AggregateScore,
  Cond1CorpusManifest,
  Cond1SealedKey,
} from "../../../src/evidence/cond1/types.js";
import { runG2JudgePipeline } from "../../../src/evidence/g2/pipeline.js";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE review_findings (
      finding_id TEXT PRIMARY KEY,
      source TEXT,
      human_state TEXT,
      confidence REAL
    );
    INSERT INTO review_findings (finding_id, source) VALUES ('source-confirmed', 'SEED');
    INSERT INTO review_findings (finding_id, source) VALUES ('source-rejected', 'SEED');
    INSERT INTO review_findings (finding_id, source) VALUES ('source-uncertain', 'SEED');
  `);
  return db;
}

const key: Cond1SealedKey = {
  version: "cond1-sealed-key-v1",
  campaignId: "campaign",
  randomizationSeed: "seed",
  answerCanonicalSha256: "a".repeat(64),
  answers: [
    {
      findingAlias: "confirmed",
      extractor: "E1",
      extractorVersion: "e1",
      sourceFindingId: "source-confirmed",
      corpusPrKey: "pr-1",
      evidenceSufficient: true,
      projectionFailure: null,
    },
    {
      findingAlias: "rejected",
      extractor: "E2",
      extractorVersion: "e2",
      sourceFindingId: "source-rejected",
      corpusPrKey: "pr-2",
      evidenceSufficient: true,
      projectionFailure: null,
    },
    {
      findingAlias: "uncertain",
      extractor: "E3",
      extractorVersion: "e3",
      sourceFindingId: "source-uncertain",
      corpusPrKey: "pr-3",
      evidenceSufficient: false,
      projectionFailure: "REDACTION_FAILED",
    },
  ],
};

const manifest = {} as Cond1CorpusManifest;
const score = { campaign: "COND1_FINDINGS_PRECISION" } as Cond1AggregateScore;
const packetEntries = key.answers.map((answer) => ({
  findingAlias: answer.findingAlias,
  evidenceKind: "REVIEW_THREAD_STATE",
  evidence: {},
}));

describe("runG2JudgePipeline", () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("returns JUDGE_ERROR when adjudication fails", async () => {
    const db = createDb();
    databases.push(db);

    const result = await runG2JudgePipeline(
      {
        db,
        judge: async () => ({ ok: false, reason: "judge unavailable" }),
        packetEntries,
        seed: [{ findingAlias: "confirmed", label: "CONFIRMED" }],
        key,
        manifest,
        corpusManifestFileSha256: "b".repeat(64),
      },
      { minSeedN: 1 },
    );

    expect(result).toEqual({
      status: "JUDGE_ERROR",
      reason: "judge unavailable",
      findingAlias: "confirmed",
    });
  });

  it("blocks below the kappa gate without persisting or scoring", async () => {
    const db = createDb();
    databases.push(db);
    let scored = false;

    const result = await runG2JudgePipeline(
      {
        db,
        judge: async () => ({
          ok: true,
          verdict: "REJECTED",
          confidence: 0.2,
          rationaleTag: "negated",
        }),
        packetEntries,
        seed: [{ findingAlias: "confirmed", label: "CONFIRMED" }],
        key,
        manifest,
        corpusManifestFileSha256: "b".repeat(64),
      },
      {
        scorer: () => {
          scored = true;
          return score;
        },
        minSeedN: 1,
      },
    );

    expect(result).toMatchObject({
      status: "BLOCKED_LOW_KAPPA",
      kappa: 0,
      rawAgreement: 0,
      seedN: 1,
      gate: 0.6,
    });
    expect(scored).toBe(false);
    expect(
      db
        .prepare(
          "SELECT source, human_state FROM review_findings WHERE finding_id = 'source-confirmed'",
        )
        .get(),
    ).toEqual({
      source: "SEED",
      human_state: null,
    });
  });

  it("persists de-blinded verdicts and scores at perfect calibration", async () => {
    const db = createDb();
    databases.push(db);
    const received: unknown[] = [];
    const results = [
      {
        ok: true as const,
        verdict: "CONFIRMED" as const,
        confidence: 0.9,
        rationaleTag: "supports",
      },
      { ok: true as const, verdict: "REJECTED" as const, confidence: 0.4, rationaleTag: "negates" },
      {
        ok: true as const,
        verdict: "CONFIRMED" as const,
        confidence: 0.7,
        rationaleTag: "supports",
      },
    ];
    let index = 0;

    const result = await runG2JudgePipeline(
      {
        db,
        judge: async () => {
          const result = results[index];
          index += 1;
          if (result === undefined) throw new Error("fixture exhausted");
          return result;
        },
        packetEntries,
        seed: [
          { findingAlias: "confirmed", label: "CONFIRMED" },
          { findingAlias: "rejected", label: "REJECTED" },
        ],
        key,
        manifest,
        corpusManifestFileSha256: "b".repeat(64),
      },
      {
        scorer: (input) => {
          received.push(input);
          return score;
        },
        minSeedN: 2,
      },
    );

    expect(result).toMatchObject({
      status: "SCORED",
      kappa: 1,
      rawAgreement: 1,
      seedN: 2,
      labeledN: 3,
      score,
    });
    expect(
      db
        .prepare(
          "SELECT source, human_state, confidence FROM review_findings WHERE finding_id = 'source-confirmed'",
        )
        .get(),
    ).toEqual({
      source: "LLM",
      human_state: "CONFIRMED",
      confidence: 0.9,
    });
    expect(
      db
        .prepare(
          "SELECT source, human_state, confidence FROM review_findings WHERE finding_id = 'source-rejected'",
        )
        .get(),
    ).toEqual({
      source: "LLM",
      human_state: "REJECTED",
      confidence: 0.4,
    });
    expect(received).toEqual([
      expect.objectContaining({
        manifest,
        corpusManifestFileSha256: "b".repeat(64),
        answers: key.answers,
        verdicts: [
          {
            findingAlias: "confirmed",
            verdict: "TRUE_POSITIVE",
            adjudicatorAlias: "g2-judge",
            reasonCode: "EVIDENCE_SUPPORTS",
          },
          {
            findingAlias: "rejected",
            verdict: "FALSE_POSITIVE",
            adjudicatorAlias: "g2-judge",
            reasonCode: "CONTEXT_NEGATES",
          },
          {
            findingAlias: "uncertain",
            verdict: "UNCERTAIN",
            adjudicatorAlias: "g2-judge",
            reasonCode: "INSUFFICIENT_EVIDENCE",
          },
        ],
      }),
    ]);
  });

  it("rejects a seed below the minimum-N floor without calling the judge", async () => {
    const db = createDb();
    databases.push(db);
    let judgeCalls = 0;

    const result = await runG2JudgePipeline({
      db,
      judge: async () => {
        judgeCalls += 1;
        return {
          ok: true as const,
          verdict: "CONFIRMED" as const,
          confidence: 0.9,
          rationaleTag: "x",
        };
      },
      packetEntries,
      seed: [{ findingAlias: "confirmed", label: "CONFIRMED" }],
      key,
      manifest,
      corpusManifestFileSha256: "b".repeat(64),
    });

    expect(result).toEqual({
      status: "INVALID_SEED",
      reason: expect.stringContaining("below the minimum"),
      seedN: 1,
      matchedN: 1,
      minSeedN: 8,
    });
    expect(judgeCalls).toBe(0);
  });

  it("rejects an unmatched seed alias regardless of size (no silent drop)", async () => {
    const db = createDb();
    databases.push(db);
    let judgeCalls = 0;

    const result = await runG2JudgePipeline(
      {
        db,
        judge: async () => {
          judgeCalls += 1;
          return {
            ok: true as const,
            verdict: "CONFIRMED" as const,
            confidence: 0.9,
            rationaleTag: "x",
          };
        },
        packetEntries,
        seed: [
          { findingAlias: "confirmed", label: "CONFIRMED" },
          { findingAlias: "not-in-packet", label: "CONFIRMED" },
        ],
        key,
        manifest,
        corpusManifestFileSha256: "b".repeat(64),
      },
      { minSeedN: 1 },
    );

    expect(result).toMatchObject({
      status: "INVALID_SEED",
      seedN: 2,
      matchedN: 1,
    });
    expect(judgeCalls).toBe(0);
  });
});
