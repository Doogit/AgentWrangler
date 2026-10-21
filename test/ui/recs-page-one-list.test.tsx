import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import * as client from "../../src/ui/api/client";
import {
  mockEfficiencyHeadroom,
  mockLedger,
  mockPractices,
  mockRecommendations,
} from "../../src/ui/api/fixtures";
import RecommendationsPage from "../../src/ui/recommendations/RecommendationsPage";

vi.mock("../../src/ui/api/client");
vi.mock("../../src/ui/recommendations/RecCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ui/recommendations/RecCard")>();
  return {
    ...actual,
    default: ({
      rec,
      onAdopt,
    }: { rec: RecommendationCard; onAdopt?: (id: string, optionId?: string) => Promise<void> }) => (
      <div data-rec-id={rec.rec_id}>
        {rec.title}
        {onAdopt && (
          <>
            <button type="button" onClick={() => void onAdopt(rec.rec_id)}>
              Adopt plain {rec.rec_id}
            </button>
            <button type="button" onClick={() => void onAdopt(rec.rec_id, "option-alpha")}>
              Adopt option {rec.rec_id}
            </button>
          </>
        )}
      </div>
    ),
  };
});

const fixture = () => {
  const response = mockRecommendations();
  if (!response.data?.active[0]) throw new Error("missing recommendation fixture");
  const base = response.data.active[0];
  const active = [
    { ...base, rec_id: "one", detector_id: "D2", title: "First", scope_workspace_id: "ws-a" },
    { ...base, rec_id: "two", detector_id: "D1", title: "Second", scope_workspace_id: "ws-b" },
    { ...base, rec_id: "three", detector_id: "D2", title: "Third", scope_workspace_id: "ws-a" },
  ];
  response.data.active = active;
  response.data.active_groups = [];
  response.data.limit_warnings = [];
  return response;
};

beforeEach(() => {
  window.location.hash = "#/recommendations";
  vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
  vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RecommendationsPage one list", () => {
  it("renders each active rec once in fixture order and changes grouping by workspace", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(fixture());
    render(<RecommendationsPage />);
    const list = await screen.findByRole("list", { name: "Ranked by weekly impact" });
    const ids = () =>
      [...list.querySelectorAll("[data-rec-id]")].map((node) => node.getAttribute("data-rec-id"));
    expect(ids()).toEqual(["one", "three", "two"]);
    expect(new Set(ids()).size).toBe(3);
    expect(list.querySelectorAll(".recs-group-section")).toHaveLength(2);

    window.location.hash = "#/recommendations?group=workspace";
    await waitFor(() => expect(list.textContent).toContain("ws-a"));
    expect(ids()).toEqual(["one", "three", "two"]);
    expect([...list.querySelectorAll(".recs-group-head")].map((node) => node.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("ws-a"), expect.stringContaining("ws-b")]),
    );
  });

  it("shows an empty ranked list without removed sections", async () => {
    const response = fixture();
    if (!response.data) throw new Error("missing fixture");
    response.data.active = [];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
    render(<RecommendationsPage />);
    const list = await screen.findByRole("list", { name: "Ranked by weekly impact" });
    expect(list.textContent).toContain("No active recommendations");
    expect(screen.queryByRole("heading", { name: "Recommendation queue" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Ranked decisions" })).toBeNull();
  });

  it("sends option_id only when provided to Adopt", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(fixture());
    const fetchMock = vi
      .fn()
      .mockImplementation(async (input: string) =>
        input === "/api/token"
          ? { ok: true, json: async () => ({ token: "test-token" }) }
          : { ok: true, json: async () => ({}) },
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<RecommendationsPage />);
    await screen.findByRole("list", { name: "Ranked by weekly impact" });
    fireEvent.click(screen.getByRole("button", { name: "Adopt plain one" }));
    fireEvent.click(screen.getByRole("button", { name: "Adopt option one" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => url === "/api/recommendations/adopt"),
      ).toHaveLength(2),
    );
    const bodies = fetchMock.mock.calls
      .filter(([url]) => url === "/api/recommendations/adopt")
      .map(([, init]) => JSON.parse(init.body));
    expect(bodies).toEqual([
      { rec_id: "one", completed_change: true },
      { rec_id: "one", option_id: "option-alpha", completed_change: true },
    ]);
  });
});
