/**
 * scripts/parity/rubric.ts
 *
 * §6 actionable-recommendation standard — FROZEN rubric.
 *
 * This is FIXED INPUT to Gauge-1 scoring. It must NOT be derived from any
 * engine output; it is authored once and never modified per session.
 *
 * Source: PRODUCT-DIRECTION.md §6 "The actionable-recommendation standard"
 */

export interface RubricItem {
  id: string;
  label: string;
  description: string;
}

/**
 * The 7-point §6 checklist. Frozen — do not reorder, rename ids, or modify
 * descriptions based on engine output.
 */
export const RUBRIC: readonly RubricItem[] = [
  {
    id: "R1",
    label: "Grounded scope",
    description:
      "Names the real workspace and ≥1 real session id; every surface (card/prompt/artifact) " +
      "carries the same evidence. Nothing withheld from the prompt that the card showed.",
  },
  {
    id: "R2",
    label: "Quantified",
    description:
      "At least one measured quantity (tokens, CEU, event count, byte total) with its window. " +
      "Dollars only when the full chain resolves and unvalidated factors are labeled. " +
      "Missing chain surfaces as 'unquantified — ranked by signal strength', never silent.",
  },
  {
    id: "R3",
    label: "One concrete action",
    description: "Single imperative, executable today. Not a category or guidance code.",
  },
  {
    id: "R4",
    label: "Paste-able or installable artifact",
    description:
      "The actual CLAUDE.md rule text, settings.json diff, hook with install button, or prompt " +
      "embedding the evidence. If not generatable, the item is T3 attribution, not a recommendation.",
  },
  {
    id: "R5",
    label: "Rollback stated",
    description: "Wherever the action mutates anything, rollback is stated.",
  },
  {
    id: "R6",
    label: "Named before/after metric",
    description:
      "A specific metric named at issue time (e.g. cache-efficiency ratio, median result bytes) " +
      "so adoption can be measured.",
  },
  {
    id: "R7",
    label: "Zero generic advice sentences",
    description:
      "Every sentence carries a measured quantity or an artifact. No generic optimization prose.",
  },
] as const;

export type RubricItemId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";
export type RubricMark = "PASS" | "FAIL" | "PENDING";

/**
 * A scoresheet for one golden session: per-rubric mark + must-catch verdict.
 * Human fills in the marks after reviewing engine output vs prompt-arm output.
 */
export interface Scoresheet {
  session_id: string;
  /** The frozen must-catch from the golden set (null when scored ad-hoc via --sessions). */
  must_catch: string | null;
  rubric_marks: Record<RubricItemId, RubricMark>;
  must_catch_hit: boolean | null; // null = not yet scored
  notes: string;
}

export function emptyScoresheet(session_id: string, must_catch: string | null = null): Scoresheet {
  return {
    session_id,
    must_catch,
    rubric_marks: {
      R1: "PENDING",
      R2: "PENDING",
      R3: "PENDING",
      R4: "PENDING",
      R5: "PENDING",
      R6: "PENDING",
      R7: "PENDING",
    },
    must_catch_hit: null,
    notes: "",
  };
}
