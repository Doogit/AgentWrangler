/**
 * src/ui/shell/InfoTip.tsx — Hover and focus tooltip component.
 *
 * Tooltip bodies are mounted only while open so they stay out of both the
 * visual layout and the accessibility tree until a user requests them.
 */

import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";

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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const pointerWasOpen = useRef(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    if (!isOpen) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      const bubble = tooltipRef.current?.getBoundingClientRect();
      if (rect && bubble)
        setPosition({
          left: Math.max(8, Math.min(rect.left, window.innerWidth - bubble.width - 8)),
          top: Math.max(8, Math.min(rect.bottom, window.innerHeight - bubble.height - 8)),
        });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [isOpen]);

  return (
    <span
      style={{ display: "inline-block", position: "relative" }}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => {
        if (document.activeElement !== triggerRef.current) setIsOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-describedby={isOpen ? tooltipId : undefined}
        aria-label={label}
        onBlur={() => setIsOpen(false)}
        onPointerDown={() => {
          pointerWasOpen.current = isOpen && document.activeElement === triggerRef.current;
        }}
        onClick={() => {
          setIsOpen(!pointerWasOpen.current);
          pointerWasOpen.current = false;
        }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setIsOpen(false);
        }}
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
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          style={{
            background: "var(--panel2)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r)",
            boxShadow: "var(--shadow)",
            color: "var(--text)",
            fontSize: 13,
            left: position.left,
            lineHeight: 1.4,
            maxWidth: "min(260px, calc(100vw - 16px))",
            maxHeight: "calc(100dvh - 16px)",
            overflowY: "auto",
            padding: "8px 10px",
            position: "fixed",
            top: position.top,
            width: "max-content",
            zIndex: 20,
          }}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
