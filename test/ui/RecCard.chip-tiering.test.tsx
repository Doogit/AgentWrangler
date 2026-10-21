import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { runDetectors } from "../../src/detector/index";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import { getRecommendationCard } from "../../src/query/api/recommendations";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context";
import RecCard from "../../src/ui/recommendations/RecCard";
import { createInMemoryFixtureDb } from "../fixtures/seed";

afterEach(() => cleanup());

function makeRec(): RecommendationCard {
  return {
    rec_id: "chip-tiering-rec",
    detector_id: "D2",
    category: "SESSION",
    scope_workspace_id: null,
    lever: "Use a session boundary between unrelated tasks",
    modeled_savings_u_per_wk: 59_400,
    pct_of_weekly_spend: null,
    run_cost_u: null,
    modeled_formula: {
      model: "D2_LONG_CONTEXT_CACHE_READ_V1",
      inputs: { reduction_fraction: 0.33 },
      kind: "MODELED",
    },
    evidence: { session_count: 3 },
    target_metric: "sessions_over_threshold",
    state: "PROPOSED",
    created_at: "2026-09-01T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: 5,
    steps: [{ kind: "generic", description: "Start a new session for unrelated work" }],
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
    actionability_ok: true,
  };
}

describe("RecCard chip tiering", () => {
  it("renders only category and scope chips; qualifiers remain in metadata", () => {
    const { container, getByRole } = render(<RecCard rec={makeRec()} />);
    const chipRow = container.querySelector(".rec-chip-row");
    if (chipRow === null) throw new Error("recommendation chip row is missing");

    expect(
      chipRow.querySelectorAll(".rec-confidence-tier, .rec-category-chip, .rec-scope-badge"),
    ).toHaveLength(2);
    expect(chipRow.querySelector(".rec-confidence-tier")).toBeNull();
    expect(chipRow.textContent).not.toMatch(/unverified|certified|verified/i);
    expect(chipRow.textContent).toContain("Long sessions");
    expect(chipRow.textContent).toContain("workspace");
    expect(chipRow.textContent).not.toContain("LIST_EQUIV · modeled USD");
    expect(container.querySelector(".rec-meta")).toBeNull();

    fireEvent.click(getByRole("button", { name: /show details/i }));
    const details = container.querySelector(".rec-details");
    // R6-12: the redundant "$X/wk modeled · early estimate" metadata line was removed; the
    // header's SavingsMeter is the only place that states the modeled figure.
    expect(container.querySelector(".rec-meta")).toBeNull();
    expect(details?.querySelectorAll(".chip")).toHaveLength(2);
    expect(details?.textContent).toContain("D2_LONG_CONTEXT_CACHE_READ_V1");
    expect(details?.textContent).toContain("LIST_EQUIV · modeled USD");
  });

  it("renders the trusted D5 formula model and no confidence-tier chip", () => {
    const db = createInMemoryFixtureDb();
    const now = new Date("2026-01-08T00:00:00.000Z");
    setQueryDb(db);
    try {
      db.prepare("UPDATE user_config SET value = ?, updated_at = ? WHERE key = 'limit_tokens'").run(
        "10000",
        now.toISOString(),
      );
      db.prepare(
        `INSERT INTO sessions
          (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
           state, turn_count, cost_equiv_u, hygiene_flags)
         VALUES ('d5-ui-session', 'ws-alpha', '/fixture/d5-ui.jsonl', ?, ?,
           'RECONCILED', 1, 0, '[]')`,
      ).run("2026-01-07T12:00:00.000Z", "2026-01-07T12:00:00.000Z");
      db.prepare(
        `INSERT INTO turns
          (message_id, session_id, workspace_id, ts, model, is_sidechain,
           input_tokens, output_tokens, cache_read_tokens, cache_write_5m,
           cache_write_1h, cache_write_other, tool_result_bytes, pricing_snapshot_id,
           cost_equiv_u, cost_claim, provisional, parser_version)
         VALUES ('d5-ui-turn', 'd5-ui-session', 'ws-alpha', ?, 'claude-sonnet-4', 0,
           9000, 0, 0, 0, 0, 0, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
      ).run("2026-01-07T12:00:00.000Z");

      runDetectors(db, { now });
      const row = db.prepare("SELECT rec_id FROM recommendations WHERE detector_id = 'D5'").get() as
        | { rec_id: string }
        | undefined;
      if (row === undefined) throw new Error("expected D5 engine recommendation");
      const rec = getRecommendationCard(row.rec_id);
      if (rec === null) throw new Error("expected validated D5 query card");

      expect(rec.modeled_formula).toMatchObject({
        model: "D5_LIMIT_BURN_FORECAST_V1",
        kind: "WARNING",
      });
      const { container, getByRole } = render(<RecCard rec={rec} />);
      expect(container.querySelector(".rec-confidence-tier")).toBeNull();
      expect(container.querySelector(".rec-chip-row")?.textContent ?? "").not.toMatch(
        /unverified|certified|verified/i,
      );
      fireEvent.click(getByRole("button", { name: /show details/i }));
      expect(container.querySelector(".rec-formula-expr")?.textContent).toBe(
        "D5_LIMIT_BURN_FORECAST_V1",
      );
    } finally {
      resetQueryDb();
      db.close();
    }
  });
});
