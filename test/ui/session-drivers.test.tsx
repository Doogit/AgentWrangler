/**
 * test/ui/session-drivers.test.tsx
 *
 * RV3 "Cost drivers" panel on SessionDetailPage.
 * Tests: gate (cheap→no panel), render (p75+/drivers→panel), routing chips,
 * approx_usd never summed, GUIDED prompt block with ≥3 measured quantities.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    await screen.findByRole("heading", { level: 1 });
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
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByTestId("cost-drivers-panel")).toBeNull();
  });
});

describe("CostDriversPanel render", () => {
  it("renders ranked driver rows with label, share, and measured quantities", async () => {
    setupBaseMocks("hot-session");
    const driverResponse = mockSessionDrivers("hot-session");
    const firstDriver = driverResponse.data?.drivers[0];
    if (firstDriver) firstDriver.session_cost_u = 1_250_000;
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(driverResponse);
    render(<SessionDetailPage sessionId="hot-session" onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId("cost-drivers-panel")).not.toBeNull());

    // Both seeded drivers render as rows
    const rows = screen.getAllByTestId("cost-driver-row");
    expect(rows.length).toBe(2);

    // D8 comes first (higher share 0.62 vs 0.41 for D6 — same sort as backend)
    expect(rows[0]?.getAttribute("data-detector")).toBe("D8");
    expect(rows[1]?.getAttribute("data-detector")).toBe("D6");

    // Labels visible
    expect(screen.getByText("Cache-write churn")).toBeTruthy();
    expect(screen.getByText("Tool-result bloat")).toBeTruthy();

    // Share percentages render
    expect(screen.getByText("62% share")).toBeTruthy();
    expect(screen.getByText("41% share")).toBeTruthy();
    expect(rows[0]?.textContent).toContain("$1.25 spent on this in this session");
    expect(rows[1]?.textContent).toContain("—");
  });

  it("puts the drivers in the investigate prompt, without weekly savings", async () => {
    setupBaseMocks("hot-session");
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(mockSessionDrivers("hot-session"));
    render(<SessionDetailPage sessionId="hot-session" onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId("cost-drivers-panel")).not.toBeNull());

    const promptText = screen.getByTestId("investigate-prompt-text").textContent ?? "";
    expect(promptText).toContain("COST DRIVERS:");
    expect(promptText).not.toContain("$/wk");
    expect(screen.queryByTestId("driver-prompt-text")).toBeNull();
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

describe("Investigate this session card", () => {
  it("quotes the session identity and the driver labels", async () => {
    setupBaseMocks("hot-session");
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(mockSessionDrivers("hot-session"));
    render(<SessionDetailPage sessionId="hot-session" onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId("cost-drivers-panel")).not.toBeNull());

    const promptText = screen.getByTestId("investigate-prompt-text").textContent ?? "";
    const session = mockSession("hot-session").data;
    if (session === null) throw new Error("missing synthetic session");
    expect(promptText).toContain(`TRANSCRIPT: ${session.file_path}`);
    expect(promptText).toContain(`WORKSPACE: ${session.repo_path ?? session.workspace_id}`);
    expect(promptText).toContain(
      `estimated cost $${(session.cost_equiv_u / 1_000_000).toFixed(2)}`,
    );
    expect(promptText).toContain("CACHE_WRITE_CHURN");
    expect(promptText).toContain("TOOL_RESULT_BLOAT");
    expect(promptText).toContain("ACCEPTANCE:");
  });

  it("renders for a session with no drivers and copies exactly the previewed text", async () => {
    setupBaseMocks("cheap-session");
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(
      mockSessionDrivers("cheap-session", true),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SessionDetailPage sessionId="cheap-session" onBack={() => {}} />);
    const preview = await screen.findByTestId("investigate-prompt-text");
    expect(screen.queryByTestId("cost-drivers-panel")).toBeNull();
    expect(preview.textContent).toMatch(/^Investigate Claude Code session cheap-session\./);
    fireEvent.click(screen.getByTestId("copy-investigate-prompt"));
    expect(writeText).toHaveBeenCalledWith(preview.textContent);
  });
});
