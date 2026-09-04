import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockCacheWriteTrend,
  mockGlobalOverview,
  mockRecommendations,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
import BriefsPage from "../../src/ui/briefs/BriefsPage";

const client = vi.hoisted(() => ({
  fetchCacheWriteTrend: vi.fn(),
  fetchGlobalOverview: vi.fn(),
  fetchHotSessions: vi.fn(),
  fetchRecommendations: vi.fn(),
  fetchWorkspaces: vi.fn(),
}));

vi.mock("../../src/ui/api/client", () => client);

const writeText = vi.fn<(text: string) => Promise<void>>();
let clipboardDescriptor: PropertyDescriptor | undefined;

const hotSessions = [
  {
    session_id: "brief-session-1",
    workspace_id: "ws-1",
    turns: 8,
    cost_equiv_u: 2_500_000,
    total_output_tokens: 8_000,
    avg_output_tokens: 1_000,
    total_context_tokens: 240_000,
    avg_context_tokens: 30_000,
    model: "claude-opus-5",
    last_turn_at: "2026-09-01T00:00:00.000Z",
    api_error_count: 0,
    compaction_count: 0,
    interrupt_count: 0,
    user_turn_count: 0,
    tool_error_count: 0,
    test_fail_count: 0,
  },
];

beforeEach(() => {
  client.fetchGlobalOverview.mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
  client.fetchWorkspaces.mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  client.fetchCacheWriteTrend.mockResolvedValue(mockCacheWriteTrend({ preset: "7d" }));
  client.fetchRecommendations.mockResolvedValue(mockRecommendations());
  client.fetchHotSessions.mockResolvedValue(hotSessions);
  writeText.mockClear();
  writeText.mockResolvedValue(undefined);
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, "clipboard");
  else Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
});

describe("BriefsPage", () => {
  it("renders a verdict, three delta tiles, and at most three action rows", async () => {
    render(<BriefsPage />);

    expect(await screen.findByRole("heading", { name: "Briefs" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("option", { name: "Global" })).toBeTruthy());

    // Verdict line
    expect(screen.getByText(/cap-weighted equivalent/)).toBeTruthy();
    // Three delta tiles
    expect(screen.getByText("Spend equivalent")).toBeTruthy();
    expect(screen.getByText("Cache-write share")).toBeTruthy();
    // "Hot sessions" appears as a tile label and in the collapsed table — assert the tile label.
    expect(document.querySelector(".brief-tile-label")?.textContent).toBeTruthy();
    expect(
      screen.getAllByText("Hot sessions").some((el) => el.className === "brief-tile-label"),
    ).toBe(true);
    // "Do these three things" section, capped at 3 action rows
    expect(screen.getByRole("heading", { name: "Do these three things" })).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Copy prompt" }).length).toBeLessThanOrEqual(3);

    // Collapsed attribution detail is still in the DOM
    expect(screen.getByText("Cost equivalent")).toBeTruthy();
  });

  it("copies a measured markdown brief", async () => {
    render(<BriefsPage />);
    await screen.findByRole("heading", { name: "Briefs" });
    await waitFor(() => expect(screen.getByRole("option", { name: "Global" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Copy as markdown" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0]?.[0] ?? "";
    expect(copied).toContain("## Verdict");
    expect(copied).toContain("## Change vs prior 7 days");
    expect(copied).toMatch(/\d/);
  });
});
