import type { JudgeRubric } from "../../query/api/judge-setup";

/** Color tone for a tier or check result. Drives `data-tone` in the .judge-* CSS. Never cyan. */
export type Tone = "green" | "blue" | "violet" | "amber" | "rose" | "plain";

/**
 * One color per tier, by its position in the rubric's `tier_names` (lowest first):
 * Drifter rose, Practitioner amber, Operator blue, Conductor green, God-tier violet.
 * The floors come from the API's rubric, never hardcoded here.
 */
const TIER_TONES: readonly Tone[] = ["rose", "amber", "blue", "green", "violet"];

function toneForTierIndex(index: number): Tone {
  return TIER_TONES[Math.min(Math.max(index, 0), TIER_TONES.length - 1)] ?? "plain";
}

export function tierTone(rubric: JudgeRubric, tier: string): Tone {
  const i = rubric.tier_names.indexOf(tier as (typeof rubric.tier_names)[number]);
  return i < 0 ? "plain" : toneForTierIndex(i);
}

/** Tier color of a 0-100 score, from the rubric's tier floors. */
export function scoreTone(rubric: JudgeRubric, score: number): Tone {
  let index = 0;
  rubric.tier_floors.forEach((floor, i) => {
    if (score >= floor) index = i;
  });
  return toneForTierIndex(index);
}
