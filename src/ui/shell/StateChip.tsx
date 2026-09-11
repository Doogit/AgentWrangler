/**
 * Explicit measurement-state chips. These never use success or failure colors:
 * a state is a qualification, not an outcome.
 */
export type StateChipKind =
  | "UNKNOWN"
  | "UNREPORTED"
  | "UNAVAILABLE"
  | "PENDING"
  | "INSUFFICIENT"
  | "LIVE_EXCLUDED";

export interface StateChipProps {
  kind: StateChipKind;
  reason?: string;
  n?: number;
  gate?: number;
}

const KIND_CLASS: Record<StateChipKind, string> = {
  UNKNOWN: "state-chip-unknown chip-experimental",
  UNREPORTED: "state-chip-unreported chip-directional",
  UNAVAILABLE: "state-chip-unavailable chip-na",
  PENDING: "state-chip-pending chip-obs-proxy",
  INSUFFICIENT: "state-chip-insufficient chip-stale",
  LIVE_EXCLUDED: "state-chip-live-excluded chip-live",
};

function label({ kind, reason, n, gate }: StateChipProps): string {
  switch (kind) {
    case "UNKNOWN":
      return "UNKNOWN";
    case "UNREPORTED":
      return "UNREPORTED";
    case "UNAVAILABLE":
      return `UNAVAILABLE${reason ? ` — ${reason}` : ""}`;
    case "PENDING":
      return `PENDING — ${n ?? 0} of ${gate ?? "?"} gate`;
    case "INSUFFICIENT":
      return `INSUFFICIENT — ${n ?? 0} < ${gate ?? "?"} gate`;
    case "LIVE_EXCLUDED":
      return "LIVE EXCLUDED";
  }
}

export default function StateChip(props: StateChipProps) {
  const text = label(props);
  return (
    // biome-ignore lint/a11y/useSemanticElements: status badge has text and status semantics; output semantics differ
    <span className={`chip ${KIND_CLASS[props.kind]}`} role="status" aria-label={text}>
      {text}
    </span>
  );
}
