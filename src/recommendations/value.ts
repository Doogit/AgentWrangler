import type { CorrelationLink, EngineFinding } from "./correlation.js";
import { type ValueFactor, estimateSavingsUsdPerWeek } from "./ranking-policy.js";

export interface ValueContext {
  readonly ceuProvenance: Omit<ValueFactor, "value">;
  readonly confidenceProvenance: Omit<ValueFactor, "value">;
  readonly price: ValueFactor;
  readonly applicability: ValueFactor;
  readonly expectedEffect: ValueFactor;
}

export function composeExpectedValue(
  findings: readonly EngineFinding[],
  links: readonly CorrelationLink[],
  context: ValueContext,
): number | null {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const primary = links.filter((link) => link.role === "PRIMARY");
  if (
    primary.length === 0 ||
    primary.some((link) => !Number.isSafeInteger(link.contributionCeuPerWeek * 1_000_000))
  )
    return null;
  const estimates = primary.map((link) => {
    const confidence = byId.get(link.findingId)?.confidence;
    if (
      confidence === null ||
      confidence === undefined ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      !Number.isFinite(link.contributionCeuPerWeek)
    )
      return null;
    return estimateSavingsUsdPerWeek({
      exclusivePoolCeuPerWeek: { ...context.ceuProvenance, value: link.contributionCeuPerWeek },
      listPriceUsdPerCeu: context.price,
      detectorConfidence: { ...context.confidenceProvenance, value: confidence },
      handlerApplicability: context.applicability,
      expectedEffectFraction: context.expectedEffect,
    });
  });
  if (estimates.some((estimate) => estimate === null)) return null;
  const total = (estimates as readonly number[]).reduce((sum, estimate) => sum + estimate, 0);
  return Number.isFinite(total) ? total : null;
}
