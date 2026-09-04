/**
 * src/ui/shell/InfoTip.tsx — Hover and focus tooltip component.
 *
 * Tooltip bodies are mounted only while open so they stay out of both the
 * visual layout and the accessibility tree until a user requests them.
 */

import { type ReactNode, useId, useState } from "react";

export interface InfoTipProps {
  /** Tooltip body. Caller keeps it <=2 sentences (what/why/what-do-I-do). */
  content: ReactNode;
  /** Optional dotted-underlined term to wrap; when absent, render a small circled-i (info glyph) button trigger. */
  children?: ReactNode;
  /** Accessible name for the trigger button (e.g. "What is Cache-write %?"). */
  label: string;
}

export default function InfoTip({ children, content, label }: InfoTipProps) {
  const [isOpen, setIsOpen] = useState(false);
  const tooltipId = `infotip-${useId().replace(/:/g, "")}`;

  return (
    <span style={{ display: "inline-block", position: "relative" }}>
      <button
        type="button"
        aria-describedby={isOpen ? tooltipId : undefined}
        aria-label={label}
        onBlur={() => setIsOpen(false)}
        onClick={() => setIsOpen((open) => !open)}
        onFocus={() => setIsOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setIsOpen(false);
        }}
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => setIsOpen(false)}
        style={
          children
            ? {
                background: "none",
                border: 0,
                color: "inherit",
                cursor: "help",
                font: "inherit",
                padding: 0,
                textDecoration: "underline dotted",
                textUnderlineOffset: 3,
              }
            : {
                alignItems: "center",
                background: "none",
                border: 0,
                borderRadius: "50%",
                color: "var(--muted)",
                cursor: "help",
                display: "inline-flex",
                fontSize: 14,
                height: 18,
                justifyContent: "center",
                padding: 0,
                width: 18,
              }
        }
      >
        {children ?? "ⓘ"}
      </button>
      {isOpen ? (
        <span
          id={tooltipId}
          role="tooltip"
          style={{
            background: "var(--panel2)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r)",
            boxShadow: "var(--shadow)",
            color: "var(--text)",
            fontSize: 12,
            left: 0,
            lineHeight: 1.4,
            marginTop: 6,
            maxWidth: 260,
            padding: "8px 10px",
            position: "absolute",
            top: "100%",
            width: "max-content",
            zIndex: 1,
          }}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
