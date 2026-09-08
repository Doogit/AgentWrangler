/** UA11 selected-window fixture contract. */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import {
  UA11_SCENARIO,
  mockGlobalOverview,
  mockHotSessions,
  mockLedger,
  mockRecommendations,
  mockSession,
  mockTrends,
  mockTurnTimeline,
  mockWorkspaceSessions,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
import ImpactLedger from "../../src/ui/recommendations/ImpactLedger";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue({
    data: null,
    meta: mockLedger().meta,
  });
});

describe("UA11 fixture matrix", () => {
  it("keeps Overview, workspaces, and trend spend in the same selected window", () => {
    const overview = mockGlobalOverview({ preset: "7d" });
    const workspaces = mockWorkspaces({ preset: "7d" });
    const trend = mockTrends({ preset: "7d" });
    if (overview.data === null || workspaces.data === null || trend.data === null) {
      throw new Error("UA11 populated scenario must contain data");
    }

    expect(overview.data.cost_equiv_u).toBe(UA11_SCENARIO.spend_u);
    expect(workspaces.data.items.reduce((sum, row) => sum + row.cost_equiv_u, 0)).toBe(
      UA11_SCENARIO.spend_u,
    );
    expect(workspaces.data.items.map((row) => row.cost_equiv_u)).toEqual(
      UA11_SCENARIO.workspace_spend_u,
    );
    expect(trend.data.buckets.reduce((sum, row) => sum + row.cost_equiv_u, 0)).toBe(
      UA11_SCENARIO.spend_u,
    );
    const directionalGroup = mockRecommendations().data?.active_groups.find(
      (group) => group.detector_id === "D2",
    );
    const directionalCard = mockRecommendations().data?.active.find(
      (card) => card.detector_id === "D2",
    );
    expect(directionalGroup?.total_savings_u_per_wk).toBe(0);
    expect(directionalCard?.modeled_savings_u_per_wk).toBeNull();
  });

  it.each(["24h", "7d", "30d"] as const)(
    "keeps every %s decomposition and metadata inside its selected window",
    (preset) => {
      const overview = mockGlobalOverview({ preset });
      const workspaces = mockWorkspaces({ preset });
      const trend = mockTrends({ preset });
      if (overview.data === null || workspaces.data === null || trend.data === null) {
        throw new Error("UA11 populated scenario must contain data");
      }

      expect(overview.meta.window).toEqual(trend.meta.window);
      expect(workspaces.meta.window).toEqual(trend.meta.window);
      expect(overview.data.cost_equiv_u).toBe(
        trend.data.buckets.reduce((sum, bucket) => sum + bucket.cost_equiv_u, 0),
      );
      expect(overview.data.cost_equiv_u).toBe(
        workspaces.data.items.reduce((sum, workspace) => sum + workspace.cost_equiv_u, 0),
      );
      expect(overview.data.model_mix.reduce((sum, model) => sum + model.turns, 0)).toBe(
        overview.data.turns,
      );
      expect(overview.data.context_per_turn.map((row) => row.n)).toEqual(
        overview.data.model_mix.map((row) => row.turns),
      );

      expect(overview.data.model_mix.map((row) => row.model)).toEqual([
        "claude-fable-5",
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-haiku-4-5",
      ]);
      for (const model of overview.data.context_per_turn) {
        if (model.usd_per_turn === null) throw new Error("Populated model must have priced turns");
        const rows = trend.data.by_model.filter((row) => row.model === model.model);
        expect(rows.reduce((sum, row) => sum + row.turns, 0)).toBe(model.n);
        expect(model.usd_per_turn * model.n * 1_000_000).toBeCloseTo(
          rows.reduce((sum, row) => sum + row.cost_equiv_u, 0),
          5,
        );
      }
      for (const workspace of workspaces.data.items) {
        expect(workspace.premium_pct).toBeGreaterThanOrEqual(workspace.opus_pct ?? 0);
      }

      for (const bucket of trend.data.buckets) {
        expect(
          trend.data.by_model
            .filter((row) => row.bucket === bucket.bucket)
            .reduce((sum, row) => sum + row.cost_equiv_u, 0),
        ).toBe(bucket.cost_equiv_u);
        expect(
          trend.data.by_workspace
            .filter((row) => row.bucket === bucket.bucket)
            .reduce((sum, row) => sum + row.cost_equiv_u, 0),
        ).toBe(bucket.cost_equiv_u);
        expect(
          trend.data.sessions
            .filter((row) => row.first_turn_at.startsWith(bucket.bucket))
            .reduce((sum, row) => sum + row.cost_equiv_u, 0),
        ).toBe(bucket.cost_equiv_u);
      }
      for (const marker of trend.data.adoption_markers) {
        expect(marker.adopted_at >= trend.meta.window.from).toBe(true);
        expect(marker.adopted_at < trend.meta.window.to).toBe(true);
      }
      for (const workspace of workspaces.data.items) {
        const sessions = mockWorkspaceSessions(workspace.workspace_id, { preset });
        expect(sessions.meta.window).toEqual(workspaces.meta.window);
        expect(sessions.data?.items.reduce((sum, row) => sum + row.cost_equiv_u, 0)).toBe(
          workspace.cost_equiv_u,
        );
        expect(sessions.data?.items.reduce((sum, row) => sum + row.turn_count, 0)).toBe(
          workspace.turns,
        );
      }
      for (const row of trend.data.sessions) {
        const session = mockSession(row.session_id).data;
        expect(session).toMatchObject({
          workspace_id: row.workspace_id,
          repo_name: row.project_slug,
          first_turn_at: row.first_turn_at,
          cost_equiv_u: row.cost_equiv_u,
        });
        expect(
          mockTrends({ preset: "30d" }).data?.sessions.find(
            (candidate) => candidate.session_id === row.session_id,
          ),
        ).toEqual(row);
        const first = mockTurnTimeline(row.session_id).data;
        const turns = [
          ...(first?.items ?? []),
          ...(first?.next_cursor
            ? (mockTurnTimeline(row.session_id, first.next_cursor).data?.items ?? [])
            : []),
        ];
        expect(turns).toHaveLength(session?.turn_count ?? 0);
        expect(turns.reduce((sum, turn) => sum + (turn.cost_equiv_u ?? 0), 0)).toBe(
          row.cost_equiv_u,
        );
        expect(turns[0]?.ts).toBe(session?.first_turn_at);
        expect(turns.at(-1)?.ts).toBe(session?.last_turn_at);
      }
      for (const hot of mockHotSessions({ preset })) {
        const session = mockSession(hot.session_id).data;
        expect(session).toMatchObject({
          workspace_id: hot.workspace_id,
          cost_equiv_u: hot.cost_equiv_u,
          turn_count: hot.turns,
          last_turn_at: hot.last_turn_at,
        });
        expect(trend.data.sessions.some((row) => row.session_id === hot.session_id)).toBe(true);
      }
    },
  );

  it("uses canonical workspace identities from trends through workspace-session detail", () => {
    const trend = mockTrends({ preset: "7d" }).data;
    const workspace = mockWorkspaces({ preset: "7d" }).data?.items.find(
      (row) => row.workspace_id === "ws-2",
    );
    const detail = mockWorkspaceSessions("ws-2", { preset: "7d" }).data?.items[0];
    const directDetail = mockSession("workspace-session-ws-2").data;
    if (!trend || !workspace || !detail || !directDetail) {
      throw new Error("UA11 workspace detail fixture must be populated");
    }

    expect(workspace.project_slug).toBe("support-portal");
    expect(trend.by_workspace.find((row) => row.workspace_id === "ws-2")?.project_slug).toBe(
      workspace.project_slug,
    );
    expect(trend.sessions.find((row) => row.workspace_id === "ws-2")?.project_slug).toBe(
      workspace.project_slug,
    );
    expect(detail).toMatchObject({ workspace_id: "ws-2", repo_name: "support-portal" });
    expect(directDetail.cost_equiv_u).toBeLessThanOrEqual(workspace.cost_equiv_u);
  });

  it("renders pending measurement, unfavorable NO_EFFECT, INCONCLUSIVE, and warning-class states", async () => {
    vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
    const { container } = render(<ImpactLedger />);

    await waitFor(() => expect(container.textContent).toContain("Local check due after"));
    const text = container.textContent ?? "";
    expect(text).toContain("225,000 tokens (+20.0%)");
    expect(text).toContain("No reliable reduction was detected in this period.");
    expect(text).toContain("Several changes happened in this period");
    expect(text).toContain("Acknowledged — not measured");
  });
});
