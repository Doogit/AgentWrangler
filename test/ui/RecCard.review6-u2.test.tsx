/**
 * Review 6 U2 (R6-07 UI part): an adopted D1 cycle can sit in OPEN_MEASURING for its whole
 * window while the tracked file is never edited. The card must say so plainly instead of
 * leaving an unexplained "Measuring" chip.
 * See docs/handoffs/2026-09-26-card-review/review-6-fix-plan.md §U2 and
 * review-6-persona-findings.md R6-07.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ObservationBundle } from "../../src/effects/types";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import RecCard from "../../src/ui/recommendations/RecCard";
import { makeEffectCycle } from "./effect-cycle-fixture";

vi.mock("../../src/ui/recommendations/EffectEvidence", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  default: () => null,
}));

afterEach(() => {
  cleanup();
});

function baseRec(overrides: Partial<RecommendationCard> = {}): RecommendationCard {
  return {
    rec_id: "review6-u2-rec",
    detector_id: "D1",
    category: "CONTEXT",
    scope_workspace_id: null,
    lever: "Trim CLAUDE.md",
    modeled_savings_u_per_wk: null,
    pct_of_weekly_spend: null,
    run_cost_u: null,
    modeled_formula: { model: "test", inputs: {} },
    certification: "UNVERIFIED",
    confidence_tier: "UNVERIFIED",
    evidence: {},
    target_metric: "test",
    state: "ADOPTED",
    created_at: "2026-09-20T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: 5,
    steps: [{ kind: "generic", description: "Edit the file" }],
    actionability_ok: true,
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: "~/.claude/CLAUDE.md",
    ...overrides,
  } as RecommendationCard;
}

function noChangeBundle(overrides: Partial<ObservationBundle> = {}): ObservationBundle {
  const unavailableMix = { available: false, total: 0, counts: {} };
  return {
    metricId: "d1-file-size",
    methodVersion: "d1-file-size-v1",
    queryDefinitionVersion: "esf-1",
    scopeFingerprint: "opaque",
    parserVersions: [],
    parserMix: { before: unavailableMix, after: unavailableMix },
    before: { value: null, denominator: null, exposureN: 0, sessionN: 0, excluded: {} },
    after: {
      value: 4799,
      denominator: null,
      exposureN: 1,
      sessionN: 1,
      excluded: { NO_CHANGED_OBSERVATION: 1 },
    },
    modelMix: { before: unavailableMix, after: unavailableMix },
    toolMix: { before: unavailableMix, after: unavailableMix },
    taskMix: { before: unavailableMix, after: unavailableMix },
    guardrails: [],
    ...overrides,
  };
}

describe("R6-07: adopted D1 cards say why nothing is happening while measuring", () => {
  it("interim (provisional) evidence with no baseline: names the file, the adopt date, and the fallback", () => {
    const cycle = makeEffectCycle({
      recId: "review6-u2-rec",
      detectorId: "D1",
      state: "OPEN_MEASURING",
      applicationSource: "USER_ATTESTED",
      appliedAt: "2026-09-25T19:09:55.000Z",
      baselineEvidence: {
        value: null,
        denominator: null,
        exposureN: 0,
        sessionN: 0,
        excluded: { NO_BASELINE: 1 },
      },
      provisionalEvidence: noChangeBundle(),
      finalEvidence: null,
    });
    const { container } = render(<RecCard rec={baseRec({ effect_cycle: cycle })} />);
    const panel = container.querySelector(".rec-d1-no-change");
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("No change to ~/.claude/CLAUDE.md seen");
    expect(panel?.textContent).toContain("since you adopted on Sep 25");
    expect(panel?.textContent).toContain("Make the edit, or Undo adopt.");
    expect(panel?.textContent).toContain(
      "No before-size on record; the verdict will use the size at adoption.",
    );
    expect(panel?.textContent).not.toContain("cannot be measured");
  });

  it("final evidence takes priority over provisional, and reads sourceIdentity from nowhere", () => {
    const cycle = makeEffectCycle({
      recId: "review6-u2-rec",
      detectorId: "D1",
      state: "OPEN_SETTLING",
      applicationSource: "USER_ATTESTED",
      appliedAt: "2026-09-25T19:09:55.000Z",
      scope: { workspaceId: null, sourceIdentity: "opaque-scope-id" },
      baselineEvidence: { value: 5200, denominator: null, exposureN: 3, sessionN: 3, excluded: {} },
      provisionalEvidence: null,
      finalEvidence: noChangeBundle(),
    });
    const { container } = render(<RecCard rec={baseRec({ effect_cycle: cycle })} />);
    const panel = container.querySelector(".rec-d1-no-change");
    expect(panel?.textContent).toContain("No change to ~/.claude/CLAUDE.md seen");
    // A baseline is on record here, so the fallback line must not render.
    expect(panel?.textContent).not.toContain("No before-size on record");
    expect(container.textContent).not.toContain("opaque-scope-id");
  });

  it("does not render when there is no NO_CHANGED_OBSERVATION exclusion", () => {
    const cycle = makeEffectCycle({
      recId: "review6-u2-rec",
      detectorId: "D1",
      state: "OPEN_MEASURING",
      applicationSource: "USER_ATTESTED",
      appliedAt: "2026-09-25T19:09:55.000Z",
      provisionalEvidence: noChangeBundle({
        after: { value: 3000, denominator: null, exposureN: 1, sessionN: 1, excluded: {} },
      }),
    });
    const { container } = render(<RecCard rec={baseRec({ effect_cycle: cycle })} />);
    expect(container.querySelector(".rec-d1-no-change")).toBeNull();
  });
});
