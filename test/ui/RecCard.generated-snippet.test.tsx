import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard, RecommendationGroup } from "../../src/query/api/recommendations";
import RecCard from "../../src/ui/recommendations/RecCard";

const writeText = vi.fn().mockResolvedValue(undefined);

afterEach(() => cleanup());

beforeEach(() => {
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});

function makeRec(overrides: Partial<RecommendationCard> = {}): RecommendationCard {
  return {
    rec_id: "generated-snippet-rec",
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

function generatedSnippetTextarea(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector<HTMLTextAreaElement>(".rec-generated-snippet textarea");
  if (textarea === null) throw new Error("generated snippet textarea is missing");
  return textarea;
}

describe("RecCard generated snippets", () => {
  it("renders and copies a D10 settings snippet alongside the prompt artifact", async () => {
    const rec = makeRec({
      detector_id: "D10",
      category: "TOOLING",
      evidence: {
        catalog_tokens: 12_000,
        catalog_target_tokens: 4_000,
        delta_context_tokens: 8_000,
      },
    });
    const { container, getByRole } = render(<RecCard rec={rec} />);

    expect(container.querySelector(".rec-generated-snippet")).not.toBeNull();
    expect(generatedSnippetTextarea(container).value).toContain('"enableToolSearch": true');
    expect(container.querySelector(".rec-prompt-artifact")).not.toBeNull();

    fireEvent.click(getByRole("button", { name: "Copy snippet" }));

    expect(writeText).toHaveBeenCalledWith(generatedSnippetTextarea(container).value);
    await waitFor(() => expect(getByRole("button", { name: "Copied ✓" })).toBeDefined());
  });

  it("renders the D4 default-model snippet with the cap caveat", () => {
    const rec = makeRec({
      detector_id: "D4",
      category: "MODEL",
      evidence: {
        mismatch_turns_per_week: 3,
        total_opus_turns_per_week: 12,
        mismatch_fraction: 0.25,
      },
    });
    const { container } = render(<RecCard rec={rec} />);

    const text = generatedSnippetTextarea(container).value;
    expect(text).toContain('"model": "sonnet"');
    expect(text).toContain("cap is binding");
    expect(container.querySelector(".rec-prompt-artifact")).not.toBeNull();
  });

  it("omits generated snippets for detectors without a supported snippet", () => {
    // D6 has no generated-config snippet (post-RI8: D2/D8 carry the autocompact
    // snippet, D4 the model/routing snippets, D10 the settings snippet). D6 is a
    // copy-route rec, so its prompt artifact renders directly (no toggle).
    const rec = makeRec({
      detector_id: "D6",
      category: "TOOLING",
      evidence: { tool_result_bytes: 100_000, bloat_share: 0.4 },
    });
    const { container } = render(<RecCard rec={rec} />);

    expect(container.querySelector(".rec-generated-snippet")).toBeNull();
    expect(container.querySelector(".rec-prompt-artifact")).not.toBeNull();
  });

  it("uses the representative recommendation for grouped cards", () => {
    const rec = makeRec({
      detector_id: "D10",
      category: "TOOLING",
      evidence: { catalog_tokens: 12_000 },
    });
    const group: RecommendationGroup = {
      detector_id: "D10",
      label: "Tool catalog",
      recs: [rec],
      session_count: 1,
      total_savings_u_per_wk: 0,
    };
    const { container } = render(<RecCard group={group} />);

    expect(generatedSnippetTextarea(container).value).toContain('"enableToolSearch": true');
  });
});
