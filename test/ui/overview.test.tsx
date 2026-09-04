/**
 * test/ui/overview.test.tsx — Overview surface integration tests.
 *
 * Covers:
 *   - Three distinct UI states: loading (skeleton) ≠ error (banner) ≠ ok/empty (data)
 *   - LiveStrip: LIVE row accent class + aria-live="polite"
 *   - BurnForecastCard: each state machine variant renders correctly
 *   - WorkspaceTable: spend column shows real USD (not N/A)
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSessionRow, WorkspaceSummary } from "../../src/query/api/overview";
import * as client from "../../src/ui/api/client";
import {
  mockBurnStatus,
  mockCacheWriteTrend,
  mockFlavorDecomposition,
  mockGlobalOverview,
  mockHeadroomTrend,
  mockHookConfigResponse,
  mockHotSessions,
  mockLiveSessions,
  mockRecommendations,
  mockSuccessRate,
  mockTrends,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
import type { WorkspaceLabelInput } from "../../src/ui/lib/workspace-label";
import BurnForecastCard from "../../src/ui/overview/BurnForecastCard";
import CacheWriteSpikesChart, {
  SPIKE_THRESHOLD_LABEL_POSITION,
} from "../../src/ui/overview/CacheWriteSpikesChart";
import LiveStrip from "../../src/ui/overview/LiveStrip";
import OverviewPage from "../../src/ui/overview/OverviewPage";
import WorkspaceTable from "../../src/ui/overview/WorkspaceTable";

vi.mock("../../src/ui/api/client");

// @testing-library/react auto-cleanup requires jest globals;
// in vitest with globals:false we must register it explicitly.
afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  // OverviewPage also fetches recommendations, success rate, and trends.
  // Give them safe defaults so auto-mocks always return a Promise;
  // individual tests may still override the other client methods.
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
  vi.mocked(client.fetchSuccessRate).mockResolvedValue(mockSuccessRate());
  vi.mocked(client.fetchBurnStatus).mockResolvedValue(mockBurnStatus());
  vi.mocked(client.fetchHookConfig).mockResolvedValue(mockHookConfigResponse(false));
  vi.mocked(client.fetchHotSessions).mockResolvedValue(mockHotSessions());
  vi.mocked(client.fetchTrends).mockResolvedValue(mockTrends({ preset: "7d" }));
  vi.mocked(client.fetchFlavorDecomposition).mockResolvedValue(
    mockFlavorDecomposition({ preset: "7d" }),
  );
  vi.mocked(client.fetchCacheWriteTrend).mockResolvedValue(mockCacheWriteTrend({ preset: "7d" }));
  vi.mocked(client.fetchHeadroomTrend).mockResolvedValue(mockHeadroomTrend({ preset: "7d" }));
});

// ---------------------------------------------------------------------------
// Helper: set all client methods to resolve with fixture data
// ---------------------------------------------------------------------------
function setupSuccess() {
  vi.mocked(client.fetchGlobalOverview).mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  vi.mocked(client.fetchLiveSessions).mockResolvedValue(mockLiveSessions());
}

// ---------------------------------------------------------------------------
// Three distinct UI states
// ---------------------------------------------------------------------------

describe("OverviewPage — three distinct states", () => {
  it("shows aria-busy skeleton while loading (state 1: loading)", () => {
    // Never-resolving promises keep the component in loading state
    vi.mocked(client.fetchGlobalOverview).mockReturnValue(new Promise(() => {}));
    vi.mocked(client.fetchWorkspaces).mockReturnValue(new Promise(() => {}));
    vi.mocked(client.fetchLiveSessions).mockReturnValue(new Promise(() => {}));

    const { container } = render(<OverviewPage />);

    // Loading skeleton must have aria-busy (distinct from error and empty)
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    // Error banner must NOT be present
    expect(container.querySelector(".banner-error")).toBeNull();
  });

  it("shows error banner when daemon is unreachable (state 2: error)", async () => {
    vi.mocked(client.fetchGlobalOverview).mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(client.fetchWorkspaces).mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(client.fetchLiveSessions).mockRejectedValue(new Error("ECONNREFUSED"));

    const { container } = render(<OverviewPage />);

    // Error banner uses role="alert" — semantically distinct from skeleton and empty
    await waitFor(() => {
      expect(container.querySelector(".banner-error")).not.toBeNull();
    });
    // aria-busy skeleton must NOT be present once error is shown
    expect(
      container.querySelector("[aria-busy='true'][aria-label='Loading overview data']"),
    ).toBeNull();
  });

  it("shows real data on success (state 3: ok) — not skeleton, not error", async () => {
    setupSuccess();

    const { container } = render(<OverviewPage />);

    // Fixture spend = $5,042.23 — must appear in the DOM
    await waitFor(() => {
      const matches = container.querySelectorAll("*");
      const found = Array.from(matches).some((el) => el.textContent?.includes("$5,042.23"));
      expect(found).toBe(true);
    });
    // No error banner
    expect(container.querySelector(".banner-error")).toBeNull();
    // No loading skeleton for overview data
    expect(container.querySelector("[aria-label='Loading overview data']")).toBeNull();
  });

  it("renders Context / Turn values from context_per_turn rather than model_mix", async () => {
    const overview = mockGlobalOverview({ preset: "7d" });
    if (overview.data === null) throw new Error("overview fixture must contain data");
    overview.data = {
      ...overview.data,
      context_per_turn: [
        {
          model: "claude-context-model",
          n: 7,
          avg_context_per_turn: 82_341,
          avg_output_per_turn: 1_234,
          usd_per_turn: null,
        },
      ],
      model_mix: [{ model: "claude-model-mix-only", turns: 7 }],
    };
    vi.mocked(client.fetchGlobalOverview).mockResolvedValue(overview);
    vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
    vi.mocked(client.fetchLiveSessions).mockResolvedValue(mockLiveSessions());

    const { container } = render(<OverviewPage />);

    await waitFor(() => {
      const section = container.querySelector("[data-testid='context-per-turn-section']");
      expect(section?.textContent).toContain("Context-model");
      expect(section?.textContent).toContain("82.3K");
      expect(section?.textContent).toContain("ctx");
      expect(section?.textContent).toContain("1.2K out");
      expect(section?.textContent).not.toContain("Model mix only");
      expect(section?.querySelector(".chip-obs-proxy")).not.toBeNull();
      expect(section?.querySelector("[role='progressbar']")?.getAttribute("aria-label")).toContain(
        "1.5%",
      );
    });
  });

  it("shows empty / N/A state when data is null (state 3b: ok but no data)", async () => {
    vi.mocked(client.fetchGlobalOverview).mockResolvedValue({
      data: null,
      meta: mockGlobalOverview({ preset: "7d" }).meta,
    });
    vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
    vi.mocked(client.fetchLiveSessions).mockResolvedValue(mockLiveSessions());

    const { container } = render(<OverviewPage />);

    await waitFor(() => {
      // Empty banner is shown (not error, not skeleton). Scope past the
      // page-top caveat banner (also .banner-info) to the empty-state one.
      const banners = Array.from(container.querySelectorAll(".banner-info"));
      expect(banners.some((b) => /No spend data/.test(b.textContent ?? ""))).toBe(true);
    });
    // Skeleton must not be visible
    expect(
      container.querySelector("[aria-busy='true'][aria-label='Loading overview data']"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LiveStrip — accent + aria-live
// ---------------------------------------------------------------------------

describe("LiveStrip", () => {
  const liveSession: LiveSessionRow & WorkspaceLabelInput = {
    session_id: "sess-1",
    workspace_id: "ws-1",
    project_slug: "orbit-api",
    repo_path: "C:/work/orbit-api",
    repo_owner: "acme",
    repo_name: "orbit-api",
    running_usd_u: 2_450_000, // $2.45
    current_context_tokens: 238_000,
    model: "claude-opus-5",
    started_at: "2026-08-23T14:00:00Z",
  };

  it("renders aria-live='polite' on the live container", () => {
    const { container } = render(<LiveStrip sessions={[]} isLoading={false} error={null} />);
    expect(container.querySelector("[aria-live='polite']")).not.toBeNull();
  });

  it("LIVE session row gets live-row-live class (orange border accent)", () => {
    const { container } = render(
      <LiveStrip sessions={[liveSession]} isLoading={false} error={null} />,
    );
    const row = container.querySelector("tr.live-row-live");
    expect(row).not.toBeNull();
    // NOT reconciled class
    expect(container.querySelector("tr.live-row-reconciled")).toBeNull();
  });

  it("shows the animated live-dot when sessions are present", () => {
    const { container } = render(
      <LiveStrip sessions={[liveSession]} isLoading={false} error={null} />,
    );
    const dot = container.querySelector(".live-dot.on");
    expect(dot).not.toBeNull();
  });

  it("shows skeleton when loading (distinct from empty state)", () => {
    const { container } = render(<LiveStrip sessions={[]} isLoading={true} error={null} />);
    // Skeleton present
    expect(container.querySelector(".skeleton")).not.toBeNull();
    // Empty message absent
    expect(container.querySelector(".live-strip-empty")).toBeNull();
  });

  it("shows empty state when loaded with no sessions (distinct from loading)", () => {
    const { container } = render(<LiveStrip sessions={[]} isLoading={false} error={null} />);
    expect(container.querySelector(".live-strip-empty")).not.toBeNull();
    // No skeleton
    expect(container.querySelector(".skeleton")).toBeNull();
  });

  it("shows error state inline when live fetch fails", () => {
    const { container } = render(
      <LiveStrip sessions={[]} isLoading={false} error="ECONNREFUSED" />,
    );
    expect(container.querySelector(".empty-state-text")?.textContent).toMatch(/unavailable/);
    // Neither skeleton nor empty-session text
    expect(container.querySelector(".skeleton")).toBeNull();
    expect(container.querySelector(".live-strip-empty")).toBeNull();
  });

  it("uses mapped and global workspace labels", () => {
    const sessions = [
      {
        ...liveSession,
        workspace_id: "mapped-id",
        project_slug: "raw-mapped",
        repo_owner: "acme",
        repo_name: "console",
      },
      { ...liveSession, session_id: "sess-global", workspace_id: "__global__" },
    ];
    render(<LiveStrip sessions={sessions} isLoading={false} error={null} />);

    expect(screen.getByText("acme/console")).toBeTruthy();
    expect(screen.getByText("Global")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// BurnForecastCard — 5+1 state machine
// ---------------------------------------------------------------------------

/** Extra ForecastFromDbResult fields added to every BurnForecastCard test fixture. */
const EXTRA_FORECAST_FIELDS = {
  cap_weighted: true,
  cap_read_coeff: 0.1,
  token_metric: "cap-weighted tokens",
  limit_scale_legacy: false,
  limit_scale_note: null,
  limit_confidence: null,
  limit_resets_at: null,
} as const;

describe("BurnForecastCard", () => {
  it("OFF: shows configure prompt and PROXY chip", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "OFF",
          limit_tokens: null,
          tokens_used: 2_450_000_000,
          tokens_per_day: null,
          projected_exhaustion_jd: null,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
        }}
        burnStatus={null}
      />,
    );
    expect(container.textContent).toMatch(/OFF/);
    expect(container.textContent).toMatch(/Weekly token limit/);
    expect(container.textContent).not.toMatch(/:limit_tokens/);
    expect(container.querySelector("[title=':limit_tokens']")).not.toBeNull();
    // PROXY chip present
    expect(container.querySelector(".chip-proxy")).not.toBeNull();
    // LIST_EQUIV chip NOT present (visually distinct)
    expect(container.querySelector(".chip-list-equiv")).toBeNull();
  });

  it("COLD_START: shows pct + baseline hint", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "COLD_START",
          limit_tokens: 10_000_000_000,
          tokens_used: 500_000_000,
          tokens_per_day: null,
          projected_exhaustion_jd: null,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
        }}
        burnStatus={null}
      />,
    );
    // 500M / 10B = 5%
    expect(container.textContent).toMatch(/5%/);
    expect(container.textContent).toMatch(/Building baseline/);
  });

  it("EXCEEDED: shows EXCEEDED chip and pct", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "EXCEEDED",
          limit_tokens: 10_000_000_000,
          tokens_used: 11_000_000_000,
          tokens_per_day: 1_500_000_000,
          projected_exhaustion_jd: null,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
        }}
        burnStatus={null}
      />,
    );
    expect(container.textContent).toMatch(/EXCEEDED/);
    // 11B / 10B = 110% (headline not clamped)
    expect(container.textContent).toMatch(/110%/);
  });

  it("WARNING: shows WARN chip and pct", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "WARNING",
          limit_tokens: 10_000_000_000,
          tokens_used: 9_000_000_000,
          tokens_per_day: 1_500_000_000,
          projected_exhaustion_jd: 2461000.5,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
        }}
        burnStatus={null}
      />,
    );
    expect(container.textContent).toMatch(/WARN/);
    // 9B / 10B = 90%
    expect(container.textContent).toMatch(/90%/);
  });

  it("OK: renders pct + used/limit, not the bare string 'OK'", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "OK",
          limit_tokens: 10_000_000_000,
          tokens_used: 3_000_000_000,
          tokens_per_day: 500_000_000,
          projected_exhaustion_jd: 2461020.5,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
        }}
        burnStatus={null}
      />,
    );
    // 3B / 10B = 30%
    expect(container.textContent).toMatch(/30%/);
    // Shows used / limit in sub-line
    expect(container.textContent).toMatch(/3\.0B/);
    expect(container.textContent).toMatch(/10\.0B/);
    // State chip says ON TRACK, not a raw text "OK"
    expect(container.textContent).toMatch(/ON TRACK/);
    expect(container.querySelector(".chip-proxy")).not.toBeNull();
  });

  it("NO_BURN: shows pct and ON TRACK chip", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "NO_BURN",
          limit_tokens: 10_000_000_000,
          tokens_used: 1_000_000_000,
          tokens_per_day: null,
          projected_exhaustion_jd: null,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
        }}
        burnStatus={null}
      />,
    );
    // 1B / 10B = 10%
    expect(container.textContent).toMatch(/10%/);
    expect(container.textContent).toMatch(/ON TRACK/);
  });

  it("prefers live burnStatus utilization over calibrated fraction", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "OK",
          limit_tokens: 10_000_000_000,
          tokens_used: 2_000_000_000, // 20% calibrated
          tokens_per_day: 300_000_000,
          projected_exhaustion_jd: null,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
          limit_resets_at: null,
        }}
        burnStatus={{
          available: true,
          seven_day: { utilization: 0.45, resets_at: "2026-09-09T00:00:00Z" },
        }}
      />,
    );
    // Live says 45%; calibrated would say 20%
    expect(container.textContent).toMatch(/45%/);
    // Should NOT show 20% as the headline fraction
    const headline = container.querySelector(".bfc-headline");
    expect(headline?.textContent).not.toMatch(/20%/);
  });

  it("falls back to calibrated fraction when burnStatus unavailable", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "OK",
          limit_tokens: 10_000_000_000,
          tokens_used: 3_500_000_000, // 35% calibrated
          tokens_per_day: 500_000_000,
          projected_exhaustion_jd: null,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
        }}
        burnStatus={null}
      />,
    );
    expect(container.textContent).toMatch(/35%/);
    // No reset-day shown (no resetsAt)
    expect(container.textContent).not.toMatch(/resets/);
  });

  it("shows LOW CONFIDENCE chip when limit_confidence === 'low'", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "OK",
          limit_tokens: 10_000_000_000,
          tokens_used: 3_000_000_000,
          tokens_per_day: null,
          projected_exhaustion_jd: null,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
          limit_confidence: "low",
        }}
        burnStatus={null}
      />,
    );
    expect(container.textContent).toMatch(/LOW CONFIDENCE/);
    expect(container.querySelector(".bfc-chip-low-confidence")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WorkspaceTable — spend is always real USD
// ---------------------------------------------------------------------------

describe("OverviewPage WorkspaceTable", () => {
  it("workspace spend column shows real USD, never N/A", async () => {
    setupSuccess();

    const { container } = render(<OverviewPage />);

    // orbit-api cost from fixture = $1,800.00
    await waitFor(() => {
      const found = Array.from(container.querySelectorAll("td")).some(
        (td) => td.textContent?.trim() === "$1,800.00",
      );
      expect(found).toBe(true);
    });
    // At least one workspace row rendered
    const rows = container.querySelectorAll("tbody tr:not([aria-hidden='true'])");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("uses mapped and global workspace labels", () => {
    const workspaces = [
      {
        workspace_id: "mapped-id",
        project_slug: "raw-mapped",
        repo_path: "C:/work/console",
        repo_owner: "acme",
        repo_name: "console",
        cost_equiv_u: 1,
        turns: 1,
        cost_share: 0.5,
        has_live: false,
        usd_per_turn: 0.000001,
      },
      {
        workspace_id: "__global__",
        project_slug: "raw-global",
        repo_path: null,
        repo_owner: null,
        repo_name: null,
        cost_equiv_u: 1,
        turns: 1,
        cost_share: 0.5,
        has_live: false,
        usd_per_turn: 0.000001,
      },
    ];
    render(
      <WorkspaceTable workspaces={workspaces} globalCostU={2} globalTurns={2} isLoading={false} />,
    );

    expect(screen.getByText("acme/console")).toBeTruthy();
    expect(screen.getByText("Global")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// CacheEfficiencyKPI — raw reuse band + separate forecast context
// ---------------------------------------------------------------------------

describe("CacheEfficiencyKPI", () => {
  it("renders the reuse band, raw-share warning, and selected-window cap draw", async () => {
    setupSuccess();
    const { container } = render(<OverviewPage />);

    await waitFor(() => {
      const text = container.textContent ?? "";
      expect(text).toMatch(/83\.3%/);
      expect(text).toMatch(/5\.0×/);
      expect(text).toMatch(/REUSE DOMINANT/);
      expect(text).toMatch(/diagnostic only · not a health signal/);
      expect(text).toMatch(/Cap-weighted draw: 13\.9M/);
      expect(text).toMatch(/coefficient 0\.1× unverified/);
    });

    expect(container.textContent ?? "").toMatch(/REUSE EFFICIENCY/);
  });

  it("retains the cache TTL volatility caveat when creations are present", async () => {
    setupSuccess();
    const { container } = render(<OverviewPage />);

    await waitFor(() => {
      expect(container.textContent ?? "").toMatch(/TTL 5m\/1h volatile/);
    });
  });

  it("keeps Burn Forecast as separate limit-relative context", async () => {
    setupSuccess();
    const { container } = render(<OverviewPage />);

    await waitFor(() => {
      const text = container.textContent ?? "";
      expect(text).toMatch(
        /Separate limit-relative context: Burn Forecast is trailing 1-day and provisional-inclusive/,
      );
      expect(text).toMatch(/BURN FORECAST/);
    });
  });
});

// ---------------------------------------------------------------------------
// FlavorDecomposition — section heading + myth note (verbatim)
// ---------------------------------------------------------------------------

describe("FlavorDecomposition", () => {
  it("renders the section heading 'Where your tokens go · weight per type'", async () => {
    setupSuccess();
    const { container } = render(<OverviewPage />);

    await waitFor(() => {
      const headings = Array.from(container.querySelectorAll("h2"));
      const found = headings.some((h) => h.textContent?.includes("Where your tokens go"));
      expect(found).toBe(true);
    });
  });

  it("renders the verbatim myth note from taxonomy §4 Section 1.2", async () => {
    setupSuccess();
    const { container } = render(<OverviewPage />);

    await waitFor(() => {
      const text = container.textContent ?? "";
      expect(text).toMatch(/Trimming a cached prompt saves ~10× less than you think\./);
      expect(text).toMatch(/Cache misses are where the real savings are\./);
    });
  });
});

// ---------------------------------------------------------------------------
// CacheWriteSpikesChart — section heading
// ---------------------------------------------------------------------------

describe("CacheWriteSpikesChart", () => {
  it("renders the writes-only chart branch (LIST_EQUIV chip + TTL caveat) when data is present", () => {
    const { container } = render(
      <CacheWriteSpikesChart
        state={{ status: "ok", value: mockCacheWriteTrend({ preset: "7d" }) }}
      />,
    );
    // Data-present branch (not the empty banner): the LIST_EQUIV claim chip and the
    // TTL volatility caveat only render when buckets exist and the chart is drawn.
    expect(container.querySelector(".chip-list-equiv")).not.toBeNull();
    expect(container.textContent ?? "").toMatch(/TTL 5m\/1h volatile/);
    expect(container.textContent ?? "").toMatch(/Cache writes over time/);
  });

  it("keeps the spike-threshold label inside the plot area", () => {
    expect(SPIKE_THRESHOLD_LABEL_POSITION).toBe("insideTopLeft");
  });

  it("renders the section heading when spike data is present", async () => {
    setupSuccess();
    const { container } = render(<OverviewPage />);

    await waitFor(() => {
      const headings = Array.from(container.querySelectorAll("h2"));
      const found = headings.some((h) => h.textContent?.includes("Cache writes over time"));
      expect(found).toBe(true);
    });
  });
});
