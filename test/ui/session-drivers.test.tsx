/**
 * test/ui/session-drivers.test.tsx
 *
 * RV3 "Cost drivers" panel on SessionDetailPage.
 * Tests: gate (cheap→no panel), render (p75+/drivers→panel), routing chips,
 * approx_usd never summed, GUIDED prompt block with ≥3 measured quantities.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockSession, mockSessionDrivers, mockTurnTimeline } from "../../src/ui/api/fixtures";
import SessionDetailPage from "../../src/ui/sessions/SessionDetailPage";

vi.mock("../../src/ui/api/client");
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ComposedChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
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

function setupBaseMocks(sessionId: string) {
  vi.mocked(client.fetchSession).mockResolvedValue(mockSession(sessionId));
  vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline(sessionId));
}

describe("CostDriversPanel gate", () => {
  it("hides the panel for a cheap session (p30, no drivers)", async () => {
    setupBaseMocks("cheap-session");
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(
      mockSessionDrivers("cheap-session", true),
    );
    render(<SessionDetailPage sessionId="cheap-session" onBack={() => {}} />);
    await screen.findByText("Session detail");
    expect(screen.queryByTestId("cost-drivers-panel")).toBeNull();
  });

  it("shows the panel when percentile ≥ 75 with drivers present", async () => {
    setupBaseMocks("hot-session");
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(mockSessionDrivers("hot-session"));
    render(<SessionDetailPage sessionId="hot-session" onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId("cost-drivers-panel")).not.toBeNull());
    expect(screen.getByTestId("cost-drivers-panel")).toBeTruthy();
  });

  it("shows the panel when ≥1 driver fires even if percentile < 75", async () => {
    setupBaseMocks("low-p-with-drivers");
    // Fixture with p80 and drivers already covers this; craft a low-p fixture here.
    const lowP = mockSessionDrivers("low-p-with-drivers");
    if (lowP.data) lowP.data.percentile = 50; // below 75 but drivers present
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(lowP);
    render(<SessionDetailPage sessionId="low-p-with-drivers" onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId("cost-drivers-panel")).not.toBeNull());
  });

  it("degrades gracefully when driver fetch fails — no panel, no crash", async () => {
    setupBaseMocks("error-session");
    vi.mocked(client.fetchSessionDrivers).mockRejectedValue(new Error("drivers unavailable"));
    render(<SessionDetailPage sessionId="error-session" onBack={() => {}} />);
    await screen.findByText("Session detail");
    expect(screen.queryByTestId("cost-drivers-panel")).toBeNull();
  });
});

describe("CostDriversPanel render", () => {
  it("renders ranked driver rows with label, share, and measured quantities", async () => {
    setupBaseMocks("hot-session");
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(mockSessionDrivers("hot-session"));
    render(<SessionDetailPage sessionId="hot-session" onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId("cost-drivers-panel")).not.toBeNull());

    // Both seeded drivers render as rows
    const rows = screen.getAllByTestId("cost-driver-row");
    expect(rows.length).toBe(2);

    // D8 comes first (higher share 0.62 vs 0.41 for D6 — same sort as backend)
    expect(rows[0]?.getAttribute("data-detector")).toBe("D8");
    expect(rows[1]?.getAttribute("data-detector")).toBe("D6");

    // Labels visible
    expect(screen.getByText("CACHE_WRITE_CHURN")).toBeTruthy();
    expect(screen.getByText("TOOL_RESULT_BLOAT")).toBeTruthy();

    // Share percentages render
    expect(screen.getByText("62% share")).toBeTruthy();
    expect(screen.getByText("41% share")).toBeTruthy();
  });

  it("approx_usd renders per-driver (D6 only) but is NOT summed across drivers", async () => {
    setupBaseMocks("hot-session");
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(mockSessionDrivers("hot-session"));
    render(<SessionDetailPage sessionId="hot-session" onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId("cost-drivers-panel")).not.toBeNull());

    // D6 has approx_usd: 0.15 — rendered as per-driver with the honesty label
    const usdEl = screen.getByText(/\$0\.15\/wk \(this driver only\)/);
    expect(usdEl).toBeTruthy();

    // D8 has no approx_usd — no combined total appears.
    const allText = screen.getByTestId("cost-drivers-panel").textContent ?? "";
    // The per-driver qualifier must be present for D6's amount.
    expect(allText).toContain("$0.15/wk (this driver only)");
    // Honesty invariant: approx_usd is never summed — the panel must NOT show any ≈$ amount
    // that is not the known per-driver one (0.15). A summed total of D6+D8 would be different.
    // Count all ≈$ occurrences in the panel — must be exactly 1 (the per-driver one).
    const approxMatches = allText.match(/≈\$/g) ?? [];
    expect(approxMatches).toHaveLength(1);
  });
});

describe("CostDriversPanel routing chips", () => {
  it("artifact detector (D6, rec_card) chip links to #/recommendations?focus=<rec_id>", async () => {
    setupBaseMocks("hot-session");
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(mockSessionDrivers("hot-session"));
    render(<SessionDetailPage sessionId="hot-session" onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId("cost-drivers-panel")).not.toBeNull());

    const recChip = screen.getByTestId("driver-route-rec_card");
    expect(recChip.tagName).toBe("A");
    expect(recChip.getAttribute("href")).toBe("#/recommendations?focus=rec-d6-1");
  });

  it("behavioral detector (D8, hook) chip links to #/settings", async () => {
    setupBaseMocks("hot-session");
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(mockSessionDrivers("hot-session"));
    render(<SessionDetailPage sessionId="hot-session" onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId("cost-drivers-panel")).not.toBeNull());

    const hookChip = screen.getByTestId("driver-route-hook");
    expect(hookChip.tagName).toBe("A");
    expect(hookChip.getAttribute("href")).toBe("#/settings");
  });
});

describe("CostDriversPanel GUIDED prompt", () => {
  it("renders the GUIDED prompt block with ≥3 measured quantities", async () => {
    setupBaseMocks("hot-session");
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(mockSessionDrivers("hot-session"));
    render(<SessionDetailPage sessionId="hot-session" onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId("cost-drivers-panel")).not.toBeNull());

    const promptEl = screen.getByTestId("driver-prompt-text");
    const promptText = promptEl.textContent ?? "";

    // Must start with TASK:
    expect(promptText).toMatch(/^TASK:/);

    // MEASURED CONTEXT section present
    expect(promptText).toContain("MEASURED CONTEXT:");

    // ACCEPTANCE section present
    expect(promptText).toContain("ACCEPTANCE:");

    // Count lines that start with "Measured " — must be ≥3
    const measuredLines = promptText
      .split("\n")
      .filter((line) => line.trimStart().startsWith("Measured "));
    expect(measuredLines.length).toBeGreaterThanOrEqual(3);
  });

  it("prompt contains the driver label names", async () => {
    setupBaseMocks("hot-session");
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(mockSessionDrivers("hot-session"));
    render(<SessionDetailPage sessionId="hot-session" onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId("driver-prompt-text")).not.toBeNull());

    const promptText = screen.getByTestId("driver-prompt-text").textContent ?? "";
    expect(promptText).toContain("CACHE_WRITE_CHURN");
    expect(promptText).toContain("TOOL_RESULT_BLOAT");
  });
});
