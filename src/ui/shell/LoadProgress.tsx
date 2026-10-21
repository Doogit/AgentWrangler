/**
 * src/ui/shell/LoadProgress.tsx — global build-progress card (R27).
 *
 * A small card meant to sit over a page's own skeleton while a slow, server-side build runs
 * (the daemon reports `{ stage, step, steps, started_at, expected_ms }`). Not page-specific:
 * any page whose data can take several seconds to build can reuse it. See DESIGN_GUIDE.md.
 *
 * Operator pick (2026-09-27, option B): a kicker + "Step n of N", the current stage name (a
 * short fade on change), one bar, and an elapsed/expected meta line.
 */

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "./Skeleton";

export interface LoadProgressProps {
  /** Kicker label, e.g. "Building diagnostics". Defaults to a generic label for reuse. */
  label?: string;
  /** Plain-English name of the running stage. */
  stage: string;
  /** Finished stages so far. */
  step: number;
  /** Total stages. */
  steps: number;
  /** ISO timestamp the build started. */
  startedAt: string;
  /** The last logged build duration for this shape of work, or null on a first build. */
  expectedMs: number | null;
}

export default function LoadProgress({
  label = "Loading",
  stage,
  step,
  steps,
  startedAt,
  expectedMs,
}: LoadProgressProps) {
  const reducedMotion = useReducedMotion();
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - Date.parse(startedAt)));
  useEffect(() => {
    const started = Date.parse(startedAt);
    const tick = () => setElapsedMs(Math.max(0, Date.now() - started));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const [swap, setSwap] = useState(false);
  const prevStage = useRef(stage);
  useEffect(() => {
    if (prevStage.current === stage) return;
    prevStage.current = stage;
    if (reducedMotion) return;
    setSwap(true);
    const id = setTimeout(() => setSwap(false), 300);
    return () => clearTimeout(id);
  }, [stage, reducedMotion]);

  const shownStep = Math.min(step + 1, steps);
  const pct =
    expectedMs !== null
      ? Math.min(95, (elapsedMs / expectedMs) * 100)
      : steps > 0
        ? (step / steps) * 100
        : 0;
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const usually = expectedMs !== null ? ` · usually ~${Math.round(expectedMs / 1000)} s` : "";

  return (
    // biome-ignore lint/a11y/useSemanticElements: build-progress card uses role="group"; <fieldset> semantics differ
    <div className="card load-progress" role="group" aria-label={label}>
      <div className="load-progress-top">
        <span className="label-caps">{label}</span>
        <span className="load-progress-step">
          Step {shownStep} of {steps}
        </span>
      </div>
      <div className={`load-progress-stage${swap ? " load-progress-stage-swap" : ""}`}>{stage}</div>
      {/* biome-ignore lint/a11y/useFocusableInteractive: non-interactive visual meter; making a progressbar focusable would be incorrect. */}
      <div
        className="meter load-progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={steps}
        aria-valuenow={step}
        aria-label={`${label} progress`}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="load-progress-meta">
        {elapsedSeconds} s{usually}
      </div>
      <div className="load-progress-sr" aria-live="polite">
        {stage}
      </div>
    </div>
  );
}
