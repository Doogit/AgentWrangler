import { useEffect, useState } from "react";
import type {
  AggregateEvidence,
  EffectCycle,
  GuardrailObservation,
  ObservationBundle,
} from "../../effects/types";
import Chip from "../shell/Chip";
import StateChip from "../shell/StateChip";

function date(value: string | null): string {
  return value === null ? "not recorded" : value.slice(0, 10);
}

function value(value: number | null, unit: string): string {
  return value === null ? "unavailable" : `${value.toLocaleString("en-US")} ${unit}`;
}

function evidenceFor(cycle: EffectCycle): { evidence: ObservationBundle | null; label: string } {
  if (cycle.finalEvidence !== null)
    return { evidence: cycle.finalEvidence, label: "Final evidence" };
  if (cycle.provisionalEvidence !== null)
    return { evidence: cycle.provisionalEvidence, label: "Provisional evidence" };
  return { evidence: null, label: "Evidence not yet available" };
}

function cycleTimelineLabel(cycle: EffectCycle): string {
  const target =
    cycle.targetDirection === null
      ? "target UNREPORTED"
      : `target ${cycle.targetDirection.toLocaleLowerCase("en-US")}`;
  return `#${cycle.cycleNo} ${cycle.state.replaceAll("_", " ")} · ${target}`;
}

function uniqueCycles(cycles: readonly EffectCycle[]): EffectCycle[] {
  return cycles.filter(
    (cycle, index) =>
      cycles.findIndex((candidate) => candidate.cycleId === cycle.cycleId) === index,
  );
}

function mixText(mix: ObservationBundle["modelMix"]["before"]): string {
  if (!mix.available || mix.total === 0) return "unavailable";
  return Object.entries(mix.counts)
    .map(
      ([model, count]) =>
        `${model}: ${count} / ${mix.total} turns (${((count / mix.total) * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%)`,
    )
    .join(", ");
}

function evidenceSummary(
  label: string,
  evidence: ObservationBundle | null,
  aggregate: AggregateEvidence | null,
  cycle: EffectCycle,
) {
  if (evidence === null || aggregate === null) return <p>{label}: unavailable.</p>;
  const excluded = Object.entries(aggregate.excluded)
    .map(([reason, count]) => `${reason}: ${count.toLocaleString()}`)
    .join(", ");
  return (
    <>
      <p>
        {label}: observed aggregate value: {value(aggregate.value, cycle.targetDefinition.unit)}.
        {" Numerator is not separately recorded. Denominator: "}
        {aggregate.denominator === null ? "unavailable" : aggregate.denominator.toLocaleString()}.
        {" Distinct sessions: "}
        {aggregate.sessionN}. Exposures: {aggregate.exposureN}.
      </p>
      <p>
        Exclusions: {excluded || "none recorded"}. Method: {evidence.methodVersion}; query:{" "}
        {evidence.queryDefinitionVersion}.
      </p>
    </>
  );
}

function openProgress(cycle: EffectCycle, evidence: ObservationBundle | null) {
  const start = new Date(cycle.observationFrom).getTime();
  const end = new Date(cycle.scheduledObservationTo).getTime();
  const totalDays = Math.max(1, Math.ceil((end - start) / 86_400_000));
  const elapsedDays = Math.max(
    1,
    Math.min(totalDays, Math.ceil((Date.now() - start) / 86_400_000)),
  );
  const sessions = evidence?.after.sessionN ?? 0;
  const gate = cycle.targetDefinition.minimumSessions;
  return {
    text: `Measuring · day ${elapsedDays} of ${totalDays} · after-window sessions ${sessions}/${gate ?? "UNKNOWN"}`,
    sessions,
    gate,
  };
}

function targetDelta(cycle: EffectCycle, evidence: ObservationBundle | null): number | null {
  const before = evidence?.before.value;
  const after = evidence?.after.value;
  if (before === null || before === undefined || after === null || after === undefined) return null;
  if (cycle.targetDefinition.deltaSemantics === "PERCENTAGE_POINTS") return after - before;
  if (before === 0) return null;
  return ((after - before) / Math.abs(before)) * 100;
}

function formatDelta(delta: number | null, cycle: EffectCycle): string {
  if (delta === null) return "UNAVAILABLE";
  const suffix = cycle.targetDefinition.deltaSemantics === "PERCENTAGE_POINTS" ? " pp" : "%";
  return `${delta >= 0 ? "+" : ""}${delta.toLocaleString("en-US", { maximumFractionDigits: 1 })}${suffix}`;
}

function TargetStrip({
  cycle,
  evidence,
}: { cycle: EffectCycle; evidence: ObservationBundle | null }) {
  const delta = targetDelta(cycle, evidence);
  // Frozen contracts store signed directional thresholds. Some measures improve
  // when they decrease (for example D1), while others improve when they rise
  // (for example D4), so the display range must be ordered rather than negated.
  const lower = Math.min(
    cycle.targetDefinition.worseningThreshold,
    cycle.targetDefinition.improvementThreshold,
  );
  const upper = Math.max(
    cycle.targetDefinition.worseningThreshold,
    cycle.targetDefinition.improvementThreshold,
  );
  const direction = cycle.targetDirection ?? "INSUFFICIENT_DATA";
  const blocked = (evidence?.guardrails ?? []).some(
    (guardrail) =>
      guardrail.availability === "UNSUPPORTED" ||
      guardrail.direction === "ADVERSE" ||
      guardrail.direction === "INSUFFICIENT_DATA",
  );
  // The material-change band occupies the middle half of the strip. This leaves
  // visible space on both sides for a measured improvement or worsening.
  const position =
    delta === null
      ? 50
      : Math.max(0, Math.min(100, ((delta - lower * 2) / (upper * 2 - lower * 2 || 1)) * 100));
  const dotColor = blocked
    ? "var(--amber)"
    : direction === "IMPROVED"
      ? "var(--cyan)"
      : direction === "WORSENED"
        ? "var(--red)"
        : "var(--text-2)";
  return (
    <section className="effect-verdict-lane effect-target-lane" aria-label="Target verdict">
      <h4>Target</h4>
      <div
        className={`effect-target-strip ${blocked ? "effect-target-strip-blocked" : ""}`}
        style={{
          position: "relative",
          display: "grid",
          alignItems: "center",
          minHeight: "2.5rem",
          padding: "0.4rem 0.5rem",
          border: "1px solid var(--line)",
          borderRadius: "0.35rem",
        }}
        aria-label={`Target ${direction}. Delta ${formatDelta(delta, cycle)} against material-change band ${formatDelta(lower, cycle)} to ${formatDelta(upper, cycle)}.`}
      >
        <span
          className="effect-target-band"
          aria-hidden="true"
          style={{
            position: "absolute",
            insetBlock: "0.35rem",
            left: "25%",
            width: "50%",
            borderRadius: "0.2rem",
            background: "rgba(184, 160, 255, 0.18)",
          }}
        >
          material-change band {formatDelta(lower, cycle)} to {formatDelta(upper, cycle)}
        </span>
        <span
          className="effect-target-dot"
          style={{
            position: "absolute",
            left: `calc(${position}% - 0.35rem)`,
            color: dotColor,
            zIndex: 1,
          }}
          aria-hidden="true"
        >
          ●
        </span>
        <span className="effect-target-strip-label" style={{ position: "relative", zIndex: 2 }}>
          {direction} · dot {formatDelta(delta, cycle)}
        </span>
      </div>
      {blocked && <p>Target is not styled as a success: a guardrail is adverse or unsupported.</p>}
    </section>
  );
}

function directionChip(direction: GuardrailObservation["direction"]) {
  const kind = direction === "ADVERSE" ? "PROXY" : "DIRECTIONAL";
  return <Chip kind={kind} label={direction.replaceAll("_", " ")} title="Guardrail direction." />;
}

function Guardrails({
  cycle,
  evidence,
}: { cycle: EffectCycle; evidence: ObservationBundle | null }) {
  const guards = evidence?.guardrails ?? [];
  return (
    <section className="effect-verdict-lane" aria-label="Guardrail verdict">
      <h4>Guardrails</h4>
      {cycle.guardrailDefinitions.map((definition) => {
        const guardrail = guards.find((item) => item.guardrailId === definition.guardrailId);
        if (guardrail === undefined)
          return (
            <p key={definition.guardrailId}>
              <strong>{definition.guardrailId}</strong>: <StateChip kind="UNREPORTED" />
            </p>
          );
        if (guardrail.availability === "UNSUPPORTED")
          return (
            <p key={definition.guardrailId}>
              <strong>{definition.guardrailId}</strong>:{" "}
              <StateChip
                kind="UNAVAILABLE"
                reason={guardrail.reasonCodes.join(", ") || "guardrail is unsupported"}
              />
            </p>
          );
        return (
          <p key={definition.guardrailId}>
            <strong>{definition.guardrailId}</strong>:{" "}
            {value(guardrail.before.value, definition.unit)} →{" "}
            {value(guardrail.after.value, definition.unit)} {directionChip(guardrail.direction)}
            {guardrail.reasonCodes.length > 0 && ` · ${guardrail.reasonCodes.join(", ")}`}
          </p>
        );
      })}
      {cycle.guardrailDefinitions.length === 0 && (
        <StateChip kind="UNAVAILABLE" reason="no guardrails are defined" />
      )}
    </section>
  );
}

function Comparability({ cycle }: { cycle: EffectCycle }) {
  return (
    <section className="effect-verdict-lane" aria-label="Comparability verdict">
      <h4>Comparability</h4>
      {cycle.comparisonStatus === null ? (
        <StateChip kind="PENDING" n={0} gate={1} />
      ) : (
        <Chip kind="DIRECTIONAL" label={cycle.comparisonStatus} title="Comparison status." />
      )}
      <div className="chips">
        {cycle.comparisonReasons.length === 0 ? (
          <StateChip kind="UNREPORTED" />
        ) : (
          cycle.comparisonReasons.map((reason) => (
            <Chip key={reason} kind="N_A" label={reason} title="Recorded comparison reason." />
          ))
        )}
      </div>
    </section>
  );
}

/** Read-only rendering of one selected frozen versioned measurement cycle. */
export default function EffectEvidence({
  cycle: initialCycle,
  cycles,
  nextCycleCursor = null,
  onLoadMore,
  loadingMore = false,
}: {
  cycle: EffectCycle;
  /** Fetched pages for this recommendation, with later pages appended. */
  cycles?: readonly EffectCycle[];
  /** Opaque cursor is only used to disclose continuation availability. */
  nextCycleCursor?: string | null;
  onLoadMore?: () => void;
  loadingMore?: boolean;
}) {
  const timelineCycles = uniqueCycles(cycles ?? [initialCycle]);
  const [selectedCycleId, setSelectedCycleId] = useState(initialCycle.cycleId);

  useEffect(() => {
    if (!timelineCycles.some((item) => item.cycleId === selectedCycleId))
      setSelectedCycleId(timelineCycles[0]?.cycleId ?? initialCycle.cycleId);
  }, [initialCycle.cycleId, selectedCycleId, timelineCycles]);

  const cycle =
    timelineCycles.find((item) => item.cycleId === selectedCycleId) ??
    timelineCycles[0] ??
    initialCycle;
  const timeline = timelineCycles.length > 1 && (
    <section className="rec-section" aria-label="Measurement cycle timeline">
      <h4 className="rec-section-label">Measurement cycles</h4>
      <div className="chips">
        {timelineCycles.map((item) => {
          const label = cycleTimelineLabel(item);
          return (
            <button
              key={item.cycleId}
              type="button"
              className="rec-action-btn"
              aria-label={`${label}. Contract version ${item.contractVersion}.`}
              aria-pressed={item.cycleId === cycle.cycleId}
              onClick={() => setSelectedCycleId(item.cycleId)}
            >
              <Chip
                kind={item.cycleId === cycle.cycleId ? "DIRECTIONAL" : "N_A"}
                label={label}
                title={`Frozen contract version ${item.contractVersion}.`}
              />
            </button>
          );
        })}
      </div>
      {nextCycleCursor !== null && onLoadMore !== undefined && (
        <button
          type="button"
          className="rec-action-btn"
          onClick={onLoadMore}
          disabled={loadingMore}
        >
          {loadingMore ? "Loading more cycles…" : "Load more cycles"}
        </button>
      )}
    </section>
  );

  if (cycle.versionStatus === "UNSUPPORTED_VERSION") {
    return (
      <div className="ledger-row" data-testid="effect-evidence">
        {timeline}
        <span className="ledger-key">Versioned measurement</span>
        <span className="ledger-val">
          Cycle {cycle.cycleNo}:{" "}
          <StateChip kind="UNAVAILABLE" reason="unsupported version; read-only" /> Frozen evidence
          is not interpreted.
        </span>
        <span className="ledger-key">Contract version</span>
        <span className="ledger-val">{cycle.contractVersion}</span>
      </div>
    );
  }

  const { evidence, label } = evidenceFor(cycle);
  const open = cycle.state === "OPEN_SETTLING" || cycle.state === "OPEN_MEASURING";
  const progress = open ? openProgress(cycle, evidence) : null;

  return (
    <div data-testid="effect-evidence">
      {timeline}
      <div className="ledger-row">
        <span className="ledger-key">Versioned measurement</span>
        <span className="ledger-val">
          Cycle {cycle.cycleNo}: {open ? progress?.text : cycle.state.replaceAll("_", " ")}
        </span>
      </div>
      <div className="ledger-row">
        <span className="ledger-key">Contract version</span>
        <span className="ledger-val">{cycle.contractVersion}</span>
      </div>
      <div className="ledger-row">
        <span className="ledger-key">Evidence state</span>
        <span className="ledger-val">{label}</span>
      </div>
      {open &&
        progress?.gate !== null &&
        progress?.gate !== undefined &&
        progress.sessions < progress.gate && (
          <div className="ledger-row">
            <span className="ledger-key">Maturity</span>
            <span className="ledger-val">
              <StateChip kind="PENDING" n={progress.sessions} gate={progress.gate} />
            </span>
          </div>
        )}
      {!open && (
        <div className="effect-verdicts">
          <TargetStrip cycle={cycle} evidence={evidence} />
          <Guardrails cycle={cycle} evidence={evidence} />
          <Comparability cycle={cycle} />
        </div>
      )}
      <section className="rec-section" aria-label="Evidence and limits">
        <h4 className="rec-section-label">Evidence and limits</h4>
        <p style={{ overflowWrap: "anywhere" }}>
          Frozen cycle ID: {cycle.cycleId}. Workspace: {cycle.scope.workspaceId ?? "all"}.
          {cycle.scope.sourceIdentity && ` Source identity: ${cycle.scope.sourceIdentity}.`}
          {cycle.scope.tool && ` Tool: ${cycle.scope.tool}.`}
          {" Frozen cohort: "}
          {JSON.stringify(cycle.cohort)}.
        </p>
        <p>
          Baseline window: [{cycle.baselineFrom}, {cycle.baselineTo}); observation window: [
          {cycle.observationFrom}, {cycle.observationTo ?? cycle.scheduledObservationTo}). Boundary
          rule: {cycle.targetDefinition.boundaryRule}.{" Scheduled observation end: "}
          {cycle.scheduledObservationTo}.
        </p>
        {evidenceSummary("Baseline evidence", evidence, evidence?.before ?? null, cycle)}
        {evidenceSummary("Follow-up evidence", evidence, evidence?.after ?? null, cycle)}
        {evidence?.modelMix && (
          <p>
            Model mix (turn counts): baseline {mixText(evidence.modelMix.before)}. Follow-up{" "}
            {mixText(evidence.modelMix.after)}. Task mix remains subject to the recorded comparison
            limits.
          </p>
        )}
      </section>
      <div className="ledger-row">
        <span className="ledger-key">Rollback / attribution</span>
        <span className="ledger-val">
          Rollback: {cycle.rollbackStatus ?? "none"}
          {cycle.rollbackAt === null ? "" : ` (${date(cycle.rollbackAt)})`} · Attribution:{" "}
          {cycle.attributionClosedAt === null
            ? "open"
            : `closed ${date(cycle.attributionClosedAt)}`}
        </span>
      </div>
    </div>
  );
}
