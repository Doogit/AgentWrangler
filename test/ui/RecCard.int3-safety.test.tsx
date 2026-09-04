import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import { setExperimentalActions } from "../../src/ui/hooks/useExperimentalActions";
import RecCard from "../../src/ui/recommendations/RecCard";

function makeRec(): RecommendationCard {
  return {
    rec_id: "int3-rec-1",
    detector_id: "D1",
    category: "CONTEXT",
    scope_workspace_id: "workspace-1",
    lever: "Trim the workspace CLAUDE.md",
    modeled_savings_u_per_wk: 59_400,
    run_cost_u: null,
    modeled_formula: {
      model: "D1_CONTEXT_TRIM_V1",
      inputs: { reduction_fraction: 0.33 },
      expression: "context_tokens * reduction_fraction",
    },
    evidence: { session_count: 3 },
    target_metric: "context_tokens",
    state: "PROPOSED",
    created_at: "2026-09-01T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: 5,
    steps: [{ kind: "trim", target: "CLAUDE_MD", max_lines: 80 }],
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: "C:\\repo\\.claude\\CLAUDE.md",
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  setExperimentalActions(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RecCard INT-3 safety controls", () => {
  it("hides the experimental action by default and updates live when enabled", () => {
    // O11 Option B: the experimental action is now "Open in Claude Code ↗"
    // (launches the user's terminal) — it replaced the headless "Apply" button.
    const { getByRole, queryByRole, queryByText } = render(<RecCard rec={makeRec()} />);

    expect(queryByRole("button", { name: /Open in Claude Code/ })).toBeNull();
    expect(queryByText("Dry-run preview")).toBeNull();
    expect(queryByRole("button", { name: "Confirm apply" })).toBeNull();
    expect(queryByRole("button", { name: "Roll back" })).toBeNull();
    expect(queryByText("Apply could not start")).toBeNull();
    expect(getByRole("button", { name: "Copy prompt" })).toBeDefined();

    act(() => setExperimentalActions(true));

    expect(getByRole("button", { name: /Open in Claude Code/ })).toBeDefined();
  });

  it("defers adopt and cancels its committed POST when undone", () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onAdopt = (recId: string) => {
      void fetch("/api/recommendations/adopt", {
        method: "POST",
        body: JSON.stringify({ rec_id: recId }),
      });
    };
    const { container, getByRole } = render(<RecCard rec={makeRec()} onAdopt={onAdopt} />);

    expect(getByRole("button", { name: "Adopt" }).getAttribute("title")).toBe(
      "Marks this adopted and starts impact tracking — changes no files.",
    );
    fireEvent.click(getByRole("button", { name: "Adopt" }));

    expect(container.querySelector(".rec-action-toast")?.textContent).toContain("Adopted — Undo");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/recommendations/adopt", expect.anything());

    fireEvent.click(getByRole("button", { name: "Undo" }));
    act(() => vi.advanceTimersByTime(5_000));

    expect(fetchMock).not.toHaveBeenCalledWith("/api/recommendations/adopt", expect.anything());
  });

  it("defers dismiss and cancels its committed POST when undone", () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onDismiss = (recId: string) => {
      void fetch("/api/recommendations/dismiss", {
        method: "POST",
        body: JSON.stringify({ rec_id: recId }),
      });
    };
    const { container, getByRole } = render(<RecCard rec={makeRec()} onDismiss={onDismiss} />);

    fireEvent.click(getByRole("button", { name: "Dismiss" }));

    expect(container.querySelector(".rec-action-toast")?.textContent).toContain("Dismissed — Undo");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/recommendations/dismiss", expect.anything());

    fireEvent.click(getByRole("button", { name: "Undo" }));
    act(() => vi.advanceTimersByTime(5_000));

    expect(fetchMock).not.toHaveBeenCalledWith("/api/recommendations/dismiss", expect.anything());
  });
});
