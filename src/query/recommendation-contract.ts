import { findingDescriptor } from "../detector/finding-registry.js";
import {
  type FindingDescriptorV2,
  type FindingEnvelopeV2,
  type RecommendationPayloadV1,
  type RecommendationTemplateDefinition,
  assertFindingEnvelopeV2,
  assertRecommendationPayloadV1,
  recommendationTemplate,
} from "../detector/privacy-contract.js";

export interface PersistedRecommendationContractRow {
  detector_id: string | null;
  category: string | null;
  lever: string | null;
  target_metric: string;
  evidence_json: string;
  contract_version: number | null;
  template_id: string | null;
  contract_status: string;
  rule_id: string | null;
}

export interface TrustedRecommendationContractV1 {
  version: 1;
  payload: RecommendationPayloadV1;
  definition: RecommendationTemplateDefinition;
}

export interface TrustedRecommendationDefinition {
  detector_id: string;
  category: RecommendationTemplateDefinition["category"];
  lever: string;
  target_metric: string;
  formula_id: string;
  title_id: string;
  action_id: string;
  actionable: boolean;
  facts: RecommendationTemplateDefinition["facts"];
}

export interface TrustedRecommendationContractV2 {
  version: 2;
  payload: FindingEnvelopeV2;
  descriptor: FindingDescriptorV2;
  definition: TrustedRecommendationDefinition;
}

export type TrustedRecommendationContract =
  | TrustedRecommendationContractV1
  | TrustedRecommendationContractV2;

/** Fail-closed projection shared by every recommendation-derived read surface. */
export function trustedRecommendationContract(
  row: PersistedRecommendationContractRow,
  resolveDescriptor: (ruleId: string) => FindingDescriptorV2 | null = findingDescriptor,
): TrustedRecommendationContract | null {
  try {
    const parsed = JSON.parse(row.evidence_json) as unknown;
    if (
      row.contract_status === "V1_VALIDATED" &&
      row.contract_version === 1 &&
      row.template_id !== null &&
      row.detector_id !== null &&
      row.rule_id === null
    ) {
      assertRecommendationPayloadV1(parsed, row.detector_id);
      if (parsed.template_id !== row.template_id) return null;
      const definition = recommendationTemplate(parsed.template_id);
      if (
        definition.detector_id !== row.detector_id ||
        definition.category !== row.category ||
        definition.lever !== row.lever ||
        definition.target_metric !== row.target_metric
      )
        return null;
      return {
        version: 1,
        payload: parsed,
        definition,
      };
    }
    if (
      row.contract_status === "V2_VALIDATED" &&
      row.contract_version === 2 &&
      row.template_id === null &&
      row.detector_id !== null &&
      typeof row.rule_id === "string"
    ) {
      const descriptor = resolveDescriptor(row.rule_id);
      if (descriptor === null) return null;
      if (descriptor.owner_detector_id !== row.detector_id) return null;
      assertFindingEnvelopeV2(parsed, descriptor);
      if (parsed.rule_id !== row.rule_id) return null;
      if (
        descriptor.presentation.category !== row.category ||
        descriptor.presentation.lever !== row.lever ||
        descriptor.presentation.target_metric !== row.target_metric
      )
        return null;
      return {
        version: 2,
        payload: parsed,
        descriptor,
        definition: {
          detector_id: row.detector_id,
          category: descriptor.presentation.category,
          lever: descriptor.presentation.lever,
          target_metric: descriptor.presentation.target_metric,
          formula_id: `V2_${descriptor.rule_id}`,
          title_id: descriptor.presentation.title,
          action_id: `${descriptor.rule_id}_ACTION`,
          actionable: parsed.routing.tier !== "INVESTIGATE",
          facts: {},
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}
