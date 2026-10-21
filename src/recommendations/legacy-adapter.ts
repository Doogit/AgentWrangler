import type { FindingId, SafeCode } from "./types.js";

export type LegacyRecommendationState =
  | "PROPOSED"
  | "ADOPTED"
  | "DISMISSED"
  | "MEASURING"
  | "MEASURED_EFFECTIVE"
  | "MEASURED_NO_EFFECT";

export interface LegacyRecommendationRowContract {
  readonly recId: string;
  readonly detectorId: string | null;
  readonly contractStatus:
    | "LEGACY_UNVERIFIED"
    | "V1_VALIDATED"
    | "V2_VALIDATED"
    | "DECISION_V1_VALIDATED";
  readonly contractVersion: number | null;
  readonly findingKind: "FINDING" | "HEALTH" | "ZERO";
  readonly state: LegacyRecommendationState;
  readonly createdAt: string;
}

export interface LegacyFindingProjection {
  readonly id: FindingId;
  readonly sourceRecommendationId: string;
  readonly detectorId: string;
  readonly contractVersion: 1 | 2;
  readonly lifecycle: "OPEN" | "ACTIONED" | "DISMISSED";
  readonly effectLinkState: "LEGACY_UNLINKED";
  readonly observedAt: string;
  readonly reasonCodes: readonly SafeCode[];
}

export type LegacyAdapterResult =
  | { readonly kind: "ADAPTED"; readonly finding: LegacyFindingProjection }
  | {
      readonly kind: "EXCLUDED";
      readonly reason: "NON_FINDING" | "UNVERIFIED_CONTRACT" | "NON_DETECTOR_DECISION";
    };

function legacyLifecycle(state: LegacyRecommendationState): LegacyFindingProjection["lifecycle"] {
  if (state === "PROPOSED") return "OPEN";
  if (state === "DISMISSED") return "DISMISSED";
  return "ACTIONED";
}

/** Maps validated detector-shaped rows into immutable finding inputs without rewriting the old row. */
export function adaptLegacyRecommendation(
  row: LegacyRecommendationRowContract,
): LegacyAdapterResult {
  if (row.findingKind !== "FINDING") return { kind: "EXCLUDED", reason: "NON_FINDING" };
  if (row.contractStatus === "DECISION_V1_VALIDATED") {
    return { kind: "EXCLUDED", reason: "NON_DETECTOR_DECISION" };
  }
  const validatedVersion =
    row.contractStatus === "V1_VALIDATED" && row.contractVersion === 1
      ? 1
      : row.contractStatus === "V2_VALIDATED" && row.contractVersion === 2
        ? 2
        : null;
  if (validatedVersion === null || row.detectorId === null) {
    return { kind: "EXCLUDED", reason: "UNVERIFIED_CONTRACT" };
  }
  return {
    kind: "ADAPTED",
    finding: {
      id: `legacy-finding:${row.recId}` as FindingId,
      sourceRecommendationId: row.recId,
      detectorId: row.detectorId,
      contractVersion: validatedVersion,
      lifecycle: legacyLifecycle(row.state),
      effectLinkState: "LEGACY_UNLINKED",
      observedAt: row.createdAt,
      reasonCodes: ["LEGACY_FINDING_ADAPTER" as SafeCode],
    },
  };
}
