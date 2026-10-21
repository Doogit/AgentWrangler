import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { b1Detector } from "../../../src/detector/detectors/b1_cache_read_collapse.js";
import {
  b4Detector,
  parseB4Events,
} from "../../../src/detector/detectors/b4_mid_session_prefix_break.js";
import { buildContext, runDetectors } from "../../../src/detector/engine.js";
import { LOAD_TOOLS_EARLY_LINE } from "../../../src/query/api/rec-actions/families/cache.js";
import { buildCardActions } from "../../../src/query/api/rec-actions/index.js";
import { buildTrigger } from "../../../src/query/api/rec-actions/trigger.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";
import { assertV2ProducerBoundary } from "../../fixtures/v2-producer-boundary.js";
const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
let db: Database.Database;
beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-b4', 'ws-b4', ?)",
  ).run(CTX.fromIso);
  db.prepare(
    "INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags) VALUES ('session-b4', 'ws-b4', '/fixture/b4.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')",
  ).run(CTX.fromIso, CTX.toIso);
});
afterEach(() => db.close());
function turn(id: string, ts: string, reads: number, write: number, model = "test") {
  db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_claim, provisional, parser_version) VALUES (?, 'session-b4', 'ws-b4', ?, ?, 0, 0, 0, ?, ?, 0, 0, 'LIST_EQUIV', 0, 'test')",
  ).run(id, ts, model, reads, write);
}
describe("B4 MID_SESSION_PREFIX_BREAK V2", () => {
  it("requires a same-session B1 collapse within five minutes and strict absolute and relative creation gates", () => {
    turn("prior", "2027-01-02T00:00:00.000Z", 12_000, 10_000, "claude-sonnet-4-6");
    turn("current", "2027-01-02T00:05:00.000Z", 2_000, 20_001, "claude-sonnet-4-6");
    expect(b4Detector.evaluate(db, CTX).fired).toHaveLength(1);
    assertV2ProducerBoundary(db, CTX, b4Detector);
    runDetectors(db, CTX, [b4Detector]);
    const row = db
      .prepare(
        "SELECT evidence_json, modeled_formula_json FROM recommendations WHERE detector_id = 'B4'",
      )
      .get() as { evidence_json: string; modeled_formula_json: string };
    const evidence = JSON.parse(row.evidence_json) as { session_ids?: string[] };
    expect(evidence.session_ids).toEqual(["session-b4"]);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'session-b4'").get(),
    ).toEqual({ n: 1 });
    const formula = JSON.parse(row.modeled_formula_json) as {
      estimate?: { basis: string; rank_value_u_per_wk: number | null };
    };
    // 20,001 × 0.5 × (3.75 - 0.3) = 34,502 µUSD/wk (rounded), rank-only: B4 is the rapid
    // subset of B1 and prices the same turn the same way.
    expect(formula.estimate).toEqual(
      expect.objectContaining({ basis: "O", rank_value_u_per_wk: 34_502, summable: false }),
    );
  });
  it("is the rapid subset of B1: every B4 event is also a B1 event, and B1 counts it", () => {
    turn("prior", "2027-01-02T00:00:00.000Z", 12_000, 10_000, "claude-sonnet-4-6");
    turn("current", "2027-01-02T00:02:00.000Z", 2_000, 20_001, "claude-sonnet-4-6");
    expect(b4Detector.evaluate(db, CTX).fired).toHaveLength(1);
    const b1 = b1Detector.evaluate(db, CTX).fired[0];
    expect(
      (b1?.payload.metrics as Record<string, { value: number }>).RAPID_COLLAPSE_COUNT?.value,
    ).toBe(1);
  });
  it("does not fire on a compaction (the context shrank)", () => {
    turn("prior", "2027-01-02T00:00:00.000Z", 200_000, 1_000, "claude-sonnet-4-6");
    turn("current", "2027-01-02T00:02:00.000Z", 5_000, 120_000, "claude-sonnet-4-6");
    expect(b4Detector.evaluate(db, CTX).fired).toHaveLength(0);
  });
  it("rejects a gap over five minutes", () => {
    turn("prior", "2027-01-03T00:00:00.000Z", 12_000, 10_001);
    turn("current", "2027-01-03T00:05:00.001Z", 2_000, 20_002);
    expect(b4Detector.evaluate(db, CTX).fired).toHaveLength(0);
  });

  it("U9: one finding per workspace, largest break first, with the ToolSearch call before it", () => {
    db.prepare(
      "INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags) VALUES ('session-b4b', 'ws-b4', '/fixture/b4b.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')",
    ).run(CTX.fromIso, CTX.toIso);
    const at = (sid: string, id: string, ts: string, reads: number, write: number) =>
      db
        .prepare(
          "INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_claim, provisional, parser_version) VALUES (?, ?, 'ws-b4', ?, 'claude-sonnet-4-6', 0, 0, 0, ?, ?, 0, 0, 'LIST_EQUIV', 0, 'test')",
        )
        .run(id, sid, ts, reads, write);
    const tool = (sid: string, id: string, ts: string, name: string) =>
      db
        .prepare(
          "INSERT INTO tool_events (event_id, session_id, ts, tool_name) VALUES (?, ?, ?, ?)",
        )
        .run(id, sid, ts, name);
    // Session A: first turn reads the 34K base; a ToolSearch call, then a break back to 34K.
    at("session-b4", "a0", "2027-01-02T00:00:00.000Z", 34_000, 30_000);
    at("session-b4", "a1", "2027-01-02T00:01:00.000Z", 200_000, 500);
    // An earlier ToolSearch call that did not break the cache (the base rate the card must show).
    tool("session-b4", "e0", "2027-01-02T00:00:30.000Z", "ToolSearch");
    tool("session-b4", "e1", "2027-01-02T00:01:00.000Z", "ToolSearch");
    at("session-b4", "a2", "2027-01-02T00:01:05.000Z", 34_000, 170_000);
    tool("session-b4", "e2", "2027-01-02T00:01:05.000Z", "mcp__browser-x__tabs");
    // Session B: a smaller break with no ToolSearch before it.
    at("session-b4b", "b0", "2027-01-03T00:00:00.000Z", 34_000, 30_000);
    at("session-b4b", "b1", "2027-01-03T00:01:00.000Z", 120_000, 500);
    at("session-b4b", "b2", "2027-01-03T00:01:04.000Z", 34_000, 90_000);

    const result = b4Detector.evaluate(db, CTX);
    const fired = result.fired;
    expect(fired).toHaveLength(1);
    // F25: the status note counts breaks (EVENT_COUNT), not workspaces.
    expect(result.note).toBe("2 mid-session cache prefix break(s)");
    const metrics = fired[0]?.payload.metrics as Record<string, { value: number | string }>;
    expect(metrics.EVENT_COUNT?.value).toBe(2);
    expect(metrics.TOOLSEARCH_EVENT_COUNT?.value).toBe(1);
    // U9 r2: the break came before the session's first MCP tool call; one other ToolSearch call
    // in these sessions did not break the cache.
    expect(metrics.FIRST_MCP_LOAD_COUNT?.value).toBe(1);
    expect(metrics.SESSION_TOOLSEARCH_CALLS?.value).toBe(2);
    expect(metrics.CURRENT_CACHE_CREATION_TOKENS?.value).toBe(260_000);
    const events = parseB4Events(String(metrics.EVENTS?.value));
    expect(events.map((e) => [e.session_id, e.written, e.after_tool_search, e.first_tool])).toEqual(
      [
        ["session-b4", 170_000, true, "mcp__browser-x__tabs"],
        ["session-b4b", 90_000, false, "-"],
      ],
    );
    expect(events[0]?.first_read).toBe(34_000);
    expect(fired[0]?.payload.session_ids).toEqual(["session-b4", "session-b4b"]);
    expect(fired[0]?.modeled_savings_u_per_wk).toBeNull();
    const b1 = b1Detector.evaluate(db, CTX).fired[0]?.payload.metrics as Record<
      string,
      { value: number }
    >;
    expect(b1.TOOLSEARCH_COLLAPSE_COUNT?.value).toBe(1);
    expect(b1.REWRITE_COST_U?.value).toBe(metrics.REWRITE_COST_U?.value);

    // The card names the measured cause and carries the CLAUDE.md line; no unsupported causes.
    const rec = {
      detector_id: "B4",
      lever: "prefix break",
      evidence: fired[0]?.payload as unknown as Record<string, unknown>,
    };
    const actions = buildCardActions(rec);
    const prompt = actions.primary.copy_text;
    expect(prompt).toContain(
      "Measured pattern: 1 of 2 breaks came on the turn right after a ToolSearch call",
    );
    expect(prompt).toContain("1 other ToolSearch call(s) did not break the cache");
    expect(prompt).toContain("a pattern, not a proven cause");
    expect(prompt).toContain("loading an MCP server's tools for the first time");
    expect(prompt).not.toMatch(/Batch CLAUDE\.md/);
    // U9 r4: B1 owns the fix; B4 is the evidence table and carries no second copy of the line.
    expect(prompt).not.toContain(LOAD_TOOLS_EARLY_LINE);
    // B1 carries its own fix, not a pointer to B4.
    const b1Rec = {
      detector_id: "B1",
      lever: "x",
      evidence: b1Detector.evaluate(db, CTX).fired[0]?.payload as unknown as Record<
        string,
        unknown
      >,
    };
    const b1Primary = buildCardActions(b1Rec).primary;
    expect(b1Primary.summary).toMatch(
      /^Load the on-demand tools a task needs in one ToolSearch call/,
    );
    expect(b1Primary.summary).toContain("not a proven cause");
    expect(b1Primary.copy_text).toContain(LOAD_TOOLS_EARLY_LINE);
    expect(prompt).toContain(
      "| session-b4 | 2027-01-02T00:01:05.000Z | 200,000 → 34,000 (34,000) | 170,000 |",
    );
    expect(prompt).toContain("browser-x (1 of 2)");
    expect(prompt).not.toContain("Typical causes");
    expect(buildTrigger(rec).problem).toContain(
      "Measured pattern: 1 of 2 came on the turn right after a ToolSearch call",
    );
  });

  it("is strict at the creation and ratio thresholds", () => {
    turn("prior", "2027-01-04T00:00:00.000Z", 12_000, 10_000);
    turn("threshold", "2027-01-04T00:01:00.000Z", 2_000, 20_000);
    expect(b4Detector.evaluate(db, CTX).fired).toHaveLength(0);
    turn("new-prior", "2027-01-04T00:02:00.000Z", 12_000, 10_001);
    turn("ratio-exact", "2027-01-04T00:03:00.000Z", 2_000, 20_002);
    expect(b4Detector.evaluate(db, CTX).fired).toHaveLength(0);
  });
});
