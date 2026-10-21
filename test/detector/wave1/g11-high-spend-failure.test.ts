import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  G11_MIN_COMPARISON_WORK_ITEMS,
  g11Detector,
} from "../../../src/detector/detectors/g11_high_spend_failure.js";
import { buildContext } from "../../../src/detector/engine.js";
import { findingIds } from "../../../src/detector/privacy-contract.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";
import { assertV2ProducerBoundary } from "../../fixtures/v2-producer-boundary.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-g11', 'ws-g11', ?)",
  ).run(CTX.fromIso);
});

afterEach(() => db.close());

function addWorkItem(
  id: string,
  index: number,
  tokens: number,
  {
    terminalAt = `2026-12-${String(index).padStart(2, "0")}T00:00:00.000Z`,
    outcome = "OBSERVED_SUCCESS",
    links = 1,
    reconciled = true,
    usage = true,
  }: {
    terminalAt?: string;
    outcome?: "OBSERVED_SUCCESS" | "OBSERVED_FAILURE";
    links?: number;
    reconciled?: boolean;
    usage?: boolean;
  } = {},
): void {
  const sessionId = `g11-session-${id}`;
  db.prepare(
    `INSERT INTO work_items
       (work_item_id, workspace_id, number, state, final_commit, checks_conclusion, opened_at, merged_at, closed_at, synced_at)
     VALUES (?, 'ws-g11', ?, 'MERGED', 'commit', 'SUCCESS', ?, ?, NULL, ?)`,
  ).run(id, index, terminalAt, terminalAt, terminalAt);
  db.prepare(
    `INSERT INTO observed_outcomes (work_item_id, outcome, derived_at, methodology_version)
     VALUES (?, ?, ?, 'test')`,
  ).run(id, outcome, terminalAt);
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, 'ws-g11', ?, ?, ?, ?, 0, 0, '[]')`,
  ).run(
    sessionId,
    `/fixture/${id}.jsonl`,
    terminalAt,
    terminalAt,
    reconciled ? "RECONCILED" : "LIVE",
  );
  db.prepare(
    `INSERT INTO session_work_links (session_id, work_item_id, confidence, method)
     VALUES (?, ?, 1, 'MANUAL')`,
  ).run(sessionId, id);
  if (links > 1) {
    const extraId = `${id}-extra`;
    db.prepare(
      `INSERT INTO work_items
         (work_item_id, workspace_id, number, state, final_commit, checks_conclusion, opened_at, merged_at, closed_at, synced_at)
       VALUES (?, 'ws-g11', ?, 'MERGED', 'commit', 'SUCCESS', ?, ?, NULL, ?)`,
    ).run(extraId, 1_000 + index, terminalAt, terminalAt, terminalAt);
    db.prepare(
      `INSERT INTO session_work_links (session_id, work_item_id, confidence, method)
       VALUES (?, ?, 1, 'MANUAL')`,
    ).run(sessionId, extraId);
  }
  if (usage) {
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
          cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_claim, provisional, parser_version)
       VALUES (?, ?, 'ws-g11', ?, 'test', 0, ?, 99_999, 0, 0, 0, 0, 'LIST_EQUIV', 0, 'test')`,
    ).run(`g11-message-${id}`, sessionId, terminalAt, tokens);
  }
}

describe("G11 HIGH_SPEND_OBSERVED_FAILURE V2", () => {
  it("fires for a current observed failure at the workspace p90, counting output tokens (U7)", () => {
    for (let index = 1; index <= G11_MIN_COMPARISON_WORK_ITEMS; index += 1) {
      addWorkItem(`g11-comparison-${index}`, index, index * 100);
    }
    addWorkItem("g11-failure", 25, 2_000, {
      terminalAt: "2027-01-04T00:00:00.000Z",
      outcome: "OBSERVED_FAILURE",
    });

    const outcome = g11Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, g11Detector);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    const finding = outcome.fired[0]?.payload;
    expect(finding?.assessment).toMatchObject({ kind: "CORRELATIONAL", posture: "REVIEW" });
    expect(finding?.routing).toEqual({ tier: "INVESTIGATE" });
    expect(finding?.metrics).toEqual({
      WORK_ITEM_ID: { kind: "OPAQUE_ID", value: findingIds.workItem("g11-failure") },
      // U7: output tokens are in the total (each fixture turn wrote 99,999 of them).
      INPUT_CACHE_TOKENS: { kind: "TOKENS", value: 2_000 + 99_999 },
      WORKSPACE_P90_INPUT_CACHE_TOKENS: { kind: "TOKENS", value: 1_800 + 99_999 },
      COMPARISON_WORK_ITEM_COUNT: { kind: "COUNT", value: G11_MIN_COMPARISON_WORK_ITEMS },
    });
    expect(finding?.anchors.map((anchor) => anchor.message_id)).toEqual([
      findingIds.message("g11-message-g11-failure"),
    ]);
    expect(JSON.stringify(finding)).not.toContain("fixture/g11-failure");
    // session_ids: non-empty, present in fixture sessions table
    expect(finding?.session_ids).toEqual(["g11-session-g11-failure"]);
    // No pricing snapshot → readPrice = 0 → modeled_savings null; P pass-through rank = null ?? 0 = 0
    expect(finding?.estimate).toMatchObject({
      basis: "P",
      rank_value_u_per_wk: 0,
      summable: false,
    });
  });

  it("fails closed for fewer than 20 complete comparison work items", () => {
    for (let index = 1; index < G11_MIN_COMPARISON_WORK_ITEMS; index += 1) {
      addWorkItem(`g11-small-${index}`, index, index * 100);
    }
    addWorkItem("g11-small-failure", 30, 99_000, {
      terminalAt: "2027-01-04T00:00:00.000Z",
      outcome: "OBSERVED_FAILURE",
    });

    expect(g11Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  // U7: a session linked to two work items used to drop both (all three real failures were
  // multi-linked). Its turns are now split between them by turn time.
  it("splits a multi-linked session by turn time instead of dropping it", () => {
    for (let index = 1; index <= G11_MIN_COMPARISON_WORK_ITEMS; index += 1) {
      addWorkItem(`g11-split-base-${index}`, index, index * 100);
    }
    addWorkItem("g11-split-failure", 30, 99_000, {
      terminalAt: "2027-01-04T00:00:00.000Z",
      outcome: "OBSERVED_FAILURE",
      links: 2,
    });
    // The extra link finishes a day later; the session's only turn (01-04) is the failure's.
    db.prepare(
      "UPDATE work_items SET merged_at = '2027-01-05T00:00:00.000Z' WHERE work_item_id = ?",
    ).run("g11-split-failure-extra");
    const outcome = g11Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.payload.metrics).toMatchObject({
      INPUT_CACHE_TOKENS: { kind: "TOKENS", value: 99_000 + 99_999 },
    });
  });

  it("falls back to the workspace's per-session p90 when it has too few terminal work items", () => {
    // 20 other sessions with no PR at all, and only one terminal work item.
    for (let index = 1; index <= 20; index += 1) {
      const sessionId = `g11-lone-${index}`;
      db.prepare(
        `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
         VALUES (?, 'ws-g11', ?, '2026-12-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', 'RECONCILED', 0, 0, '[]')`,
      ).run(sessionId, `/fixture/${sessionId}.jsonl`);
      db.prepare(
        `INSERT INTO turns
           (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
            cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_claim, provisional, parser_version)
         VALUES (?, ?, 'ws-g11', '2026-12-01T00:00:00.000Z', 'test', 0, ?, 0, 0, 0, 0, 0, 'LIST_EQUIV', 0, 'test')`,
      ).run(`g11-lone-msg-${index}`, sessionId, index * 100);
    }
    addWorkItem("g11-fallback-failure", 30, 50_000, {
      terminalAt: "2027-01-04T00:00:00.000Z",
      outcome: "OBSERVED_FAILURE",
    });
    const outcome = g11Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired[0]?.payload.metrics).toMatchObject({
      COMPARISON_WORK_ITEM_COUNT: { kind: "COUNT", value: 20 },
    });
  });

  it("does not fire for an item under 1% of the workspace's 90-day spend", () => {
    for (let index = 1; index <= G11_MIN_COMPARISON_WORK_ITEMS; index += 1) {
      addWorkItem(`g11-gate-base-${index}`, index, index * 100);
    }
    addWorkItem("g11-gate-failure", 30, 99_000, {
      terminalAt: "2027-01-04T00:00:00.000Z",
      outcome: "OBSERVED_FAILURE",
    });
    // The failure's turn cost $1; another turn in the workspace cost $1,000.
    db.prepare(
      "UPDATE turns SET cost_equiv_u = 1000000 WHERE message_id = 'g11-message-g11-gate-failure'",
    ).run();
    db.prepare(
      "UPDATE turns SET cost_equiv_u = 1000000000 WHERE message_id = 'g11-message-g11-gate-base-1'",
    ).run();
    expect(g11Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("fails closed when a current failure has unreconciled or absent linked usage", () => {
    for (let index = 1; index <= G11_MIN_COMPARISON_WORK_ITEMS; index += 1) {
      addWorkItem(`g11-baseline-${index}`, index, index * 100);
    }
    addWorkItem("g11-live", 31, 99_000, {
      terminalAt: "2027-01-04T01:00:00.000Z",
      outcome: "OBSERVED_FAILURE",
      reconciled: false,
    });
    addWorkItem("g11-usage-less", 32, 99_000, {
      terminalAt: "2027-01-04T02:00:00.000Z",
      outcome: "OBSERVED_FAILURE",
      usage: false,
    });

    expect(g11Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("requires a terminal observed failure inside the trailing seven-day candidate window", () => {
    for (let index = 1; index <= G11_MIN_COMPARISON_WORK_ITEMS; index += 1) {
      addWorkItem(`g11-terminal-${index}`, index, index * 100);
    }
    addWorkItem("g11-success", 30, 99_000, {
      terminalAt: "2027-01-04T00:00:00.000Z",
      outcome: "OBSERVED_SUCCESS",
    });
    addWorkItem("g11-old-failure", 31, 99_000, {
      terminalAt: "2026-12-01T00:00:00.000Z",
      outcome: "OBSERVED_FAILURE",
    });

    expect(g11Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });
});
