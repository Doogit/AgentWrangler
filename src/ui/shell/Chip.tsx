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
  LIST_EQUIV: "LIST_EQUIV",
  LIST_EQUIV_STALE: "STALE",
  PROXY: "PROXY",
  OBS_PROXY: "OBS PROXY ±9% BPE",
  EXPERIMENTAL: "EXPERIMENTAL",
  DIRECTIONAL: "DIRECTIONAL",
  N_A: "N/A",
  EXACT: "EXACT",
  LIVE: "LIVE",
  MODELED: "MODELED",
  PASS: "PASS",
  ATTENTION: "ATTENTION",
  NO_DATA: "NO DATA",
  VERIFIED_SOURCE: "VERIFIED SOURCE",
};

export const KIND_TOOLTIP: Record<ChipProps["kind"], string> = {
  LIST_EQUIV: "LIST_EQUIV: modeled USD equivalent using list pricing; not billed spend.",
  OBS_PROXY: "OBS_PROXY: observed token usage with an approximate BPE conversion.",
  EXPERIMENTAL:
    "EXPERIMENTAL: directional evidence from a methodology that is still under validation.",
  DIRECTIONAL:
    "DIRECTIONAL: coarse band derived from observed counts — not a precision score. Thresholds are declared in the friction tooltip.",
  EXACT: "EXACT: directly measured from observed session data.",
  PROXY: "PROXY: derived estimate used where direct measurement is unavailable.",
  MODELED: "MODELED: projected outcome from a model, not achieved savings.",
  N_A: "N/A: metric is defined, but no value is available.",
  LIVE: "LIVE: session is currently active.",
  LIST_EQUIV_STALE: "STALE: list-price equivalent based on pricing data that may be outdated.",
  PASS: "PASS: this practice is being followed based on the current measurement signal.",
  ATTENTION:
    "ATTENTION: this practice may need review — the signal is outside its declared threshold.",
  NO_DATA: "NO DATA: not enough signal in this window to evaluate this practice.",
  VERIFIED_SOURCE:
    "VERIFIED SOURCE: this citation links to the Anthropic documentation or blog post the practice is grounded in.",
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
