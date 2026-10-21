import type { ReactNode } from "react";

export interface SignalRow {
  label: string;
  value: ReactNode;
  valueTestId?: string;
  /** Short tag such as "High" or "Look"; omitted for context-only rows. */
  level?: string;
  tone?: "red" | "amber" | "green";
  /** Lower ranks sort first; ties keep their given order. */
  rank: number;
  found: ReactNode;
  why: string;
}

/** Expandable rows, most important first: the summary shows the value, the body says why it matters. */
export function SignalRows({ rows }: { rows: SignalRow[] }) {
  const sorted = [...rows].sort((a, b) => a.rank - b.rank);
  return (
    <div className="signal-list">
      {sorted.map((row) => (
        <details className="signal-row" key={row.label} data-tone={row.tone}>
          <summary>
            <span className="signal-label">{row.label}</span>
            <span className="signal-value" data-testid={row.valueTestId}>
              {row.value}
            </span>
            {row.level !== undefined && <span className="signal-level">{row.level}</span>}
          </summary>
          <div className="signal-body">
            <p>
              <strong>What we found.</strong> {row.found}
            </p>
            <p>
              <strong>Why it matters.</strong> {row.why}
            </p>
          </div>
        </details>
      ))}
    </div>
  );
}
