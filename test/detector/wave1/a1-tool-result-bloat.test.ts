import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  A1_RESULT_BYTES_THRESHOLD,
  a1Detector,
  a1FindingDescriptor,
} from "../../../src/detector/detectors/a1_tool_result_bloat.js";
import { buildContext, runDetectors } from "../../../src/detector/engine.js";
import { findingDescriptor } from "../../../src/detector/finding-registry.js";
import { findingIds } from "../../../src/detector/privacy-contract.js";
import { DETECTORS } from "../../../src/detector/registry.js";
import { getRecommendationCard } from "../../../src/query/api/recommendations.js";
import { __resetToolCallTargets } from "../../../src/query/api/tool-calls.js";
import { resetQueryDb, setQueryDb } from "../../../src/query/db-context.js";
import { trustedRecommendationContract } from "../../../src/query/recommendation-contract.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";
import { assertV2ProducerBoundary } from "../../fixtures/v2-producer-boundary.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX = buildContext(NOW);

let db: Database.Database;
let sequence = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  sequence = 0;
  db.prepare(
    `INSERT INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES ('ws-a1', 'ws-a1', ?)`,
  ).run(CTX.fromIso);
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('session-a1', 'ws-a1', '/fixture/a1.jsonl', ?, ?,
             'RECONCILED', 0, 0, '[]')`,
  ).run(CTX.fromIso, CTX.toIso);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

function addResult(toolName: string, resultBytes: number, ts = "2027-01-02T00:00:00.000Z"): string {
  const eventId = `a1-event-${sequence++}`;
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
        input_hash, exit_class, commit_sha)
     VALUES (?, 'session-a1', ?, ?, 0, ?, NULL, 'OK', NULL)`,
  ).run(eventId, ts, toolName, resultBytes);
  return eventId;
}

describe("A1 TOOL_RESULT_BLOAT V2", () => {
  it("uses a strict >25 KiB boundary and aggregates qualifying bytes per workspace across tools", () => {
    addResult("Read", A1_RESULT_BYTES_THRESHOLD);
    addResult("Read", A1_RESULT_BYTES_THRESHOLD + 1);
    addResult("Read", A1_RESULT_BYTES_THRESHOLD + 9);
    addResult("mcp__private_server__secret_tool", A1_RESULT_BYTES_THRESHOLD + 20);

    const outcome = a1Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, a1Detector);
    expect(outcome.status).toBe("ACTIVE");
    // One card per workspace (P3.1 review 1, R2.3): the card breaks the bytes down by tool.
    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.scopeKey).toBe("A1|ws-a1");
    expect(outcome.fired[0]?.payload.metrics).toEqual({
      EVENT_COUNT: { kind: "COUNT", value: 3 },
      RESULT_BYTES_TOTAL: {
        kind: "BYTES",
        value: A1_RESULT_BYTES_THRESHOLD * 3 + 30,
      },
      MAX_RESULT_BYTES: { kind: "BYTES", value: A1_RESULT_BYTES_THRESHOLD + 20 },
      THRESHOLD_BYTES: { kind: "BYTES", value: A1_RESULT_BYTES_THRESHOLD },
      // U9 r8: the Read tool's share of the large results (the fixture has two Reads).
      READ_EVENT_COUNT: { kind: "COUNT", value: 2 },
      READ_RESULT_BYTES: { kind: "BYTES", value: A1_RESULT_BYTES_THRESHOLD * 2 + 10 },
    });
    // No owner turn to price the carry at.
    expect(outcome.fired[0]?.payload.estimate?.rank_value_u_per_wk).toBe(0);
    expect(JSON.stringify(outcome.fired)).not.toContain("mcp__private_server__secret_tool");
  });

  it("keeps the five largest deterministic structural anchors", () => {
    const eventIds: string[] = [];
    for (let index = 0; index < 6; index++) {
      eventIds.push(
        addResult(
          "Read",
          A1_RESULT_BYTES_THRESHOLD + index + 1,
          `2027-01-0${index + 1}T00:00:00.000Z`,
        ),
      );
    }

    const finding = a1Detector.evaluate(db, CTX).fired[0]?.payload;
    expect(finding).toBeDefined();
    expect(finding?.anchors).toHaveLength(5);
    expect(finding?.anchors.map((anchor) => anchor.event_id)).toEqual(
      eventIds
        .slice(1)
        .reverse()
        .map((eventId) => findingIds.event(eventId)),
    );
    expect(
      finding?.anchors.every((anchor) => anchor.session_id === findingIds.session("session-a1")),
    ).toBe(true);
  });

  it("P2 estimate carries only later same-chain turns, stopping at a verified compact boundary", () => {
    const eventId = addResult("Bash", A1_RESULT_BYTES_THRESHOLD + 2_700);
    const insTurn = db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens,
          output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
          cost_claim, provisional, parser_version)
       VALUES (?, 'session-a1', 'ws-a1', ?, 'claude-sonnet-4-6', ?, 100, 0, 0, 0, 0, 0,
               'LIST_EQUIV', ?, 'test')`,
    );
    insTurn.run("a1-owner", "2027-01-02T00:00:00.000Z", 0, 0);
    insTurn.run("a1-later-1", "2027-01-02T01:00:00.000Z", 0, 0);
    insTurn.run("a1-side", "2027-01-02T01:30:00.000Z", 1, 0); // other chain: not carried
    insTurn.run("a1-later-2", "2027-01-02T02:00:00.000Z", 0, 1); // provisional still carries
    insTurn.run("a1-after-compact", "2027-01-02T03:00:00.000Z", 0, 0);
    db.prepare(
      `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
       VALUES (?, 'a1-owner', 0, 0)`,
    ).run(eventId);
    db.prepare(
      `INSERT INTO ingest_metric_events
         (event_id, session_id, is_user_turn, is_compact_summary, is_api_error, is_interrupt,
          event_ts, boundary_kind, boundary_verification)
       VALUES ('a1-compact', 'session-a1', 0, 0, 0, 0, '2027-01-02T02:30:00.000Z',
               'compact-boundary', 'VERIFIED')`,
    ).run();

    runDetectors(db, CTX, [a1Detector]);
    const row = db
      .prepare("SELECT modeled_formula_json FROM recommendations WHERE detector_id = 'A1'")
      .get() as { modeled_formula_json: string };
    // Hand-computed from the oracle's A1 rule: 2,700 B / 2.7 = 1,000 tok; N = 2 carried turns;
    // the first writes it, the other reads it (U7: no read on the write turn, as the ledger);
    // sonnet list w5m 3.75, read 0.3: 1,000 × 0.5 × (3.75 + 0.3 × 1) = 2,025 µUSD/wk.
    expect(JSON.parse(row.modeled_formula_json).estimate).toMatchObject({
      basis: "E",
      rank_value_u_per_wk: 2_025,
    });
  });

  it("U7: prices a subagent's read along that subagent's own chain, not zero, not its siblings'", () => {
    const eventId = addResult("Read", A1_RESULT_BYTES_THRESHOLD + 2_700);
    const insTurn = db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id, input_tokens,
          output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
          cost_claim, provisional, parser_version)
       VALUES (?, 'session-a1', 'ws-a1', ?, 'claude-sonnet-4-6', ?, ?, 100, 0, 0, 0, 0, 0,
               'LIST_EQUIV', 0, 'test')`,
    );
    insTurn.run("sub-owner", "2027-01-02T00:00:00.000Z", 1, "agent-a");
    // Two later turns of the same subagent carry it; a parallel subagent and the main thread do not.
    insTurn.run("sub-later-1", "2027-01-02T00:01:00.000Z", 1, "agent-a");
    insTurn.run("sub-later-2", "2027-01-02T00:02:00.000Z", 1, "agent-a");
    for (let i = 0; i < 5; i++) {
      insTurn.run(`sibling-${i}`, `2027-01-02T00:0${i + 1}:30.000Z`, 1, "agent-b");
      insTurn.run(`main-${i}`, `2027-01-02T00:0${i + 1}:40.000Z`, 0, null);
    }
    db.prepare(
      `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
       VALUES (?, 'sub-owner', 0, 0)`,
    ).run(eventId);

    const payload = a1Detector.evaluate(db, CTX).fired[0]?.payload;
    // 2,700 B / 2.7 = 1,000 tok; carried by 2 turns of agent-a: one write, one read.
    // 1,000 × 0.5 × (3.75 + 0.3 × 1) = 2,025 µUSD/wk.
    expect(payload?.estimate?.rank_value_u_per_wk).toBe(2_025);
  });

  it("U7: ranks every large result, the same set the ledger headline claims (was R6-03 lead-only)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aw-a1-"));
    const transcript = path.join(dir, "a1.jsonl");
    // File A read twice (the lead: repeated calls come first), file B read once but larger.
    const events = [
      { id: "tu-a-1", file: "/repo/a.md", bytes: 40_000, ts: "2027-01-02T00:00:00.000Z" },
      { id: "tu-a-2", file: "/repo/a.md", bytes: 40_000, ts: "2027-01-02T00:10:00.000Z" },
      { id: "tu-b-1", file: "/repo/b.md", bytes: 100_000, ts: "2027-01-02T00:20:00.000Z" },
    ];
    writeFileSync(
      transcript,
      `${events
        .map(({ id, file }) =>
          JSON.stringify({
            type: "assistant",
            message: {
              content: [{ type: "tool_use", id, name: "Read", input: { file_path: file } }],
            },
          }),
        )
        .join("\n")}\n`,
    );
    const run = (ids: string[]) => {
      __resetToolCallTargets();
      db.close();
      db = createInMemoryFixtureDb();
      db.prepare(
        "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-a1', 'ws-a1', ?)",
      ).run(CTX.fromIso);
      db.prepare(
        `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
           state, turn_count, cost_equiv_u, hygiene_flags)
         VALUES ('session-a1', 'ws-a1', ?, ?, ?, 'RECONCILED', 0, 0, '[]')`,
      ).run(transcript, CTX.fromIso, CTX.toIso);
      const turn = db.prepare(
        `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
           input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
           cache_write_other, cost_claim, provisional, parser_version)
         VALUES (?, 'session-a1', 'ws-a1', ?, 'claude-sonnet-4-6', 0, 100, 0, 0, 0, 0, 0,
                 'LIST_EQUIV', 0, 'test')`,
      );
      for (let minute = 30; minute < 40; minute++) {
        turn.run(`later-${minute}`, `2027-01-02T00:${minute}:00.000Z`);
      }
      // The same turns in every run: only the large results differ.
      for (const event of events) turn.run(`owner-${event.id}`, event.ts);
      for (const event of events.filter(({ id }) => ids.includes(id))) {
        db.prepare(
          `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
             input_hash, exit_class, commit_sha)
           VALUES (?, 'session-a1', ?, 'Read', 0, ?, NULL, 'OK', NULL)`,
        ).run(event.id, event.ts, event.bytes);
        db.prepare(
          `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
           VALUES (?, ?, 0, 0)`,
        ).run(event.id, `owner-${event.id}`);
      }
      const payload = a1Detector.evaluate(db, CTX).fired[0]?.payload;
      return {
        rank: payload?.estimate?.rank_value_u_per_wk ?? 0,
        all: payload?.metrics?.ALL_RESULTS_CARRY_U_PER_WK,
      };
    };

    try {
      const both = run(["tu-a-1", "tu-a-2", "tu-b-1"]);
      const onlyA = run(["tu-a-1", "tu-a-2"]);
      const onlyB = run(["tu-b-1"]);
      expect(onlyA.rank).toBeGreaterThan(0);
      expect(onlyB.rank).toBeGreaterThan(0);
      // The lead target (a.md) is where the card starts; the rank covers b.md too.
      expect(both.rank).toBe(onlyA.rank + onlyB.rank);
      expect(both.all).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers, serializes, persists, and reads the trusted V2 finding", () => {
    const rawEventId = addResult("Bash", A1_RESULT_BYTES_THRESHOLD + 2_700);
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens,
          output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
          cost_claim, provisional, parser_version)
       VALUES ('a1-owner', 'session-a1', 'ws-a1', '2027-01-02T00:00:00.000Z',
               'claude-sonnet-4-6', 0, 0, 0, 0, 1_000, 0, 0, 'LIST_EQUIV', 0, 'test')`,
    ).run();
    // U7: the result is sent (written) by the next turn; with no later turn it costs nothing.
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens,
          output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
          cost_claim, provisional, parser_version)
       VALUES ('a1-next', 'session-a1', 'ws-a1', '2027-01-02T00:01:00.000Z',
               'claude-sonnet-4-6', 0, 0, 0, 0, 1_000, 0, 0, 'LIST_EQUIV', 0, 'test')`,
    ).run();
    db.prepare(
      `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
       VALUES (?, 'a1-owner', 0, 0)`,
    ).run(rawEventId);
    expect(findingDescriptor(a1FindingDescriptor.rule_id)).toBe(a1FindingDescriptor);
    expect(DETECTORS).toContain(a1Detector);

    runDetectors(db, CTX, [a1Detector]);
    const row = db
      .prepare(
        `SELECT rec_id, detector_id, category, lever, target_metric, evidence_json,
                contract_version, template_id, contract_status, rule_id, state,
                scope_workspace_id, modeled_savings_u_per_wk, modeled_formula_json,
                created_at, adopted_at, dismissed_until
           FROM recommendations WHERE detector_id = 'A1'`,
      )
      .get() as Record<string, unknown>;

    expect(row).toMatchObject({
      detector_id: "A1",
      category: "TOOLING",
      target_metric: "tool_result_bytes",
      contract_version: 2,
      template_id: null,
      contract_status: "V2_VALIDATED",
      rule_id: "A1_TOOL_RESULT_BLOAT",
      scope_workspace_id: "ws-a1",
      modeled_savings_u_per_wk: null,
    });
    expect(row.evidence_json).not.toContain(rawEventId);
    expect(row.evidence_json).not.toContain("Bash");
    const evidence = JSON.parse(row.evidence_json as string) as { session_ids?: string[] };
    expect(evidence.session_ids).toEqual(["session-a1"]);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?").get("session-a1"),
    ).toEqual({ n: 1 });
    const formula = JSON.parse(row.modeled_formula_json as string) as {
      estimate?: { basis: string; rank_value_u_per_wk: number | null };
    };
    // (28,300 - 25,600) / 2.7 × 0.5 × 3.75 = 1,875 µUSD/wk.
    expect(formula.estimate).toEqual(
      expect.objectContaining({ basis: "E", rank_value_u_per_wk: 1_875 }),
    );

    const trusted = trustedRecommendationContract(
      row as unknown as Parameters<typeof trustedRecommendationContract>[0],
    );
    expect(trusted?.version).toBe(2);
    if (trusted?.version !== 2) throw new Error("expected trusted A1 V2 finding");
    expect(trusted.payload.routing).toEqual({ tier: "T3" });
    expect(trusted.payload.metrics?.EVENT_COUNT).toEqual({ kind: "COUNT", value: 1 });

    setQueryDb(db);
    const card = getRecommendationCard(row.rec_id as string);
    expect(card).toMatchObject({
      detector_id: "A1",
      scope_workspace_id: "ws-a1",
      target_metric: "tool_result_bytes",
      actionability_ok: true,
    });
    expect(card?.evidence).toEqual(trusted.payload);
  });
});
