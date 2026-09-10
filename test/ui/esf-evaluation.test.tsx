import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ObservationBundle } from "../../src/effects/types";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import EffectEvidence from "../../src/ui/recommendations/EffectEvidence";
import EvaluationDisclosure from "../../src/ui/recommendations/EvaluationDisclosure";
import RecCard from "../../src/ui/recommendations/RecCard";
import { makeEffectCycle } from "./effect-cycle-fixture";

function rec(): RecommendationCard {
  return {
    rec_id: "esf-evaluation-rec",
    detector_id: "D1",
    category: "CONTEXT",
    scope_workspace_id: "workspace-1",
    lever: "Trim workspace instructions",
    modeled_savings_u_per_wk: null,
    run_cost_u: null,
    modeled_formula: { model: "D1", inputs: {}, expression: "none" },
    evidence: {},
    target_metric: "context_tokens",
    state: "PROPOSED",
    created_at: "2026-09-01T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: null,
    steps: [],
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
    effect_capability: { mode: "TRACKABLE", reason: null },
  };
}

afterEach(() => cleanup());

describe("ESF4 evaluation disclosures", () => {
  it("moves focus into details and returns it to the launcher on Escape", () => {
    render(<RecCard rec={rec()} />);
    const launcher = screen.getByRole("button", { name: /show details/i });
    fireEvent.click(launcher);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Recommendation details" }),
    );

    fireEvent.keyDown(screen.getByRole("heading", { name: "Recommendation details" }), {
      key: "Escape",
    });
    expect(document.activeElement).toBe(launcher);
    expect(screen.queryByRole("heading", { name: "Recommendation details" })).toBeNull();
  });

  it("keeps a named evaluation route available before a cycle exists", () => {
    render(<RecCard rec={rec()} />);
    fireEvent.click(screen.getByRole("button", { name: "Evaluation" }));
    const evaluation = screen.getByRole("region", { name: "Evaluation" });
    expect(evaluation.textContent).toContain("Target: context_tokens");
    expect(evaluation.textContent).toContain("Quality and repair guardrails are unavailable");
    expect(evaluation.textContent).toContain("Comparability is unavailable");
    expect(evaluation.textContent).toContain("Stop measurement");
    expect(evaluation.textContent).toContain("Rollback");
    expect(evaluation.textContent).toContain("Retrack");
  });

  it("focuses Evaluation and restores its launcher after Escape or Back", () => {
    render(<RecCard rec={rec()} />);
    const launcher = screen.getByRole("button", { name: "Evaluation" });

    fireEvent.click(launcher);
    const heading = screen.getByRole("heading", { name: "Evaluation" });
    expect(document.activeElement).toBe(heading);

    fireEvent.keyDown(heading, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Evaluation" })).toBeNull();
    expect(document.activeElement).toBe(launcher);

    fireEvent.click(launcher);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("region", { name: "Evaluation" })).toBeNull();
    expect(document.activeElement).toBe(launcher);
  });

  it("marks closed and unsupported cycles unavailable for stopping measurement", () => {
    const { rerender } = render(
      <EvaluationDisclosure
        rec={rec()}
        cycle={makeEffectCycle({ state: "STOPPED" })}
        capability={{ mode: "TRACKABLE", reason: null }}
        canRetrack={false}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole("region", { name: "Evaluation" }).textContent).toContain(
      "Stop measurement: unavailable because this cycle is closed.",
    );

    rerender(
      <EvaluationDisclosure
        rec={rec()}
        cycle={makeEffectCycle({ state: "UNSUPPORTED", versionStatus: "UNSUPPORTED_VERSION" })}
        capability={{ mode: "TRACKABLE", reason: null }}
        canRetrack={false}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole("region", { name: "Evaluation" }).textContent).toContain(
      "Stop measurement: unavailable because this cycle is unsupported and read-only.",
    );
  });

  it("renders frozen evidence metadata and labels missing evidence unavailable", () => {
    const withEvidence = makeEffectCycle({
      provisionalEvidence: {
        metricId: "d2-floor-context",
        methodVersion: "d2-floor-context-v2",
        queryDefinitionVersion: "esf-1",
        scopeFingerprint: "opaque",
        parserVersions: [],
        parserMix: {
          before: { available: false, total: 0, counts: {} },
          after: { available: false, total: 0, counts: {} },
        },
        before: { value: 100, denominator: 10, exposureN: 10, sessionN: 10, excluded: {} },
        after: { value: 80, denominator: 9, exposureN: 9, sessionN: 9, excluded: { LIVE: 1 } },
        modelMix: {
          before: { available: false, total: 0, counts: {} },
          after: { available: false, total: 0, counts: {} },
        },
        toolMix: {
          before: { available: false, total: 0, counts: {} },
          after: { available: false, total: 0, counts: {} },
        },
        taskMix: {
          before: { available: false, total: 0, counts: {} },
          after: { available: false, total: 0, counts: {} },
        },
        guardrails: [],
      },
    });
    const result = render(<EffectEvidence cycle={withEvidence} />);
    expect(screen.getByRole("region", { name: "Evidence and limits" }).textContent).toContain(
      "observed aggregate value: 80 tokens. Numerator is not separately recorded. Denominator: 9",
    );
    expect(result.container.textContent).toContain(
      "[2026-08-18T00:00:00.000Z, 2026-09-01T00:00:00.000Z)",
    );
    expect(result.container.textContent).toContain("Exclusions: LIVE: 1");
    result.unmount();

    render(<EffectEvidence cycle={makeEffectCycle()} />);
    expect(screen.getByText("Follow-up evidence: unavailable.")).toBeTruthy();
  });

  it("shows session and exposure denominators, model-mix counts, and the supplied repair seam", () => {
    const unavailableMix = { available: false, total: 0, counts: {} };
    const evidence: ObservationBundle = {
      metricId: "d2-floor-context",
      methodVersion: "d2-floor-context-v2",
      queryDefinitionVersion: "esf-1",
      scopeFingerprint: "opaque",
      parserVersions: [],
      parserMix: { before: unavailableMix, after: unavailableMix },
      before: { value: 100, denominator: 10, exposureN: 10, sessionN: 9, excluded: {} },
      after: { value: 82, denominator: 10, exposureN: 10, sessionN: 9, excluded: {} },
      modelMix: {
        before: { available: true, total: 20, counts: { sonnet: 6, opus: 14 } },
        after: { available: true, total: 20, counts: { sonnet: 11, opus: 9 } },
      },
      toolMix: { before: unavailableMix, after: unavailableMix },
      taskMix: { before: unavailableMix, after: unavailableMix },
      guardrails: [
        {
          guardrailId: "reported-useful-completion-repair",
          methodVersion: "synthetic-supplied-guardrail-1",
          availability: "SUPPORTED",
          unit: "completion",
          before: { value: 2, denominator: 10, exposureN: 10, sessionN: 9, excluded: {} },
          after: { value: 5, denominator: 10, exposureN: 10, sessionN: 9, excluded: {} },
          direction: "ADVERSE",
          reasonCodes: ["SYNTHETIC_SUPPLIED_GUARDRAIL_SEAM"],
          evidence: { source: "synthetic supplied guardrail seam" },
        },
        {
          guardrailId: "native-token-repair",
          methodVersion: "native-token-repair-v1",
          availability: "SUPPORTED",
          unit: "tokens",
          before: { value: 30, denominator: 30, exposureN: 30, sessionN: 9, excluded: {} },
          after: { value: 30, denominator: 30, exposureN: 30, sessionN: 9, excluded: {} },
          direction: "STABLE",
          reasonCodes: [],
          evidence: {},
        },
      ],
    };
    const cycle = makeEffectCycle({
      provisionalEvidence: evidence,
      guardrailDefinitions: [
        {
          guardrailId: "reported-useful-completion-repair",
          methodVersion: "synthetic-supplied-guardrail-1",
          unit: "completion",
        },
        {
          guardrailId: "native-token-repair",
          methodVersion: "native-token-repair-v1",
          unit: "tokens",
        },
      ],
    });
    const result = render(<EffectEvidence cycle={cycle} />);
    const text = screen.getByRole("region", { name: "Evidence and limits" }).textContent ?? "";

    expect(text).toContain("Distinct sessions: 9. Exposures: 10.");
    expect(text).toContain("sonnet: 6 / 20 turns (30%)");
    expect(text).toContain("sonnet: 11 / 20 turns (55%)");
    expect(text).toContain(
      "reported-useful-completion-repair: baseline value: 2 completion. Denominator: 10. Follow-up value: 5 completion. Denominator: 10.",
    );
    expect(text).toContain(
      "native-token-repair: baseline value: 30 tokens. Denominator: 30. Follow-up value: 30 tokens. Denominator: 30.",
    );
    expect(text).not.toContain("native-token-repair: baseline 30 / 30");
    expect(text).toContain("SYNTHETIC_SUPPLIED_GUARDRAIL_SEAM");
    expect(screen.getByText(/reported-useful-completion-repair: adverse/i)).toBeTruthy();
    result.unmount();

    render(
      <EffectEvidence
        cycle={makeEffectCycle({
          provisionalEvidence: {
            ...evidence,
            before: { ...evidence.before, sessionN: 1, exposureN: 10 },
            after: { ...evidence.after, sessionN: 1, exposureN: 10 },
          },
        })}
      />,
    );
    expect(screen.getAllByText(/Distinct sessions: 1\. Exposures: 10\./)).toHaveLength(2);
  });
});
