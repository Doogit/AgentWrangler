import { type ReactNode, useEffect, useRef, useState } from "react";
import LoadBoundary from "./LoadBoundary";
import { SkeletonChart } from "./Skeleton";

/**
 * Mount a chart one task after its page commits, behind a same-height skeleton. A route's first
 * render plus a recharts mount in one task ran over the 50 ms long-task bar (M17); split, each fits.
 * The chart gets a fixed pixel width, kept current by a ResizeObserver: `ResponsiveContainer`
 * measures in its mount effect, which forces a layout inside the chart's task.
 */
export function ChartAfterPaint({
  children,
  height,
}: {
  children: (width: number) => ReactNode;
  height: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    // After a frame, not in the effect: React flushes a click's effects in the same task, and
    // once the skeleton is laid out, reading its width forces no layout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => setWidth(Math.floor(box.current?.clientWidth ?? 0)), 0);
    });
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect.width;
            if (w !== undefined) setWidth((prev) => (prev === null ? prev : Math.floor(w)));
          });
    if (box.current) observer?.observe(box.current);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      observer?.disconnect();
    };
  }, []);
  return (
    <div ref={box} style={{ minHeight: height }}>
      {width !== null ? children(width) : <SkeletonChart height={height} />}
    </div>
  );
}

/** Render children one task after mount: splits a chart's series from its frame (M17). */
export function NextTask({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 0);
    return () => clearTimeout(timer);
  }, []);
  return ready ? children : null;
}

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
        <button
          type="button"
          onClick={() => setVisible(true)}
          aria-label={`Load ${label}`}
          style={{ width: "100%", padding: 0, border: 0, background: "transparent" }}
        >
          <SkeletonChart />
        </button>
      )}
    </div>
  );
}
