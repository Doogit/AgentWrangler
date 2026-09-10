import type {
  AggregateEvidence,
  EffectCycle,
  GuardrailObservation,
  ObservationBundle,
} from "../../effects/types";

function date(value: string | null): string {
  return value === null ? "not recorded" : value.slice(0, 10);
}

function value(value: number | null, unit: string): string {
  return value === null ? "unavailable" : `${value.toLocaleString("en-US")} ${unit}`;
}

function evidenceFor(cycle: EffectCycle): ObservationBundle | null {
  return cycle.finalEvidence ?? cycle.provisionalEvidence;
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

function guardrailText(guardrail: GuardrailObservation | undefined, guardrailId: string): string {
  if (guardrail === undefined) return `${guardrailId}: visibility unavailable`;
  if (guardrail.availability === "UNSUPPORTED") return `${guardrailId}: unsupported`;
  if (guardrail.direction === "ADVERSE") return `${guardrailId}: adverse`;
  if (guardrail.direction === "INSUFFICIENT_DATA") return `${guardrailId}: insufficient data`;
  return `${guardrailId}: ${guardrail.direction.toLowerCase()}`;
}

/** Read-only rendering of one frozen versioned measurement cycle. */
export default function EffectEvidence({ cycle }: { cycle: EffectCycle }) {
  if (cycle.versionStatus === "UNSUPPORTED_VERSION") {
    return (
      <div className="ledger-row" data-testid="effect-evidence">
        <span className="ledger-key">Versioned measurement</span>
        <span className="ledger-val">
          Cycle {cycle.cycleNo}: unsupported version (read-only). Frozen evidence is not
          interpreted.
        </span>
      </div>
    );
  }

  const evidence = evidenceFor(cycle);
  const open = cycle.state === "OPEN_SETTLING" || cycle.state === "OPEN_MEASURING";
  const guards = evidence?.guardrails ?? [];

  return (
    <div data-testid="effect-evidence">
      <div className="ledger-row">
        <span className="ledger-key">Versioned measurement</span>
        <span className="ledger-val">
          Cycle {cycle.cycleNo}: {cycle.state.replaceAll("_", " ")}
          {open ? ` · Scheduled check: ${date(cycle.scheduledObservationTo)}` : ""}
        </span>
      </div>
      <div className="ledger-row">
        <span className="ledger-key">Target direction</span>
        <span className="ledger-val">{cycle.targetDirection ?? "not finalized"}</span>
      </div>
      <div className="ledger-row">
        <span className="ledger-key">Evidence</span>
        <span className="ledger-val">
          {evidence === null
            ? "not yet available"
            : `Baseline: ${value(evidence.before.value, cycle.targetDefinition.unit)} · Follow-up: ${value(evidence.after.value, cycle.targetDefinition.unit)}`}
        </span>
      </div>
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
        {guards
          .filter((guardrail) => guardrail.availability === "SUPPORTED")
          .map((guardrail) => (
            <p key={guardrail.guardrailId}>
              {guardrail.guardrailId}: baseline value:{" "}
              {value(
                guardrail.before?.value ?? null,
                cycle.guardrailDefinitions.find(
                  (definition) => definition.guardrailId === guardrail.guardrailId,
                )?.unit ?? "",
              )}
              . Denominator: {guardrail.before?.denominator ?? "unavailable"}.{" Follow-up value: "}
              {value(
                guardrail.after?.value ?? null,
                cycle.guardrailDefinitions.find(
                  (definition) => definition.guardrailId === guardrail.guardrailId,
                )?.unit ?? "",
              )}
              . Denominator: {guardrail.after?.denominator ?? "unavailable"}.{" Evidence limits: "}
              {guardrail.reasonCodes.join(", ") || "none recorded"}.
            </p>
          ))}
      </section>
      <div className="ledger-row">
        <span className="ledger-key">Comparison</span>
        <span className="ledger-val">
          {cycle.comparisonStatus ?? "not finalized"}
          {cycle.comparisonReasons.length > 0 ? ` · ${cycle.comparisonReasons.join(", ")}` : ""}
        </span>
      </div>
      <div className="ledger-row">
        <span className="ledger-key">Guardrails</span>
        <span className="ledger-val">
          {cycle.guardrailDefinitions.length === 0
            ? "none defined"
            : cycle.guardrailDefinitions
                .map((definition) =>
                  guardrailText(
                    guards.find((guardrail) => guardrail.guardrailId === definition.guardrailId),
                    definition.guardrailId,
                  ),
                )
                .join(" · ")}
        </span>
      </div>
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
