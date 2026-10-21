import type { EngineFinding } from "../../../../../src/recommendations/correlation.js";
import type {
  H5PermissionEvidenceV1,
  H5PermissionRules,
  H5PermissionScope,
  H5ScopedRules,
} from "../../../../../src/recommendations/handlers/h5-permission-friction/index.js";

export const H5_NOW = "2026-09-16T00:00:00.000Z";
export const H5_FINDING_ID = `finding:${"a".repeat(64)}`;

const emptyRules = (): H5PermissionRules => ({ allow: [], ask: [], deny: [] });

export const emptySettings = (): H5ScopedRules => ({
  MANAGED: emptyRules(),
  CLI: emptyRules(),
  PROJECT_LOCAL: emptyRules(),
  PROJECT_SHARED: emptyRules(),
  USER: emptyRules(),
});

export const withRule = (
  scope: H5PermissionScope,
  effect: keyof H5PermissionRules,
  permission: "Read" | "Grep" | "Glob" = "Read",
): H5ScopedRules => {
  const settings = emptySettings();
  return {
    ...settings,
    [scope]: { ...settings[scope], [effect]: [permission] },
  };
};

export const h5Evidence = (
  changes: Partial<H5PermissionEvidenceV1> = {},
): H5PermissionEvidenceV1 => ({
  schemaVersion: 1,
  findingId: H5_FINDING_ID,
  detectorId: "C9",
  eventClass: "REPEATED_APPROVAL",
  permission: "Read",
  targetClass: "PROJECT_FILES",
  operationRisk: "READ_ONLY",
  occurrenceCount: 2,
  inProject: true,
  readOnly: true,
  sideEffectFree: true,
  broadWildcard: false,
  h9Evasion: false,
  interrupted: false,
  promptShown: true,
  settings: emptySettings(),
  ...changes,
});

export const h5Finding = (changes: Partial<EngineFinding> = {}): EngineFinding => ({
  id: H5_FINDING_ID as EngineFinding["id"],
  detectorId: "C9",
  schemaVersion: 2,
  observedAt: H5_NOW,
  correlationKey: "permission-friction",
  ceuPoolId: "permission-friction-pool" as EngineFinding["ceuPoolId"],
  ceuPerWeek: 3,
  confidence: 0.95,
  ...changes,
});
