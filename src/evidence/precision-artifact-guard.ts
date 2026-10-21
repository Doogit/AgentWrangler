import crypto from "node:crypto";
import {
  U12_MINIMUM_DISTINCT_SESSIONS,
  assertPrelabelPayload,
  wilson95,
} from "./precision-gate.js";

export const U12_PRIVATE_CORPUS_ROOTS = [
  "artifacts/evidence/precision-corpus/",
  "test/fixtures/evidence/precision-corpus/",
] as const;
export const U12_COMMITTED_FIXTURE_ROOTS = [
  "artifacts/evidence/precision-gate/",
  "test/fixtures/evidence/precision-gate/",
] as const;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SYNTHETIC_SOURCE = /^u12-fixture-[a-z0-9][a-z0-9-]{0,63}$/u;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function exact(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new TypeError(`${name} contains unknown or missing keys`);
}
export function isU12GuardedPath(path: string): boolean {
  const relative = path.replaceAll("\\", "/");
  return [...U12_PRIVATE_CORPUS_ROOTS, ...U12_COMMITTED_FIXTURE_ROOTS].some((root) =>
    relative.startsWith(root),
  );
}

/**
 * Synthetic fixture IDs use a namespace that production finding IDs never use.
 * The guard recomputes every committed anchor from its bounded fixture source,
 * so a copied live sid_/mid_ value cannot be blessed by toggling `synthetic`.
 */
export function u12SyntheticFixtureId(kind: "session" | "message", source: string): string {
  if (!SYNTHETIC_SOURCE.test(source)) {
    throw new TypeError("U12 fixture identity source is invalid");
  }
  const digest = crypto
    .createHash("sha256")
    .update(`u12_synthetic_${kind}`)
    .update("\0")
    .update(source)
    .digest("hex");
  return `${kind === "session" ? "sid" : "mid"}_${digest}`;
}

export function assertU12CommittedArtifact(path: string, content: string): void {
  const relative = path.replaceAll("\\", "/");
  if (U12_PRIVATE_CORPUS_ROOTS.some((root) => relative.startsWith(root)))
    throw new TypeError(`U12 live calibration corpus must not be committed: ${relative}`);
  if (!U12_COMMITTED_FIXTURE_ROOTS.some((root) => relative.startsWith(root))) return;
  if (!relative.endsWith(".json"))
    throw new TypeError(`U12 fixture format is not allowed: ${relative}`);
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new TypeError(`U12 fixture is not valid JSON: ${relative}`);
  }
  if (!isRecord(value)) throw new TypeError(`U12 fixture must be an object: ${relative}`);
  if (relative.startsWith("test/fixtures/")) {
    exact(value, ["version", "synthetic", "vocabulary", "candidates"], "U12 synthetic fixture");
    if (value.version !== "u12-synthetic-fixture-v2" || value.synthetic !== true)
      throw new TypeError("U12 committed fixture must be explicitly synthetic");
    if (!isRecord(value.vocabulary))
      throw new TypeError("U12 fixture vocabulary must be an object");
    exact(
      value.vocabulary,
      [
        "detector_ids",
        "rule_versions",
        "parser_versions",
        "claude_code_versions",
        "criteria_labels",
        "feature_names",
        "feature_enums",
      ],
      "U12 fixture vocabulary",
    );
    const arrays = [
      value.vocabulary.detector_ids,
      value.vocabulary.criteria_labels,
      value.vocabulary.feature_names,
    ];
    if (
      arrays.some(
        (items) =>
          !Array.isArray(items) ||
          items.some((item) => typeof item !== "string" || !CODE.test(item)),
      )
    )
      throw new TypeError("U12 fixture vocabulary is invalid");
    const versionArrays = [
      value.vocabulary.rule_versions,
      value.vocabulary.parser_versions,
      value.vocabulary.claude_code_versions,
    ];
    if (
      versionArrays.some(
        (items) =>
          !Array.isArray(items) ||
          items.some((item) => typeof item !== "string" || !VERSION_ID.test(item)),
      )
    )
      throw new TypeError("U12 fixture version vocabulary is invalid");
    if (
      !isRecord(value.vocabulary.feature_enums) ||
      Object.values(value.vocabulary.feature_enums).some(
        (items) =>
          !Array.isArray(items) ||
          items.some((item) => typeof item !== "string" || !CODE.test(item)),
      )
    )
      throw new TypeError("U12 fixture enum vocabulary is invalid");
    if (!Array.isArray(value.candidates))
      throw new TypeError("U12 fixture candidates must be an array");
    const vocabulary = {
      detectorIds: value.vocabulary.detector_ids as string[],
      ruleVersions: value.vocabulary.rule_versions as string[],
      parserVersions: value.vocabulary.parser_versions as string[],
      claudeCodeVersions: value.vocabulary.claude_code_versions as string[],
      criteriaLabels: value.vocabulary.criteria_labels as string[],
      featureNames: value.vocabulary.feature_names as string[],
      featureEnums: value.vocabulary.feature_enums as Record<string, string[]>,
    };
    for (const candidate of value.candidates) {
      if (!isRecord(candidate)) throw new TypeError("U12 fixture candidate must be an object");
      exact(
        candidate,
        candidate.operator_adjudication === undefined
          ? ["payload", "prelabel", "synthetic_anchor_sources"]
          : ["payload", "prelabel", "operator_adjudication", "synthetic_anchor_sources"],
        "U12 fixture candidate",
      );
      assertPrelabelPayload(candidate.payload, vocabulary);
      if (!Array.isArray(candidate.synthetic_anchor_sources)) {
        throw new TypeError("U12 fixture synthetic anchor sources must be an array");
      }
      const payload = candidate.payload as {
        readonly anchors: readonly Readonly<{ session_id: string; message_id: string }>[];
      };
      if (candidate.synthetic_anchor_sources.length !== payload.anchors.length) {
        throw new TypeError("U12 fixture synthetic anchor sources must match payload anchors");
      }
      for (const [index, sourceValue] of candidate.synthetic_anchor_sources.entries()) {
        if (!isRecord(sourceValue)) {
          throw new TypeError(`U12 fixture synthetic anchor source ${index} must be an object`);
        }
        exact(
          sourceValue,
          ["session_source", "message_source"],
          `U12 fixture synthetic anchor source ${index}`,
        );
        if (
          typeof sourceValue.session_source !== "string" ||
          typeof sourceValue.message_source !== "string" ||
          payload.anchors[index]?.session_id !==
            u12SyntheticFixtureId("session", sourceValue.session_source) ||
          payload.anchors[index]?.message_id !==
            u12SyntheticFixtureId("message", sourceValue.message_source)
        ) {
          throw new TypeError(
            "U12 fixture anchor is not derived from its synthetic identity source",
          );
        }
      }
      if (candidate.prelabel !== "SUPPORTED" && candidate.prelabel !== "UNSUPPORTED")
        throw new TypeError("U12 fixture prelabel is invalid");
      if (
        candidate.operator_adjudication !== undefined &&
        candidate.operator_adjudication !== "TRUE_POSITIVE" &&
        candidate.operator_adjudication !== "FALSE_POSITIVE"
      )
        throw new TypeError("U12 fixture adjudication is invalid");
    }
    return;
  }
  exact(
    value,
    [
      "version",
      "detector_id",
      "rule_version",
      "parser_version",
      "claude_code_version",
      "status",
      "firing_count",
      "distinct_session_count",
      "operator_adjudicated_count",
      "true_positive_count",
      "minimum_firings",
      "estimated_precision",
      "confidence95",
      "population_commitment",
    ],
    "U12 aggregate artifact",
  );
  if (
    value.version !== "u12-precision-aggregate-v2" ||
    typeof value.detector_id !== "string" ||
    !CODE.test(value.detector_id) ||
    typeof value.rule_version !== "string" ||
    !VERSION_ID.test(value.rule_version) ||
    typeof value.parser_version !== "string" ||
    !VERSION_ID.test(value.parser_version) ||
    typeof value.claude_code_version !== "string" ||
    !VERSION_ID.test(value.claude_code_version)
  )
    throw new TypeError("U12 aggregate artifact identity is invalid");
  if (value.status !== "CERTIFIED_ON_BY_DEFAULT" && value.status !== "REVIEW_ONLY")
    throw new TypeError("U12 aggregate status is invalid");
  if (
    ![
      value.firing_count,
      value.distinct_session_count,
      value.operator_adjudicated_count,
      value.true_positive_count,
      value.minimum_firings,
      value.estimated_precision,
    ].every((item) => typeof item === "number" && Number.isFinite(item))
  )
    throw new TypeError("U12 aggregate metrics are invalid");
  const firingCount = value.firing_count as number;
  const distinctSessionCount = value.distinct_session_count as number;
  const operatorAdjudicatedCount = value.operator_adjudicated_count as number;
  const truePositiveCount = value.true_positive_count as number;
  const minimumFirings = value.minimum_firings as number;
  const estimatedPrecision = value.estimated_precision as number;
  if (
    !Number.isSafeInteger(firingCount) ||
    !Number.isSafeInteger(distinctSessionCount) ||
    !Number.isSafeInteger(operatorAdjudicatedCount) ||
    !Number.isSafeInteger(truePositiveCount) ||
    !Number.isSafeInteger(minimumFirings) ||
    firingCount < 0 ||
    distinctSessionCount < 0 ||
    distinctSessionCount > firingCount ||
    operatorAdjudicatedCount < 0 ||
    operatorAdjudicatedCount > firingCount ||
    truePositiveCount < 0 ||
    truePositiveCount > operatorAdjudicatedCount ||
    minimumFirings < U12_MINIMUM_DISTINCT_SESSIONS ||
    estimatedPrecision < 0 ||
    estimatedPrecision > 1
  )
    throw new TypeError("U12 aggregate metrics are out of range");
  if (!isRecord(value.confidence95)) throw new TypeError("U12 aggregate confidence is invalid");
  exact(value.confidence95, ["lower", "upper"], "U12 aggregate confidence");
  const { lower, upper } = value.confidence95;
  if (
    typeof lower !== "number" ||
    typeof upper !== "number" ||
    !Number.isFinite(lower) ||
    !Number.isFinite(upper) ||
    lower < 0 ||
    upper > 1 ||
    lower > upper
  )
    throw new TypeError("U12 aggregate confidence is out of range");
  const expectedPrecision = firingCount === 0 ? 0 : truePositiveCount / firingCount;
  const expectedConfidence =
    firingCount === 0 ? { lower: 0, upper: 0 } : wilson95(truePositiveCount, firingCount);
  const tolerance = 1e-12;
  if (
    Math.abs(estimatedPrecision - expectedPrecision) > tolerance ||
    Math.abs(lower - expectedConfidence.lower) > tolerance ||
    Math.abs(upper - expectedConfidence.upper) > tolerance
  ) {
    throw new TypeError("U12 aggregate precision or confidence is inconsistent with counts");
  }
  if (
    typeof value.population_commitment !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.population_commitment)
  )
    throw new TypeError("U12 aggregate commitment is invalid");
  if (
    value.status === "CERTIFIED_ON_BY_DEFAULT" &&
    (distinctSessionCount < minimumFirings ||
      firingCount !== distinctSessionCount ||
      operatorAdjudicatedCount !== firingCount ||
      estimatedPrecision < 0.9 ||
      lower < 0.9)
  )
    throw new TypeError("U12 aggregate certification claim is inconsistent with gate thresholds");
}
