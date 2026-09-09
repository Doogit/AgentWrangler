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

import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
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
import ImpactLedger from "../../src/ui/recommendations/ImpactLedger";
import RecCard, { __resetHookInstallCache } from "../../src/ui/recommendations/RecCard";
import RecommendationsPage from "../../src/ui/recommendations/RecommendationsPage";
import { makeEffectCycle as effectCycle } from "./effect-cycle-fixture";

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
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
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
    // ESF2 fixtures opt into tracking explicitly. Missing capability remains
    // a conservative manual state and is covered below.
    effect_capability: { mode: "TRACKABLE", reason: null },
    ...overrides,
  };
}

function withTrackableCapabilities(view: ReturnType<typeof mockRecommendations>) {
  if (view.data === null) return view;
  return {
    ...view,
    data: {
      ...view.data,
      active: view.data.active.map((rec) => ({
        ...rec,
        effect_capability: { mode: "TRACKABLE" as const, reason: null },
      })),
      // Groups are derived from active cards when their pre-ESF payload lacks
      // the matching lifecycle projection.
      active_groups: [],
    },
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

  it("uses the plain-language D7 label instead of the session-hygiene fallback", () => {
    const rec = makeRec({ detector_id: "D7", category: "SESSION_HYGIENE" });
    const { container } = render(<RecCard rec={rec} />);

    expect(container.querySelector(".rec-category-chip")?.textContent).toBe(
      "Repeated attempts and reads",
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

  it("requires manual completion attestation before tracking a copied action", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/token")
        return Promise.resolve({ ok: true, json: async () => ({ token: "tok" }) });
      return Promise.resolve({
        ok: true,
        json: async () => ({
          supported: true,
          cycle: effectCycle({ state: "OPEN_SETTLING" }),
        }),
      });
    });
    vi.stubGlobal("fetch", mockFetch);
    const { getByRole } = render(<RecCard rec={makeRec()} />);
    expect(() => getByRole("button", { name: "Track this change" })).toThrow();
    fireEvent.click(getByRole("button", { name: "Show guided prompt" }));
    fireEvent.click(getByRole("button", { name: "Copy prompt" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(getByRole("button", { name: "I completed the change" })).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "I completed the change" }));
    fireEvent.click(getByRole("button", { name: "Track this change" }));
    expect(mockFetch).toHaveBeenCalledTimes(0);
    expect(getByRole("button", { name: "Undo" })).toBeDefined();
    expect(getByRole("button", { name: "Undo" }).parentElement?.textContent).toContain(
      "Track pending",
    );
    act(() => vi.advanceTimersByTime(5_000));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/esf/effects/track",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"completed_change":true'),
      }),
    );
  });

  it("Dismiss is disabled when no onDismiss prop is given", () => {
    const { getByRole } = render(<RecCard rec={makeRec()} />);
    expect((getByRole("button", { name: "Dismiss" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not offer tracking until there is action evidence", () => {
    const { queryByRole } = render(<RecCard rec={makeRec()} />);
    expect(queryByRole("button", { name: "Track this change" })).toBeNull();
  });

  it("keeps recommendations without an ESF capability manual and does not show a countdown", () => {
    const { effect_capability: _capability, ...rec } = makeRec();
    const { queryByRole, getByText } = render(<RecCard rec={rec} />);
    expect(queryByRole("button", { name: "Track this change" })).toBeNull();
    expect(getByText(/Measurement availability is unknown/)).toBeDefined();
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
// RecCard — ESF2 lifecycle evidence and controls
// ---------------------------------------------------------------------------

describe("RecCard — ESF2 lifecycle evidence and controls", () => {
  it("loads bounded history, loads more, and keeps legacy evidence read-only", async () => {
    const mockFetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("cycle_cursor=next-cycle")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            writer_enabled: true,
            cycles: [
              effectCycle({
                cycleId: "cycle-older",
                cycleNo: 1,
                state: "STOPPED",
                createdAt: "2026-09-01T00:00:00Z",
                versionStatus: "SUPPORTED",
              }),
            ],
            legacy: [],
            next_cycle_cursor: null,
            next_legacy_cursor: null,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          writer_enabled: true,
          cycles: [
            effectCycle({
              cycleId: "cycle-current",
              cycleNo: 2,
              state: "OPEN_MEASURING",
              createdAt: "2026-09-02T00:00:00Z",
              versionStatus: "SUPPORTED",
            }),
          ],
          legacy: [
            {
              cycleId: "legacy-1",
              state: "LEGACY_FINALIZED",
              measuredAt: "2026-08-30T00:00:00Z",
              verdict: "NO_EFFECT",
            },
          ],
          next_cycle_cursor: "next-cycle",
          next_legacy_cursor: null,
        }),
      });
    });
    vi.stubGlobal("fetch", mockFetch);
    const view = render(<RecCard rec={makeRec({ effect_cycle: effectCycle() })} />);
    await waitFor(() =>
      expect(view.getByText(/Legacy target-metric result: NO_EFFECT/)).toBeDefined(),
    );
    expect(view.getByText(/read-only/)).toBeDefined();
    fireEvent.click(view.getByRole("button", { name: "Load more history" }));
    await waitFor(() => expect(view.getByText(/Cycle 1: STOPPED/)).toBeDefined());
  });

  it("retries a failed history read and reuses a lifecycle retry key", async () => {
    let historyAttempts = 0;
    let stopAttempts = 0;
    const stopBodies: string[] = [];
    const mockFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/token")
        return Promise.resolve({ ok: true, json: async () => ({ token: "tok" }) });
      if (url.startsWith("/api/esf/effects?")) {
        historyAttempts += 1;
        return Promise.resolve(
          historyAttempts === 1
            ? { ok: false, json: async () => ({ error: "offline" }) }
            : {
                ok: true,
                json: async () => ({
                  writer_enabled: true,
                  cycles: [],
                  legacy: [],
                  next_cycle_cursor: null,
                  next_legacy_cursor: null,
                }),
              },
        );
      }
      if (url === "/api/esf/effects/stop") {
        stopAttempts += 1;
        stopBodies.push(String(init?.body));
        return Promise.resolve(
          stopAttempts === 1
            ? { ok: false, status: 409, json: async () => ({ error: "conflict" }) }
            : { ok: true, json: async () => effectCycle({ state: "STOPPED" }) },
        );
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);
    const view = render(<RecCard rec={makeRec({ effect_cycle: effectCycle() })} />);
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Retry loading history" })).toBeDefined(),
    );
    fireEvent.click(view.getByRole("button", { name: "Retry loading history" }));
    await waitFor(() => expect(view.getByText("No recorded measurement history.")).toBeDefined());
    fireEvent.click(view.getByRole("button", { name: "Stop measurement" }));
    await waitFor(() => expect(view.getByText(/Could not save: conflict/)).toBeDefined());
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(stopAttempts).toBe(2));
    expect(stopBodies[1]).toBe(stopBodies[0]);
  });

  it("offers close only for finalized attribution and consumes the server result", async () => {
    let attempts = 0;
    const bodies: string[] = [];
    const cycle = effectCycle({ state: "FINALIZED", attributionClosedAt: null });
    const closed = {
      ...cycle,
      attributionClosedAt: "2026-09-08T12:00:00Z",
      attributionCloseReason: "USER_CLOSED",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/token") return { ok: true, json: async () => ({ token: "tok" }) };
        if (url === "/api/esf/effects/close") {
          bodies.push(String(init?.body));
          attempts += 1;
          return attempts === 1
            ? { ok: false, status: 409, json: async () => ({ error: "conflict" }) }
            : { ok: true, json: async () => closed };
        }
        return {
          ok: true,
          json: async () => ({
            writer_enabled: true,
            cycles: [],
            legacy: [],
            next_cycle_cursor: null,
            next_legacy_cursor: null,
          }),
        };
      }),
    );
    const view = render(<RecCard rec={makeRec({ effect_cycle: cycle })} />);
    fireEvent.click(view.getByRole("button", { name: "Close attribution" }));
    await waitFor(() => expect(view.getByText(/Could not save: conflict/)).toBeDefined());
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "Close attribution" })).toBeNull(),
    );
    expect(bodies[1]).toBe(bodies[0]);
    expect(view.getByText(/Attribution closed/)).toBeDefined();
    view.rerender(<RecCard rec={makeRec({ effect_cycle: effectCycle() })} />);
    expect(view.queryByRole("button", { name: "Close attribution" })).toBeNull();
    expect(view.getByRole("button", { name: "Stop measurement" })).toBeDefined();
  });

  it("uses the server's finalized state when stopping races finalization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/token") return { ok: true, json: async () => ({ token: "tok" }) };
        if (url === "/api/esf/effects/stop")
          return { ok: true, json: async () => effectCycle({ state: "FINALIZED" }) };
        return {
          ok: true,
          json: async () => ({
            writer_enabled: true,
            cycles: [],
            legacy: [],
            next_cycle_cursor: null,
            next_legacy_cursor: null,
          }),
        };
      }),
    );
    const view = render(<RecCard rec={makeRec({ effect_cycle: effectCycle() })} />);
    fireEvent.click(view.getByRole("button", { name: "Stop measurement" }));
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Close attribution" })).toBeDefined(),
    );
    expect(view.queryByRole("button", { name: "Stop measurement" })).toBeNull();
  });

  it("keeps frozen lifecycle controls available after current source drift without allowing retrack", async () => {
    const stopped = effectCycle({ state: "STOPPED" });
    const mockFetch = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        json: async () => (String(input) === "/api/token" ? { token: "tok" } : stopped),
      }),
    );
    vi.stubGlobal("fetch", mockFetch);
    const rec = makeRec({
      effect_cycle: effectCycle(),
      effect_capability: { mode: "MANUAL", reason: "SOURCE_UNAVAILABLE" },
    });
    const view = render(<RecCard rec={rec} />);
    fireEvent.click(view.getByRole("button", { name: "Stop measurement" }));
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "Stop measurement" })).toBeNull(),
    );
    expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith("/stop"))).toBe(true);
    expect(view.getByRole("button", { name: "I reverted the change" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Track another change" })).toBeNull();
    view.rerender(<RecCard rec={{ ...rec, effect_cycle: effectCycle({ state: "FINALIZED" }) }} />);
    expect(view.getByRole("button", { name: "Close attribution" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Track another change" })).toBeNull();
  });

  it("keeps unsupported versions and disabled writers read-only, including rollback", () => {
    const cycle = effectCycle({ versionStatus: "UNSUPPORTED_VERSION", rollbackStatus: "MANUAL" });
    const view = render(<RecCard rec={makeRec({ effect_cycle: cycle })} />);
    for (const name of [
      "Stop measurement",
      "Close attribution",
      "I reverted the change",
      "Track another change",
    ]) {
      expect(view.queryByRole("button", { name })).toBeNull();
    }
    view.rerender(
      <RecCard
        rec={makeRec({
          effect_cycle: effectCycle(),
          effect_capability: { mode: "READ_ONLY", reason: "WRITER_DISABLED" },
        })}
      />,
    );
    expect(view.queryByRole("button", { name: "Stop measurement" })).toBeNull();
    expect(view.queryByRole("button", { name: "I reverted the change" })).toBeNull();
  });

  it("retries rollback attestation with the same intent and reloads its canonical cycle", async () => {
    let attempts = 0;
    const bodies: string[] = [];
    const current = effectCycle({ rollbackStatus: "MANUAL" });
    const recorded = effectCycle({
      state: "STOPPED",
      rollbackStatus: "USER_ATTESTED",
      comparisonReasons: ["ROLLBACK_TIME_UNKNOWN"],
    });
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push(url);
        if (url === "/api/token") return { ok: true, json: async () => ({ token: "tok" }) };
        if (url === "/api/esf/effects/attest-rollback") {
          attempts += 1;
          bodies.push(String(init?.body));
          return attempts === 1
            ? { ok: false, status: 409, json: async () => ({ error: "offline" }) }
            : {
                ok: true,
                json: async () => ({ cycleId: current.cycleId, status: "USER_ATTESTED" }),
              };
        }
        return {
          ok: true,
          json: async () => ({
            writer_enabled: true,
            cycles: [attempts > 1 ? recorded : current],
            legacy: [],
            next_cycle_cursor: null,
            next_legacy_cursor: null,
          }),
        };
      }),
    );
    const view = render(<RecCard rec={makeRec({ effect_cycle: current })} />);
    fireEvent.click(view.getByRole("button", { name: "I reverted the change" }));
    await waitFor(() => expect(view.getByRole("button", { name: "Retry" })).toBeDefined());
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "I reverted the change" })).toBeNull(),
    );
    expect(view.queryByRole("button", { name: "Stop measurement" })).toBeNull();
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[1] ?? "{}")).toMatchObject({
      cycle_id: current.cycleId,
      actual_time_known: false,
    });
    expect(requests).not.toContain("/api/esf/effects/track");
  });

  it("requires confirmation before retracking a terminal cycle", () => {
    const view = render(
      <RecCard rec={makeRec({ effect_cycle: effectCycle({ state: "STOPPED" }) })} />,
    );
    fireEvent.click(view.getByRole("button", { name: "Track another change" }));
    expect(view.getByText(/starts a new measurement cycle/)).toBeDefined();
    expect(
      (view.getByRole("button", { name: "Confirm retrack" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(view.getByRole("checkbox", { name: /I completed another change/ }));
    expect(
      (view.getByRole("button", { name: "Confirm retrack" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    view.rerender(
      <RecCard
        rec={makeRec({
          effect_cycle: effectCycle({ state: "STOPPED", rollbackStatus: "PENDING" }),
        })}
      />,
    );
    expect(view.queryByRole("button", { name: "Track another change" })).toBeNull();
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
    expect(container.textContent ?? "").toContain("Make this edit between tasks or after /clear.");
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

    const mockFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ token: "synthetic-token" }) });
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

  it("tracks a completed change through ESF2 and re-fetches on success", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(
      withTrackableCapabilities(mockRecommendations()),
    );

    const mockFetch = vi.fn((input: RequestInfo | URL) =>
      String(input) === "/api/token"
        ? Promise.resolve({ ok: true, json: async () => ({ token: "synthetic-token" }) })
        : Promise.resolve({
            ok: true,
            json: async () => ({
              supported: true,
              cycle: effectCycle({ state: "OPEN_SETTLING" }),
            }),
          }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const { container } = render(<RecommendationsPage />);

    // Wait for the page to load (real timers — waitFor is safe here)
    await waitFor(() => expect(container.querySelector(".rec-card")).not.toBeNull());

    // Switch to fake timers for the deferred-commit window
    vi.useFakeTimers();

    const guidedToggle = container.querySelector<HTMLButtonElement>(".rec-guided-toggle");
    if (!guidedToggle) throw new Error("guided prompt toggle not found");
    fireEvent.click(guidedToggle);
    const copyPrompt = container.querySelector<HTMLButtonElement>(".rec-prompt-artifact button");
    if (!copyPrompt) throw new Error("copy prompt button not found");
    fireEvent.click(copyPrompt);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toContain("I completed the change");
    const completionButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "I completed the change");
    if (!completionButton) throw new Error("completion attestation not found");
    fireEvent.click(completionButton);
    const adoptBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Track this change",
    );
    if (!adoptBtn) throw new Error("adopt button not found");
    fireEvent.click(adoptBtn);

    // Advance past the 5 s undo window — fires the deferred onAdopt callback
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/esf/effects/track",
      expect.objectContaining({ method: "POST" }),
    );

    // re-fetch triggered (fetchRecommendations called again)
    expect(vi.mocked(client.fetchRecommendations).mock.calls.length).toBeGreaterThan(1);
  });

  it("copies and attests a change before tracking it, then exposes the measuring ledger state", async () => {
    const initial = withTrackableCapabilities(mockRecommendations());
    const rec = initial.data?.active[0];
    const measuring = mockLedger().data?.entries[1];
    if (!initial.data || !rec || !measuring) throw new Error("missing controlled workflow fixture");

    const tracked = structuredClone(initial);
    if (tracked.data === null) throw new Error("tracked fixture data must be populated");
    tracked.data.active = [];
    tracked.data.active_groups = [];
    tracked.data.adopted = [{ ...rec, state: "ADOPTED", effect_cycle: effectCycle() }];
    let ledger: ReturnType<typeof mockLedger> = {
      ...mockLedger(),
      data: { entries: [], cap_read_coeff: 0.1 },
    };
    vi.mocked(client.fetchRecommendations)
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(tracked);
    vi.mocked(client.fetchLedger).mockImplementation(() => Promise.resolve(ledger));

    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/token") {
        return { ok: true, json: async () => ({ token: "synthetic-token" }) };
      }
      if (url === "/api/esf/effects/track") {
        ledger = {
          ...mockLedger(),
          data: {
            entries: [
              {
                ...measuring,
                rec_id: rec.rec_id,
                state: "ADOPTED",
                effects: [],
                effect_cycle: effectCycle(),
              },
            ],
            cap_read_coeff: 0.1,
          },
        };
        return {
          ok: true,
          json: async () => ({
            supported: true,
            cycle: effectCycle({ state: "OPEN_MEASURING" }),
          }),
        };
      }
      return { ok: false, status: 404, text: async () => "unexpected request" };
    });
    vi.stubGlobal("fetch", mockFetch);

    const page = render(<RecommendationsPage />);
    await waitFor(() => expect(page.container.querySelector(".rec-card")).not.toBeNull());
    vi.useFakeTimers();
    const guidedToggle = page.container.querySelector<HTMLButtonElement>(".rec-guided-toggle");
    if (!guidedToggle) throw new Error("guided prompt toggle not found");
    fireEvent.click(guidedToggle);
    const copyPrompt = page.container.querySelector<HTMLButtonElement>(
      ".rec-prompt-artifact button",
    );
    if (!copyPrompt) throw new Error("copy prompt button not found");
    fireEvent.click(copyPrompt);
    await act(async () => {
      await Promise.resolve();
    });
    const completeButton = Array.from(
      page.container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "I completed the change");
    if (!completeButton) throw new Error("completion attestation not found");
    fireEvent.click(completeButton);
    const trackButton = Array.from(
      page.container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Track this change");
    if (!trackButton) throw new Error("track change button not found");
    fireEvent.click(trackButton);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/esf/effects/track",
      expect.objectContaining({
        body: expect.stringContaining(`"rec_id":"${rec.rec_id}"`),
        method: "POST",
      }),
    );

    vi.useRealTimers();
    await waitFor(() =>
      expect(page.getByRole("button", { name: "Stop measurement" })).toBeDefined(),
    );
    expect(page.getByRole("button", { name: "I reverted the change" })).toBeDefined();
    // A fresh page still exposes controls for the adopted member.
    page.unmount();
    const reopened = render(<RecommendationsPage />);
    await waitFor(() =>
      expect(reopened.getByRole("button", { name: "Stop measurement" })).toBeDefined(),
    );
    reopened.unmount();
    const ledgerView = render(<ImpactLedger />);
    await waitFor(() => expect(ledgerView.container.textContent).toContain("OPEN MEASURING"));
    expect(ledgerView.container.textContent).toContain("2026-09-30");
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

  it("collapsed copy-route group renders exactly one Copy prompt action", () => {
    const { getAllByRole } = render(<RecCard group={makeGroup()} rank={1} />);
    expect(getAllByRole("button", { name: "Copy prompt" })).toHaveLength(1);
  });

  it("keeps grouped D1 copy, attestation and tracking owned by the selected member", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn((input: RequestInfo | URL) =>
      String(input) === "/api/token"
        ? Promise.resolve({ ok: true, json: async () => ({ token: "tok" }) })
        : Promise.resolve({
            ok: true,
            json: async () => ({
              supported: true,
              cycle: effectCycle({
                cycleId: "cycle-2",
                cycleNo: 1,
                state: "OPEN_SETTLING",
                targetDirection: null,
                comparisonStatus: null,
                comparisonReasons: [],
                scheduledObservationTo: "2026-09-30T00:00:00Z",
                rollbackStatus: null,
              }),
            }),
          }),
    );
    vi.stubGlobal("fetch", mockFetch);
    const recs = ["first", "second"].map((name) => ({
      ...makeCopyRec(),
      rec_id: `rec-${name}`,
      file_ref: `C:/synthetic/${name}/CLAUDE.md`,
      effect_capability: { mode: "TRACKABLE" as const, reason: null },
    }));
    const view = render(<RecCard group={makeGroup({ recs })} rank={1} />);
    // The representative preview must grant no member evidence.
    fireEvent.click(view.getByRole("button", { name: "Copy prompt" }));
    await act(async () => {
      await Promise.resolve();
    });
    for (const toggle of view.getAllByRole("button", { name: /Show details/ })) {
      fireEvent.click(toggle);
    }
    const rows = view.container.querySelectorAll(".rec-group-members > .rec-session-row");
    expect(rows).toHaveLength(2);
    const first = within(rows[0] as HTMLElement);
    const second = within(rows[1] as HTMLElement);
    expect(view.queryByRole("button", { name: "I completed the change" })).toBeNull();
    expect(view.queryByRole("button", { name: "Track this change" })).toBeNull();
    expect(first.getByRole("button", { name: "Copy prompt" })).toBeDefined();
    fireEvent.click(second.getByRole("button", { name: "Copy prompt" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      expect.stringContaining("C:/synthetic/second/CLAUDE.md"),
    );
    expect(second.queryByRole("button", { name: "Track this change" })).toBeNull();
    fireEvent.click(second.getByRole("button", { name: "I completed the change" }));
    expect(second.getByText(/Tracking records a baseline/)).toBeDefined();
    fireEvent.click(second.getByRole("button", { name: "Track this change" }));
    expect(mockFetch).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/esf/effects/track",
      expect.objectContaining({ body: expect.stringContaining('"rec_id":"rec-second"') }),
    );
    expect(first.queryByRole("button", { name: "I completed the change" })).toBeNull();
    expect(first.queryByRole("button", { name: "Track this change" })).toBeNull();
    expect(first.getByRole("button", { name: "Copy prompt" })).toBeDefined();
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

  it("rechecks hook state on return, focus and settings changes", async () => {
    vi.mocked(client.fetchHookConfig).mockResolvedValue(hookConfigResponse(true));
    const first = render(<RecCard rec={makeRec()} />);
    await first.findByRole("button", { name: "Installed ✓" });
    first.unmount();
    vi.mocked(client.fetchHookConfig).mockResolvedValue(hookConfigResponse(false));
    const next = render(<RecCard rec={makeRec()} />);
    await next.findByRole("button", { name: "Install hook" });
    vi.mocked(client.fetchHookConfig).mockResolvedValue(hookConfigResponse(true));
    fireEvent(window, new Event("focus"));
    await next.findByRole("button", { name: "Installed ✓" });
    vi.mocked(client.fetchHookConfig).mockResolvedValue(hookConfigResponse(false));
    fireEvent(window, new Event("agentwrangler:hooks-changed"));
    await next.findByRole("button", { name: "Install hook" });
  });

  it("does not treat failed status reads as not installed and permits retry", async () => {
    vi.mocked(client.fetchHookConfig).mockRejectedValueOnce(new Error("status offline"));
    const result = render(<RecCard rec={makeRec()} />);
    expect((await result.findByRole("alert")).textContent).toContain("status offline");
    expect(result.queryByRole("button", { name: "Install hook" })).toBeNull();
    vi.mocked(client.fetchHookConfig).mockResolvedValue(hookConfigResponse(false));
    fireEvent.click(result.getByRole("button", { name: "Retry status check" }));
    await result.findByRole("button", { name: "Install hook" });
  });

  it("shares an in-flight hook check and rechecks when the document becomes visible", async () => {
    let resolveCheck: (value: ReturnType<typeof hookConfigResponse>) => void = () => {};
    vi.mocked(client.fetchHookConfig).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );
    const result = render(
      <>
        <RecCard rec={makeRec()} />
        <RecCard rec={makeRec({ rec_id: "second-hook-card" })} />
      </>,
    );
    await waitFor(() => expect(client.fetchHookConfig).toHaveBeenCalledTimes(1));
    await act(async () => resolveCheck(hookConfigResponse(true)));
    expect(result.getAllByRole("button", { name: "Installed ✓" })).toHaveLength(2);
    vi.mocked(client.fetchHookConfig).mockResolvedValue(hookConfigResponse(false));
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(client.fetchHookConfig).toHaveBeenCalledTimes(1);
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(result.getAllByRole("button", { name: "Install hook" })).toHaveLength(2),
    );
    expect(client.fetchHookConfig).toHaveBeenCalledTimes(2);
    hidden.mockRestore();
  });

  it("claims installation only after persistence succeeds and permits retry on failure", async () => {
    vi.mocked(client.fetchHookConfig).mockResolvedValue(hookConfigResponse(false));
    let rejectInstall: (reason: Error) => void = () => {};
    vi.mocked(client.installHook).mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectInstall = reject;
      }),
    );
    const result = render(<RecCard rec={makeRec()} />);
    fireEvent.click(await result.findByRole("button", { name: "Install hook" }));
    expect(result.getByRole("button", { name: "Installing…" }).hasAttribute("disabled")).toBe(true);
    expect(result.queryByRole("button", { name: "Installed ✓" })).toBeNull();
    await act(async () => rejectInstall(new Error("install failed")));
    expect(result.getByRole("alert").textContent).toContain("install failed");
    vi.mocked(client.installHook).mockResolvedValue({
      changed: true,
      settingsPath: "/synthetic/settings.json",
    });
    fireEvent.click(result.getByRole("button", { name: "Install hook" }));
    await result.findByRole("button", { name: "Installed ✓" });
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
    expect(link.getAttribute("href")).toBe("#/settings?section=idle-sessions");
    expect(queryByRole("button", { name: "Copy prompt" })).toBeNull();
  });

  it("D5 card routes to the Settings budget-calibration panel with no prompt", () => {
    const { getByRole, queryByRole } = render(
      <RecCard rec={makeRec({ detector_id: "D5", category: "LIMIT" })} />,
    );
    const link = getByRole("link", { name: "Calibrate budget hook" });
    expect(link.getAttribute("href")).toBe("#/settings?section=calibration");
    expect(queryByRole("button", { name: "Copy prompt" })).toBeNull();
  });
});
