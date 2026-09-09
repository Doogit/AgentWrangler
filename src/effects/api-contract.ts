import type { LegacyEffectCycle } from "./legacy.js";
import type { EffectCycle } from "./types.js";

export interface EffectCapability {
  mode: "TRACKABLE" | "MANUAL" | "ACKNOWLEDGEMENT" | "READ_ONLY";
  reason: string | null;
}

/** Bounded history pages; each stream has its own opaque continuation cursor. */
export interface EffectEvidencePage {
  writer_enabled: boolean;
  cycles: EffectCycle[];
  legacy: LegacyEffectCycle[];
  next_cycle_cursor: string | null;
  next_legacy_cursor: string | null;
}

export interface EffectProjection {
  effect_capability?: EffectCapability;
  effect_cycle?: EffectCycle | null;
}
