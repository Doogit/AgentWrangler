/**
 * Loaded-empty onboarding state for dashboard surfaces.
 *
 * This intentionally differs from daemon-error banners: it explains a
 * successful zero-row response and never implies a failed request.
 */

import type { CSSProperties } from "react";

export interface EmptyStateProps {
  headline: string;
  why: string;
  whatWillAppear: string;
  command?: string;
}

const ROOT_STYLE: CSSProperties = {
  alignItems: "flex-start",
  background: "var(--panel2)",
  border: "1px dashed var(--line)",
  borderRadius: 8,
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "20px 16px",
  textAlign: "left",
};

const COMMAND_STYLE: CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 999,
  color: "var(--text)",
  cursor: "copy",
  fontFamily: "var(--mono)",
  fontSize: 12,
  padding: "4px 8px",
};

export default function EmptyState({ headline, why, whatWillAppear, command }: EmptyStateProps) {
  const copyCommand = (commandToCopy: string) => {
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) return;
    void navigator.clipboard.writeText(commandToCopy).catch(() => undefined);
  };

  return (
    <section className="empty-state onboarding-empty-state" style={ROOT_STYLE} aria-live="polite">
      <h2 style={{ fontSize: 14, margin: 0 }}>{headline}</h2>
      <p className="empty-state-text" style={{ margin: 0 }}>
        {why}
      </p>
      <p className="empty-state-text" style={{ margin: 0 }}>
        {whatWillAppear}
      </p>
      {command !== undefined && (
        <button
          type="button"
          className="empty-state-command"
          style={COMMAND_STYLE}
          onClick={() => copyCommand(command)}
          aria-label={`Copy command: ${command}`}
          title="Copy command"
        >
          <code>{command}</code>
        </button>
      )}
    </section>
  );
}
