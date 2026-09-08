/**
 * src/ui/shell/Chip.tsx — Honesty chip component.
 *
 * Every chip MUST pair a color with a text label (WCAG 1.4.1 / SC 4.1.3).
 * Never render color-only indicators.
 *
 * Claim kinds that have their own CSS class:
 *   - LIST_EQUIV  → .chip-list-equiv (teal — distinct from PARTIAL/amber)
 *   - STALE       → .chip-stale (amber warning badge)
 *   - PROXY       → .chip-proxy (red/salmon)
 *   - OBS_PROXY   → .chip-obs-proxy (cyan, with ±BPE label)
 *   - EXPERIMENTAL→ .chip-experimental (blue)
 *   - N/A         → .chip-na (grey)
 *   - EXACT       → .chip-exact (green)
 *   - LIVE        → .chip-live (orange)
 *   - MODELED     → .chip-modeled (purple — UI-only display chip, NOT a ClaimKind)
 */

export interface ChipProps {
  /** The honesty claim kind, or a custom display variant. */
  kind:
    | "LIST_EQUIV"
    | "LIST_EQUIV_STALE"
    | "PROXY"
    | "OBS_PROXY"
    | "EXPERIMENTAL"
    | "DIRECTIONAL"
    | "N_A"
    | "EXACT"
    | "LIVE"
    | "MODELED"
    | "PASS"
    | "ATTENTION"
    | "NO_DATA"
    | "VERIFIED_SOURCE";
  /** Override the label text. Defaults to the canonical label for the kind. */
  label?: string;
  /** Optional explanation shown by the browser tooltip. */
  title?: string;
}

const KIND_CLASS: Record<ChipProps["kind"], string> = {
  LIST_EQUIV: "chip-list-equiv",
  LIST_EQUIV_STALE: "chip-stale",
  PROXY: "chip-proxy",
  OBS_PROXY: "chip-obs-proxy",
  EXPERIMENTAL: "chip-experimental",
  DIRECTIONAL: "chip-directional",
  N_A: "chip-na",
  EXACT: "chip-exact",
  LIVE: "chip-live",
  MODELED: "chip-modeled",
  // Practice scorecard status chips — reuse existing CSS color tokens.
  PASS: "chip-exact",
  ATTENTION: "chip-stale",
  NO_DATA: "chip-na",
  VERIFIED_SOURCE: "chip-list-equiv",
};

const KIND_LABEL: Record<ChipProps["kind"], string> = {
  LIST_EQUIV: "ESTIMATED VALUE",
  LIST_EQUIV_STALE: "PRICE ESTIMATE MAY BE OLD",
  PROXY: "ESTIMATE",
  OBS_PROXY: "TOKEN-BASED ESTIMATE",
  EXPERIMENTAL: "EARLY ESTIMATE",
  DIRECTIONAL: "TREND ONLY",
  N_A: "NO DATA",
  EXACT: "MEASURED",
  LIVE: "LIVE",
  MODELED: "PROJECTED",
  PASS: "ON TRACK",
  ATTENTION: "REVIEW",
  NO_DATA: "NO DATA",
  VERIFIED_SOURCE: "VERIFIED SOURCE",
};

export const KIND_TOOLTIP: Record<ChipProps["kind"], string> = {
  LIST_EQUIV: "Estimated value at public API list prices. This is not your billed spend.",
  OBS_PROXY: "Token-based estimate from observed use. It may differ from the exact token count.",
  EXPERIMENTAL: "Early estimate from a method that is still being checked.",
  DIRECTIONAL: "Trend only: a broad signal from observed counts, not a precise measurement.",
  EXACT: "Measured directly from recorded session data.",
  PROXY: "Estimate used when a direct measurement is unavailable.",
  MODELED: "Projected outcome from a model, not a result that has happened yet.",
  N_A: "This measure is available here, but there is no value yet.",
  LIVE: "LIVE: session is currently active.",
  LIST_EQUIV_STALE: "Estimated value based on public API prices that may be out of date.",
  PASS: "This practice is on track based on the current measurement signal.",
  ATTENTION: "Review this practice: the current signal is outside its stated range.",
  NO_DATA: "There is not enough activity in this period to assess this practice.",
  VERIFIED_SOURCE:
    "Source checked: this links to the Anthropic documentation or post behind the practice.",
};

export default function Chip({ kind, label, title }: ChipProps) {
  return (
    <span
      className={`chip ${KIND_CLASS[kind]}`}
      // biome-ignore lint/a11y/useSemanticElements: chip badge uses role="status"; <output> semantics differ
      role="status"
      aria-label={KIND_LABEL[kind]}
      title={title ?? KIND_TOOLTIP[kind]}
    >
      {label ?? KIND_LABEL[kind]}
    </span>
  );
}
