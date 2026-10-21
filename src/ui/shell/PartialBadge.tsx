/**
 * src/ui/shell/PartialBadge.tsx — Honesty badge for partial-data cards (U5).
 *
 * Renders on full-history-dependent cards while the background detector pipeline
 * (U3/U4) is still processing historical sessions. "may-change" is the cross-session
 * instability class in spec-detector-library.md §U5 (value could move either way). The
 * "incomplete" variant (Overview Sessions KPI) was removed in Task 9: the "This period"
 * coverage chip carries that caveat.
 *
 * SEC-101: static copy only — no raw transcript content.
 */

interface PartialBadgeProps {
  variant: "may-change";
}

/** Amber chip that appears on full-history-dependent cards during backfill. */
export default function PartialBadge({ variant }: PartialBadgeProps): React.ReactElement {
  return (
    <span className="chip unv chip-wrap" data-testid="partial-badge" data-variant={variant}>
      May change until full parse
    </span>
  );
}
