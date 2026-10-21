import type { CapabilityProfile } from "../../../../../src/recommendations/capabilities.js";
import type { EngineFinding } from "../../../../../src/recommendations/correlation.js";

export const H3_NOW = "2026-09-17T18:00:00.000Z";
export const H3_WINDOW = {
  from: "2026-09-10T18:00:00.000Z",
  to: "2026-09-17T17:00:00.000Z",
} as const;

export const h3Finding = (
  id: string,
  detectorId: "B1" | "B2" | "B3" | "B4" = "B2",
  changes: Partial<EngineFinding> = {},
): EngineFinding => ({
  id: id as EngineFinding["id"],
  detectorId,
  schemaVersion: 2,
  observedAt: "2026-09-16T18:00:00.000Z",
  correlationKey: "cache-event-1",
  ceuPoolId: "cache-pool-1" as EngineFinding["ceuPoolId"],
  ceuPerWeek: 12,
  confidence: 0.9,
  ...changes,
});

export const H3_FINDING_CORPUS = {
  healthyNoChange: [] as readonly EngineFinding[],
  actionable: [h3Finding("b1-actionable", "B1"), h3Finding("b2-actionable", "B2")],
  actionableResume: [h3Finding("b3-actionable", "B3")],
  actionablePrefix: [h3Finding("b4-actionable", "B4")],
  sparse: [h3Finding("sparse", "B2", { ceuPerWeek: null })],
  conflicting: [h3Finding("conflict-b2", "B2"), h3Finding("conflict-b4", "B4")],
  adverse: [
    h3Finding("adverse-b1", "B1", { ceuPerWeek: 10 }),
    h3Finding("adverse-b2", "B2", { ceuPerWeek: 12 }),
  ],
  falsePositive: [h3Finding("false-positive", "B2", { ceuPerWeek: 0 })],
  b1Unclassified: [h3Finding("b1-only", "B1")],
  unsupportedB5: [h3Finding("b5-unsupported", "B1", { detectorId: "B5" })],
  unsupportedA6: [h3Finding("a6-unsupported", "B1", { detectorId: "A6" })],
} as const;

export const h3CapabilityProfile = (
  verdict: "SUPPORTED" | "UNSUPPORTED" | "UNKNOWN" | "CONTRADICTED" = "SUPPORTED",
): CapabilityProfile => ({
  id: "h3-profile",
  version: "h3-profile-1",
  claudeCodeVersion: "2.1.260",
  platform: "WINDOWS",
  workspaceScope: "WORKSPACE",
  createdAt: "2026-09-17T00:00:00.000Z",
  expiresAt: "2026-09-18T00:00:00.000Z",
  observations: [
    {
      capability: "claude-md-project-rules",
      verdict,
      source: "VERSION_GATE",
      canaryVersion: null,
      observedAt: "2026-09-17T01:00:00.000Z",
    },
  ],
});
