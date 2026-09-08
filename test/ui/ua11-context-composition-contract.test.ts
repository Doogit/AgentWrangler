import { describe, expect, it } from "vitest";
import {
  mockContextComposition,
  mockWorkspaceSessions,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";

describe("UA11 workspace context composition contract", () => {
  it.each(["ws-1", "ws-2", "ws-3", "ws-4", "ws-5"])(
    "decomposes the seven-day context average for %s",
    (workspaceId) => {
      const summary = mockWorkspaces({ preset: "7d" });
      const workspace = summary.data?.items.find((row) => row.workspace_id === workspaceId);
      const composition = mockContextComposition(workspaceId);
      const data = composition.data;
      if (!workspace || !data) throw new Error("Expected populated workspace fixtures");

      expect(data.workspace_id).toBe(workspace.workspace_id);
      expect(composition.meta.drilldown_ids).toEqual({ workspace_id: workspace.workspace_id });
      expect(composition.meta.window).toEqual(summary.meta.window);
      expect(composition.meta.qualification.provisional_excluded).toBe(false);
      expect(composition.meta.claim_kind).toBe("OBS_PROXY");
      expect(data.observed_context_tokens).toBe(workspace.avg_context_per_turn);
      expect(data.observed_turns).toBe(workspace.turns);
      expect(composition.meta.n).toBe(data.observed_turns);
      const sessions = mockWorkspaceSessions(workspaceId, { preset: "7d" });
      expect(data.observed_turns).toBe(
        sessions.data?.items.reduce((sum, session) => sum + session.turn_count, 0),
      );

      const [inventory, residual] = data.rows;
      expect(inventory.key).toBe("always_loaded");
      expect(residual.key).toBe("session_residual");
      expect(residual.tokens).toBe(
        Math.max((workspace.avg_context_per_turn ?? 0) - inventory.tokens, 0),
      );
      const total = inventory.tokens + residual.tokens;
      expect(total).toBe(data.observed_context_tokens);
      for (const row of data.rows) expect(row.share).toBeCloseTo(row.tokens / total);
      expect((inventory.share ?? 0) + (residual.share ?? 0)).toBeCloseTo(1);

      // Composition has no window selector: it must not use 24h or 30d counts.
      for (const preset of ["24h", "30d"] as const) {
        const other = mockWorkspaces({ preset });
        expect(composition.meta.window).not.toEqual(other.meta.window);
        expect(data.observed_turns).not.toBe(
          other.data?.items.find((row) => row.workspace_id === workspaceId)?.turns,
        );
      }
    },
  );

  it("does not borrow another workspace's observation for an unknown identity", () => {
    const response = mockContextComposition("unknown-workspace");
    expect(response.data).toMatchObject({
      workspace_id: "unknown-workspace",
      observed_context_tokens: null,
      observed_turns: 0,
    });
    expect(response.meta.n).toBe(0);
    expect(response.data?.rows[1].tokens).toBe(0);
    expect(response.data?.rows.every((row) => row.share === null)).toBe(true);
  });
});
