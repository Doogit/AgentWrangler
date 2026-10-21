import { describe, expect, it } from "vitest";
import { registeredFindingDescriptors } from "../../src/detector/finding-registry.js";
import { RECOMMENDATION_TEMPLATES } from "../../src/detector/privacy-contract.js";
import { ERROR_DETECTOR_IDS } from "../../src/query/api/rec-actions/families/errors.js";
import { PERMISSIONS_DETECTOR_IDS } from "../../src/query/api/rec-actions/families/permissions.js";
import { ROUTING_DETECTOR_IDS } from "../../src/query/api/rec-actions/families/routing.js";
import { buildCardActions } from "../../src/query/api/rec-actions/index.js";

const FAMILY_IDS: readonly string[] = [
  ...ERROR_DETECTOR_IDS,
  ...PERMISSIONS_DETECTOR_IDS,
  ...ROUTING_DETECTOR_IDS,
];

// Facts that select a template's own action branch when a detector has several templates.
const TEMPLATE_FACTS: Record<string, Record<string, unknown>> = {
  D7_CROSS_SESSION_REREAD: { redundant_path_count: 3, total_redundant_read_count: 9 },
};

// Branches that change the action shape, so each one is checked too.
const VARIANT_METRICS: Record<string, Array<Record<string, { value: unknown }>>> = {
  C9: [{}, { DENIAL_CLASS: { value: "HOOK_BLOCK" } }],
  D14: [{}, { INTERRUPT_KIND: { value: "PURE_INTERRUPT" } }],
  H1: [{}, { DESTRUCTIVE_OPERATION: { value: "RM_RF" } }],
};

const contracts = [
  ...registeredFindingDescriptors().map((descriptor) => ({
    source: descriptor.rule_id,
    detector: descriptor.owner_detector_id,
    metric: descriptor.presentation.target_metric,
    facts: {} as Record<string, unknown>,
  })),
  ...Object.entries(RECOMMENDATION_TEMPLATES).map(([id, template]) => ({
    source: id,
    detector: template.detector_id as string,
    metric: template.target_metric as string,
    facts: TEMPLATE_FACTS[id] ?? {},
  })),
].filter((contract) => FAMILY_IDS.includes(contract.detector));

describe("errors, permissions and routing actions carry the contract target metric", () => {
  it("has a contract for every detector in these families", () => {
    expect(new Set(contracts.map((contract) => contract.detector))).toEqual(new Set(FAMILY_IDS));
  });

  it.each(contracts)("$source → $metric", ({ detector, metric, facts }) => {
    for (const metrics of VARIANT_METRICS[detector] ?? [{}]) {
      const actions = buildCardActions({
        detector_id: detector,
        lever: "lever",
        evidence: { metrics },
        facts: { session_ids: ["session-1"], ...facts },
      });
      for (const option of [actions.primary, ...actions.alternatives]) {
        expect(option.target_metric).toBe(metric);
      }
    }
  });
});
