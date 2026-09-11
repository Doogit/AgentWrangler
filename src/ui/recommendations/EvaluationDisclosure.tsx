import { type KeyboardEvent, useEffect, useRef } from "react";
import type { EffectCapability } from "../../effects/api-contract";
import type { EffectCycle } from "../../effects/types";
import type { RecommendationCard } from "../../query/api/recommendations";

type Props = {
  rec: RecommendationCard;
  cycle: EffectCycle | null;
  capability: EffectCapability | undefined;
  canRetrack: boolean;
  onClose: () => void;
};

function names(items: { guardrailId: string; methodVersion: string }[]): string {
  return items.length === 0
    ? "No guardrails are defined for this frozen cycle."
    : items.map((item) => `${item.guardrailId} (${item.methodVersion})`).join("; ");
}

function stopMeasurementStatus(
  cycle: EffectCycle | null,
  capability: EffectCapability | undefined,
): string {
  if (cycle?.versionStatus === "UNSUPPORTED_VERSION" || cycle?.state === "UNSUPPORTED") {
    return "unavailable because this cycle is unsupported and read-only.";
  }
  if (cycle !== null && cycle.state !== "OPEN_SETTLING" && cycle.state !== "OPEN_MEASURING") {
    return "unavailable because this cycle is closed.";
  }
  if (cycle !== null) return "available; it stops attribution and does not undo the action.";
  if (capability?.mode !== "TRACKABLE") {
    return "unavailable because this recommendation does not support tracked cycles.";
  }
  return "available after tracking starts; it does not undo the action.";
}

/** Explains the evaluation route without treating an action or proxy as an outcome. */
export default function EvaluationDisclosure({
  rec,
  cycle,
  capability,
  canRetrack,
  onClose,
}: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rollbackPending = cycle?.rollbackStatus === "PENDING";
  const supportsTracking = capability?.mode === "TRACKABLE";

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose();
  }

  return (
    <section className="rec-tracking-gate" aria-label="Evaluation" onKeyDown={handleKeyDown}>
      <h4 ref={headingRef} className="rec-section-label" tabIndex={-1}>
        Evaluation
      </h4>
      {cycle === null ? (
        <>
          <p>Not measured yet — confirm a completed change to start measurement</p>
          <details>
            <summary>Evaluation details</summary>
            <p>
              Target: {rec.target_metric}. A baseline and target method require a supported
              completed change to start a frozen cycle.
            </p>
            <p>
              Quality and repair guardrails need that cycle to record their typed definitions. A
              proxy or completed action is not an outcome.
            </p>
            <p>Comparability needs matching before and after windows to be frozen.</p>
            <p>Stop measurement: {stopMeasurementStatus(cycle, capability)}</p>
            <p>Rollback: no tracked rollback route yet.</p>
            <p>
              Retrack:{" "}
              {supportsTracking
                ? "available only after a terminal cycle, no rollback pending, and another supported completed change."
                : "unavailable because this recommendation does not support tracked cycles."}
            </p>
          </details>
        </>
      ) : (
        <>
          <p>
            Target: {cycle.targetDefinition.metricId} ({cycle.targetDefinition.methodVersion});{" "}
            {cycle.targetDefinition.aggregation} per {cycle.targetDefinition.sampleUnit}.
          </p>
          <p>Quality and repair guardrails: {names(cycle.guardrailDefinitions)}</p>
          <p>
            Comparability: {cycle.comparisonStatus ?? "pending"}
            {cycle.comparisonReasons.length > 0 ? ` (${cycle.comparisonReasons.join(", ")})` : ""}.
          </p>
          <p>Stop measurement: {stopMeasurementStatus(cycle, capability)}</p>
          <p>
            Rollback:{" "}
            {rollbackPending
              ? "pending."
              : "use the shown owned rollback or manual-reversion route; stopping measurement alone does not undo the action."}
          </p>
          <p>
            Retrack:{" "}
            {canRetrack
              ? "available for a new cycle with a new baseline."
              : supportsTracking
                ? "available only after a terminal cycle, no rollback pending, and another supported completed change."
                : "unavailable because this recommendation does not support tracked cycles."}
          </p>
        </>
      )}
      <button type="button" className="rec-action-btn" onClick={onClose}>
        Back
      </button>
    </section>
  );
}
