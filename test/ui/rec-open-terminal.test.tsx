import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import { setExperimentalActions } from "../../src/ui/hooks/useExperimentalActions";
import RecCard from "../../src/ui/recommendations/RecCard";

// O11 Option B — the "Open in Claude Code ↗" button (replaces headless Apply).

function makeRec(overrides: Partial<RecommendationCard> = {}): RecommendationCard {
  return {
    rec_id: "ot-rec-1",
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
    evidence: { session_count: 3, source_tokens: 5000, source_target: 2000 },
    target_metric: "context_tokens",
    state: "PROPOSED",
    created_at: "2026-09-01T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: 5,
    steps: [{ kind: "trim", target: "CLAUDE_MD", max_lines: 80 }],
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: "C:\\repo\\CLAUDE.md",
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  setExperimentalActions(false);
  vi.unstubAllGlobals();
});

describe("RecCard — Open in Claude Code ↗", () => {
  it("is hidden by default and cross-workspace recs never show it", () => {
    const { queryByRole } = render(<RecCard rec={makeRec()} />);
    expect(queryByRole("button", { name: /Open in Claude Code/ })).toBeNull();

    act(() => setExperimentalActions(true));
    // Global/cross-workspace rec has no single folder → no button even when on.
    cleanup();
    const global = render(
      <RecCard rec={makeRec({ scope_workspace_id: null, cross_workspace: true })} />,
    );
    expect(global.queryByRole("button", { name: /Open in Claude Code/ })).toBeNull();
  });

  it("POSTs the prompt (not workspace_cwd) and shows a success toast", async () => {
    let capturedBody: unknown = null;
    const mockFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/token")
        return Promise.resolve({ ok: true, json: () => ({ token: "tok" }) });
      if (url.endsWith("/open-terminal")) {
        capturedBody = JSON.parse(String(init?.body));
        return Promise.resolve({ ok: true, json: () => ({ launched: true, launcher: "wt" }) });
      }
      return Promise.resolve({ ok: false, json: () => ({}) });
    });
    vi.stubGlobal("fetch", mockFetch);
    act(() => setExperimentalActions(true));

    const { getByRole, findByText } = render(<RecCard rec={makeRec()} />);
    fireEvent.click(getByRole("button", { name: /Open in Claude Code/ }));

    expect(await findByText(/Opened a terminal in/)).toBeDefined();
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/recommendations/ot-rec-1/open-terminal",
      expect.objectContaining({ method: "POST" }),
    );
    // The body carries the seed prompt and NOT a workspace_cwd (server resolves cwd).
    expect(capturedBody).toHaveProperty("prompt");
    expect((capturedBody as { prompt: string }).prompt.length).toBeGreaterThan(0);
    expect(capturedBody).not.toHaveProperty("workspace_cwd");
  });

  it("shows the server's friendly failure reason when no terminal launches", async () => {
    const mockFetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/token")
        return Promise.resolve({ ok: true, json: () => ({ token: "tok" }) });
      if (url.endsWith("/open-terminal"))
        return Promise.resolve({
          ok: false,
          json: () => ({
            launched: false,
            reason: "No terminal emulator found — Copy prompt instead.",
          }),
        });
      return Promise.resolve({ ok: false, json: () => ({}) });
    });
    vi.stubGlobal("fetch", mockFetch);
    act(() => setExperimentalActions(true));

    const { getByRole, findByText } = render(<RecCard rec={makeRec()} />);
    fireEvent.click(getByRole("button", { name: /Open in Claude Code/ }));

    expect(await findByText(/No terminal emulator found/)).toBeDefined();
  });

  it("F1: is disabled while its request is pending, so a second click can't launch twice", async () => {
    let finish: (v: unknown) => void = () => {};
    const mockFetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/token")
        return Promise.resolve({ ok: true, json: () => ({ token: "tok" }) });
      if (url.endsWith("/open-terminal"))
        return new Promise((resolve) => {
          finish = resolve;
        });
      return Promise.resolve({ ok: false, json: () => ({}) });
    });
    vi.stubGlobal("fetch", mockFetch);
    act(() => setExperimentalActions(true));

    const { getByRole, findByText } = render(<RecCard rec={makeRec()} />);
    const button = getByRole("button", { name: /Open in Claude Code/ }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    await vi.waitFor(() =>
      expect(
        mockFetch.mock.calls.filter(([u]) => String(u).endsWith("/open-terminal")),
      ).toHaveLength(1),
    );

    await act(async () => {
      finish({
        ok: true,
        json: () => ({
          launched: false,
          reason: "Answer the macOS permission dialog, then retry.",
        }),
      });
    });
    expect(await findByText(/Answer the macOS permission dialog/)).toBeDefined();
    expect(button.disabled).toBe(false);
  });
});
