import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import RecCard from "../../src/ui/recommendations/RecCard";

const writeText = vi.fn().mockResolvedValue(undefined);

afterEach(() => cleanup());

beforeEach(() => {
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});

function makeRec(overrides: Partial<RecommendationCard> = {}): RecommendationCard {
  return {
    rec_id: "prompt-artifact-rec",
    detector_id: "D2",
    category: "SESSION",
    scope_workspace_id: null,
    lever: "Use a session boundary between unrelated tasks",
    modeled_savings_u_per_wk: 59_400,
    run_cost_u: null,
    modeled_formula: {
      model: "D2_LONG_CONTEXT_CACHE_READ_V1",
      inputs: { reduction_fraction: 0.33 },
      expression: "cache_tokens * price * reduction_fraction",
    },
    evidence: { qualifying_session_count: 3 },
    target_metric: "sessions_over_threshold",
    state: "PROPOSED",
    created_at: "2026-09-01T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: 5,
    steps: [{ kind: "generic", description: "Start a new session for unrelated work" }],
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
    ...overrides,
  };
}

function promptArtifactTextarea(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector<HTMLTextAreaElement>(".rec-prompt-artifact textarea");
  if (textarea === null) throw new Error("prompt artifact textarea is missing");
  return textarea;
}

describe("RecCard prompt artifacts", () => {
  it("renders the D1 turnkey artifact with measured context and a confirmation step", () => {
    const rec = makeRec({
      detector_id: "D1",
      category: "CONTEXT",
      evidence: {
        source_tokens: 12_000,
        source_target: 4_000,
        delta_context_tokens: 8_000,
        component: "CLAUDE.md",
      },
      file_ref: "/repo/CLAUDE.md",
    });
    const { container } = render(<RecCard rec={rec} />);

    const artifact = container.querySelector<HTMLElement>(
      '.rec-prompt-artifact[data-flavor="TURNKEY"]',
    );
    expect(artifact).not.toBeNull();

    const text = promptArtifactTextarea(container).value;
    expect(text).toContain("12,000");
    expect(text).toContain("4,000");
    expect(text).toContain("8,000");
    expect(text).toMatch(/(verify|confirm)/i);
  });

  it("renders the D2 guided artifact for working through measured context", () => {
    const rec = makeRec({
      evidence: {
        qualifying_session_count: 3,
        raw_context_average_tokens_per_turn: 12_000,
        cap_weighted_burn_tokens_per_week: 48_000,
        cache_read_tokens_per_week: 36_000,
        cache_read_exposure_spend_u_per_week: 5_400,
      },
    });
    const { container, getByRole } = render(<RecCard rec={rec} />);

    // D2 is a behavioral (hook-route) card — the guided prompt is collapsed
    // behind "Show guided prompt" (RV4). Reveal it before asserting its content.
    fireEvent.click(getByRole("button", { name: "Show guided prompt" }));

    const artifact = container.querySelector<HTMLElement>(
      '.rec-prompt-artifact[data-flavor="GUIDED"]',
    );
    expect(artifact).not.toBeNull();

    const text = promptArtifactTextarea(container).value;
    expect(text).toMatch(/work (this )?through|with Claude|with an agent/i);
    expect(text).toContain("12,000");
    expect(text).toContain("48,000");
    expect(text).toContain("36,000");
    expect(text).toContain("5,400");
  });

  it("copies the rendered artifact text", () => {
    const rec = makeRec({
      detector_id: "D1",
      category: "CONTEXT",
      evidence: {
        source_tokens: 12_000,
        source_target: 4_000,
        delta_context_tokens: 8_000,
        component: "CLAUDE.md",
      },
      file_ref: "/repo/CLAUDE.md",
    });
    const { container, getByRole } = render(<RecCard rec={rec} />);
    const text = promptArtifactTextarea(container).value;

    fireEvent.click(getByRole("button", { name: "Copy prompt" }));

    expect(writeText).toHaveBeenCalledWith(text);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("12,000"));
  });
});
