import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import { setExperimentalActions } from "../../src/ui/hooks/useExperimentalActions";
import RecCard from "../../src/ui/recommendations/RecCard";

function makeRec(overrides: Partial<RecommendationCard> = {}): RecommendationCard {
  return {
    rec_id: "int3-rec-1",
    detector_id: "D1",
    category: "CONTEXT",
    scope_workspace_id: "workspace-1",
    lever: "Trim the workspace CLAUDE.md",
    actions: {
      primary: {
        option_id: "primary",
        kind: "EDIT",
        summary: "Trim workspace instructions",
        detail: [],
        copy_text: "Review and trim the workspace CLAUDE.md.",
        file_ref: "CLAUDE.md",
      },
      alternatives: [],
    },
    action_validation: { primary: { ok: true }, alternatives: {} },
    modeled_savings_u_per_wk: 59_400,
    pct_of_weekly_spend: null,
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
    actionability_ok: true,
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: "C:\\repo\\.claude\\CLAUDE.md",
    effect_capability: { mode: "TRACKABLE", reason: null },
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  cleanup();
  setExperimentalActions(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RecCard INT-3 safety controls", () => {
  it("sanitizes MCP names in tool-routing steps", () => {
    const { container, getByRole } = render(
      <RecCard
        rec={makeRec({
          steps: [
            {
              kind: "route_tool",
              from: "mcp__claude-in-chrome__browser_batch",
              to: "mcp__private-server__deploy",
            },
          ],
        })}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Show details ▼" }));
    expect(container.textContent).toContain("Route An MCP browser tool → An MCP tool");
    expect(container.textContent).not.toContain("mcp__claude-in-chrome__browser_batch");
    expect(container.textContent).not.toContain("mcp__private-server__deploy");
  });

  it("hides the experimental action by default and updates live when enabled", () => {
    // O11 Option B: the experimental action is now "Open in Claude Code ↗"
    // (launches the user's terminal) — it replaced the headless "Apply" button.
    const { getByRole, queryByRole, queryByText } = render(<RecCard rec={makeRec()} />);

    expect(queryByRole("button", { name: /Open in Claude Code/ })).toBeNull();
    expect(queryByText("Dry-run preview")).toBeNull();
    expect(queryByRole("button", { name: "Confirm apply" })).toBeNull();
    expect(queryByRole("button", { name: "Roll back" })).toBeNull();
    expect(queryByText("Apply could not start")).toBeNull();
    expect(getByRole("button", { name: "Review edit" })).toBeDefined();

    act(() => setExperimentalActions(true));

    expect(getByRole("button", { name: /Open in Claude Code/ })).toBeDefined();
  });

  it("defers tracking and cancels its committed POST when undone", async () => {
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
    expect(getByRole("button", { name: "Track" })).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Track" }));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(getByRole("button", { name: "I completed the change" }));
    expect(getByRole("button", { name: "Track" }).getAttribute("title")).toBe(
      "Records a baseline for this completed change; it changes no files.",
    );
    fireEvent.click(getByRole("button", { name: "Track" }));

    expect(container.querySelector(".rec-action-toast")?.textContent).toContain(
      "Track pending — Undo",
    );
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

    expect(container.querySelector(".rec-action-toast")?.textContent).toContain(
      "Dismiss pending — Undo",
    );
    expect(fetchMock).not.toHaveBeenCalledWith("/api/recommendations/dismiss", expect.anything());

    fireEvent.click(getByRole("button", { name: "Undo" }));
    act(() => vi.advanceTimersByTime(5_000));

    expect(fetchMock).not.toHaveBeenCalledWith("/api/recommendations/dismiss", expect.anything());
  });
});
