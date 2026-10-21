import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { findingIds } from "../../src/detector/privacy-contract";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import RecCard from "../../src/ui/recommendations/RecCard";

afterEach(() => cleanup());

// The routing id older C9 findings carried for the removed Bash allowlist artifact.
const LEGACY_ARTIFACT_ID = findingIds.artifact("c9-permission-allowlist");

function c9Rec(
  denialCount: number,
  label: "DENY_RULE" | "USER_REJECTED" = "DENY_RULE",
  artifactId: string | null = null,
): RecommendationCard {
  return {
    rec_id: "c9-permission-artifact-rec",
    detector_id: "C9",
    category: "TOOLING",
    scope_workspace_id: "ws-c9",
    lever: "Review recurring blocked tool requests before repeating the same command shape.",
    modeled_savings_u_per_wk: null,
    pct_of_weekly_spend: null,
    run_cost_u: null,
    modeled_formula: { model: "V2_C9_DENIAL_FRICTION", inputs: {} },
    evidence: {
      label,
      ...(artifactId === null ? {} : { routing: { tier: "T3", artifact_id: artifactId } }),
      metrics: {
        DENIAL_CLASS: { kind: "ENUM", value: label },
        COMMAND_ARGUMENT_COUNT_CLASS: { kind: "ENUM", value: "ARGS_1" },
        DENIAL_COUNT: { kind: "COUNT", value: denialCount },
      },
    },
    target_metric: "denial_friction_count",
    state: "PROPOSED",
    created_at: "2026-09-16T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: 1,
    steps: [{ kind: "generic", description: "Review recurring blocked tool requests" }],
    actionability_ok: true,
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
  };
}

describe("RecCard C9 renders no permission artifact", () => {
  it.each([
    {
      name: "a formerly qualifying USER_REJECTED finding",
      rec: c9Rec(3, "USER_REJECTED", LEGACY_ARTIFACT_ID),
    },
    { name: "a sub-threshold finding", rec: c9Rec(1, "USER_REJECTED", LEGACY_ARTIFACT_ID) },
    { name: "a deny-rule finding", rec: c9Rec(3) },
  ])("renders no permissions JSON block for $name", ({ rec }) => {
    const { container } = render(<RecCard rec={rec} />);
    expect(container.querySelector(".rec-generated-snippet")).toBeNull();
    expect(container.textContent).not.toContain('"permissions"');
    expect(container.textContent).not.toContain('"Bash"');
  });
});
