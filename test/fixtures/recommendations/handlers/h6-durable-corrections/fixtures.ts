import type { CapabilityProfile } from "../../../../../src/recommendations/capabilities.js";
import type { EngineFinding } from "../../../../../src/recommendations/correlation.js";

export const H6_NOW = "2026-09-17T18:00:00.000Z";
export const H6_WINDOW = {
  from: "2026-09-10T18:00:00.000Z",
  to: "2026-09-17T17:00:00.000Z",
} as const;

export const h6Finding = (
  id: string,
  detectorId: "D1" | "D4" | "D5" = "D4",
  changes: Partial<EngineFinding> = {},
): EngineFinding => ({
  id: id as EngineFinding["id"],
  detectorId,
  schemaVersion: 2,
  observedAt: "2026-09-16T18:00:00.000Z",
  correlationKey: "durable-correction-1",
  ceuPoolId: "correction-pool-1" as EngineFinding["ceuPoolId"],
  ceuPerWeek: 12,
  confidence: 0.9,
  ...changes,
});

export const H6_FINDING_CORPUS = {
  healthyNoChange: [] as readonly EngineFinding[],
  actionableBroad: [h6Finding("d1-actionable", "D1")],
  actionableModel: [h6Finding("d4-actionable", "D4")],
  actionableBudget: [h6Finding("d5-actionable", "D5")],
  actionableMixed: [h6Finding("d1-mixed", "D1"), h6Finding("d4-mixed", "D4")],
  actionableBothNarrow: [h6Finding("d4-both", "D4"), h6Finding("d5-both", "D5")],
  sparse: [h6Finding("sparse", "D4", { ceuPerWeek: null })],
  conflicting: [
    h6Finding("conflict-d4", "D4", { correlationKey: "durable-correction-1" }),
    h6Finding("conflict-d5", "D5", { correlationKey: "durable-correction-2" }),
  ],
  adverse: [h6Finding("adverse", "D4", { ceuPerWeek: 0 })],
  duplicate: [h6Finding("duplicate-a", "D4"), h6Finding("duplicate-b", "D4")],
  versionMismatch: [h6Finding("version-mismatch", "D4", { schemaVersion: 1 })],
  unsupportedD2: [h6Finding("d2-unsupported", "D4", { detectorId: "D2" })],
  unsupportedRetiredD3: [h6Finding("d3-retired", "D4", { detectorId: "D3" })],
} as const;

export const h6CapabilityProfile = (
  verdict: "SUPPORTED" | "UNSUPPORTED" | "UNKNOWN" | "CONTRADICTED" = "SUPPORTED",
): CapabilityProfile => ({
  id: "h6-profile",
  version: "h6-profile-1",
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
