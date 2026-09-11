import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("shows one pre-track summary before its expandable qualifications", () => {
    render(<RecCard rec={rec()} />);
    fireEvent.click(screen.getByRole("button", { name: "Evaluation" }));
    const evaluation = screen.getByRole("region", { name: "Evaluation" });
    expect(evaluation.querySelector("p")?.textContent).toBe(
      "Not measured yet — confirm a completed change to start measurement",
    );
    expect(evaluation.querySelector("details")?.open).toBe(false);
    expect(evaluation.textContent).not.toContain("unavailable until");

    fireEvent.click(screen.getByText("Evaluation details"));
    expect(evaluation.textContent).toContain("Target: context_tokens");
    expect(evaluation.textContent).toContain(
      "Quality and repair guardrails need that cycle to record their typed definitions",
    );
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
      state: "FINALIZED",
      finalEvidence: evidence,
      targetDirection: "IMPROVED",
      comparisonStatus: "COMPARABLE",
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
    const guardrails = screen.getByLabelText("Guardrail verdict").textContent ?? "";
    expect(guardrails).toContain(
      "reported-useful-completion-repair: 2 completion → 5 completion ADVERSE",
    );
    expect(guardrails).toContain("native-token-repair: 30 tokens → 30 tokens STABLE");
    expect(guardrails).toContain("SYNTHETIC_SUPPLIED_GUARDRAIL_SEAM");
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

  it("shows open-cycle day and after-window gate progress rather than hiding maturity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    const cycle = makeEffectCycle({
      provisionalEvidence: {
        metricId: "target",
        methodVersion: "esf-1",
        queryDefinitionVersion: "esf-1",
        scopeFingerprint: "opaque",
        parserVersions: [],
        parserMix: {
          before: { available: false, total: 0, counts: {} },
          after: { available: false, total: 0, counts: {} },
        },
        before: { value: 100, denominator: 10, exposureN: 10, sessionN: 3, excluded: {} },
        after: { value: 80, denominator: 10, exposureN: 10, sessionN: 2, excluded: {} },
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
    render(<EffectEvidence cycle={cycle} />);
    expect(screen.getByTestId("effect-evidence").textContent).toContain(
      "Measuring · day 10 of 29 · after-window sessions 2/3",
    );
    expect(screen.getByText("PENDING — 2 of 3 gate")).toBeTruthy();
    vi.useRealTimers();
  });

  it("renders terminal target, every guardrail movement, and comparability without a net-effect success badge", () => {
    const unavailableMix = { available: false, total: 0, counts: {} };
    const finalEvidence: ObservationBundle = {
      metricId: "low-cost-repair",
      methodVersion: "esf-1",
      queryDefinitionVersion: "esf-1",
      scopeFingerprint: "opaque",
      parserVersions: [],
      parserMix: { before: unavailableMix, after: unavailableMix },
      before: { value: 100, denominator: 10, exposureN: 10, sessionN: 10, excluded: {} },
      after: { value: 80, denominator: 10, exposureN: 10, sessionN: 10, excluded: {} },
      modelMix: { before: unavailableMix, after: unavailableMix },
      toolMix: { before: unavailableMix, after: unavailableMix },
      taskMix: { before: unavailableMix, after: unavailableMix },
      guardrails: [
        {
          guardrailId: "repair-quality",
          methodVersion: "esf-1",
          availability: "SUPPORTED",
          unit: "score",
          before: { value: 9, denominator: 10, exposureN: 10, sessionN: 10, excluded: {} },
          after: { value: 5, denominator: 10, exposureN: 10, sessionN: 10, excluded: {} },
          direction: "ADVERSE",
          reasonCodes: ["QUALITY_DECLINED"],
          evidence: {},
        },
        {
          guardrailId: "latency",
          methodVersion: "esf-1",
          availability: "SUPPORTED",
          unit: "ms",
          before: { value: 30, denominator: 10, exposureN: 10, sessionN: 10, excluded: {} },
          after: { value: 32, denominator: 10, exposureN: 10, sessionN: 10, excluded: {} },
          direction: "STABLE",
          reasonCodes: [],
          evidence: {},
        },
      ],
    };
    const cycle = makeEffectCycle({
      state: "FINALIZED",
      finalEvidence,
      targetDirection: "IMPROVED",
      comparisonStatus: "CONFOUNDED",
      comparisonReasons: ["OVERLAPPING_INTERVENTION"],
      targetDefinition: {
        ...makeEffectCycle().targetDefinition,
        improvementThreshold: -5,
        worseningThreshold: 5,
      },
      guardrailDefinitions: [
        { guardrailId: "repair-quality", methodVersion: "esf-1", unit: "score" },
        { guardrailId: "latency", methodVersion: "esf-1", unit: "ms" },
      ],
    });
    const { container } = render(<EffectEvidence cycle={cycle} />);

    expect(screen.getByText("Final evidence")).toBeTruthy();
    expect(screen.getByLabelText("Target verdict").textContent).toContain("IMPROVED · dot -20%");
    expect(screen.getByLabelText("Target verdict").textContent).toContain(
      "material-change band -5% to +5%",
    );
    expect(screen.getByLabelText("Guardrail verdict").textContent).toContain(
      "repair-quality: 9 score → 5 score ADVERSE",
    );
    expect(screen.getByLabelText("Guardrail verdict").textContent).toContain(
      "latency: 30 ms → 32 ms STABLE",
    );
    expect(screen.getByLabelText("Comparability verdict").textContent).toContain("CONFOUNDED");
    expect(screen.getByLabelText("Comparability verdict").textContent).toContain(
      "OVERLAPPING_INTERVENTION",
    );
    expect(container.querySelector(".effect-target-strip-blocked")).not.toBeNull();
    expect(container.querySelector(".effect-target-lane .chip-exact")).toBeNull();
    expect(container.textContent).not.toContain("net effect");
  });

  it("orders signed target thresholds for both decreasing and increasing metrics", () => {
    const finalEvidence: ObservationBundle = {
      metricId: "model-routing-adherence",
      methodVersion: "esf-1",
      queryDefinitionVersion: "esf-1",
      scopeFingerprint: "opaque",
      parserVersions: [],
      parserMix: {
        before: { available: false, total: 0, counts: {} },
        after: { available: false, total: 0, counts: {} },
      },
      before: { value: 60, denominator: 10, exposureN: 10, sessionN: 10, excluded: {} },
      after: { value: 75, denominator: 10, exposureN: 10, sessionN: 10, excluded: {} },
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
    };
    const cycle = makeEffectCycle({
      state: "FINALIZED",
      finalEvidence,
      targetDirection: "IMPROVED",
      targetDefinition: {
        ...makeEffectCycle().targetDefinition,
        deltaSemantics: "PERCENTAGE_POINTS",
        improvementThreshold: 10,
        worseningThreshold: -10,
      },
    });

    render(<EffectEvidence cycle={cycle} />);

    expect(screen.getByLabelText("Target verdict").textContent).toContain(
      "material-change band -10 pp to +10 pp",
    );
  });

  it("selects immutable fetched cycles and appends the next cursor page without aggregating them", () => {
    const unavailableMix = { available: false, total: 0, counts: {} };
    const frozenEvidence = (afterValue: number): ObservationBundle => ({
      metricId: "aggregate-metric",
      methodVersion: "frozen-method",
      queryDefinitionVersion: "frozen-query",
      scopeFingerprint: "opaque",
      parserVersions: [],
      parserMix: { before: unavailableMix, after: unavailableMix },
      before: { value: 100, denominator: 10, exposureN: 10, sessionN: 10, excluded: {} },
      after: { value: afterValue, denominator: 10, exposureN: 10, sessionN: 10, excluded: {} },
      modelMix: { before: unavailableMix, after: unavailableMix },
      toolMix: { before: unavailableMix, after: unavailableMix },
      taskMix: { before: unavailableMix, after: unavailableMix },
      guardrails: [],
    });
    const latest = makeEffectCycle({
      cycleId: "cycle-3",
      cycleNo: 3,
      contractVersion: "esf-effect-3",
      state: "FINALIZED",
      finalEvidence: frozenEvidence(70),
      targetDirection: "IMPROVED",
      comparisonStatus: "COMPARABLE",
    });
    const second = makeEffectCycle({
      cycleId: "cycle-2",
      cycleNo: 2,
      contractVersion: "esf-effect-2",
      state: "STOPPED",
      finalEvidence: frozenEvidence(90),
      targetDirection: "WORSENED",
      comparisonStatus: "CONFOUNDED",
    });
    const first = makeEffectCycle({
      cycleId: "cycle-1",
      cycleNo: 1,
      contractVersion: "esf-effect-1",
      state: "FINALIZED",
      finalEvidence: frozenEvidence(80),
      targetDirection: "IMPROVED",
      comparisonStatus: "COMPARABLE",
    });

    function HistoryHarness() {
      const [cycles, setCycles] = useState([latest, second]);
      return (
        <EffectEvidence
          cycle={latest}
          cycles={cycles}
          nextCycleCursor={cycles.length === 2 ? "older-cycles" : null}
          onLoadMore={() => setCycles((current) => [...current, first])}
        />
      );
    }

    render(<HistoryHarness />);
    expect(screen.getByRole("button", { name: /#3 FINALIZED.*target improved/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /#2 STOPPED.*target worsened/i })).toBeTruthy();
    expect(screen.getByText("esf-effect-3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /#2 STOPPED.*target worsened/i }));
    expect(screen.getByText("esf-effect-2")).toBeTruthy();
    expect(
      screen.getByText(/Follow-up evidence: observed aggregate value: 90 tokens\./),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load more cycles" }));
    expect(screen.getByRole("button", { name: /#1 FINALIZED.*target improved/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more cycles" })).toBeNull();
  });
});
