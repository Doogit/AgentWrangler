import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HotSessionsPage from "../../../src/ui/sessions/HotSessionsPage";

const sessionId = "12345678-1234-1234-1234-123456789abc";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          session_id: sessionId,
          workspace_id: "workspace-alpha",
          turns: 12,
          cost_equiv_u: 20_000,
          total_output_tokens: 1_200,
          avg_output_tokens: 100,
          total_context_tokens: 120_000,
          avg_context_tokens: 10_000,
          model: "claude-opus-5",
          last_turn_at: "2026-08-31T12:00:00Z",
          api_error_count: 0,
          compaction_count: 0,
          interrupt_count: 0,
          user_turn_count: 0,
          tool_error_count: 0,
          test_fail_count: 0,
        },
      ],
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HotSessionsPage privacy labels", () => {
  it("shows a shortened session id without default-visible UUID text", async () => {
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("12345678…")).toBeTruthy());
    expect(screen.queryByText(sessionId)).toBeNull();
  });

  it("omits the spend chip when the row carries no percentile", async () => {
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("12345678…")).toBeTruthy());
    expect(screen.queryByText(/by spend/)).toBeNull();
  });
});

describe("HotSessionsPage self-percentile chip (BM3)", () => {
  it("renders the top X% chip when the row has a non-null percentile", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            session_id: sessionId,
            workspace_id: "workspace-alpha",
            turns: 12,
            cost_equiv_u: 20_000,
            total_output_tokens: 1_200,
            avg_output_tokens: 100,
            total_context_tokens: 120_000,
            avg_context_tokens: 10_000,
            model: "claude-opus-5",
            last_turn_at: "2026-08-31T12:00:00Z",
            api_error_count: 0,
            compaction_count: 0,
            interrupt_count: 0,
            user_turn_count: 0,
            tool_error_count: 0,
            test_fail_count: 0,
            spend_percentile: 0.95, // (1 - 0.95) → top 5%
            spend_percentile_n: 30,
          },
        ],
      }),
    );
    render(<HotSessionsPage onSelectSession={vi.fn()} />);
    const chip = await screen.findByText("top 5% by spend");
    expect(chip.getAttribute("title")).toContain("30 sessions");
  });
});
