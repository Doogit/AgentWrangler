import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AvoidableRow,
  DiagnosticsBuilding,
  DiagnosticsPayload,
  DiagnosticsReady,
  ReliabilityRow,
  RiskRow,
} from "../../src/query/api/diagnostics-triage";
import type { ApiResponse } from "../../src/query/envelope";
import * as client from "../../src/ui/api/client";
import AvoidableSection from "../../src/ui/diagnostics/AvoidableSection";
import DiagnosticsPage from "../../src/ui/diagnostics/DiagnosticsPage";
import ReliabilitySection from "../../src/ui/diagnostics/ReliabilitySection";

vi.mock("../../src/ui/api/client");

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

function envelope<T>(data: T): ApiResponse<T> {
  return {
    data,
    meta: {
      claim_kind: "OBS_PROXY",
      n: 0,
      drilldown_ids: {},
      window: { from: "2026-09-09T00:00:00.000Z", to: "2026-09-16T00:00:00.000Z", preset: "7d" },
      qualification: {
        provisional_excluded: false,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "",
      },
      metric_definition_version: "observe-1",
    },
  };
}

function avoidableRow(overrides: Partial<AvoidableRow>): AvoidableRow {
  return {
    cause_id: "synthetic-cause",
    name: "Synthetic cause",
    explanation: "Synthetic explanation of the cause.",
    rank: 1,
    featured: false,
    trend: "steady",
    trend_basis: "spend_share",
    handoff: null,
    patterns: [{ label: "Synthetic pattern", code: "SYN1", count: 3 }],
    sessions_affected: 4,
    sessions_affected_is_lower_bound: false,
    sessions: [
      { session_id: "synthetic-session-001", title: "Synthetic review", occurrences: 3 },
      { session_id: "synthetic-session-002", title: null, occurrences: 1 },
    ],
    occurrences: 5,
    count_unit: "occurrences",
    share: 0.005,
    avoidable_u: 500_000,
    coverage: "ALL",
    folded: false,
    when: { buckets: [1, 2, 3, 4, 5, 6], weight: "occurrences", heaviest: "late" },
    example: {
      session_id: "synthetic-session-001",
      title: "Synthetic review",
      message_id: "synthetic-message-1",
      turn_index: 12,
      text: "synthetic command text",
      figure_line: "1,200 context tokens in this turn",
    },
    ...overrides,
  };
}

function reliabilityRow(overrides: Partial<ReliabilityRow>): ReliabilityRow {
  return {
    cause_id: "synthetic-reliability",
    name: "Synthetic reliability cause",
    explanation: "Synthetic explanation.",
    rank: 1,
    featured: false,
    trend: "steady",
    trend_basis: "session_rate",
    handoff: null,
    patterns: [],
    sessions_affected: 2,
    sessions_affected_is_lower_bound: false,
    sessions: [{ session_id: "synthetic-session-003", title: "Synthetic session", occurrences: 2 }],
    occurrences: 10,
    count_unit: "occurrences",
    share: 0.02,
    breakdown: [{ label: "Synthetic breakdown", count: 10 }],
    top_commands: [{ text: "synthetic-cmd", count: 5 }],
    cost: { wait_ms: 60_000, replan_u: null },
    ...overrides,
  };
}

const AVOIDABLE_FEATURED = avoidableRow({
  cause_id: "A",
  name: "Context grows too large before it is compacted",
  rank: 1,
  featured: true,
  trend: "rising",
  share: 0.009,
  avoidable_u: 900_000,
  handoff: { rec_id: "rec-a", label: "Fix: compact earlier" },
});
const AVOIDABLE_NO_HANDOFF = avoidableRow({
  cause_id: "B",
  name: "The cache is rebuilt mid-session",
  rank: 2,
  trend: "steady",
  share: 0.008,
  avoidable_u: 800_000,
  handoff: null,
});
const AVOIDABLE_THIRD = avoidableRow({
  cause_id: "C",
  name: "Tool results are too large",
  rank: 3,
  trend: "falling",
  share: 0.007,
  avoidable_u: 700_000,
  handoff: { rec_id: "rec-c", label: "Fix: trim large outputs" },
});
const AVOIDABLE_FOLDED_1 = avoidableRow({
  cause_id: "D",
  name: "Missing files read",
  rank: 4,
  trend: "steady",
  share: 0.004,
  avoidable_u: 400_000,
  folded: true,
  handoff: null,
});
const AVOIDABLE_FOLDED_2 = avoidableRow({
  cause_id: "E",
  name: "Subagent overhead",
  rank: 5,
  trend: "steady",
  share: 0.003,
  avoidable_u: 300_000,
  folded: true,
  handoff: null,
});
const AVOIDABLE_NOT_ESTIMATED = avoidableRow({
  cause_id: "F",
  name: "Cache misses without churn",
  rank: 6,
  trend: "steady",
  share: null,
  avoidable_u: null,
  coverage: null,
  when: null,
  example: null,
  handoff: null,
});

const RELIABILITY_FEATURED = reliabilityRow({
  cause_id: "BLOCKED_BY_PERMISSIONS",
  name: "Tool calls blocked by permissions",
  rank: 1,
  featured: true,
  trend: "rising",
  share: 0.11,
  occurrences: 87,
  count_unit: "blocks",
  breakdown: [
    { label: "Blocked by a hook", count: 39 },
    { label: "Rejected by you", count: 33 },
    { label: "Matched a deny rule", count: 15 },
  ],
  top_commands: [
    { text: "pytest", count: 21 },
    { text: "npm test", count: 12 },
    { text: "curl", count: 7 },
  ],
  cost: { wait_ms: 780_000, replan_u: null },
  handoff: { rec_id: "rec-perm", label: "Fix: update allow-list" },
});
const RELIABILITY_SECOND = reliabilityRow({
  cause_id: "SHELL_BURST",
  name: "Shell commands fail in bursts",
  rank: 2,
  trend: "steady",
  share: 0.02,
  occurrences: 16,
  count_unit: "bursts",
  handoff: { rec_id: "rec-shell", label: "Fix: pin the shell" },
});
const RELIABILITY_THIRD = reliabilityRow({
  cause_id: "LOOP_RETRY",
  name: "The agent repeats the same error",
  rank: 3,
  trend: "falling",
  share: 0.01,
  occurrences: 14,
  count_unit: "loops",
  handoff: null,
});
const RISK_ROW: RiskRow = {
  cause_id: "DESTRUCTIVE_COMMANDS",
  name: "Destructive commands ran",
  explanation: "Synthetic explanation.",
  rank: 0,
  featured: false,
  trend: "steady",
  trend_basis: "session_rate",
  handoff: { rec_id: "rec-h1", label: "H1 headline" },
  patterns: [],
  sessions_affected: 2,
  sessions_affected_is_lower_bound: false,
  sessions: [{ session_id: "synthetic-session-004", title: "Synthetic session", occurrences: 2 }],
  occurrences: 67,
  count_unit: "commands",
  share: 0.08,
  breakdown: [],
  top_commands: [],
  risk: true,
};

function readyValue(overrides: Partial<DiagnosticsReady> = {}): DiagnosticsReady {
  return {
    window_days: 7,
    as_of: "2026-09-16T00:00:00.000Z",
    built_at: "2026-09-16T00:00:00.000Z",
    partial: false,
    tiles: {
      spend_u: 5_933_000_000,
      session_count: 465,
      avoidable_u: 900_000,
      avoidable_share: 0.009,
      friction_sessions: 60,
      friction_share: 0.13,
      fix_ready: { n: 3, m: 6 },
    },
    avoidable: {
      banner: { not_estimated_count: 0 },
      causes: [
        AVOIDABLE_FEATURED,
        AVOIDABLE_NO_HANDOFF,
        AVOIDABLE_THIRD,
        AVOIDABLE_FOLDED_1,
        AVOIDABLE_FOLDED_2,
        AVOIDABLE_NOT_ESTIMATED,
      ],
    },
    reliability: {
      causes: [RELIABILITY_FEATURED, RELIABILITY_SECOND, RELIABILITY_THIRD],
      risk: RISK_ROW,
    },
    ...overrides,
  };
}

function buildingValue(
  overrides: Partial<DiagnosticsBuilding["progress"]> = {},
): DiagnosticsBuilding {
  return {
    status: "building",
    window_days: 7,
    progress: {
      stage: "Counting failed and blocked commands",
      step: 0,
      steps: 4,
      started_at: "1970-01-01T00:00:00.000Z",
      expected_ms: 6000,
      ...overrides,
    },
  };
}

function mockReady(value: DiagnosticsReady = readyValue()) {
  vi.mocked(client.fetchDiagnostics).mockResolvedValue(envelope<DiagnosticsPayload>(value));
  vi.mocked(client.fetchStatus).mockResolvedValue({
    sessions: 465,
    files_seen: 465,
    files_parsed: 465,
  });
}

beforeEach(() => {
  window.location.hash = "#/diagnostics";
  vi.clearAllMocks();
  vi.mocked(client.fetchStatus).mockResolvedValue({
    sessions: 465,
    files_seen: 465,
    files_parsed: 465,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("DiagnosticsPage", () => {
  it("renders tiles (each with an InfoTip), the avoidable section, and reliability", async () => {
    mockReady();
    render(<DiagnosticsPage />);
    const avoidable = await screen.findByRole("region", { name: "Avoidable spend" });
    expect(window.location.hash).toBe("#/diagnostics?window=7");
    expect(screen.getByText("$5,933.00")).toBeTruthy();
    expect(
      within(avoidable).getByText("Context grows too large before it is compacted"),
    ).toBeTruthy();
    const reliability = screen.getByRole("region", { name: "Reliability" });
    expect(within(reliability).getByText("Tool calls blocked by permissions")).toBeTruthy();
    expect(
      screen.getAllByRole("button", {
        name: /^About (Spend in window|Avoidable spend|Sessions with friction|Causes with a fix ready)$/,
      }),
    ).toHaveLength(4);
  });

  it("U5: the friction tile InfoTip names the Reliability causes it counts", async () => {
    mockReady();
    render(<DiagnosticsPage />);
    await screen.findByRole("region", { name: "Avoidable spend" });
    fireEvent.click(screen.getByRole("button", { name: "About Sessions with friction" }));
    const tip = screen.getByRole("tooltip").textContent ?? "";
    expect(tip).toContain("Tool calls blocked by permissions");
    expect(tip).toMatch(/view all/);
  });

  it("shows 'No fix yet' with no link when a cause's handoff is null (AE1)", async () => {
    mockReady();
    render(<DiagnosticsPage />);
    const avoidable = await screen.findByRole("region", { name: "Avoidable spend" });
    const row = within(avoidable)
      .getByText("The cache is rebuilt mid-session")
      .closest("article") as HTMLElement;
    expect(within(row).getByText("No fix yet")).toBeTruthy();
    expect(within(row).queryByRole("link")).toBeNull();
  });

  it("RC-B: shows 'No fix this week' with an InfoTip when a rec sits in history", async () => {
    const base = readyValue();
    mockReady({
      ...base,
      avoidable: {
        ...base.avoidable,
        causes: base.avoidable.causes.map((r) =>
          r === AVOIDABLE_NO_HANDOFF ? { ...r, fix_quiet: true } : r,
        ),
      },
    });
    render(<DiagnosticsPage />);
    const avoidable = await screen.findByRole("region", { name: "Avoidable spend" });
    const row = within(avoidable)
      .getByText("The cache is rebuilt mid-session")
      .closest("article") as HTMLElement;
    expect(within(row).getByText(/No fix this week/)).toBeTruthy();
    expect(within(row).queryByText("No fix yet")).toBeNull();
    // Without a quiet_rec_id the label is plain text.
    expect(within(row).queryByRole("link")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "About No fix this week" }));
    expect(screen.getByRole("tooltip").textContent).toMatch(/has not fired in the last week/);
    // The fix tile names what the rest show, not a blanket "no fix yet".
    const tiles = screen.getByRole("region", { name: "Usage patterns tiles" });
    expect(within(tiles).getByText(/^the rest: .*1 no fix this week/)).toBeTruthy();
  });

  it("RC-B: 'No fix this week' links to its history card when the row names one", async () => {
    const base = readyValue();
    mockReady({
      ...base,
      avoidable: {
        ...base.avoidable,
        causes: base.avoidable.causes.map((r) =>
          r === AVOIDABLE_NO_HANDOFF ? { ...r, fix_quiet: true, quiet_rec_id: "rec-old" } : r,
        ),
      },
    });
    render(<DiagnosticsPage />);
    const avoidable = await screen.findByRole("region", { name: "Avoidable spend" });
    const row = within(avoidable)
      .getByText("The cache is rebuilt mid-session")
      .closest("article") as HTMLElement;
    const link = within(row).getByRole("link", { name: "No fix this week" });
    expect(link.getAttribute("href")).toBe("#/recommendations?focus=rec-old");
  });

  it("RC-B: shows a secondary 'Small fix →' link with an InfoTip for a below-floor card", async () => {
    const base = readyValue();
    mockReady({
      ...base,
      avoidable: {
        ...base.avoidable,
        causes: base.avoidable.causes.map((r) =>
          r === AVOIDABLE_NO_HANDOFF
            ? { ...r, handoff: { rec_id: "rec-small", label: "Small fix" }, fix_small: true }
            : r,
        ),
      },
    });
    render(<DiagnosticsPage />);
    const avoidable = await screen.findByRole("region", { name: "Avoidable spend" });
    const row = within(avoidable)
      .getByText("The cache is rebuilt mid-session")
      .closest("article") as HTMLElement;
    const link = within(row).getByRole("link", { name: "Small fix →" });
    expect(link.getAttribute("href")).toBe("#/recommendations?focus=rec-small");
    expect(link.className).toBe("btn-secondary");
    expect(within(row).queryByText("No fix yet")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "About Small fix" }));
    expect(screen.getByRole("tooltip").textContent).toMatch(/Below the low-impact threshold/);
    const tiles = screen.getByRole("region", { name: "Usage patterns tiles" });
    expect(within(tiles).getByText(/^the rest: 1 small fix/)).toBeTruthy();
  });

  it("shows the banner and folds small causes behind Show N more, revealing collapsed rows (AE2/AE3)", async () => {
    mockReady();
    render(<DiagnosticsPage />);
    const avoidable = await screen.findByRole("region", { name: "Avoidable spend" });
    expect(
      within(avoidable).getByText(
        "Nothing here is worth more than 1% of your spend in this window.",
      ),
    ).toBeTruthy();
    expect(within(avoidable).queryByText("Missing files read")).toBeNull();
    fireEvent.click(within(avoidable).getByRole("button", { name: "Show 2 more" }));
    const revealedD = within(avoidable)
      .getByText("Missing files read")
      .closest("article") as HTMLElement;
    const revealedE = within(avoidable)
      .getByText("Subagent overhead")
      .closest("article") as HTMLElement;
    expect(within(revealedD).getByText("4")).toBeTruthy();
    expect(within(revealedE).getByText("5")).toBeTruthy();
    expect(
      within(revealedD)
        .getByRole("button", { name: /Missing files read/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      within(revealedE)
        .getByRole("button", { name: /Subagent overhead/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("starts the featured row open and others closed; toggling one leaves others unchanged; window change resets (R8)", async () => {
    mockReady();
    render(<DiagnosticsPage />);
    const avoidable = await screen.findByRole("region", { name: "Avoidable spend" });
    const featuredToggle = within(avoidable).getByRole("button", {
      name: /Context grows too large before it is compacted/,
    });
    const secondToggle = within(avoidable).getByRole("button", {
      name: /The cache is rebuilt mid-session/,
    });
    expect(featuredToggle.getAttribute("aria-expanded")).toBe("true");
    expect(secondToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(secondToggle);
    expect(secondToggle.getAttribute("aria-expanded")).toBe("true");
    expect(featuredToggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(
      within(screen.getByRole("group", { name: "Usage patterns window" })).getByRole("button", {
        name: "14d",
      }),
    );
    await waitFor(() => expect(client.fetchDiagnostics).toHaveBeenCalledWith(14));
    const avoidableAfter = await screen.findByRole("region", { name: "Avoidable spend" });
    const secondToggleAfter = within(avoidableAfter).getByRole("button", {
      name: /The cache is rebuilt mid-session/,
    });
    expect(secondToggleAfter.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders the risk row last, marked '!', with its fixed hand-off text", async () => {
    mockReady();
    render(<DiagnosticsPage />);
    const reliability = await screen.findByRole("region", { name: "Reliability" });
    const rows = within(reliability)
      .getAllByRole("button", { name: /./ })
      .filter((el) => el.className.includes("triage-row-toggle"));
    const lastRow = rows[rows.length - 1] as HTMLElement;
    expect(within(lastRow).getByText("!")).toBeTruthy();
    expect(within(lastRow).getByText("Destructive commands ran")).toBeTruthy();
    const riskArticle = lastRow.closest("article") as HTMLElement;
    expect(within(riskArticle).getByRole("link", { name: "Review 67 commands →" })).toBeTruthy();
  });

  it("shows the trend as a word alongside its colour class", async () => {
    mockReady();
    render(<DiagnosticsPage />);
    const avoidable = await screen.findByRole("region", { name: "Avoidable spend" });
    const trend = within(avoidable).getByText("rising", { exact: false });
    expect(trend.textContent).toContain("rising");
    expect(trend.className).toContain("trend-rising");
  });

  it("uses the singular unit word for a count of 1 and one arrow per hand-off", async () => {
    mockReady(
      readyValue({
        tiles: { ...readyValue().tiles, session_count: 1, friction_sessions: 1 },
        reliability: {
          causes: [
            { ...RELIABILITY_FEATURED, occurrences: 1, count_unit: "failing turns" },
            { ...RELIABILITY_SECOND, occurrences: 1, count_unit: "occurrences" },
          ],
          risk: { ...RISK_ROW, occurrences: 1 },
        },
      }),
    );
    render(<DiagnosticsPage />);
    const reliability = await screen.findByRole("region", { name: "Reliability" });
    expect(within(reliability).getByText("1 failing turn")).toBeTruthy();
    expect(within(reliability).getByText("1 occurrence")).toBeTruthy();
    expect(within(reliability).getByRole("link", { name: "Review 1 command →" })).toBeTruthy();
    expect(
      within(reliability).getByRole("link", { name: "Fix: update allow-list →" }),
    ).toBeTruthy();
    expect(screen.getByText("1 session")).toBeTruthy();
    expect(screen.getByText("1 session · any Reliability cause below")).toBeTruthy();
  });

  it("keeps the row toggle free of nested interactive elements; the toggle and the hand-off link focus separately", async () => {
    mockReady();
    render(<DiagnosticsPage />);
    const avoidable = await screen.findByRole("region", { name: "Avoidable spend" });
    const toggle = within(avoidable).getByRole("button", {
      name: /Context grows too large before it is compacted/,
    });
    expect(within(toggle).queryAllByRole("link")).toHaveLength(0);
    expect(within(toggle).queryAllByRole("button")).toHaveLength(0);
    const handoffLink = within(avoidable).getByRole("link", { name: "Fix: compact earlier →" });
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    handoffLink.focus();
    expect(document.activeElement).toBe(handoffLink);
  });

  it("shows a loading skeleton with four tile placeholders", () => {
    vi.mocked(client.fetchDiagnostics).mockImplementation(() => new Promise(() => {}));
    const { container } = render(<DiagnosticsPage />);
    expect(screen.getByLabelText(/loading usage patterns/i).tagName).toBe("DIV");
    expect(container.querySelectorAll(".grid.g4 .card.kpi.skeleton")).toHaveLength(4);
  });

  it("shows a reader-safe error and Retry refetches", async () => {
    vi.mocked(client.fetchDiagnostics).mockRejectedValue(new Error("private detail"));
    render(<DiagnosticsPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load this page.");
    expect(document.body.textContent).not.toContain("private detail");
    mockReady();
    fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
    await screen.findByRole("region", { name: "Avoidable spend" });
    expect(client.fetchDiagnostics).toHaveBeenCalledTimes(2);
  });

  it("never folds a Reliability row", async () => {
    mockReady();
    render(<DiagnosticsPage />);
    const reliability = await screen.findByRole("region", { name: "Reliability" });
    expect(within(reliability).queryByText(/Show \d+ more/)).toBeNull();
  });

  describe("R27 build progress", () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: 0 });
    });

    it("shows LoadProgress once the build has been visible for ~1s, then swaps it for the ready view on the next poll", async () => {
      const pending: Array<(value: ApiResponse<DiagnosticsPayload>) => void> = [];
      vi.mocked(client.fetchDiagnostics).mockImplementation(
        () =>
          new Promise((resolve) => {
            pending.push(resolve);
          }),
      );
      render(<DiagnosticsPage />);
      await advance(0);
      expect(client.fetchDiagnostics).toHaveBeenCalledTimes(1);

      pending[0]?.(envelope<DiagnosticsPayload>(buildingValue()));
      await advance(0);
      expect(screen.queryByRole("progressbar")).toBeNull();

      await advance(1000);
      expect(client.fetchDiagnostics).toHaveBeenCalledTimes(2);
      const bar = screen.getByRole("progressbar");
      expect(bar.getAttribute("aria-valuenow")).toBe("0");
      expect(
        screen.getByText("Counting failed and blocked commands", {
          selector: ".load-progress-stage",
        }),
      ).toBeTruthy();
      expect(screen.getByText(/usually ~6 s/)).toBeTruthy();

      pending[1]?.(envelope<DiagnosticsPayload>(readyValue()));
      await advance(0);
      expect(screen.queryByRole("progressbar")).toBeNull();
      expect(screen.getByRole("region", { name: "Avoidable spend" })).toBeTruthy();
    });

    it("says 'Checking for a fix…' while handoffs_pending, then shows fix links on the next poll without a reload (F9)", async () => {
      const pending: Array<(value: ApiResponse<DiagnosticsPayload>) => void> = [];
      vi.mocked(client.fetchDiagnostics).mockImplementation(
        () =>
          new Promise((resolve) => {
            pending.push(resolve);
          }),
      );
      render(<DiagnosticsPage />);
      await advance(0);
      const unjoined = readyValue();
      pending[0]?.(
        envelope<DiagnosticsPayload>({
          ...unjoined,
          partial: true,
          handoffs_pending: true,
          tiles: { ...unjoined.tiles, fix_ready: { n: 0, m: unjoined.tiles.fix_ready.m } },
          avoidable: {
            ...unjoined.avoidable,
            causes: unjoined.avoidable.causes.map((row) => ({ ...row, handoff: null })),
          },
          reliability: {
            causes: unjoined.reliability.causes.map((row) => ({ ...row, handoff: null })),
            risk: unjoined.reliability.risk && { ...unjoined.reliability.risk, handoff: null },
          },
        }),
      );
      await advance(0);
      expect(screen.getAllByText("Checking for a fix…").length).toBeGreaterThan(0);
      expect(screen.queryByText("No fix yet")).toBeNull();
      expect(screen.getByText("Checking…")).toBeTruthy();
      expect(screen.queryByRole("link", { name: "Fix: compact earlier →" })).toBeNull();

      await advance(1000);
      expect(client.fetchDiagnostics).toHaveBeenCalledTimes(2);
      pending[1]?.(envelope<DiagnosticsPayload>(readyValue()));
      await advance(0);
      expect(screen.queryByText("Checking for a fix…")).toBeNull();
      expect(screen.getByRole("link", { name: "Fix: compact earlier →" })).toBeTruthy();

      await advance(5000);
      expect(client.fetchDiagnostics).toHaveBeenCalledTimes(2);
    });

    it("omits 'usually ~N s' when expected_ms is null", async () => {
      const pending: Array<(value: ApiResponse<DiagnosticsPayload>) => void> = [];
      vi.mocked(client.fetchDiagnostics).mockImplementation(
        () =>
          new Promise((resolve) => {
            pending.push(resolve);
          }),
      );
      render(<DiagnosticsPage />);
      await advance(0);
      pending[0]?.(envelope<DiagnosticsPayload>(buildingValue({ expected_ms: null })));
      await advance(1000);
      expect(screen.getByRole("progressbar")).toBeTruthy();
      expect(screen.queryByText(/usually/)).toBeNull();
    });
  });

  it("renders a refreshing snapshot's rows plus a quiet header indicator", async () => {
    const snapshotAt = new Date(Date.now() - 5 * 60_000).toISOString();
    mockReady(readyValue({ refreshing: true, snapshot_at: snapshotAt }));
    render(<DiagnosticsPage />);
    await screen.findByRole("region", { name: "Avoidable spend" });
    expect(screen.getByText(/Updated 5 min ago · refreshing…/)).toBeTruthy();
  });

  describe("page-review copy and state fixes (P4 U7)", () => {
    const tipText = (scope: HTMLElement, name: string): string => {
      fireEvent.click(within(scope).getByRole("button", { name }));
      return screen.getByRole("tooltip").textContent ?? "";
    };
    const rowOf = (scope: HTMLElement, name: string) =>
      within(scope).getByText(name).closest("article") as HTMLElement;
    const unestimated = (row: AvoidableRow): AvoidableRow => ({
      ...row,
      share: null,
      avoidable_u: null,
      trend_basis: "session_rate",
    });

    it("F1: the avoidable chip names the real ranking basis", async () => {
      mockReady(
        readyValue({
          avoidable: {
            banner: null,
            causes: [unestimated(AVOIDABLE_FEATURED), unestimated(AVOIDABLE_NO_HANDOFF)],
          },
        }),
      );
      render(<DiagnosticsPage />);
      const avoidable = await screen.findByRole("region", { name: "Avoidable spend" });
      expect(within(avoidable).getByText("ranked by how often it happens")).toBeTruthy();
      expect(within(avoidable).queryByText("ranked by share of spend")).toBeNull();
    });

    it("F1: keeps 'ranked by share of spend' when causes carry an estimate", async () => {
      mockReady();
      render(<DiagnosticsPage />);
      const avoidable = await screen.findByRole("region", { name: "Avoidable spend" });
      expect(within(avoidable).getByText("ranked by share of spend")).toBeTruthy();
    });

    it("F6: the avoidable tile InfoTip explains 'Not estimated'", async () => {
      mockReady(
        readyValue({
          tiles: { ...readyValue().tiles, avoidable_share: null, avoidable_u: null },
        }),
      );
      render(<DiagnosticsPage />);
      const tiles = await screen.findByRole("region", { name: "Usage patterns tiles" });
      expect(tipText(tiles, "About Avoidable spend")).toMatch(/not estimated/i);
    });

    it("RC-B U3: lists silent causes from both sections on one line, none when absent", async () => {
      const base = readyValue();
      mockReady({
        ...base,
        avoidable: {
          ...base.avoidable,
          silent: [{ cause_id: "A", name: "Model bigger than needed" }],
        },
        reliability: {
          ...base.reliability,
          silent: [{ cause_id: "B", name: "Destructive commands ran" }],
        },
      });
      const { unmount } = render(<DiagnosticsPage />);
      expect(
        await screen.findByText(
          "Also watched, nothing in this window: Model bigger than needed, Destructive commands ran.",
        ),
      ).toBeTruthy();
      unmount();
      mockReady();
      render(<DiagnosticsPage />);
      await screen.findByRole("region", { name: "Usage patterns tiles" });
      expect(screen.queryByText(/Also watched/)).toBeNull();
    });

    it("F9: the friction InfoTip covers every Reliability cause, incl. interrupted", async () => {
      mockReady();
      render(<DiagnosticsPage />);
      const tiles = await screen.findByRole("region", { name: "Usage patterns tiles" });
      expect(tipText(tiles, "About Sessions with friction")).toMatch(/interrupted/);
    });

    it("F3: the trend InfoTip names its basis", async () => {
      mockReady();
      render(<DiagnosticsPage />);
      const avoidable = await screen.findByRole("region", { name: "Avoidable spend" });
      const spendRow = rowOf(avoidable, "Context grows too large before it is compacted");
      expect(tipText(spendRow, "About the trend")).toMatch(/share of spend/);
      fireEvent.blur(within(spendRow).getByRole("button", { name: "About the trend" }));
      const reliability = screen.getByRole("region", { name: "Reliability" });
      const rateRow = rowOf(reliability, "Tool calls blocked by permissions");
      expect(tipText(rateRow, "About the trend")).toMatch(/share of sessions/);
    });

    it("F4: a sub-minute wait reads '<1 min', not '~0 min'", async () => {
      mockReady(
        readyValue({
          reliability: {
            causes: [{ ...RELIABILITY_FEATURED, cost: { wait_ms: 3_000, replan_u: null } }],
            risk: null,
          },
        }),
      );
      render(<DiagnosticsPage />);
      const reliability = await screen.findByRole("region", { name: "Reliability" });
      expect(within(reliability).getByText(/<1 min of waiting on this cause\./)).toBeTruthy();
      expect(within(reliability).queryByText(/~0 min/)).toBeNull();
    });

    it("L8: a re-plan cost shows as $ with an upper-bound InfoTip; null shows nothing", async () => {
      mockReady(
        readyValue({
          reliability: {
            causes: [{ ...RELIABILITY_FEATURED, cost: { wait_ms: 3_000, replan_u: 1_230_000 } }],
            risk: null,
          },
        }),
      );
      render(<DiagnosticsPage />);
      const reliability = await screen.findByRole("region", { name: "Reliability" });
      expect(within(reliability).getByText(/\$1\.23 spent re-planning/)).toBeTruthy();
      expect(tipText(reliability, "About re-plan cost")).toMatch(/Upper bound/);
    });

    it("F5: an untitled session's cut id is marked with an ellipsis", async () => {
      mockReady();
      render(<DiagnosticsPage />);
      const avoidable = await screen.findByRole("region", { name: "Avoidable spend" });
      const row = rowOf(avoidable, "Context grows too large before it is compacted");
      expect(within(row).getByText("syntheti…")).toBeTruthy();
    });

    it("F14: a lower-bound count reads 'at least N sessions affected'", async () => {
      mockReady(
        readyValue({
          avoidable: {
            banner: null,
            causes: [{ ...AVOIDABLE_FEATURED, sessions_affected_is_lower_bound: true }],
          },
          reliability: {
            causes: [{ ...RELIABILITY_FEATURED, sessions_affected_is_lower_bound: true }],
            risk: null,
          },
        }),
      );
      render(<DiagnosticsPage />);
      const avoidable = await screen.findByRole("region", { name: "Avoidable spend" });
      const reliability = screen.getByRole("region", { name: "Reliability" });
      for (const section of [avoidable, reliability]) {
        expect(section.textContent).toMatch(/at least \d+ sessions affected/);
        expect(section.textContent).not.toMatch(/\d\+ sessions/);
      }
    });

    it("F17: no 'the rest: …' caption when nothing is left without a fix", async () => {
      mockReady(readyValue({ tiles: { ...readyValue().tiles, fix_ready: { n: 0, m: 0 } } }));
      render(<DiagnosticsPage />);
      const tiles = await screen.findByRole("region", { name: "Usage patterns tiles" });
      expect(within(tiles).getByText("0 of 0")).toBeTruthy();
      expect(within(tiles).queryByText(/^the rest/)).toBeNull();
    });

    it("F16: a window change folds the small causes again", async () => {
      mockReady();
      render(<DiagnosticsPage />);
      const avoidable = await screen.findByRole("region", { name: "Avoidable spend" });
      fireEvent.click(within(avoidable).getByRole("button", { name: "Show 2 more" }));
      expect(within(avoidable).getByText("Missing files read")).toBeTruthy();
      fireEvent.click(
        within(screen.getByRole("group", { name: "Usage patterns window" })).getByRole("button", {
          name: "14d",
        }),
      );
      await waitFor(() => expect(client.fetchDiagnostics).toHaveBeenCalledWith(14));
      const after = await screen.findByRole("region", { name: "Avoidable spend" });
      expect(within(after).getByRole("button", { name: "Show 2 more" })).toBeTruthy();
      expect(within(after).queryByText("Missing files read")).toBeNull();
    });
  });
});

describe("AvoidableSection standalone estimate (F9)", () => {
  const notEstimated = { avoidable_u: null, share: null, coverage: null } as const;

  it("a cause with no ledger figure shows its standalone $/wk, marked not in total, with an InfoTip", () => {
    const row = avoidableRow({ ...notEstimated, cause_id: "E1C", standalone_u: 1_234_000 });
    render(<AvoidableSection causes={[row]} banner={null} windowDays={7} />);
    const headline = screen.getByTestId("triage-standalone-E1C");
    expect(headline.textContent).toContain("$1.23/wk estimate");
    expect(headline.textContent).toContain("not in total");
    expect(headline.textContent).not.toContain("Not estimated");
    expect(within(headline).getByRole("button", { name: "About this estimate" })).toBeTruthy();
  });

  it("a tiny standalone figure reads 'under $0.01', and null still reads Not estimated", () => {
    render(
      <AvoidableSection
        causes={[
          avoidableRow({ ...notEstimated, cause_id: "TINY", standalone_u: 4_000 }),
          avoidableRow({ ...notEstimated, cause_id: "NONE", standalone_u: null }),
        ]}
        banner={null}
        windowDays={7}
      />,
    );
    expect(screen.getByTestId("triage-standalone-TINY").textContent).toContain("under $0.01/wk");
    expect(screen.queryByTestId("triage-standalone-NONE")).toBeNull();
    expect(screen.getAllByText("Not estimated").length).toBe(1);
  });
});

describe("ReliabilitySection panels (RC-A U1/U5)", () => {
  const open = (overrides: Partial<ReliabilityRow>) =>
    reliabilityRow({ featured: true, breakdown: [], top_commands: [], ...overrides });
  const panelOf = () => document.querySelector(".triage-row-panel") as HTMLElement;

  it("no row prints a 'No … recorded' placeholder; empty columns and a null wait are left out", () => {
    render(
      <ReliabilitySection
        causes={[open({ cost: { wait_ms: null, replan_u: null } })]}
        risk={null}
        windowDays={7}
      />,
    );
    const panel = panelOf();
    expect(panel.textContent).not.toMatch(/No .* recorded/);
    expect(panel.textContent).not.toMatch(/Breakdown|Most frequent commands/i);
    expect(panel.textContent).toMatch(/affected/);
    // No silent hiding: an InfoTip names what this cause has no data for.
    fireEvent.click(within(panel).getByRole("button", { name: "About what is recorded" }));
    expect(screen.getByRole("tooltip").textContent).toMatch(
      /Not recorded for this cause: a breakdown, command text, waiting time\./,
    );
  });

  it("a row with every panel part recorded has no 'what is recorded' InfoTip", () => {
    render(
      <ReliabilitySection
        causes={[
          open({
            breakdown: [{ label: "Rejected by you", count: 3 }],
            top_commands: [{ text: "git push", count: 3 }],
            cost: { wait_ms: 60_000, replan_u: null },
          }),
        ]}
        risk={null}
        windowDays={7}
      />,
    );
    expect(within(panelOf()).queryByRole("button", { name: "About what is recorded" })).toBeNull();
  });

  it("with no label breakdown, two or more patterns show as the breakdown", () => {
    render(
      <ReliabilitySection
        causes={[
          open({
            patterns: [
              { label: "Edited before reading", code: "C3", count: 3 },
              { label: "Flip-flopped on the same lines", code: "C6", count: 35 },
            ],
            by_tool: [{ label: "Edit", count: 3 }],
          }),
        ]}
        risk={null}
        windowDays={7}
      />,
    );
    const panel = panelOf();
    expect(within(panel).getByText("Patterns")).toBeTruthy();
    expect(within(panel).getByText("Flip-flopped on the same lines")).toBeTruthy();
    expect(within(panel).getByText("35")).toBeTruthy();
  });

  it("a single-pattern row falls back to the tool breakdown, labelled as events", () => {
    render(
      <ReliabilitySection
        causes={[
          open({
            patterns: [{ label: "Tool error rate outlier", code: "C1", count: 16 }],
            by_tool: [
              { label: "Bash", count: 9 },
              { label: "WebFetch", count: 4 },
            ],
          }),
        ]}
        risk={null}
        windowDays={7}
      />,
    );
    const panel = panelOf();
    expect(within(panel).getByText("By tool (events)")).toBeTruthy();
    expect(within(panel).getByText("Bash")).toBeTruthy();
    expect(within(panel).getByText("9")).toBeTruthy();
  });

  it("a single label breakdown (the risk row's operation) still shows", () => {
    render(
      <ReliabilitySection
        causes={[]}
        risk={{ ...RISK_ROW, breakdown: [{ label: "rm -rf", count: 1 }] }}
        windowDays={7}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Destructive commands ran/ }));
    expect(within(panelOf()).getByText("rm -rf")).toBeTruthy();
  });

  it("U5: a re-plan cost shows in the row headline, and the section no longer says small in dollars", () => {
    render(
      <ReliabilitySection
        causes={[open({ featured: false, cost: { wait_ms: null, replan_u: 4_185_456 } })]}
        risk={null}
        windowDays={7}
      />,
    );
    const figure = document.querySelector(".triage-row-figure") as HTMLElement;
    expect(figure.textContent).toContain("≈ $4.19 re-planning");
    expect(document.body.textContent).not.toMatch(/Small in dollars/);
  });
});
