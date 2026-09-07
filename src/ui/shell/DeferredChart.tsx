import { type ReactNode, useEffect, useRef, useState } from "react";
import LoadBoundary from "./LoadBoundary";

/** Load below-the-fold chart code on approach, or explicitly from the keyboard. */
export default function DeferredChart({
  children,
  label,
  ready = true,
}: { children: ReactNode; label: string; ready?: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    // A transient loading layout can put a below-the-fold chart in the viewport.
    if (visible || !ready) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, [visible, ready]);

  return (
    <div ref={element} style={{ minHeight: 320 }}>
      {visible ? (
        <LoadBoundary label={label}>{children}</LoadBoundary>
      ) : (
        <button type="button" onClick={() => setVisible(true)}>
          Load {label}
        </button>
      )}
    </div>
  );
}
