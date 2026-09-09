import type { EffectCycle, GuardrailObservation, ObservationBundle } from "../../effects/types";

function date(value: string | null): string {
  return value === null ? "not recorded" : value.slice(0, 10);
}

function value(value: number | null, unit: string): string {
  return value === null ? "unavailable" : `${value.toLocaleString("en-US")} ${unit}`;
}

function evidenceFor(cycle: EffectCycle): ObservationBundle | null {
  return cycle.finalEvidence ?? cycle.provisionalEvidence;
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
