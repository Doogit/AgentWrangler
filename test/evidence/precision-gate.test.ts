import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { c1FindingDescriptor } from "../../src/detector/detectors/c1_tool_error_rate.js";
import { findingIds } from "../../src/detector/privacy-contract.js";
import {
  U12_COMMITTED_FIXTURE_ROOTS,
  U12_PRIVATE_CORPUS_ROOTS,
  assertU12CommittedArtifact,
  u12SyntheticFixtureId,
} from "../../src/evidence/precision-artifact-guard.js";
import {
  type OperatorAdjudication,
  type PrecisionCandidate,
  type PrecisionGateConfig,
  type PrelabelVocabulary,
  U12_PRELABEL_VERSION,
  assertPrelabelPayload,
  candidateIdentity,
  evaluatePrecisionGate as evaluateRaw,
  preparePrecisionPopulation,
  selectAgreementAudit,
  wilson95,
} from "../../src/evidence/precision-gate.js";
import { PARSER_VERSION } from "../../src/ingest/types.js";

const digest = (prefix: "cand" | "sid" | "mid", value: number): string =>
  `${prefix}_${value.toString(16).padStart(64, "0")}`;

const C1_RULE_VERSION = c1FindingDescriptor.defaults.assessment.provenance.version;
const CLAUDE_CODE_VERSION = "claude-code-2.1.0";

const vocabulary = {
  detectorIds: ["C1"],
  ruleVersions: [C1_RULE_VERSION],
  parserVersions: [PARSER_VERSION],
  claudeCodeVersions: [CLAUDE_CODE_VERSION],
  criteriaLabels: ["TOOL_ERROR_CLUSTER"],
  featureNames: ["ERROR_COUNT", "HAS_RECOVERY", "TOOL_CLASS"],
  featureEnums: { TOOL_CLASS: ["SHELL", "EDITOR"] },
} as const;
const payload = (value: number) =>
  ({
    version: U12_PRELABEL_VERSION,
    detector_id: "C1",
    rule_version: C1_RULE_VERSION,
    parser_version: PARSER_VERSION,
    claude_code_version: CLAUDE_CODE_VERSION,
    certification_session_id: digest("sid", value),
    criteria_label: "TOOL_ERROR_CLUSTER",
    anchors: [
      {
        session_id: digest("sid", value),
        message_id: digest("mid", value),
        timestamp: "2026-09-16T00:00:00.000Z",
      },
    ],
    features: { ERROR_COUNT: value },
  }) as const;

function candidates(
  agreementN: number,
  agreementFalseN = 0,
  disagreementAdjudications: readonly OperatorAdjudication[] = [],
): PrecisionCandidate[] {
  const agreements: PrecisionCandidate[] = Array.from({ length: agreementN }, (_, index) => ({
    payload: payload(index + 1),
    prelabel: "SUPPORTED",
    operatorAdjudication: index < agreementFalseN ? "FALSE_POSITIVE" : "TRUE_POSITIVE",
  }));
  return [
    ...agreements,
    ...disagreementAdjudications.map((operatorAdjudication, index) => ({
      payload: payload(agreementN + index + 1),
      prelabel: "UNSUPPORTED" as const,
      operatorAdjudication,
    })),
  ];
}

const config = {
  detectorId: "C1",
  ruleVersion: C1_RULE_VERSION,
  parserVersion: PARSER_VERSION,
  claudeCodeVersion: CLAUDE_CODE_VERSION,
  minimumFirings: 35,
  agreementAuditRate: 1,
  lowPrevalence: false,
} as const;

function evaluatePrecisionGate(
  items: readonly PrecisionCandidate[],
  options: Omit<PrecisionGateConfig, "expectedPopulationCommitment">,
  selectedVocabulary: PrelabelVocabulary = vocabulary,
) {
  const prepared = preparePrecisionPopulation(
    items.map((item) => item.payload),
    selectedVocabulary,
  );
  return evaluateRaw(
    items,
    { ...options, expectedPopulationCommitment: prepared.populationCommitment },
    selectedVocabulary,
  );
}

describe("U12 provider-safe precision gate", () => {
  it("enforces the distinct-session floor and two-sided Wilson certification examples", () => {
    expect(evaluatePrecisionGate(candidates(35), config, vocabulary)).toMatchObject({
      status: "CERTIFIED_ON_BY_DEFAULT",
      reason: "CERTIFIED",
      estimatedPrecision: 1,
      firingCount: 35,
      distinctSessionCount: 35,
    });
    expect(evaluatePrecisionGate(candidates(34), config, vocabulary)).toMatchObject({
      status: "REVIEW_ONLY",
      reason: "BELOW_MINIMUM_FIRINGS",
      distinctSessionCount: 34,
    });
    expect(evaluatePrecisionGate(candidates(35, 1), config, vocabulary)).toMatchObject({
      status: "REVIEW_ONLY",
      routingTier: "T3_REVIEW",
      reason: "WILSON_LOWER_BOUND_BELOW_THRESHOLD",
      estimatedPrecision: 34 / 35,
    });
    expect(evaluatePrecisionGate(candidates(50), config, vocabulary)).toMatchObject({
      status: "CERTIFIED_ON_BY_DEFAULT",
      reason: "CERTIFIED",
    });
    const fortyNineOfFifty = evaluatePrecisionGate(candidates(50, 1), config, vocabulary);
    expect(fortyNineOfFifty).toMatchObject({
      status: "REVIEW_ONLY",
      reason: "WILSON_LOWER_BOUND_BELOW_THRESHOLD",
      estimatedPrecision: 0.98,
    });
    expect(fortyNineOfFifty.estimateConfidence95?.lower).toBeLessThan(0.9);
  });

  it("does not allow callers or low prevalence to relax the 35-session floor", () => {
    expect(() =>
      evaluatePrecisionGate(candidates(10), { ...config, minimumFirings: 10 }, vocabulary),
    ).toThrow("minimumFirings must be at least 35 distinct sessions");
    expect(
      evaluatePrecisionGate(
        [
          { payload: payload(1), prelabel: "SUPPORTED" },
          { payload: payload(2), prelabel: "SUPPORTED" },
        ],
        { ...config, lowPrevalence: true },
        vocabulary,
      ),
    ).toMatchObject({
      status: "REVIEW_ONLY",
      routingTier: "T3_REVIEW",
      reason: "LOW_PREVALENCE_BELOW_MINIMUM_FIRINGS",
      estimatedPrecision: null,
    });
  });

  it("uses every operator adjudication as ground truth regardless of the pre-label", () => {
    const upheld = evaluatePrecisionGate(candidates(34, 0, ["TRUE_POSITIVE"]), config, vocabulary);
    const overturned = evaluatePrecisionGate(
      candidates(34, 0, ["FALSE_POSITIVE"]),
      config,
      vocabulary,
    );
    expect(upheld.estimatedPrecision).toBe(1);
    expect(overturned.estimatedPrecision).toBe(34 / 35);
  });

  it("rejects the old 9/10 full-audit certification behavior", () => {
    expect(evaluatePrecisionGate(candidates(10, 1), config, vocabulary)).toMatchObject({
      status: "REVIEW_ONLY",
      reason: "BELOW_MINIMUM_FIRINGS",
      firingCount: 10,
      distinctSessionCount: 10,
    });
    const fortyFiveOfFifty = evaluatePrecisionGate(candidates(50, 5), config, vocabulary);
    expect(fortyFiveOfFifty).toMatchObject({
      status: "REVIEW_ONLY",
      reason: "WILSON_LOWER_BOUND_BELOW_THRESHOLD",
      estimatedPrecision: 0.9,
    });
    expect(fortyFiveOfFifty.estimateConfidence95?.lower).toBeLessThan(0.9);
  });

  it("selects a deterministic random agreement audit sample", () => {
    const population = candidates(10);
    const commitment = preparePrecisionPopulation(
      population.map((item) => item.payload),
      vocabulary,
    ).populationCommitment;
    const first = selectAgreementAudit(population, 0.2, commitment);
    const second = selectAgreementAudit([...population].reverse(), 0.2, commitment);
    expect([...first].sort()).toEqual([...second].sort());
    expect(first.size).toBe(2);
  });

  it("freezes the structural population before labels and rejects commitment mismatch", () => {
    const population = candidates(10);
    const prepared = preparePrecisionPopulation(
      population.map((item) => item.payload),
      vocabulary,
    );
    const relabeled = population.map((item, index) => ({
      ...item,
      prelabel: index < 2 ? ("UNSUPPORTED" as const) : ("SUPPORTED" as const),
    }));
    const immutableRankOrder = [
      ...selectAgreementAudit(population, 1, prepared.populationCommitment),
    ];
    const relabeledSample = selectAgreementAudit(relabeled, 0.5, prepared.populationCommitment);
    const eligible = new Set(
      relabeled
        .filter((item) => item.prelabel === "SUPPORTED")
        .map((item) => candidateIdentity(item.payload)),
    );
    expect([...relabeledSample]).toEqual(
      immutableRankOrder.filter((identity) => eligible.has(identity)).slice(0, 4),
    );
    expect(
      preparePrecisionPopulation(
        [...population].reverse().map((item) => item.payload),
        vocabulary,
      ).populationCommitment,
    ).toBe(prepared.populationCommitment);
    expect(
      preparePrecisionPopulation(
        population.slice(1).map((item) => item.payload),
        vocabulary,
      ).populationCommitment,
    ).not.toBe(prepared.populationCommitment);
    expect(
      preparePrecisionPopulation(
        [...population.map((item) => item.payload), payload(99)],
        vocabulary,
      ).populationCommitment,
    ).not.toBe(prepared.populationCommitment);
    expect(() =>
      evaluateRaw(
        population,
        { ...config, expectedPopulationCommitment: "f".repeat(64) },
        vocabulary,
      ),
    ).toThrow("does not match approved commitment");
  });

  it("requires the initial path to use full operator adjudication", () => {
    expect(() =>
      evaluatePrecisionGate(candidates(50), { ...config, agreementAuditRate: 0.2 }, vocabulary),
    ).toThrow("agreementAuditRate must be 1 for full operator adjudication");
  });

  it("binds sampling to canonical payloads and the whole population", () => {
    const population = candidates(35);
    const first = evaluatePrecisionGate(population, config, vocabulary);
    const reordered = evaluatePrecisionGate([...population].reverse(), config, vocabulary);
    expect(first.populationCommitment).toBe(reordered.populationCommitment);
    const duplicate = population[0];
    if (duplicate === undefined) throw new Error("test population is unexpectedly empty");
    expect(() => evaluatePrecisionGate([...population, duplicate], config, vocabulary)).toThrow(
      "structural payload must be unique",
    );
  });

  it("fails closed until disagreements and selected agreement audits are adjudicated", () => {
    const incomplete = candidates(34, 0, ["TRUE_POSITIVE"]);
    incomplete[0] = { payload: payload(1), prelabel: "SUPPORTED" };
    expect(evaluatePrecisionGate(incomplete, config, vocabulary)).toMatchObject({
      status: "REVIEW_ONLY",
      reason: "INCOMPLETE_OPERATOR_ADJUDICATION",
      estimatedPrecision: null,
    });
  });

  it("does not count repeated same-session candidates toward the initial floor", () => {
    const population = candidates(34);
    const repeatedSessionPayload = {
      ...payload(99),
      certification_session_id: digest("sid", 1),
      anchors: [
        {
          ...payload(99).anchors[0],
          session_id: digest("sid", 1),
        },
      ],
    } as const;
    population.push({
      payload: repeatedSessionPayload,
      prelabel: "SUPPORTED",
      operatorAdjudication: "TRUE_POSITIVE",
    });
    expect(evaluatePrecisionGate(population, config, vocabulary)).toMatchObject({
      status: "REVIEW_ONLY",
      reason: "MULTIPLE_CANDIDATES_PER_SESSION",
      firingCount: 35,
      distinctSessionCount: 34,
    });
  });

  it("cannot alias one multi-session surfaced finding into multiple certification samples", () => {
    const first = {
      ...payload(1),
      anchors: [payload(1).anchors[0], payload(2).anchors[0]],
    } as const;
    const reordered = {
      ...first,
      anchors: [...first.anchors].reverse(),
      features: { ERROR_COUNT: 999 },
    } as const;
    expect(candidateIdentity(first)).toBe(candidateIdentity(reordered));
    expect(() => preparePrecisionPopulation([first, reordered], vocabulary)).toThrow(
      "structural payload must be unique",
    );
    expect(() =>
      assertPrelabelPayload({ ...first, certification_session_id: digest("sid", 2) }, vocabulary),
    ).toThrow("must be the lowest included structural session id");
  });

  it("does not pool rule, parser, or Claude Code compatibility strata", () => {
    expect(C1_RULE_VERSION).toBe("c1-v1");
    expect(PARSER_VERSION).toBe("ingest-3");
    const mixed = candidates(35);
    const first = mixed[0];
    if (first === undefined) throw new Error("test population is unexpectedly empty");
    mixed[0] = {
      ...first,
      payload: { ...payload(1), rule_version: "c1-v2" },
    };
    expect(() =>
      evaluatePrecisionGate(mixed, config, {
        ...vocabulary,
        ruleVersions: [C1_RULE_VERSION, "c1-v2"],
      }),
    ).toThrow("candidate rule version does not match gate rule version");

    mixed[0] = { ...first, payload: { ...payload(1), parser_version: "ingest-4" } };
    expect(() =>
      evaluatePrecisionGate(mixed, config, {
        ...vocabulary,
        parserVersions: [PARSER_VERSION, "ingest-4"],
      }),
    ).toThrow("candidate parser version does not match gate parser version");

    mixed[0] = {
      ...first,
      payload: { ...payload(1), claude_code_version: "claude-code-2.2.0" },
    };
    expect(() =>
      evaluatePrecisionGate(mixed, config, {
        ...vocabulary,
        claudeCodeVersions: [CLAUDE_CODE_VERSION, "claude-code-2.2.0"],
      }),
    ).toThrow("candidate Claude Code version does not match gate Claude Code version");
  });

  it("allows only closed labels, structural anchors, and derived feature values for egress", () => {
    const payloadVocabulary = {
      detectorIds: ["C1"],
      ruleVersions: [C1_RULE_VERSION],
      parserVersions: [PARSER_VERSION],
      claudeCodeVersions: [CLAUDE_CODE_VERSION],
      criteriaLabels: ["TOOL_ERROR_CLUSTER"],
      featureNames: ["ERROR_COUNT", "HAS_RECOVERY", "TOOL_CLASS"],
      featureEnums: { TOOL_CLASS: ["SHELL", "EDITOR"] },
    } as const;
    const safe = {
      version: U12_PRELABEL_VERSION,
      detector_id: "C1",
      rule_version: C1_RULE_VERSION,
      parser_version: PARSER_VERSION,
      claude_code_version: CLAUDE_CODE_VERSION,
      certification_session_id: digest("sid", 1),
      criteria_label: "TOOL_ERROR_CLUSTER",
      anchors: [
        {
          session_id: digest("sid", 1),
          message_id: digest("mid", 1),
          timestamp: "2026-09-16T00:00:00.000Z",
        },
      ],
      features: {
        ERROR_COUNT: 4,
        HAS_RECOVERY: false,
        TOOL_CLASS: { kind: "ENUM", value: "SHELL" },
      },
    };
    expect(() => assertPrelabelPayload(safe, payloadVocabulary)).not.toThrow();

    for (const unsafe of [
      { ...safe, transcript: "raw prompt" },
      { ...safe, features: { ...safe.features, ERROR_TEXT: "permission denied" } },
      { ...safe, anchors: [{ ...safe.anchors[0], session_id: "live-session-123" }] },
      { ...safe, anchors: [{ ...safe.anchors[0], timestamp: "2026-99-16T00:00:00.000Z" }] },
    ]) {
      expect(() => assertPrelabelPayload(unsafe, payloadVocabulary)).toThrow();
    }
  });

  // export-manifest.txt is private-only and absent from the public export.
  it.skipIf(!fs.existsSync(path.resolve(process.cwd(), "scripts/launch/export-manifest.txt")))(
    "keeps calibration and certification artifacts out of the public export manifest",
    () => {
      const manifest = fs.readFileSync(
        path.resolve(process.cwd(), "scripts/launch/export-manifest.txt"),
        "utf8",
      );
      for (const root of [
        ...U12_PRIVATE_CORPUS_ROOTS,
        ...U12_COMMITTED_FIXTURE_ROOTS.slice(0, 2),
      ]) {
        expect(manifest).toContain(root);
      }
    },
  );

  it("rejects live DB session ids and any attempted committed live corpus", () => {
    const sessionSource = "u12-fixture-session-1";
    const messageSource = "u12-fixture-message-1";
    const fixturePayload = {
      ...payload(1),
      certification_session_id: u12SyntheticFixtureId("session", sessionSource),
      anchors: [
        {
          ...payload(1).anchors[0],
          session_id: u12SyntheticFixtureId("session", sessionSource),
          message_id: u12SyntheticFixtureId("message", messageSource),
        },
      ],
    };
    const fixture = {
      version: "u12-synthetic-fixture-v2",
      synthetic: true,
      vocabulary: {
        detector_ids: ["C1"],
        rule_versions: [C1_RULE_VERSION],
        parser_versions: [PARSER_VERSION],
        claude_code_versions: [CLAUDE_CODE_VERSION],
        criteria_labels: ["TOOL_ERROR_CLUSTER"],
        feature_names: ["ERROR_COUNT"],
        feature_enums: {},
      },
      candidates: [
        {
          payload: fixturePayload,
          prelabel: "SUPPORTED",
          synthetic_anchor_sources: [
            { session_source: sessionSource, message_source: messageSource },
          ],
        },
      ],
    };
    expect(() =>
      assertU12CommittedArtifact(
        "test/fixtures/evidence/precision-gate/c1.json",
        JSON.stringify({ ...fixture, "session\u0049d": "live-db-session-123" }),
      ),
    ).toThrow("unknown or missing keys");
    expect(() =>
      assertU12CommittedArtifact(
        "test/fixtures/evidence/precision-gate/c1.json",
        JSON.stringify(fixture),
      ),
    ).not.toThrow();
    expect(() =>
      assertU12CommittedArtifact(
        "test/fixtures/evidence/precision-gate/c1.json",
        JSON.stringify({
          ...fixture,
          candidates: [
            {
              ...fixture.candidates[0],
              payload: {
                ...fixturePayload,
                certification_session_id: findingIds.session("operator-live-session"),
                anchors: [
                  {
                    ...fixturePayload.anchors[0],
                    session_id: findingIds.session("operator-live-session"),
                    message_id: findingIds.message("operator-live-message"),
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).toThrow("not derived from its synthetic identity source");
    expect(() =>
      assertU12CommittedArtifact("test/fixtures/evidence/precision-gate/c1.json", "not json"),
    ).toThrow("not valid JSON");
    expect(() =>
      assertU12CommittedArtifact(
        "test/fixtures/evidence/precision-gate/c1.ts",
        "export default {}",
      ),
    ).toThrow("format is not allowed");
    expect(() =>
      assertU12CommittedArtifact(
        "test/fixtures/evidence/precision-gate/c1.json",
        JSON.stringify({
          ...fixture,
          candidates: [{ ...fixture.candidates[0], unexpected: { session_id: "live" } }],
        }),
      ),
    ).toThrow("unknown or missing keys");
    expect(() =>
      assertU12CommittedArtifact(
        "artifacts/evidence/precision-corpus/private.json",
        JSON.stringify({ aggregateOnly: true }),
      ),
    ).toThrow("must not be committed");
  });

  it("rejects hand-authored aggregate certification claims that do not clear every gate", () => {
    const aggregate = {
      version: "u12-precision-aggregate-v2",
      detector_id: "C1",
      rule_version: C1_RULE_VERSION,
      parser_version: PARSER_VERSION,
      claude_code_version: CLAUDE_CODE_VERSION,
      status: "CERTIFIED_ON_BY_DEFAULT",
      firing_count: 100,
      distinct_session_count: 100,
      operator_adjudicated_count: 100,
      true_positive_count: 100,
      minimum_firings: 50,
      estimated_precision: 1,
      confidence95: wilson95(100, 100),
      population_commitment: "a".repeat(64),
    };
    const target = "artifacts/evidence/precision-gate/c1.json";
    expect(() => assertU12CommittedArtifact(target, JSON.stringify(aggregate))).not.toThrow();
    const internallyConsistentFailures = [
      {
        ...aggregate,
        firing_count: 49,
        distinct_session_count: 49,
        operator_adjudicated_count: 49,
        true_positive_count: 49,
        confidence95: wilson95(49, 49),
      },
      { ...aggregate, distinct_session_count: 34 },
      { ...aggregate, distinct_session_count: 99 },
      {
        ...aggregate,
        operator_adjudicated_count: 99,
        true_positive_count: 99,
        estimated_precision: 0.99,
        confidence95: wilson95(99, 100),
      },
    ];
    for (const invalid of internallyConsistentFailures)
      expect(() => assertU12CommittedArtifact(target, JSON.stringify(invalid))).toThrow(
        "certification claim is inconsistent",
      );
    for (const inconsistent of [
      { ...aggregate, estimated_precision: 0.99 },
      { ...aggregate, confidence95: { lower: 0.91, upper: 0.99 } },
    ])
      expect(() => assertU12CommittedArtifact(target, JSON.stringify(inconsistent))).toThrow(
        "inconsistent with counts",
      );
    expect(() =>
      assertU12CommittedArtifact(target, JSON.stringify({ ...aggregate, minimum_firings: 34 })),
    ).toThrow("aggregate metrics are out of range");
  });
});
