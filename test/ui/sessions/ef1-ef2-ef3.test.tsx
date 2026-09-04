/**
 * test/ui/sessions/ef1-ef2-ef3.test.tsx
 *
 * Behavioral tests for EF1/EF2/EF3 UI surfaces:
 *  - EF1 cells on SessionDetailPage (turns_to_first_commit, deep_abandoned)
 *  - EF3 gap aggregates in FrictionCell (strip + compact variants)
 *  - EF2 closure proxy on WorkspaceDetailPage
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_GAP_THRESHOLD_S } from "../../../src/ingest/types";
import type { SessionSummary } from "../../../src/query/api/overview";
import * as client from "../../../src/ui/api/client";
import {
  mockClosureProxy,
  mockCostPerSuccess,
  mockSession,
  mockTurnTimeline,
  mockWorkspaceSessions,
  mockWorkspaces,
} from "../../../src/ui/api/fixtures";
import { FrictionCell } from "../../../src/ui/sessions/FrictionCell";
import SessionDetailPage from "../../../src/ui/sessions/SessionDetailPage";

vi.mock("../../../src/ui/api/client");
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ComposedChart: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Line: () => null,
    Scatter: () => null,
    ReferenceLine: () => null,
  };
});

afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// EF1 — turns_to_first_commit + deep_abandoned on SessionDetailPage
// ---------------------------------------------------------------------------

describe("EF1 cells on SessionDetailPage", () => {
  it("renders turns_to_first_commit from the session fixture", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-demo"));
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);

    await screen.findByText("Session detail");
    // fixture sets turns_to_first_commit: 4
    expect(screen.getByTestId("turns-to-first-commit").textContent).toBe("4");
  });

  it("renders '—/no commit' when turns_to_first_commit is null", async () => {
    const fixture = mockSession("session-no-commit");
    if (fixture.data === null) throw new Error("fixture must have data");
    fixture.data = {
      ...(fixture.data as SessionSummary),
      turns_to_first_commit: null,
      deep_abandoned: false,
    };
    vi.mocked(client.fetchSession).mockResolvedValue(fixture);
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-no-commit"));
    render(<SessionDetailPage sessionId="session-no-commit" onBack={() => {}} />);

    await screen.findByText("Session detail");
    expect(screen.getByTestId("turns-to-first-commit").textContent).toBe("—/no commit");
  });

  it("renders '—' when turns_to_first_commit is undefined (legacy row)", async () => {
    const fixture = mockSession("session-legacy");
    if (fixture.data === null) throw new Error("fixture must have data");
    // Omit the EF1 fields entirely
    const {
      turns_to_first_commit: _t,
      deep_abandoned: _d,
      ...rest
    } = fixture.data as SessionSummary & {
      turns_to_first_commit?: number | null;
      deep_abandoned?: boolean;
    };
    fixture.data = rest as SessionSummary;
    vi.mocked(client.fetchSession).mockResolvedValue(fixture);
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-legacy"));
    render(<SessionDetailPage sessionId="session-legacy" onBack={() => {}} />);

    await screen.findByText("Session detail");
    expect(screen.getByTestId("turns-to-first-commit").textContent).toBe("—");
  });

  it("renders DEEP ABANDONED chip when deep_abandoned is true", async () => {
    const fixture = mockSession("session-deep");
    if (fixture.data === null) throw new Error("fixture must have data");
    fixture.data = {
      ...(fixture.data as SessionSummary),
      turns_to_first_commit: null,
      deep_abandoned: true,
    };
    vi.mocked(client.fetchSession).mockResolvedValue(fixture);
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-deep"));
    render(<SessionDetailPage sessionId="session-deep" onBack={() => {}} />);

    await screen.findByText("Session detail");
    expect(screen.getByTestId("deep-abandoned").textContent).toContain("DEEP ABANDONED");
  });

  it("renders 'No' for deep_abandoned when false", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-demo"));
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);

    await screen.findByText("Session detail");
    expect(screen.getByTestId("deep-abandoned").textContent).toBe("No");
  });
});

// ---------------------------------------------------------------------------
// EF3 — gap aggregates in FrictionCell
// ---------------------------------------------------------------------------

describe("FrictionCell gap aggregates (strip variant)", () => {
  it("shows gap median, p90, and long-gap count when gap_n >= 2", () => {
    render(
      <FrictionCell
        counts={{
          api_error_count: 0,
          tool_error_count: 0,
          test_fail_count: 0,
          compaction_count: 0,
          interrupt_count: 0,
          user_turn_count: 3,
          turn_count: 12,
          gap_median_s: 45,
          gap_p90_s: 320,
          long_gap_count: 1,
          gap_n: 3,
        }}
        variant="strip"
      />,
    );
    expect(screen.getByTestId("gap-median").textContent).toBe("45s");
    expect(screen.getByTestId("gap-p90").textContent).toBe("320s");
    expect(screen.getByTestId("long-gap-count").textContent).toBe("1");
  });

  it("shows '—' for all gap fields when gap_n < 2", () => {
    render(
      <FrictionCell
        counts={{
          api_error_count: 0,
          tool_error_count: 0,
          test_fail_count: 0,
          compaction_count: 0,
          interrupt_count: 0,
          user_turn_count: 1,
          turn_count: 5,
          gap_median_s: null,
          gap_p90_s: null,
          long_gap_count: 0,
          gap_n: 1,
        }}
        variant="strip"
      />,
    );
    expect(screen.getByTestId("gap-median").textContent).toBe("—");
    expect(screen.getByTestId("gap-p90").textContent).toBe("—");
    expect(screen.getByTestId("long-gap-count").textContent).toBe("—");
  });

  it("tooltip declares the imported LONG_GAP_THRESHOLD_S constant", () => {
    const { container } = render(
      <FrictionCell
        counts={{
          api_error_count: 0,
          tool_error_count: 0,
          test_fail_count: 0,
          compaction_count: 0,
          interrupt_count: 0,
          user_turn_count: 3,
          turn_count: 10,
          gap_median_s: 30,
          gap_p90_s: 310,
          long_gap_count: 1,
          gap_n: 3,
        }}
        variant="strip"
      />,
    );
    const cell = container.querySelector("[data-testid='friction-cell']");
    expect(cell?.getAttribute("title")).toContain(`${LONG_GAP_THRESHOLD_S}s`);
  });

  it("compact variant shows long-gap count when > 0 and gap_n >= 2", () => {
    render(
      <FrictionCell
        counts={{
          api_error_count: 0,
          tool_error_count: 0,
          test_fail_count: 0,
          compaction_count: 0,
          interrupt_count: 0,
          user_turn_count: 4,
          turn_count: 16,
          gap_median_s: 60,
          gap_p90_s: 400,
          long_gap_count: 2,
          gap_n: 4,
        }}
        variant="compact"
      />,
    );
    // compact renders as text in parts
    expect(screen.getByTestId("friction-cell").textContent).toContain("long-gap 2");
  });

  it("compact variant omits long-gap when long_gap_count is 0", () => {
    render(
      <FrictionCell
        counts={{
          api_error_count: 0,
          tool_error_count: 0,
          test_fail_count: 0,
          compaction_count: 0,
          interrupt_count: 0,
          user_turn_count: 3,
          turn_count: 12,
          gap_median_s: 30,
          gap_p90_s: 90,
          long_gap_count: 0,
          gap_n: 3,
        }}
        variant="compact"
      />,
    );
    expect(screen.getByTestId("friction-cell").textContent).not.toContain("long-gap");
  });
});

// ---------------------------------------------------------------------------
// EF2 — closure proxy on WorkspaceDetailPage
// ---------------------------------------------------------------------------

// WorkspaceDetailPage is a heavyweight component; mock all client calls.
vi.mock("../../../src/ui/api/client");

describe("EF2 closure proxy on WorkspaceDetailPage", () => {
  beforeEach(() => {
    vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
    vi.mocked(client.fetchWorkspaceSessions).mockResolvedValue(
      mockWorkspaceSessions("ws-1", { preset: "7d" }),
    );
    vi.mocked(client.fetchWorkspaceOutcomes).mockResolvedValue({
      data: [],
      meta: {
        n: 0,
        window: { from: "2026-08-16T00:00:00Z", to: "2026-08-23T00:00:00Z" },
        qualification: {
          provisional_excluded: false,
          unpriced_turns: 0,
          claim_kinds_count: 1,
          note: "",
        },
        metric_definition_version: "observe-1",
        claim_kind: "EXPERIMENTAL",
        drilldown_ids: {},
      },
    });
    vi.mocked(client.fetchContextComposition).mockResolvedValue({
      data: null,
      meta: {
        n: 0,
        window: { from: "2026-08-16T00:00:00Z", to: "2026-08-23T00:00:00Z" },
        qualification: {
          provisional_excluded: false,
          unpriced_turns: 0,
          claim_kinds_count: 1,
          note: "",
        },
        metric_definition_version: "observe-1",
        claim_kind: "EXPERIMENTAL",
        drilldown_ids: {},
      },
    });
    vi.mocked(client.fetchCostPerSuccess).mockResolvedValue(
      mockCostPerSuccess({ preset: "7d" }, "ws-1"),
    );
  });

  it("renders aggregate-first share from closure proxy fixture", async () => {
    vi.mocked(client.fetchClosureProxy).mockResolvedValue(mockClosureProxy("ws-1"));

    const { default: WorkspaceDetailPage } = await import(
      "../../../src/ui/workspaces/WorkspaceDetailPage"
    );
    render(<WorkspaceDetailPage workspaceId="ws-1" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("ef2-closure-proxy")).toBeTruthy();
    });

    const summary = screen.getByTestId("closure-proxy-summary");
    // fixture: resolved=7, unresolved=3, resolved_share=0.7 => "7 of 10 no-commit sessions..."
    expect(summary.textContent).toContain("7 of 10");
    expect(summary.textContent).toContain("70%");

    expect(screen.getByTestId("closure-resolved").textContent).toBe("7");
    expect(screen.getByTestId("closure-unresolved").textContent).toBe("3");
    expect(screen.getByTestId("closure-pending").textContent).toBe("2");
  });

  it("renders 'all PENDING' message when resolved_share is null", async () => {
    const allPending = mockClosureProxy("ws-1");
    if (allPending.data === null) throw new Error("fixture must have data");
    allPending.data = {
      ...allPending.data,
      no_commit_session_count: 3,
      resolved_count: 0,
      unresolved_count: 0,
      pending_count: 3,
      resolved_share: null,
    };
    vi.mocked(client.fetchClosureProxy).mockResolvedValue(allPending);

    const { default: WorkspaceDetailPage } = await import(
      "../../../src/ui/workspaces/WorkspaceDetailPage"
    );
    render(<WorkspaceDetailPage workspaceId="ws-1" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("closure-proxy-summary").textContent).toContain("all PENDING");
    });
    // The resolved-branch sentence ("… saw no 48h re-open …") must NOT also render —
    // guards against showing both states at once.
    expect(screen.getByTestId("closure-proxy-summary").textContent).not.toContain("re-open");
  });

  it("renders 'No no-commit sessions observed' for empty proxy", async () => {
    const empty = mockClosureProxy("ws-1");
    if (empty.data === null) throw new Error("fixture must have data");
    empty.data = {
      ...empty.data,
      no_commit_session_count: 0,
      resolved_count: 0,
      unresolved_count: 0,
      pending_count: 0,
      resolved_share: null,
    };
    vi.mocked(client.fetchClosureProxy).mockResolvedValue(empty);

    const { default: WorkspaceDetailPage } = await import(
      "../../../src/ui/workspaces/WorkspaceDetailPage"
    );
    render(<WorkspaceDetailPage workspaceId="ws-1" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("closure-proxy-summary").textContent).toContain(
        "No no-commit sessions observed",
      );
    });
  });
});
