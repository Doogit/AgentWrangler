import type { CapabilityProfile } from "../../../../../src/recommendations/capabilities.js";
import type { EngineFinding } from "../../../../../src/recommendations/correlation.js";

export const H2_NOW = "2026-09-16T12:00:00.000Z";
export const H2_WINDOW = {
  from: "2026-09-09T12:00:00.000Z",
  to: "2026-09-16T12:00:00.000Z",
} as const;

const finding = (
  id: string,
  detectorId: "A1" | "A2" = "A1",
  changes: Partial<EngineFinding> = {},
): EngineFinding => ({
  id: id as EngineFinding["id"],
  detectorId,
  schemaVersion: 2,
  observedAt: "2026-09-15T12:00:00.000Z",
  correlationKey: `output-scope-${id}`,
  ceuPoolId: `output-pool-${id}` as EngineFinding["ceuPoolId"],
  ceuPerWeek: 10,
  confidence: 0.8,
  ...changes,
});

export const H2_FINDING_CORPUS = {
  healthyNoChange: [] as readonly EngineFinding[],
  actionable: [finding("actionable")],
  sparse: [finding("sparse", "A1", { ceuPerWeek: null })],
  conflicting: [
    finding("conflict-a", "A1", {
      correlationKey: "shared-output-scope",
      ceuPoolId: "output-pool-a" as EngineFinding["ceuPoolId"],
    }),
    finding("conflict-b", "A2", {
      correlationKey: "shared-output-scope",
      ceuPoolId: "output-pool-b" as EngineFinding["ceuPoolId"],
    }),
  ],
  falsePositive: [finding("false-positive", "A1", { ceuPerWeek: 0 })],
  unsupported: [finding("unsupported", "A1", { detectorId: "A3" })],
} as const;

export const h2CapabilityProfile = (
  verdict: "SUPPORTED" | "UNSUPPORTED" | "UNKNOWN" | "CONTRADICTED" = "SUPPORTED",
): CapabilityProfile => ({
  id: "h2-profile",
  version: "h2-profile-1",
  claudeCodeVersion: "2.1.177",
  platform: "WINDOWS",
  workspaceScope: "WORKSPACE",
  createdAt: "2026-09-16T00:00:00.000Z",
  expiresAt: "2026-09-17T00:00:00.000Z",
  observations: [
    {
      capability: "claude-md-project-rules",
      verdict,
      source: "VERSION_GATE",
      canaryVersion: null,
      observedAt: "2026-09-16T01:00:00.000Z",
    },
  ],
});

export const H2_ADVERSE_CAPABILITY_PROFILE = h2CapabilityProfile("CONTRADICTED");
