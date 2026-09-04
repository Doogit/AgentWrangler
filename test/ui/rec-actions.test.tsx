/**
 * test/ui/rec-actions.test.tsx — P4 action wiring in RecCard and RecommendationsPage.
 *
 * Covers:
 *   - Dismiss button calls onDismiss callback
 *   - Adopt button calls onAdopt callback
 *   - "Analyze with Claude" button writes a seeded prompt to clipboard (SEC-101: no SQL/content)
 *   - RecommendationsPage calls fetch on dismiss/adopt and re-fetches on success
 *   - Adopted/dismissed sections show live data from the API
 *   - Progressive disclosure: collapsed by default; expanded reveals details
 *   - D1 backfire caveat only visible when expanded
 *   - No absolute paths in collapsed DOM
 *   - No duplicated steps
 */

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BoundedStep,
  RecommendationCard,
  RecommendationGroup,
  RecommendationsView,
} from "../../src/query/api/recommendations";
import * as client from "../../src/ui/api/client";
import {
  mockEfficiencyHeadroom,
  mockLedger,
  mockPractices,
  mockRecommendations,
} from "../../src/ui/api/fixtures";
import { setExperimentalActions } from "../../src/ui/hooks/useExperimentalActions";
import RecCard, { __resetHookInstallCache } from "../../src/ui/recommendations/RecCard";
import RecommendationsPage from "../../src/ui/recommendations/RecommendationsPage";

vi.mock("../../src/ui/api/client");

afterEach(() => {
  cleanup();
  setExperimentalActions(false);
  __resetHookInstallCache();
  vi.useRealTimers();
});
// W4: RecommendationsPage now renders <ImpactLedger />, which calls
// fetchLedger() — give the auto-mocked client a resolved default so the page
// renders without unhandled rejections.
// BM1/BM2: PracticesSection and HeadroomSummary also need resolved defaults.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
  vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
});

// ---------------------------------------------------------------------------
// Minimal fixture card for RecCard unit tests
// ---------------------------------------------------------------------------
function makeRec(overrides: Partial<RecommendationCard> = {}): RecommendationCard {
  return {
    rec_id: "rec-test-1",
    detector_id: "D2",
    category: "SESSION",
    scope_workspace_id: null,
    lever: "Use /clear between unrelated tasks",
    modeled_savings_u_per_wk: 59_400,
    run_cost_u: null,
    modeled_formula: {
      model: "D2_LONG_CONTEXT_CACHE_READ_V1",
      inputs: { reduction_fraction: 0.33 },
      expression: "excess_turns * cache_read_price * reduction_fraction",
    },
    evidence: { session_count: 3, avg_turns: 200, session_ids: ["s1", "s2", "s3"] },
    target_metric: "sessions_over_threshold",
    state: "PROPOSED",
    created_at: "2026-08-24T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: 5,
    steps: [
      { kind: "generic", description: "Use /clear between unrelated tasks" } satisfies BoundedStep,
    ],
    cross_workspace: true,
    workspace_multiplier: null,
    file_ref: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RecCard — action buttons
// ---------------------------------------------------------------------------

describe("RecCard — action buttons", () => {
  it("uses the D10 tool-catalog label instead of the TOOLING category fallback", () => {
    const rec = makeRec({ detector_id: "D10", category: "TOOLING" });
    const { container } = render(<RecCard rec={rec} />);

    expect(container.querySelector(".rec-category-chip")?.textContent).toBe("Tool catalog");
  });

  it("uses the D7 retry label instead of the session-hygiene fallback", () => {
    const rec = makeRec({ detector_id: "D7", category: "SESSION_HYGIENE" });
    const { container } = render(<RecCard rec={rec} />);

    expect(container.querySelector(".rec-category-chip")?.textContent).toBe(
      "Retry / redundant-read",
    );
  });

  it("Dismiss button calls onDismiss with rec_id", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { getByRole } = render(<RecCard rec={makeRec()} onDismiss={onDismiss} />);
    fireEvent.click(getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(5_000));
    expect(onDismiss).toHaveBeenCalledWith("rec-test-1");
  });

  it("Adopt button calls onAdopt with rec_id", () => {
    vi.useFakeTimers();
    const onAdopt = vi.fn();
    const { getByRole } = render(<RecCard rec={makeRec()} onAdopt={onAdopt} />);
    fireEvent.click(getByRole("button", { name: "Adopt" }));
    expect(onAdopt).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(5_000));
    expect(onAdopt).toHaveBeenCalledWith("rec-test-1");
  });

  it("Dismiss is disabled when no onDismiss prop is given", () => {
    const { getByRole } = render(<RecCard rec={makeRec()} />);
    expect((getByRole("button", { name: "Dismiss" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Adopt is disabled when no onAdopt prop is given", () => {
    const { getByRole } = render(<RecCard rec={makeRec()} />);
    expect((getByRole("button", { name: "Adopt" }) as HTMLButtonElement).disabled).toBe(true);
  });

  // O11 Option B (2026-09-04): the experimental action is now "Open in Claude
  // Code ↗", which replaced the headless "Apply" button (spec-apply-console.md
  // §3). The four tests below exercise that removed button's dry-run / confirm /
  // failure PANELS. The W3-A engine + its panels are preserved (un-shelve, NOT
  // §6 cut) but are no longer reachable from a button, so these UI-flow tests are
  // skipped rather than deleted. Engine coverage stays in test/apply/*; the new
  // Open-in-terminal button + POST + toast are covered in
  // test/ui/rec-open-terminal.test.tsx.
  it.skip("workspace-local file rec exposes Apply and renders the dry-run preview", async () => {
    const rec = makeRec({
      detector_id: "D1",
      category: "CONTEXT",
      scope_workspace_id: "ws-alpha",
      file_ref: "C:\\repo\\.claude\\CLAUDE.md",
      steps: [{ kind: "trim", target: "CLAUDE_MD", max_lines: 80 }],
    });
    const mockFetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/token")
        return Promise.resolve({ ok: true, json: () => ({ token: "tok" }) });
      if (url.endsWith("/apply")) {
        return Promise.resolve({ ok: true, json: () => ({ data: { job_id: "job-1" } }) });
      }
      if (url.endsWith("/jobs/job-1")) {
        return Promise.resolve({
          ok: true,
          json: () => ({
            data: {
              job_id: "job-1",
              status: "DRY_DONE",
              diff_preview: "Dry run preview",
              diff_applied: null,
              error_msg: null,
            },
          }),
        });
      }
      return Promise.resolve({ ok: false, text: () => "unexpected" });
    });
    vi.stubGlobal("fetch", mockFetch);
    setExperimentalActions(true);

    const { getByRole, findByText } = render(<RecCard rec={rec} />);
    fireEvent.click(getByRole("button", { name: "Apply" }));

    expect(await findByText("Dry run preview")).toBeDefined();
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/recommendations/rec-test-1/apply",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workspace_cwd: "C:\\repo" }),
      }),
    );
  });

  it.skip("repo-root CLAUDE.md rec (no .claude/ segment) exposes Apply and derives workspace_cwd", async () => {
    const rec = makeRec({
      detector_id: "D1",
      category: "CONTEXT",
      scope_workspace_id: "ws-alpha",
      file_ref: "C:\\repo\\CLAUDE.md",
      steps: [{ kind: "trim", target: "CLAUDE_MD", max_lines: 80 }],
    });
    const mockFetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/token")
        return Promise.resolve({ ok: true, json: () => ({ token: "tok" }) });
      if (url.endsWith("/apply")) {
        return Promise.resolve({ ok: true, json: () => ({ data: { job_id: "job-1" } }) });
      }
      if (url.endsWith("/jobs/job-1")) {
        return Promise.resolve({
          ok: true,
          json: () => ({
            data: {
              job_id: "job-1",
              status: "DRY_DONE",
              diff_preview: "Dry run preview",
              diff_applied: null,
              error_msg: null,
            },
          }),
        });
      }
      return Promise.resolve({ ok: false, text: () => "unexpected" });
    });
    vi.stubGlobal("fetch", mockFetch);
    setExperimentalActions(true);

    const { getByRole, findByText } = render(<RecCard rec={rec} />);
    fireEvent.click(getByRole("button", { name: "Apply" }));

    expect(await findByText("Dry run preview")).toBeDefined();
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/recommendations/rec-test-1/apply",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workspace_cwd: "C:\\repo" }),
      }),
    );
  });

  it.skip("shows friendly startup failure UX with retry, prompt copy, and diagnostics", async () => {
    const rec = makeRec({
      detector_id: "D1",
      category: "CONTEXT",
      scope_workspace_id: "ws-alpha",
      file_ref: "C:\\repo\\.claude\\CLAUDE.md",
      steps: [{ kind: "trim", target: "CLAUDE_MD", max_lines: 80 }],
    });
    const spawnError = "spawn EPERM";
    const mockFetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/token")
        return Promise.resolve({ ok: true, json: () => ({ token: "tok" }) });
      if (url.endsWith("/apply")) {
        return Promise.resolve({ ok: true, json: () => ({ data: { job_id: "job-1" } }) });
      }
      if (url.endsWith("/jobs/job-1")) {
        return Promise.resolve({
          ok: true,
          json: () => ({
            data: {
              job_id: "job-1",
              status: "FAILED",
              diff_preview: null,
              diff_applied: null,
              error_msg: spawnError,
            },
          }),
        });
      }
      return Promise.resolve({ ok: false, text: () => "unexpected" });
    });
    vi.stubGlobal("fetch", mockFetch);
    setExperimentalActions(true);

    const { container, findByRole, getByRole, getAllByRole, findByText } = render(
      <RecCard rec={rec} />,
    );
    fireEvent.click(getByRole("button", { name: "Apply" }));

    expect(await findByRole("button", { name: "Retry" })).toBeDefined();
    const friendly = await findByText(/Couldn't start the local Claude Code CLI/);
    expect(friendly.textContent).not.toContain(spawnError);
    // Copy prompt appears both as the card's primary action and inside the failed panel.
    expect(getAllByRole("button", { name: "Copy prompt" }).length).toBeGreaterThanOrEqual(1);
    const diagnostics = container.querySelector<HTMLDetailsElement>("details.rec-diagnostics");
    expect(diagnostics?.open).toBe(false);
    expect(diagnostics?.textContent).toContain(spawnError);
  });

  it.skip("shows 'Apply did not complete' heading for non-startup failures", async () => {
    const rec = makeRec({
      detector_id: "D1",
      category: "CONTEXT",
      scope_workspace_id: "ws-alpha",
      file_ref: "C:\\repo\\.claude\\CLAUDE.md",
      steps: [{ kind: "trim", target: "CLAUDE_MD", max_lines: 80 }],
    });
    const errorMsg = "Patch could not be applied cleanly";
    const mockFetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/token")
        return Promise.resolve({ ok: true, json: () => ({ token: "tok" }) });
      if (url.endsWith("/apply"))
        return Promise.resolve({ ok: true, json: () => ({ data: { job_id: "job-2" } }) });
      if (url.endsWith("/jobs/job-2"))
        return Promise.resolve({
          ok: true,
          json: () => ({
            data: {
              job_id: "job-2",
              status: "FAILED",
              diff_preview: null,
              diff_applied: null,
              error_msg: errorMsg,
            },
          }),
        });
      return Promise.resolve({ ok: false, text: () => "unexpected" });
    });
    vi.stubGlobal("fetch", mockFetch);
    setExperimentalActions(true);

    const { findByText, getByRole } = render(<RecCard rec={rec} />);
    fireEvent.click(getByRole("button", { name: "Apply" }));

    const heading = await findByText("Apply did not complete");
    expect(heading).toBeDefined();
    expect(await findByText(/The assisted apply did not complete/)).toBeDefined();
  });

  it("Analyze with Claude button writes to clipboard after expanding (SEC-101: no SQL, no file paths)", async () => {
    const written: string[] = [];
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn((s: string) => {
          written.push(s);
          return Promise.resolve();
        }),
      },
    });

    const rec = makeRec();
    const { getByRole } = render(<RecCard rec={rec} />);

    // Expand card to reveal "Analyze with Claude" button.
    fireEvent.click(getByRole("button", { name: /show details/i }));

    fireEvent.click(getByRole("button", { name: "Analyze with Claude" }));

    await waitFor(() => expect(written.length).toBe(1));
    const prompt = written[0] ?? "";
    expect(prompt).toContain("D2");
    expect(prompt).toContain("Use /clear between unrelated tasks");
    // Evidence provenance hash present (not raw evidence keys — SEC-101 hardened)
    expect(prompt).toContain("evidence_pack_hash");
    // Data is inside <data>…</data> delimiters
    expect(prompt).toContain("<data>");
    expect(prompt).toContain("</data>");
    // No SQL
    expect(prompt).not.toMatch(/\bSELECT\b/i);
    expect(prompt).not.toMatch(/\bINSERT INTO\b/i);
  });
});

// ---------------------------------------------------------------------------
// RecCard — progressive disclosure
// ---------------------------------------------------------------------------

describe("RecCard — progressive disclosure", () => {
  it("shows a recorded Tier-2 run cost in developer diagnostics", () => {
    const { container, getByRole } = render(<RecCard rec={makeRec({ run_cost_u: 1_250_000 })} />);

    fireEvent.click(getByRole("button", { name: /show details/i }));

    expect(container.textContent ?? "").toContain("run cost: $1.25");
  });

  it("labels an unmetered or unlinked Tier-2 run cost as not yet recorded", () => {
    const { container, getByRole } = render(<RecCard rec={makeRec({ run_cost_u: null })} />);

    fireEvent.click(getByRole("button", { name: /show details/i }));

    expect(container.textContent ?? "").toContain("run cost: not yet recorded");
  });

  it("is collapsed by default: headline visible, evidence/formula hidden", () => {
    const rec = makeRec({
      modeled_formula: {
        model: "D2_LONG_CONTEXT_CACHE_READ_V1",
        inputs: { reduction_fraction: 0.33 },
        expression: "cache_tokens * price * reduction_fraction",
      },
    });
    const { container } = render(<RecCard rec={rec} />);

    // Headline (title) visible in collapsed state.
    expect(container.textContent ?? "").toContain("Use /clear between unrelated tasks");
    // Modeled $/wk is demoted OUT of the collapsed view (INT-5) — it appears only in the
    // expanded Expected-impact block.
    expect(container.textContent ?? "").not.toContain("$0.06/wk");

    // Formula detail NOT visible when collapsed.
    expect(container.textContent ?? "").not.toContain("reduction_fraction");
    expect(container.textContent ?? "").not.toContain("reduction_fraction");

    // Expand button present and aria-expanded=false.
    const expandBtn = container.querySelector<HTMLButtonElement>("button[aria-expanded='false']");
    expect(expandBtn).not.toBeNull();
  });

  it("expanding reveals formula, provenance, and target metric", () => {
    const rec = makeRec({
      target_metric: "unique_target_metric_xyz",
      modeled_formula: {
        model: "D2",
        inputs: { reduction_fraction: 0.5 },
        expression: "tokens * price * reduction_fraction",
      },
    });
    const { container, getByRole } = render(<RecCard rec={rec} />);

    // Collapsed: target metric not visible.
    expect(container.textContent ?? "").not.toContain("unique_target_metric_xyz");

    // Expand.
    fireEvent.click(getByRole("button", { name: /show details/i }));

    // Now visible after expanding.
    expect(container.textContent ?? "").toContain("unique_target_metric_xyz");
    expect(container.textContent ?? "").toContain("reduction_fraction");
  });

  it("D1 backfire caveat only visible when expanded", () => {
    const rec = makeRec({ detector_id: "D1", category: "CONTEXT" });
    const { container, getByRole } = render(<RecCard rec={rec} />);

    // Collapsed — caveat not visible.
    expect(container.textContent ?? "").not.toContain("batch this edit");

    // Expand.
    fireEvent.click(getByRole("button", { name: /show details/i }));

    // Now the D1 backfire warning is visible.
    expect(container.textContent ?? "").toContain(
      "batch this edit to a /clear or session boundary",
    );
  });

  it("collapsed state contains no absolute C:\\Users or /Users/ paths", () => {
    const rec = makeRec({
      evidence: {
        file_ref: "C:\\Users\\dev\\.claude\\CLAUDE.md",
        source_tokens: 23_000,
      },
    });
    const { container } = render(<RecCard rec={rec} />);

    // Evidence table is behind the expand toggle — collapsed DOM has no absolute paths.
    expect(container.textContent ?? "").not.toMatch(/C:\\Users/);
    expect(container.textContent ?? "").not.toMatch(/\/Users\//);
  });

  it("steps appear once in expanded view; steps key excluded from evidence table", () => {
    const steps: BoundedStep[] = [
      { kind: "generic", description: "Step Alpha" },
      { kind: "generic", description: "Step Beta" },
    ];
    // evidence.steps is raw DB data (still string[]); rec.steps is BoundedStep[]
    const rec = makeRec({
      steps,
      evidence: { session_count: 3, steps: ["Step Alpha", "Step Beta"] },
    });
    const { container, getByRole } = render(<RecCard rec={rec} />);

    // Collapsed — no steps visible.
    expect(container.textContent ?? "").not.toContain("Step Alpha");

    // Expand.
    fireEvent.click(getByRole("button", { name: /show details/i }));

    // Steps visible — count occurrences to verify no duplication.
    const text = container.textContent ?? "";
    expect(text).toContain("Step Alpha");
    const occurrences = (text.match(/Step Alpha/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RecommendationsPage — action integration
// ---------------------------------------------------------------------------

describe("RecommendationsPage — dismiss/adopt integration", () => {
  it("calls /api/recommendations/dismiss and re-fetches on success", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const { container } = render(<RecommendationsPage />);

    // Wait for the page to load (real timers — waitFor is safe here)
    await waitFor(() => expect(container.querySelector(".rec-card")).not.toBeNull());

    // Switch to fake timers for the deferred-commit window
    vi.useFakeTimers();

    const dismissBtn = container.querySelector<HTMLButtonElement>(
      ".rec-actions button:first-child",
    );
    if (!dismissBtn) throw new Error("dismiss button not found");
    fireEvent.click(dismissBtn);

    // Advance past the 5 s undo window — fires the deferred onDismiss callback
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/recommendations/dismiss",
      expect.objectContaining({ method: "POST" }),
    );

    // re-fetch triggered (fetchRecommendations called again)
    expect(vi.mocked(client.fetchRecommendations).mock.calls.length).toBeGreaterThan(1);
  });

  it("calls /api/recommendations/adopt and re-fetches on success", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const { container } = render(<RecommendationsPage />);

    // Wait for the page to load (real timers — waitFor is safe here)
    await waitFor(() => expect(container.querySelector(".rec-card")).not.toBeNull());

    // Switch to fake timers for the deferred-commit window
    vi.useFakeTimers();

    const adoptBtn = container.querySelector<HTMLButtonElement>(".rec-actions button:nth-child(2)");
    if (!adoptBtn) throw new Error("adopt button not found");
    fireEvent.click(adoptBtn);

    // Advance past the 5 s undo window — fires the deferred onAdopt callback
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/recommendations/adopt",
      expect.objectContaining({ method: "POST" }),
    );

    // re-fetch triggered (fetchRecommendations called again)
    expect(vi.mocked(client.fetchRecommendations).mock.calls.length).toBeGreaterThan(1);
  });

  it("shows adopted recs in the adopted section when present", async () => {
    const fixture = mockRecommendations();
    const adoptedRec = makeRec({
      rec_id: "rec-adopted-1",
      state: "ADOPTED",
      lever: "Adopted lever action",
    });
    const baseData = fixture.data as RecommendationsView;
    const withAdopted = {
      ...fixture,
      data: { ...baseData, adopted: [adoptedRec], dismissed: [] } satisfies RecommendationsView,
    };
    vi.mocked(client.fetchRecommendations).mockResolvedValue(withAdopted);

    const { container } = render(<RecommendationsPage />);

    await waitFor(() => {
      expect(container.textContent).toContain("Adopted lever action");
    });
  });

  it("shows dismissed recs with cool-down date in the dismissed section", async () => {
    const fixture = mockRecommendations();
    const dismissedRec = makeRec({
      rec_id: "rec-dismissed-1",
      state: "DISMISSED",
      lever: "Dismissed lever action",
      dismissed_until: "2026-09-24T00:00:00.000Z",
    });
    const baseData2 = fixture.data as RecommendationsView;
    const withDismissed = {
      ...fixture,
      data: { ...baseData2, dismissed: [dismissedRec], active: [] } satisfies RecommendationsView,
    };
    vi.mocked(client.fetchRecommendations).mockResolvedValue(withDismissed);

    const { container } = render(<RecommendationsPage />);

    await waitFor(() => {
      expect(container.textContent).toContain("Dismissed lever action");
      expect(container.textContent).toContain("2026-09-24");
    });
  });
});

// ---------------------------------------------------------------------------
// RecCard — RV4 primary-action routing
// ---------------------------------------------------------------------------

function hookConfigResponse(installed: boolean) {
  return {
    data: {
      context_window: 200_000,
      soft_pct: 0.6,
      hard_pct: 0.8,
      stale_s: 300,
      d7_fail_count: 3,
      d7_window_turns: 10,
      d9_idle_seconds: 1800,
      installed,
    },
    meta: mockLedger().meta,
  };
}

function makeCopyRec(): RecommendationCard {
  return makeRec({
    detector_id: "D1",
    category: "CONTEXT",
    evidence: {
      source_tokens: 12_000,
      source_target: 4_000,
      delta_context_tokens: 8_000,
      component: "CLAUDE.md",
    },
  });
}

function makeGroup(overrides: Partial<RecommendationGroup> = {}): RecommendationGroup {
  return {
    detector_id: "D1",
    label: "CLAUDE.md / memory",
    recs: [makeCopyRec()],
    session_count: 1,
    total_savings_u_per_wk: 2_000_000,
    ...overrides,
  };
}

describe("RecCard — RV4 primary-action routing", () => {
  it("copy-route card (D1) renders exactly one Copy prompt action", () => {
    const { getAllByRole } = render(<RecCard rec={makeCopyRec()} />);
    expect(getAllByRole("button", { name: "Copy prompt" })).toHaveLength(1);
  });

  it("copy-route group renders exactly one Copy prompt action", () => {
    const { getAllByRole } = render(<RecCard group={makeGroup()} rank={1} />);
    expect(getAllByRole("button", { name: "Copy prompt" })).toHaveLength(1);
  });

  it("no card renders the removed 'Copy Claude Code prompt' action", () => {
    const { queryByRole } = render(<RecCard rec={makeCopyRec()} />);
    expect(queryByRole("button", { name: "Copy Claude Code prompt" })).toBeNull();
  });

  it("behavioral card (D2) leads with Install hook and collapses the guided prompt", async () => {
    vi.mocked(client.fetchHookConfig).mockResolvedValue(hookConfigResponse(false));
    const { getByRole, findByRole, queryByRole } = render(
      <RecCard rec={makeRec({ detector_id: "D2" })} />,
    );

    expect(await findByRole("button", { name: "Install hook" })).toBeDefined();
    expect(queryByRole("button", { name: "Copy prompt" })).toBeNull();

    fireEvent.click(getByRole("button", { name: "Show guided prompt" }));
    expect(getByRole("button", { name: "Copy prompt" })).toBeDefined();
  });

  it("behavioral card (D8) also leads with Install hook", async () => {
    vi.mocked(client.fetchHookConfig).mockResolvedValue(hookConfigResponse(false));
    const { findByRole } = render(
      <RecCard rec={makeRec({ detector_id: "D8", category: "CACHE" })} />,
    );
    expect(await findByRole("button", { name: "Install hook" })).toBeDefined();
  });

  it("reflects an already-installed hook as a disabled Installed pill", async () => {
    vi.mocked(client.fetchHookConfig).mockResolvedValue(hookConfigResponse(true));
    const { findByRole } = render(<RecCard rec={makeRec({ detector_id: "D2" })} />);
    const btn = (await findByRole("button", { name: "Installed ✓" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("behavioral group (D2) leads with Install hook", async () => {
    vi.mocked(client.fetchHookConfig).mockResolvedValue(hookConfigResponse(false));
    const group = makeGroup({
      detector_id: "D2",
      label: "Session hygiene",
      recs: [makeRec({ detector_id: "D2" })],
    });
    const { findByRole, queryByRole } = render(<RecCard group={group} rank={1} />);
    expect(await findByRole("button", { name: "Install hook" })).toBeDefined();
    expect(queryByRole("button", { name: "Copy prompt" })).toBeNull();
  });

  it("D9 card routes to the Settings idle-sessions panel with no prompt", () => {
    const { getByRole, queryByRole } = render(
      <RecCard rec={makeRec({ detector_id: "D9", category: "SESSION_HYGIENE" })} />,
    );
    const link = getByRole("link", { name: "Review idle sessions" });
    expect(link.getAttribute("href")).toBe("#/settings");
    expect(queryByRole("button", { name: "Copy prompt" })).toBeNull();
  });

  it("D5 card routes to the Settings budget-calibration panel with no prompt", () => {
    const { getByRole, queryByRole } = render(
      <RecCard rec={makeRec({ detector_id: "D5", category: "LIMIT" })} />,
    );
    const link = getByRole("link", { name: "Calibrate budget hook" });
    expect(link.getAttribute("href")).toBe("#/settings");
    expect(queryByRole("button", { name: "Copy prompt" })).toBeNull();
  });
});
