import {
  type ArtifactKind,
  type CapabilityProfile,
  type HandlerRegistration,
  evaluateHandlerCompatibility,
} from "./capabilities.js";
import type { EngineFinding } from "./correlation.js";
import type { FrozenMeasurementDefinition } from "./storage.js";
import type { SafeCode } from "./types.js";

export interface ArtifactContract {
  readonly artifactRevisionId: string;
  readonly kind: ArtifactKind;
  readonly validationStatus: "VALIDATED" | "REJECTED";
  readonly validated: boolean;
  readonly artifactHash: string;
  readonly scopeHash: string;
  readonly targetHash: string;
  readonly rollbackArtifactRevisionId: string;
  readonly rollbackHash: string;
  readonly supersedesArtifactRevisionId: string | null;
  readonly createdAt: string;
  /** A closed structural code; never a command or content payload. */
  readonly applyMechanismCode: string;
}
export interface MeasurementContract {
  readonly verdict: "AUTOMATIC" | "VALIDATED_PROXY" | "MANUAL" | "UNMEASURABLE";
  readonly measurementMethodId: string;
  readonly methodVersion: string;
  readonly artifactRevisionId: string;
  readonly targetMetricCode: string;
  readonly definition: FrozenMeasurementDefinition;
  readonly createdAt: string;
}
export interface HandlerImplementation {
  readonly registration: HandlerRegistration;
  readonly compose: (input: {
    readonly findings: readonly EngineFinding[];
    readonly now: string;
    readonly window: { readonly from: string; readonly to: string };
  }) => {
    readonly artifacts: readonly ArtifactContract[];
    readonly measurement: MeasurementContract | null;
  };
}
export interface HandlerRegistry {
  readonly version: string;
  readonly handlers: readonly HandlerImplementation[];
}
export type RegistrySelection =
  | { readonly kind: "SELECTED"; readonly implementation: HandlerImplementation }
  | { readonly kind: "INVESTIGATE"; readonly reasonCodes: readonly SafeCode[] };

export function selectHandler(
  registry: HandlerRegistry,
  findings: readonly EngineFinding[],
  profile: CapabilityProfile,
  now: string,
): RegistrySelection {
  const candidates = [...registry.handlers]
    .filter((entry) => entry.registration.registryVersion === registry.version)
    .sort(
      (a, b) =>
        a.registration.family.localeCompare(b.registration.family) ||
        a.registration.version.localeCompare(b.registration.version),
    );
  const reasons: SafeCode[] = [];
  for (const candidate of candidates) {
    const compatible = findings.every((finding) =>
      candidate.registration.artifactKinds.some((artifactKind) => {
        const decision = evaluateHandlerCompatibility(
          candidate.registration,
          {
            detectorId: finding.detectorId,
            evidenceSchemaVersion: finding.schemaVersion,
            artifactKind,
          },
          profile,
          now,
        );
        if (decision.kind === "INVESTIGATE") reasons.push(decision.reasonCode);
        return decision.kind === "SUPPORTED";
      }),
    );
    if (compatible) return { kind: "SELECTED", implementation: candidate };
  }
  const canonical = [...new Set(reasons)].sort();
  return {
    kind: "INVESTIGATE",
    reasonCodes: (canonical.length > 0
      ? canonical
      : ["HANDLER_UNAVAILABLE"]) as unknown as readonly SafeCode[],
  };
}
