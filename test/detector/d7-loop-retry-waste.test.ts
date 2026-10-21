import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeD7LoopEvents } from "../../src/detector/d7-loop-analysis.js";
import { d7Detector } from "../../src/detector/detectors/d7_loop_retry_waste.js";
import {
  assertRecommendationPayloadV1,
  recommendationTemplate,
} from "../../src/detector/privacy-contract.js";
import { turnKey, wastedTurnClaims } from "../../src/detector/turn-claim.js";
import type { DetectorContext, DetectorOutcome } from "../../src/detector/types.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const BASE = new Date("2027-01-02T00:00:00.000Z").getTime();
const CTX: DetectorContext = {
  now: NOW,
  fromIso: "2027-01-01T00:00:00.000Z",
  toIso: NOW.toISOString(),
};

let db: Database.Database;
let sequence = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES ('ws-d7', 'ws-d7', '2027-01-01T00:00:00.000Z')`,
  ).run();
});

afterEach(() => db.close());

function addSession(sessionId: string, state: "LIVE" | "RECONCILED" = "RECONCILED"): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, 'ws-d7', ?, ?, ?, ?, 0, 0, '[]')`,
  ).run(
    sessionId,
    `/fixture/${sessionId}.jsonl`,
    new Date(BASE).toISOString(),
    new Date(BASE).toISOString(),
    state,
  );
}

function addTurn(
  sessionId: string,
  offsetSeconds: number,
  options: {
    provisional?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWrite5m?: number;
    cacheWrite1h?: number;
    cacheWriteOther?: number;
    model?: string;
    snapshotId?: string;
    costEquivU?: number | null;
    /** A subagent's turn: sidechain, with this agent id. */
    agentId?: string;
  } = {},
): string {
  const messageId = `msg-d7-${sequence++}`;
  const ts = new Date(BASE + offsetSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?, ?, 'ws-d7', ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'LIST_EQUIV', ?, 'test-v1')`,
  ).run(
    messageId,
    sessionId,
    ts,
    options.model ?? "claude-sonnet",
    options.agentId === undefined ? 0 : 1,
    options.agentId ?? null,
    options.inputTokens ?? 100,
    options.outputTokens ?? 0,
    options.cacheReadTokens ?? 0,
    options.cacheWrite5m ?? 0,
    options.cacheWrite1h ?? 0,
    options.cacheWriteOther ?? 0,
    options.snapshotId ?? "snap-sonnet",
    options.costEquivU === undefined ? 0 : options.costEquivU,
    options.provisional ?? 0,
  );
  return messageId;
}

function addSnapshot(snapshotId: string, tier: string, prices: number[]): void {
  db.prepare(
    `INSERT OR IGNORE INTO pricing_snapshots
       (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES (?, ?, ?, '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z')`,
  ).run(snapshotId, tier, JSON.stringify(prices));
}

function addEvent(
  sessionId: string,
  ownerMessageId: string,
  offsetSeconds: number,
  options: {
    tool?: string;
    inputHash?: string | null;
    exitClass?: string | null;
    pathHash?: string | null;
    blockIndex?: number;
    metadata?: boolean;
    contentText?: string;
    resultBytes?: number;
  } = {},
): string {
  const eventId = `event-d7-${sequence++}`;
  const ts = new Date(BASE + offsetSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
        input_hash, exit_class, commit_sha)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL)`,
  ).run(
    eventId,
    sessionId,
    ts,
    options.tool ?? "ToolA",
    options.resultBytes ?? null,
    options.inputHash ?? null,
    options.exitClass ?? null,
  );
  if (options.metadata !== false) {
    db.prepare(
      `INSERT INTO tool_event_metadata
         (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      options.pathHash ?? null,
      ownerMessageId,
      options.blockIndex ?? 0,
      options.exitClass === "TEST_FAIL" ? 1 : 0,
    );
  }
  if (options.contentText !== undefined) {
    db.prepare(
      `INSERT INTO tool_event_content (event_id, content_json)
       VALUES (?, ?)`,
    ).run(eventId, JSON.stringify({ command: options.contentText }));
  }
  return eventId;
}

function addSingleEventTurn(
  sessionId: string,
  offsetSeconds: number,
  options: Parameters<typeof addEvent>[3],
  turnOptions: Parameters<typeof addTurn>[2] = {},
): void {
  const owner = addTurn(sessionId, offsetSeconds, turnOptions);
  addEvent(sessionId, owner, offsetSeconds, options);
}

function evaluate(): DetectorOutcome {
  return d7Detector.evaluate(db, CTX);
}

function onlyEvidence(outcome: DetectorOutcome): Record<string, unknown> {
  expect(outcome.status).toBe("ACTIVE");
  expect(outcome.fired).toHaveLength(1);
  const fired = outcome.fired[0];
  if (!fired) throw new Error("expected one D7 recommendation");
  expect(fired.payload.template_id).toBe("D7_RETRY_LOOP");
  expect(fired.modeled_savings_u_per_wk).toBeNull();
  return fired.payload.facts as Record<string, unknown>;
}

describe("D7 signal detection", () => {
  it("prices the loop from the repeat turns' stored cost, each at its model's price (B1)", () => {
    addSnapshot("snap-t-opus", "opus", [5, 25, 0.5, 6.25, 10]);
    addSnapshot("snap-t-sonnet4", "sonnet-4", [3, 15, 0.3, 3.75, 6]);
    addSession("estimated-loop");
    const loop = { tool: "ToolA", inputHash: "same-input" };
    // Four identical calls: the first is not a repeat; the next three are repeat-excess turns.
    addSingleEventTurn("estimated-loop", 0, loop, { costEquivU: 999_999 });
    // Opus repeat: read 100,000 × 0.5 = 50,000; write 2,000 × 6.25 = 12,500;
    // io 10 × 5 + 500 × 25 = 12,550; ingest's stored cost 75,050.
    addSingleEventTurn("estimated-loop", 1, loop, {
      model: "claude-opus-4-7",
      snapshotId: "snap-t-opus",
      inputTokens: 10,
      outputTokens: 500,
      cacheReadTokens: 100_000,
      cacheWrite5m: 2_000,
      costEquivU: 75_050,
    });
    // Sonnet 4 repeat: read 200,000 × 0.3 = 60,000; write (1,000 5m + 400 other) × 3.75
    // + 500 1h × 6 = 5,250 + 3,000 = 8,250; io 20 × 3 + 1,000 × 15 = 15,060; stored 83,310.
    addSingleEventTurn("estimated-loop", 2, loop, {
      model: "claude-sonnet-4-6",
      snapshotId: "snap-t-sonnet4",
      inputTokens: 20,
      outputTokens: 1_000,
      cacheReadTokens: 200_000,
      cacheWrite5m: 1_000,
      cacheWrite1h: 500,
      cacheWriteOther: 400,
      costEquivU: 83_310,
    });
    // Unpriceable repeat (NULL cost): adds 0 to the total and to every component.
    addSingleEventTurn("estimated-loop", 3, loop, {
      model: "claude-unknown",
      snapshotId: "snap-t-opus",
      inputTokens: 7_777,
      cacheReadTokens: 999_999,
      costEquivU: null,
    });

    const fired = evaluate().fired[0];
    if (!fired) throw new Error("expected D7 loop recommendation");
    const facts = fired.payload.facts as unknown as Record<string, number>;
    const num = (key: string): number => facts[key] ?? Number.NaN;
    expect(facts.repeat_excess_turn_count).toBe(3);
    // Σ stored cost = 75,050 + 83,310 = 158,360; × 0.5 = 79,180 µUSD/wk; basis P passes it through.
    expect(facts.repeat_excess_cost_u).toBe(158_360);
    expect(fired.modeled_savings_u_per_wk).toBe(79_180);
    expect(fired.modeled_formula_json?.estimate).toMatchObject({
      basis: "P",
      rank_value_u_per_wk: 79_180,
      summable: false,
    });
    expect(facts.repeat_excess_read_tokens).toBe(300_000);
    expect(facts.repeat_excess_write_tokens).toBe(3_900);
    expect(facts.repeat_excess_io_tokens).toBe(1_530);
    expect(facts.repeat_excess_read_u).toBe(110_000);
    expect(facts.repeat_excess_write_u).toBe(20_750);
    expect(facts.repeat_excess_io_u).toBe(27_610);
    // Independent check: the snapshot components add up to ingest's stored cost within
    // half a µUSD per turn (ingest rounds each turn).
    const parts =
      num("repeat_excess_read_u") + num("repeat_excess_write_u") + num("repeat_excess_io_u");
    expect(Math.abs(parts - num("repeat_excess_cost_u"))).toBeLessThanOrEqual(3 * 0.5);
    const sessionIds = (fired.payload.facts as Record<string, unknown>).session_ids as string[];
    expect(sessionIds).toEqual(["estimated-loop"]);
    expect(
      db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionIds[0]),
    ).toBeDefined();
  });

  it("flags three consecutive calls with the same tool name and non-null input hash", () => {
    addSession("same-call");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("same-call", i, { tool: "ToolA", inputHash: "same-input" });
    }

    const evidence = onlyEvidence(evaluate());
    expect(evidence.identical_call_event_count).toBe(3);
    expect(evidence.loop_flagged_turn_count).toBe(3);
    expect(evidence.owner_turn_metadata_coverage).toBe(1);
  });

  it("F7: a repeated successful browser or poll call is waiting, not a loop", () => {
    addSession("polling");
    for (const tool of ["mcp__claude-in-chrome__computer", "TaskOutput"]) {
      for (let i = 0; i < 4; i++) {
        addSingleEventTurn("polling", sequence, { tool, inputHash: "wait-10", exitClass: "OK" });
      }
    }
    expect(evaluate().fired.some((f) => f.scopeKey.startsWith("D7|"))).toBe(false);
  });

  it("F7: a failing browser call repeated is still a loop", () => {
    addSession("browser-fail");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("browser-fail", i, {
        tool: "mcp__claude-in-chrome__computer",
        inputHash: "click",
        exitClass: "ERROR",
      });
    }
    expect(onlyEvidence(evaluate()).identical_call_event_count).toBe(3);
  });

  it("F7: calls a PreToolUse guard blocked are C9's, not loop evidence", () => {
    addSession("guarded");
    for (let i = 0; i < 3; i++) {
      const owner = addTurn("guarded", i);
      const eventId = addEvent("guarded", owner, i, {
        tool: "TaskCreate",
        inputHash: "task",
        exitClass: "ERROR",
      });
      db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
        eventId,
        JSON.stringify({ error: "PreToolUse:TaskCreate hook error: blocked" }),
      );
    }
    expect(evaluate().fired.some((f) => f.scopeKey.startsWith("D7|"))).toBe(false);
  });

  it("F30: a shell error without 'Exit code N' never ran, so it breaks a test-fail run", () => {
    const run = (sid: string, firstError: string): void => {
      addSession(sid);
      for (let i = 0; i < 3; i++) {
        const owner = addTurn(sid, i);
        const eventId = addEvent(sid, owner, i, { tool: "Bash", exitClass: "TEST_FAIL" });
        db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
          eventId,
          JSON.stringify({
            command: `npx vitest run ${i}`,
            error: i === 0 ? firstError : "Exit code 1\nFAIL",
          }),
        );
      }
    };
    run("deny-reason", "Blocked command shape (guard rules): cd&&-prefix");
    expect(evaluate().fired.some((f) => f.scopeKey.startsWith("D7|"))).toBe(false);
    run("ran", "Exit code 1\nFAIL");
    expect(onlyEvidence(evaluate()).test_fail_event_count).toBe(3);
  });

  it("keeps the calls of the longest repeated call as one loop example (R4.2)", () => {
    addSession("loop-example");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("loop-example", i, { tool: "ToolA", inputHash: "short-loop" });
    }
    addSingleEventTurn("loop-example", 3, { tool: "ToolC", inputHash: "break" });
    const longLoop: string[] = [];
    for (let i = 0; i < 7; i++) {
      const owner = addTurn("loop-example", 10 + i);
      longLoop.push(addEvent("loop-example", owner, 10 + i, { tool: "ToolB", inputHash: "long" }));
    }

    const evidence = onlyEvidence(evaluate());
    expect(evidence.loop_example_event_ids).toEqual(longLoop.slice(0, 5));
    expect(evidence.loop_example_call_count).toBe(7);
  });

  it("clusters retained command text instead of input hashes", () => {
    addSession("retained-command");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("retained-command", i, {
        tool: "ToolA",
        inputHash: `different-hash-${i}`,
        contentText: i === 0 ? "  npm\n test  " : "NPM TEST",
      });
    }

    const evidence = onlyEvidence(evaluate());
    expect(evidence.identical_call_event_count).toBe(3);
  });

  it("keeps distinct retained command texts separate despite one input hash", () => {
    addSession("distinct-retained-commands");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("distinct-retained-commands", i, {
        tool: "ToolA",
        inputHash: "same-legacy-hash",
        contentText: `npm test -- shard-${i}`,
      });
    }

    expect(evaluate()).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("reports honest partial in-window owner-turn metadata coverage", () => {
    addSession("partial-coverage");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("partial-coverage", i, { tool: "ToolA", inputHash: "same-input" });
    }
    const owner = addTurn("partial-coverage", 3);
    addEvent("partial-coverage", owner, 3, {
      tool: "ToolA",
      inputHash: "same-input",
      metadata: false,
    });
    const metadataOnlyOwner = addTurn("partial-coverage", 4);
    addEvent("partial-coverage", metadataOnlyOwner, 4);

    const outcome = evaluate();
    const evidence = onlyEvidence(outcome);
    expect(evidence.owner_turn_metadata_coverage).toBe(0.8);
    expect(evidence.owner_turn_metadata_covered_event_count).toBe(4);
    expect(evidence.owner_turn_metadata_denominator_event_count).toBe(5);
    const fired = outcome.fired[0];
    if (!fired) throw new Error("expected D7 recommendation");
    if (fired.payload.template_id !== "D7_RETRY_LOOP") {
      throw new Error("expected D7 retry-loop payload");
    }
    expect(fired.payload.facts.owner_turn_metadata_coverage).toBe(0.8);
  });

  it("reports full in-window owner-turn metadata coverage for an enriched window", () => {
    addSession("full-coverage");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("full-coverage", i, { inputHash: "same-input" });
    }

    const outcome = evaluate();
    const evidence = onlyEvidence(outcome);
    expect(evidence.owner_turn_metadata_coverage).toBe(1);
    expect(evidence.owner_turn_metadata_covered_event_count).toBe(3);
    expect(evidence.owner_turn_metadata_denominator_event_count).toBe(3);
  });

  it("keeps SEC-4 command marker rows in the coverage denominator as missing-metadata events", () => {
    addSession("command-markers");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("command-markers", i, { tool: "ToolA", inputHash: "same-input" });
    }
    // Marker rows from the SEC-4 writer: local_command, cmd- namespace ID,
    // classified marker or NULL, no tool_event_metadata.
    const marker = db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_hash)
       VALUES (?, 'command-markers', ?, 'local_command', ?)`,
    );
    marker.run(`cmd-${"1".repeat(20)}`, new Date(BASE + 3000).toISOString(), "/compact");
    marker.run(`cmd-${"2".repeat(20)}`, new Date(BASE + 4000).toISOString(), null);

    const outcome = evaluate();
    const evidence = onlyEvidence(outcome);
    expect(evidence.identical_call_event_count).toBe(3);
    expect(evidence.owner_turn_metadata_covered_event_count).toBe(3);
    expect(evidence.owner_turn_metadata_denominator_event_count).toBe(5);
    expect(evidence.owner_turn_metadata_coverage).toBe(0.6);
  });

  it("flags three consecutive TEST_FAIL events", () => {
    addSession("test-fail");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("test-fail", i, {
        tool: "Bash",
        exitClass: "TEST_FAIL",
      });
    }

    const evidence = onlyEvidence(evaluate());
    expect(evidence.test_fail_event_count).toBe(3);
  });

  it("flags three reads of one path identity without an intervening edit", () => {
    addSession("reads");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("reads", i, {
        tool: "Read",
        inputHash: "same-read-region",
        pathHash: "private-path-identity",
      });
    }

    const evidence = onlyEvidence(evaluate());
    expect(evidence.redundant_read_event_count).toBe(3);
  });

  it("review 6 R6-10: counts a repeat only inside one context, not across subagents", () => {
    addSession("brief");
    const read = { tool: "Read", inputHash: "same-read-region", pathHash: "brief-path" };
    // The main thread reads the brief once; twelve subagents each read it once.
    addSingleEventTurn("brief", 0, read);
    for (let agent = 1; agent <= 12; agent++) {
      addSingleEventTurn("brief", agent, read, { agentId: `agent-${agent}` });
    }

    expect(evaluate().status).not.toBe("ACTIVE");
  });

  it("review 6 R6-10: still flags three reads in a row inside one subagent", () => {
    addSession("sub-reads");
    const read = { tool: "Read", inputHash: "same-read-region", pathHash: "sub-path" };
    addSingleEventTurn("sub-reads", 0, read);
    for (let i = 1; i <= 3; i++) {
      addSingleEventTurn("sub-reads", i, read, { agentId: "agent-1" });
    }

    expect(onlyEvidence(evaluate()).redundant_read_event_count).toBe(3);
  });

  it("T9: leaves results over 25 KB to A1", () => {
    addSession("big-reads");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("big-reads", i, {
        tool: "Read",
        inputHash: "same-big-read",
        pathHash: "big-path",
        resultBytes: 30_000,
      });
    }
    expect(evaluate().fired.filter((f) => f.scopeKey.startsWith("D7|"))).toEqual([]);
  });

  it("flags three consecutive repetitions of a non-identical three-gram", () => {
    addSession("three-gram");
    const events = [
      ["ToolA", "input-a"],
      ["ToolB", "input-b"],
      ["ToolC", "input-c"],
      ["ToolA", "input-a"],
      ["ToolB", "input-b"],
      ["ToolC", "input-c"],
      ["ToolA", "input-a"],
      ["ToolB", "input-b"],
      ["ToolC", "input-c"],
    ] as const;
    events.forEach(([tool, inputHash], index) =>
      addSingleEventTurn("three-gram", index, { tool, inputHash }),
    );

    const evidence = onlyEvidence(evaluate());
    expect(evidence.three_gram_loop_event_count).toBe(9);
    expect(evidence.loop_flagged_event_count).toBe(9);
  });

  it("does not flag a three-gram when one repeated element changes", () => {
    addSession("interrupted-three-gram");
    const events = [
      ["ToolA", "input-a"],
      ["ToolB", "input-b"],
      ["ToolC", "input-c"],
      ["ToolA", "input-a"],
      ["ToolB", "input-b"],
      ["ToolX", "input-x"],
      ["ToolA", "input-a"],
      ["ToolB", "input-b"],
      ["ToolC", "input-c"],
    ] as const;
    events.forEach(([tool, inputHash], index) =>
      addSingleEventTurn("interrupted-three-gram", index, { tool, inputHash }),
    );

    expect(evaluate()).toEqual({
      fired: [],
      status: "INACTIVE",
      note: "no reconciled session met a loop/retry threshold",
    });
  });

  it("keeps all-identical runs assigned only to the identical-call signal", () => {
    addSession("identical-not-three-gram");
    for (let index = 0; index < 9; index++) {
      addSingleEventTurn("identical-not-three-gram", index, {
        tool: "ToolA",
        inputHash: "input-a",
      });
    }

    const evidence = onlyEvidence(evaluate());
    expect(evidence.identical_call_event_count).toBe(9);
    expect(evidence.three_gram_loop_event_count).toBe(0);
  });

  it("does not span three-gram loops across sessions", () => {
    addSession("three-gram-first");
    addSession("three-gram-second");
    const events = [
      ["ToolA", "input-a"],
      ["ToolB", "input-b"],
      ["ToolC", "input-c"],
    ] as const;
    events.forEach(([tool, inputHash], index) =>
      addSingleEventTurn("three-gram-first", index, { tool, inputHash }),
    );
    events.forEach(([tool, inputHash], index) =>
      addSingleEventTurn("three-gram-first", index + events.length, { tool, inputHash }),
    );
    events.forEach(([tool, inputHash], index) =>
      addSingleEventTurn("three-gram-second", index, { tool, inputHash }),
    );

    expect(evaluate()).toEqual({
      fired: [],
      status: "INACTIVE",
      note: "no reconciled session met a loop/retry threshold",
    });
  });
});

describe("D7 quiet and exclusion cases", () => {
  it("stays quiet for only two identical calls, failures, or reads", () => {
    for (const [sessionId, options] of [
      ["two-calls", { tool: "ToolA", inputHash: "same" }],
      ["two-fails", { tool: "Bash", exitClass: "TEST_FAIL" }],
      ["two-reads", { tool: "Read", pathHash: "path-two" }],
    ] as const) {
      addSession(sessionId);
      addSingleEventTurn(sessionId, 0, options);
      addSingleEventTurn(sessionId, 1, options);
    }

    expect(evaluate()).toEqual({
      fired: [],
      status: "INACTIVE",
      note: "no reconciled session met a loop/retry threshold",
    });
  });

  it("keeps justified repeats quiet after an Edit to the same path", () => {
    addSession("edit-reset");
    const events = [
      { tool: "Read", pathHash: "path-reset" },
      { tool: "Read", pathHash: "path-reset" },
      { tool: "Edit", pathHash: "path-reset" },
      { tool: "Read", pathHash: "path-reset" },
      { tool: "Read", pathHash: "path-reset" },
    ];
    events.forEach((event, i) =>
      addSingleEventTurn("edit-reset", i, {
        ...event,
        inputHash: event.tool === "Read" ? "same-region" : `edit-${i}`,
      }),
    );

    expect(evaluate().status).toBe("INACTIVE");
  });

  it("keeps a qualifying three-read run when a later Edit resets the path", () => {
    addSession("edit-after-run");
    const events = [
      { tool: "Read", pathHash: "path-complete" },
      { tool: "Read", pathHash: "path-complete" },
      { tool: "Read", pathHash: "path-complete" },
      { tool: "Edit", pathHash: "path-complete" },
      { tool: "Read", pathHash: "path-complete" },
      { tool: "Read", pathHash: "path-complete" },
    ];
    events.forEach((event, i) =>
      addSingleEventTurn("edit-after-run", i, {
        ...event,
        inputHash: event.tool === "Read" && i < 3 ? "same-region-before-edit" : `unique-after-${i}`,
      }),
    );

    const evidence = onlyEvidence(evaluate());
    expect(evidence.redundant_read_event_count).toBe(3);
    expect(evidence.loop_flagged_turn_count).toBe(3);
  });

  it("does not treat different Read chunks of one path as redundant", () => {
    addSession("different-read-regions");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("different-read-regions", i, {
        tool: "Read",
        inputHash: `chunk-${i}`,
        pathHash: "same-private-path",
      });
    }

    expect(evaluate().status).toBe("INACTIVE");
  });

  // Re-review N2 (2026-10-05): a file a test run rewrote between reads returns a new size each time.
  it("does not treat reads that return a different size as redundant", () => {
    addSession("rewritten-output-file");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("rewritten-output-file", i, {
        tool: "Read",
        inputHash: "whole-file",
        pathHash: "debug-output",
        resultBytes: 1_000 + i,
      });
    }

    expect(evaluate().status).toBe("INACTIVE");
  });

  it("groups same-size reads apart from reads after the content changed", () => {
    const read = (id: string, second: number, bytes: number | undefined) => ({
      event_id: id,
      ts: `2027-01-02T00:00:0${second}.000Z`,
      tool_name: "Read",
      input_hash: "same",
      exit_class: "OK",
      file_path_hash: "path",
      ...(bytes === undefined ? {} : { result_bytes: bytes }),
    });
    const changed = analyzeD7LoopEvents([
      read("a1", 0, 10),
      read("a2", 1, 10),
      read("b1", 2, 20),
      read("b2", 3, 20),
      read("b3", 4, 20),
    ]);
    expect(changed.redundantReads).toEqual(new Set(["b1", "b2", "b3"]));
    // Size unknown (callers that do not pass it): grouped by path and region, as before.
    const unknown = analyzeD7LoopEvents([
      read("u1", 0, undefined),
      read("u2", 1, undefined),
      read("u3", 2, undefined),
    ]);
    expect(unknown.redundantReads).toEqual(new Set(["u1", "u2", "u3"]));
  });

  it("treats an excluded null-path event as a redundant-read boundary", () => {
    const analysis = analyzeD7LoopEvents([
      {
        event_id: "read-a",
        ts: "2027-01-02T00:00:00.000Z",
        tool_name: "Read",
        input_hash: "same",
        exit_class: "OK",
        file_path_hash: "path",
      },
      {
        event_id: "read-b",
        ts: "2027-01-02T00:00:01.000Z",
        tool_name: "Read",
        input_hash: "same",
        exit_class: "OK",
        file_path_hash: "path",
      },
      {
        event_id: "excluded",
        ts: "2027-01-02T00:00:02.000Z",
        tool_name: "Bash",
        input_hash: "other",
        exit_class: "OK",
        file_path_hash: null,
        eligible: false,
      },
      {
        event_id: "read-c",
        ts: "2027-01-02T00:00:03.000Z",
        tool_name: "Read",
        input_hash: "same",
        exit_class: "OK",
        file_path_hash: "path",
      },
    ]);
    expect(analysis.redundantReads).toEqual(new Set());
  });

  it("excludes provisional owner turns and LIVE sessions", () => {
    addSession("provisional");
    addSingleEventTurn("provisional", 0, { inputHash: "same" });
    addSingleEventTurn("provisional", 1, { inputHash: "same" }, { provisional: 1 });
    addSingleEventTurn("provisional", 2, { inputHash: "same" });

    addSession("live", "LIVE");
    for (let i = 0; i < 3; i++) addSingleEventTurn("live", i, { inputHash: "same" });

    expect(evaluate().status).toBe("INACTIVE");
  });

  it("reports explicit forward-only coverage when no enriched events are eligible", () => {
    addSession("unenriched");
    for (let i = 0; i < 3; i++) {
      const owner = addTurn("unenriched", i);
      addEvent("unenriched", owner, i, {
        inputHash: "same",
        metadata: false,
      });
    }

    expect(evaluate()).toEqual({
      fired: [],
      status: "NOT_EVALUATED",
      note: "0 enriched tool events available in the trailing window; forward-only D7 coverage has not started",
    });
  });

  it("does not treat a missing owner turn as an enriched repeat", () => {
    addSession("missing-owner");
    for (let i = 0; i < 3; i++) {
      const owner = addTurn("missing-owner", i);
      addEvent("missing-owner", `${owner}-missing`, i, {
        inputHash: "same-input",
      });
    }

    expect(evaluate()).toEqual({
      fired: [],
      status: "NOT_EVALUATED",
      note: "0 enriched tool events available in the trailing window; forward-only D7 coverage has not started",
    });
  });
});

describe("D7 workspace rollup", () => {
  it("two flagged sessions in one workspace → one Fired with aggregated counts and unweighted mean share", () => {
    // Session A: 3 identical calls, 3 total turns → share = 1.0
    addSession("ws-rollup-a");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("ws-rollup-a", i, { tool: "ToolA", inputHash: "hash-ws-a" });
    }

    // Session B: 3 identical calls + 3 non-looping turns → share = 0.5
    addSession("ws-rollup-b");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("ws-rollup-b", i, { tool: "ToolA", inputHash: "hash-ws-b" });
    }
    for (let i = 3; i < 6; i++) {
      addSingleEventTurn("ws-rollup-b", i, { tool: "ToolA", inputHash: `distinct-${i}` });
    }

    const outcome = evaluate();
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    const fired = outcome.fired[0];
    if (!fired) throw new Error("expected one D7 recommendation");
    expect(fired.scopeKey).toBe("D7|ws-d7");
    expect(fired.scope_workspace_id).toBe("ws-d7");
    const ev = fired.payload.facts as Record<string, unknown>;
    expect(ev.session_count).toBe(2);
    expect(ev.session_ids).toEqual(["ws-rollup-a", "ws-rollup-b"]);
    // Sums: loop_flagged_event_count = 3+3=6, loop_flagged_turn_count = 3+3=6
    expect(ev.loop_flagged_event_count).toBe(6);
    expect(ev.loop_flagged_turn_count).toBe(6);
    // Unweighted mean: (3/3 + 3/6) / 2 = (1.0 + 0.5) / 2 = 0.75
    expect(ev.loop_flagged_turn_share).toBe(0.75);
    expect(ev.session_id).toBeUndefined();
  });

  it("two flagged sessions in two workspaces → two separate Fired", () => {
    // Session in default workspace ws-d7
    addSession("ws2-sess-a");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("ws2-sess-a", i, { tool: "ToolA", inputHash: "hash-ws2-a" });
    }

    // Second workspace with its own session
    const ws2Id = "ws-d7-b";
    const ws2SessionId = "ws2-sess-b";
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
       VALUES (?, ?, '2027-01-01T00:00:00.000Z')`,
    ).run(ws2Id, ws2Id);
    db.prepare(
      `INSERT INTO sessions
         (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
          state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?, ?, ?, ?, ?, 'RECONCILED', 0, 0, '[]')`,
    ).run(
      ws2SessionId,
      ws2Id,
      `/fixture/${ws2SessionId}.jsonl`,
      new Date(BASE).toISOString(),
      new Date(BASE).toISOString(),
    );
    for (let i = 0; i < 3; i++) {
      const msgId = `msg-d7-${sequence++}`;
      const ts = new Date(BASE + i * 1000).toISOString();
      db.prepare(
        `INSERT INTO turns
           (message_id, session_id, workspace_id, ts, model, is_sidechain,
            input_tokens, output_tokens, cache_read_tokens,
            cache_write_5m, cache_write_1h, cache_write_other,
            tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
            provisional, parser_version)
         VALUES (?, ?, ?, ?, 'claude-sonnet', 0,
                 100, 0, 0, 0, 0, 0, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
      ).run(msgId, ws2SessionId, ws2Id, ts);
      const evId = `event-d7-${sequence++}`;
      db.prepare(
        `INSERT INTO tool_events
           (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
            input_hash, exit_class, commit_sha)
         VALUES (?, ?, ?, 'ToolA', 1, NULL, 'hash-ws2-b', NULL, NULL)`,
      ).run(evId, ws2SessionId, ts);
      db.prepare(
        `INSERT INTO tool_event_metadata
           (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
         VALUES (?, NULL, ?, 0, 0)`,
      ).run(evId, msgId);
    }

    const outcome = evaluate();
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(2);
    const wsIds = outcome.fired.map((f) => f.scope_workspace_id).sort();
    expect(wsIds).toEqual(["ws-d7", "ws-d7-b"]);
    const recA = outcome.fired.find((f) => f.scope_workspace_id === "ws-d7");
    const recB = outcome.fired.find((f) => f.scope_workspace_id === "ws-d7-b");
    if (!recA || !recB) throw new Error("expected two D7 recs");
    if (
      recA.payload.template_id !== "D7_RETRY_LOOP" ||
      recB.payload.template_id !== "D7_RETRY_LOOP"
    ) {
      throw new Error("expected D7 retry-loop payloads");
    }
    expect(recA.scopeKey).toBe("D7|ws-d7");
    expect(recB.scopeKey).toBe("D7|ws-d7-b");
    expect(recA.payload.facts.session_ids).toEqual(["ws2-sess-a"]);
    expect(recB.payload.facts.session_ids).toEqual(["ws2-sess-b"]);
  });
});

describe("D7 deduplication, formula, and privacy", () => {
  it("deduplicates overlapping signals and shared owning turns", () => {
    addSession("overlap");
    const ownerA = addTurn("overlap", 0, { inputTokens: 100 });
    const ownerB = addTurn("overlap", 1, { inputTokens: 100 });
    addEvent("overlap", ownerA, 0, {
      tool: "Read",
      inputHash: "same-input",
      exitClass: "TEST_FAIL",
      pathHash: "same-path",
      blockIndex: 0,
    });
    addEvent("overlap", ownerA, 0, {
      tool: "Read",
      inputHash: "same-input",
      exitClass: "TEST_FAIL",
      pathHash: "same-path",
      blockIndex: 1,
    });
    addEvent("overlap", ownerB, 1, {
      tool: "Read",
      inputHash: "same-input",
      exitClass: "TEST_FAIL",
      pathHash: "same-path",
      blockIndex: 0,
    });

    const outcome = evaluate();
    const evidence = onlyEvidence(outcome);
    // F14: the two ownerA calls are one message, so the identical call repeats in 2 messages only.
    expect(evidence.identical_call_event_count).toBe(0);
    expect(evidence.test_fail_event_count).toBe(3);
    expect(evidence.redundant_read_event_count).toBe(3);
    expect(evidence.loop_flagged_event_count).toBe(3);
    expect(evidence.loop_flagged_turn_count).toBe(2);
    expect(evidence.loop_flagged_turn_share).toBe(1);
    expect(evidence.owner_turn_metadata_coverage).toBe(1);
    expect(evidence.repeat_excess_turn_cap_weighted_tokens).toBe(200);
    expect(evidence.repeat_excess_event_count).toBe(2);
    expect(evidence.repeat_excess_turn_count).toBe(2);
    expect(evidence.directional_avoidable_cap_weighted_tokens).toBeUndefined();
    expect(evidence.avoidance_fraction).toBeUndefined();

    const fired = outcome.fired[0];
    if (!fired) throw new Error("expected D7 recommendation");
    if (fired.payload.template_id !== "D7_RETRY_LOOP") {
      throw new Error("expected D7 retry-loop payload");
    }
    expect(recommendationTemplate(fired.payload.template_id).formula_id).toBe(
      "D7_LOOP_RETRY_WASTE_V1",
    );
    expect(fired.payload.facts.owner_turn_metadata_coverage).toBe(1);
    expect(fired.payload.facts.repeat_excess_event_count).toBe(2);
    expect("avoidance_fraction" in fired.payload.facts).toBe(false);
  });

  it("validates a pre-B1 retry-loop row without the seven cost facts", () => {
    addSession("older-row");
    for (let i = 0; i < 3; i++)
      addSingleEventTurn("older-row", i, { tool: "ToolA", inputHash: "same-input" });
    const fired = evaluate().fired[0];
    if (!fired) throw new Error("expected D7 recommendation");
    expect(() => assertRecommendationPayloadV1(fired.payload, "D7")).not.toThrow();
    const older = { ...(fired.payload.facts as Record<string, unknown>) };
    for (const key of [
      "repeat_excess_read_tokens",
      "repeat_excess_write_tokens",
      "repeat_excess_io_tokens",
      "repeat_excess_read_u",
      "repeat_excess_write_u",
      "repeat_excess_io_u",
      "repeat_excess_cost_u",
    ]) {
      expect(key in older).toBe(true);
      delete older[key];
    }
    expect(() =>
      assertRecommendationPayloadV1({ ...fired.payload, facts: older }, "D7"),
    ).not.toThrow();
  });

  it("is deterministic and never exposes hashes, commands, paths, or content", () => {
    addSession("privacy");
    const secrets = ["hash-secret", "path-secret", "command-secret", "content-secret"] as const;
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("privacy", i, {
        tool: "Read",
        inputHash: secrets[0],
        pathHash: secrets[1],
      });
    }

    const first = evaluate();
    expect(evaluate()).toEqual(first);
    const serialized = JSON.stringify(first);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('"template_id":"D7_RETRY_LOOP"');
  });
});

describe("D7 error-run and edit-without-read signals (pure fn)", () => {
  const err = (
    id: string,
    tool: string,
    seconds: number,
    exit: string | null = "ERROR",
  ): {
    event_id: string;
    ts: string;
    tool_name: string;
    input_hash: string | null;
    exit_class: string | null;
    file_path_hash: string | null;
  } => ({
    event_id: id,
    ts: new Date(BASE + seconds * 1000).toISOString(),
    tool_name: tool,
    // One error text for the run: a repeated error. U9 r4: a changed value ends the run.
    input_hash: "same-error",
    exit_class: exit,
    file_path_hash: null,
  });

  it("ends an ERROR run when the input or error text changes (not an unchanged retry)", () => {
    const changed = { ...err("b", "Read", 1), input_hash: "other-error" };
    const analysis = analyzeD7LoopEvents([err("a", "Read", 0), changed, err("c", "Read", 2)], {
      includeFrictionSignals: true,
    });
    expect(analysis.errorRuns).toEqual(new Set());
    const same = analyzeD7LoopEvents(
      [err("a", "Read", 0), err("b", "Read", 1), err("c", "Read", 2)],
      { includeFrictionSignals: true },
    );
    expect(same.errorRuns).toEqual(new Set(["a", "b", "c"]));
  });

  it("does not compute friction signals unless includeFrictionSignals is set", () => {
    const rows = [err("a", "Bash", 0), err("b", "Bash", 1), err("c", "Bash", 2)];
    const off = analyzeD7LoopEvents(rows);
    expect(off.errorRuns).toEqual(new Set());
    const on = analyzeD7LoopEvents(rows, { includeFrictionSignals: true });
    expect(on.errorRuns).toEqual(new Set(["a", "b", "c"]));
  });

  it("flags 3+ consecutive same-tool ERRORs but not 2", () => {
    const three = analyzeD7LoopEvents(
      [err("a", "Bash", 0), err("b", "Bash", 1), err("c", "Bash", 2)],
      { includeFrictionSignals: true },
    );
    expect(three.errorRuns).toEqual(new Set(["a", "b", "c"]));
    const two = analyzeD7LoopEvents([err("a", "Bash", 0), err("b", "Bash", 1)], {
      includeFrictionSignals: true,
    });
    expect(two.errorRuns).toEqual(new Set());
  });

  it("F14: calls in one assistant message count once for signals 1 and 5", () => {
    const inMsg = (id: string, seconds: number, msg: string) => ({
      ...err(id, "Glob", seconds),
      owner_message_id: msg,
    });
    const oneMsg = [inMsg("a", 0, "m1"), inMsg("b", 0, "m1"), inMsg("c", 0, "m1")];
    const parallel = analyzeD7LoopEvents(oneMsg, { includeFrictionSignals: true });
    expect(parallel.errorRuns).toEqual(new Set());
    expect(parallel.identicalCalls).toEqual(new Set());
    const twoMsgs = [inMsg("a", 0, "m1"), inMsg("b", 0, "m1"), inMsg("c", 5, "m2")];
    expect(analyzeD7LoopEvents(twoMsgs, { includeFrictionSignals: true }).errorRuns).toEqual(
      new Set(),
    );
    const threeMsgs = [...twoMsgs, inMsg("d", 10, "m3")];
    const loop = analyzeD7LoopEvents(threeMsgs, { includeFrictionSignals: true });
    expect(loop.errorRuns).toEqual(new Set(["a", "b", "c", "d"]));
    expect(loop.identicalCalls).toEqual(new Set(["a", "b", "c", "d"]));
    // Only calls after the first message are repeats.
    expect(loop.repeatExcessEventIds).toEqual(new Set(["c", "d"]));
  });

  it("does not treat alternating tools' ERRORs as one run", () => {
    const rows = [err("a", "Bash", 0), err("b", "PowerShell", 1), err("c", "Bash", 2)];
    const analysis = analyzeD7LoopEvents(rows, { includeFrictionSignals: true });
    expect(analysis.errorRuns).toEqual(new Set());
  });

  it("breaks a run when the wall-clock gap exceeds the ceiling (fabricated adjacency guard)", () => {
    // Third ERROR is 200s after the second (> 120s ceiling) → not one run of 3.
    const rows = [err("a", "Bash", 0), err("b", "Bash", 60), err("c", "Bash", 260)];
    const analysis = analyzeD7LoopEvents(rows, { includeFrictionSignals: true });
    expect(analysis.errorRuns).toEqual(new Set());
  });

  it("ends a run on a non-ERROR event between same-tool ERRORs", () => {
    const rows = [
      err("a", "Bash", 0),
      err("b", "Bash", 1),
      err("ok", "Bash", 2, "OK"),
      err("c", "Bash", 3),
    ];
    const analysis = analyzeD7LoopEvents(rows, { includeFrictionSignals: true });
    expect(analysis.errorRuns).toEqual(new Set());
  });

  it("keeps a run intact when the wall-clock gap is exactly the ceiling (120s, not >)", () => {
    // b→c gap is exactly 120s; the guard is `> MAX_RUN_GAP_SEC`, so the run holds.
    const rows = [err("a", "Bash", 0), err("b", "Bash", 60), err("c", "Bash", 180)];
    const analysis = analyzeD7LoopEvents(rows, { includeFrictionSignals: true });
    expect(analysis.errorRuns).toEqual(new Set(["a", "b", "c"]));
  });

  it("breaks a run on an unparseable timestamp (NaN gap fails safe, no false run)", () => {
    const rows = [
      err("a", "Bash", 0),
      { ...err("b", "Bash", 1), ts: "not-a-date" },
      err("c", "Bash", 2),
    ];
    const analysis = analyzeD7LoopEvents(rows, { includeFrictionSignals: true });
    expect(analysis.errorRuns).toEqual(new Set());
  });

  const file = (
    id: string,
    tool: string,
    seconds: number,
    pathHash: string | null,
  ): {
    event_id: string;
    ts: string;
    tool_name: string;
    input_hash: string | null;
    exit_class: string | null;
    file_path_hash: string | null;
  } => ({
    event_id: id,
    ts: new Date(BASE + seconds * 1000).toISOString(),
    tool_name: tool,
    input_hash: `in-${id}`,
    exit_class: "OK",
    file_path_hash: pathHash,
  });

  it("flags an Edit with no prior in-session Read of its path", () => {
    const analysis = analyzeD7LoopEvents([file("e", "Edit", 0, "p1")], {
      includeFrictionSignals: true,
    });
    expect(analysis.editWithoutRead).toEqual(new Set(["e"]));
    // D7a1: it means "never read in this session", not a repeat, so it flags no loop turn.
    expect(analysis.flaggedEventIds).toEqual(new Set());
  });

  it("does not flag an Edit preceded by a Read of the same path", () => {
    const analysis = analyzeD7LoopEvents(
      [file("r", "Read", 0, "p1"), file("e", "Edit", 1, "p1"), file("e2", "Edit", 2, "p1")],
      { includeFrictionSignals: true },
    );
    expect(analysis.editWithoutRead).toEqual(new Set());
  });

  it("never flags Write without a prior Read (Edit-only)", () => {
    const analysis = analyzeD7LoopEvents([file("w", "Write", 0, "p1")], {
      includeFrictionSignals: true,
    });
    expect(analysis.editWithoutRead).toEqual(new Set());
  });
});

describe("D7 friction signals (detector surface)", () => {
  it("fires an error-loop rec with a tool-labeled step for a coverage-passing session", () => {
    addSession("error-loop");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("error-loop", i, { tool: "Bash", exitClass: "ERROR" });
    }
    const evidence = onlyEvidence(evaluate());
    expect(evidence.error_loop_event_count).toBe(3);
    expect(evidence.friction_signals_suppressed_below_coverage_floor).toBe(false);
    expect(evidence.error_loop_event_count).toBe(3);
  });

  it("suppresses the error-loop signal below the owner-turn-metadata coverage floor", () => {
    addSession("low-cov");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("low-cov", i, { tool: "Bash", exitClass: "ERROR" });
    }
    // Two enriched-but-unowned events drag coverage to 3/5 = 0.6 (< 0.8 floor).
    for (let i = 3; i < 5; i++) {
      const owner = addTurn("low-cov", i);
      addEvent("low-cov", owner, i, { tool: "Bash", exitClass: "ERROR", metadata: false });
    }
    // Friction suppressed and no other signal present → no rec fires.
    expect(evaluate().status).toBe("INACTIVE");
  });

  it("enables friction signals at exactly the 0.8 coverage floor (inclusive >=)", () => {
    addSession("floor-exact");
    // 4 covered consecutive Bash ERRORs (the run) + 1 enriched-but-unowned event
    // → coverage 4/5 = 0.8, exactly the floor → friction enabled.
    for (let i = 0; i < 4; i++) {
      addSingleEventTurn("floor-exact", i, { tool: "Bash", exitClass: "ERROR" });
    }
    const owner = addTurn("floor-exact", 4);
    addEvent("floor-exact", owner, 4, { tool: "Bash", exitClass: "ERROR", metadata: false });

    const evidence = onlyEvidence(evaluate());
    expect(evidence.owner_turn_metadata_coverage).toBe(0.8);
    expect(evidence.friction_signals_suppressed_below_coverage_floor).toBe(false);
    expect(evidence.error_loop_event_count).toBe(4);
  });

  it("uses an MCP category label in steps and never leaks the full MCP tool name (SEC-101)", () => {
    addSession("mcp-loop");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("mcp-loop", i, {
        tool: "mcp__claude-in-chrome__browser_batch",
        exitClass: "ERROR",
      });
    }
    const outcome = evaluate();
    const evidence = onlyEvidence(outcome);
    expect(evidence.error_loop_event_count).toBe(3);
    const serialized = JSON.stringify(outcome.fired[0]);
    expect(serialized).not.toContain("browser_batch");
    expect(serialized).not.toContain("mcp__");
  });

  it("D7a1: an edit without a prior read is not a loop on its own", () => {
    addSession("edit-no-read");
    addSingleEventTurn("edit-no-read", 0, { tool: "Edit", pathHash: "p1" });
    expect(evaluate().status).toBe("INACTIVE");
  });
});

describe("D7 cross-session redundant reads (Item 4)", () => {
  function addRead(
    sessionId: string,
    pathHash: string,
    resultBytes: number,
    inputBytes: number,
    tool = "Read",
    region: string | null = null,
  ): void {
    const eventId = `xread-${sequence++}`;
    db.prepare(
      `INSERT INTO tool_events
         (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
          input_hash, exit_class, commit_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'OK', NULL)`,
    ).run(eventId, sessionId, new Date(BASE).toISOString(), tool, inputBytes, resultBytes, region);
    db.prepare(
      `INSERT INTO tool_event_metadata
         (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
       VALUES (?, ?, NULL, 0, 0)`,
    ).run(eventId, pathHash);
  }

  function firedXRead(): Record<string, unknown> {
    const outcome = evaluate();
    const rec = outcome.fired.find((f) => f.scopeKey.startsWith("D7-XREAD|"));
    if (!rec) throw new Error("expected a cross-session redundant-read rec");
    expect(rec.payload.template_id).toBe("D7_CROSS_SESSION_REREAD");
    expect(rec.modeled_savings_u_per_wk).toBeNull();
    return rec.payload.facts as Record<string, unknown>;
  }

  it("fires for a balanced 5+5 split and weights by result_bytes, not input_bytes", () => {
    addSession("xr-a");
    addSession("xr-b");
    // 5 reads in each of two sessions of one path = 10 reads, 2 sessions.
    // result_bytes total = 10*1000; input_bytes (tiny paths) must NOT be summed.
    for (let i = 0; i < 5; i++) addRead("xr-a", "shared-path", 1000, 7);
    for (let i = 0; i < 5; i++) addRead("xr-b", "shared-path", 1000, 7);

    const evidence = firedXRead();
    expect(evidence.redundant_path_count).toBe(1);
    // T9: the re-reads card counts one read per session; repeats inside a session are the loop
    // card's. The path still qualifies on all 10 reads.
    expect(evidence.total_redundant_read_count).toBe(2);
    expect(evidence.max_path_read_count).toBe(10);
    expect(evidence.max_path_session_count).toBe(2);
    expect(evidence.total_redundant_result_bytes).toBe(2000);
  });

  // F7 (2026-10-04) replaces T9's per-session average: a re-read counts only when it got back
  // what an earlier session had (same region, same size), so one identity has one size.
  it("F7: a file whose size changed between sessions is new context, not a re-read", () => {
    for (const id of ["xr-s1", "xr-s2", "xr-s3"]) addSession(id);
    for (let i = 0; i < 4; i++) addRead("xr-s1", "avg-path", 1000, 7);
    for (let i = 0; i < 4; i++) addRead("xr-s2", "avg-path", 3000, 7);
    for (let i = 0; i < 2; i++) addRead("xr-s3", "avg-path", 2000, 7);
    expect(evaluate().fired.find((f) => f.scopeKey.startsWith("D7-XREAD|"))).toBeUndefined();
  });

  it("F7: the same content read in three sessions counts one read per session", () => {
    for (const id of ["xr-u1", "xr-u2", "xr-u3"]) addSession(id);
    for (let i = 0; i < 4; i++) addRead("xr-u1", "same-path", 2000, 7);
    for (let i = 0; i < 4; i++) addRead("xr-u2", "same-path", 2000, 7);
    for (let i = 0; i < 2; i++) addRead("xr-u3", "same-path", 2000, 7);
    const evidence = firedXRead();
    expect(evidence.redundant_path_count).toBe(1);
    expect(evidence.total_redundant_read_count).toBe(3);
    expect(evidence.total_redundant_result_bytes).toBe(6000);
  });

  it("F7: reads of different regions of one file are not re-reads of each other", () => {
    for (const id of ["xr-g1", "xr-g2", "xr-g3"]) addSession(id);
    for (const [session, region] of [
      ["xr-g1", "lines-1-200"],
      ["xr-g2", "lines-200-400"],
      ["xr-g3", "lines-400-600"],
    ] as const) {
      for (let i = 0; i < 4; i++) addRead(session, "region-path", 2000, 7, "Read", region);
    }
    expect(evaluate().fired.find((f) => f.scopeKey.startsWith("D7-XREAD|"))).toBeUndefined();
  });

  it("D7b1: leaves out a session's reads of a file it also edited", () => {
    for (const id of ["xr-e1", "xr-e2", "xr-e3"]) addSession(id);
    for (let i = 0; i < 4; i++) addRead("xr-e1", "edited-path", 1000, 7);
    for (let i = 0; i < 4; i++) addRead("xr-e2", "edited-path", 1000, 7);
    for (let i = 0; i < 4; i++) addRead("xr-e3", "edited-path", 1000, 7);
    // xr-e3 was working on the file, so its re-reads were needed: 8 reads remain (< 10).
    addRead("xr-e3", "edited-path", 0, 7, "Edit");
    expect(evaluate().fired.find((f) => f.scopeKey.startsWith("D7-XREAD|"))).toBeUndefined();
  });

  it("D7b3: stores the true session count past the 20 listed", () => {
    for (let index = 0; index < 25; index++) {
      addSession(`xr-many-${index}`);
      addRead(`xr-many-${index}`, "many-path", 1000, 7);
    }
    const evidence = firedXRead();
    expect(evidence.session_ids).toHaveLength(20);
    expect(evidence.session_count).toBe(25);
  });

  it("does not fire for a path re-read heavily within a single session", () => {
    addSession("xr-solo");
    for (let i = 0; i < 12; i++) addRead("xr-solo", "solo-path", 1000, 7);
    const rec = evaluate().fired.find((f) => f.scopeKey.startsWith("D7-XREAD|"));
    expect(rec).toBeUndefined();
  });

  it("does not fire for a lopsided 9+1 split", () => {
    addSession("xr-dominant");
    addSession("xr-minority");
    for (let i = 0; i < 9; i++) addRead("xr-dominant", "lopsided-path", 1000, 7);
    addRead("xr-minority", "lopsided-path", 1000, 7);

    const rec = evaluate().fired.find((f) => f.scopeKey.startsWith("D7-XREAD|"));
    expect(rec).toBeUndefined();
  });

  it("keeps the flagship 103-read case across 35 sessions", () => {
    for (let sessionIndex = 0; sessionIndex < 35; sessionIndex++) {
      const sessionId = `xr-flagship-${sessionIndex}`;
      addSession(sessionId);
      const reads = sessionIndex < 33 ? 3 : 2;
      for (let readIndex = 0; readIndex < reads; readIndex++) {
        addRead(sessionId, "flagship-path", 1000, 7);
      }
    }

    const evidence = firedXRead();
    // T9: one read per session counts; the path still qualifies on all 103.
    expect(evidence.total_redundant_read_count).toBe(35);
    expect(evidence.max_path_read_count).toBe(103);
    expect(evidence.max_path_session_count).toBe(35);
  });

  it("does not fire below the minimum cross-session read count", () => {
    addSession("xr-c");
    addSession("xr-d");
    // 9 reads total across 2 sessions (< MIN 10).
    for (let i = 0; i < 5; i++) addRead("xr-c", "thin-path", 1000, 7);
    for (let i = 0; i < 4; i++) addRead("xr-d", "thin-path", 1000, 7);
    const rec = evaluate().fired.find((f) => f.scopeKey.startsWith("D7-XREAD|"));
    expect(rec).toBeUndefined();
  });

  it("leaves reads over A1's 25 KB threshold to A1 (R2.7)", () => {
    addSession("xr-i");
    addSession("xr-j");
    // 12 large re-reads are A1's; the 6 small ones alone are below the minimum.
    for (let i = 0; i < 6; i++) addRead("xr-i", "big-path", 30 * 1024, 7);
    for (let i = 0; i < 6; i++) addRead("xr-j", "big-path", 30 * 1024, 7);
    for (let i = 0; i < 3; i++) addRead("xr-i", "mixed-path", 25 * 1024, 7);
    for (let i = 0; i < 3; i++) addRead("xr-j", "mixed-path", 25 * 1024, 7);
    for (let i = 0; i < 6; i++) addRead("xr-j", "mixed-path", 25 * 1024 + 1, 7);
    expect(evaluate().fired.find((f) => f.scopeKey.startsWith("D7-XREAD|"))).toBeUndefined();

    // Four more small reads of the mixed path cross the minimum: only the 10 small ones count.
    for (let i = 0; i < 2; i++) addRead("xr-i", "mixed-path", 25 * 1024, 7);
    for (let i = 0; i < 2; i++) addRead("xr-j", "mixed-path", 25 * 1024, 7);
    const evidence = firedXRead();
    expect(evidence.redundant_path_count).toBe(1);
    // T9: the 10 small reads qualify the path; one read per session counts.
    expect(evidence.max_path_read_count).toBe(10);
    expect(evidence.total_redundant_read_count).toBe(2);
    expect(evidence.total_redundant_result_bytes).toBe(2 * 25 * 1024);
    const ids = evidence.top_read_event_ids as string[];
    const bytesOf = db.prepare("SELECT result_bytes FROM tool_events WHERE event_id = ?");
    expect((bytesOf.get(ids[0]) as { result_bytes: number }).result_bytes).toBe(25 * 1024);
  });

  it("keeps one read of each top file, most-read first, so the card can name it (R4.1)", () => {
    addSession("xr-g");
    addSession("xr-h");
    for (let i = 0; i < 5; i++) addRead("xr-g", "second-path", 1000, 7);
    for (let i = 0; i < 5; i++) addRead("xr-h", "second-path", 1000, 7);
    for (let i = 0; i < 6; i++) addRead("xr-g", "top-path", 10, 7);
    for (let i = 0; i < 6; i++) addRead("xr-h", "top-path", 10, 7);

    const ids = firedXRead().top_read_event_ids as string[];
    const hashOf = db.prepare("SELECT file_path_hash FROM tool_event_metadata WHERE event_id = ?");
    expect(ids.map((id) => (hashOf.get(id) as { file_path_hash: string }).file_path_hash)).toEqual([
      "top-path",
      "second-path",
    ]);
  });

  it("keeps cross-session evidence free of path hashes and content (SEC-101)", () => {
    addSession("xr-e");
    addSession("xr-f");
    for (let i = 0; i < 5; i++) addRead("xr-e", "secret-path-hash", 1000, 7);
    for (let i = 0; i < 5; i++) addRead("xr-f", "secret-path-hash", 1000, 7);
    const rec = evaluate().fired.find((f) => f.scopeKey.startsWith("D7-XREAD|"));
    if (!rec) throw new Error("expected a cross-session redundant-read rec");
    expect(JSON.stringify(rec)).not.toContain("secret-path-hash");
  });
});

describe("D7 U7: cross-session $ and C3/C5 exclusion", () => {
  /** 5 reads of one 2,700 B file in an origin session, then 5 in a later session with an owner turn. */
  function seedXRead(spendPerTurnU: number, laterTurns: number): void {
    addSession("xu-origin");
    addSession("xu-later");
    for (let i = 0; i < 5; i++) {
      addEvent("xu-origin", addTurn("xu-origin", i, { costEquivU: 0 }), i, {
        tool: "Read",
        pathHash: "xu-path",
        resultBytes: 2700,
        exitClass: "OK",
      });
    }
    const owner = addTurn("xu-later", 100, { costEquivU: spendPerTurnU });
    for (let i = 0; i < 5; i++) {
      addEvent("xu-later", owner, 100 + i, {
        tool: "Read",
        pathHash: "xu-path",
        resultBytes: 2700,
        exitClass: "OK",
        blockIndex: i,
      });
    }
    for (let i = 0; i < laterTurns; i++) {
      addTurn("xu-later", 200 + i * 100, { costEquivU: spendPerTurnU });
    }
  }

  it("prices the re-read along its owner chain: one cache write, then reads (hand-computed)", () => {
    seedXRead(100_000, 3);
    const rec = evaluate().fired.find((f) => f.scopeKey.startsWith("D7-XREAD|"));
    if (!rec) throw new Error("expected a cross-session redundant-read rec");
    // The redundant read is xu-later's first: 2,700 B / 2.7 B per token = 1,000 tokens.
    // 3 later turns: the first writes it (snap-sonnet cw5m $3.75/MTok), the other two read it
    // ($0.30/MTok): 3.75 + 2 x 0.30 = 4.35 $/MTok. 1,000 x 4.35 = 4,350 uUSD; x 0.5 avoidance = 2,175.
    expect(rec.modeled_savings_u_per_wk).toBe(2175);
    const estimate = (rec.modeled_formula_json as { estimate: { basis: string; label: string } })
      .estimate;
    expect(estimate.basis).toBe("E");
    expect(estimate.label).toContain("2.7 bytes per token");
  });

  it("drops the card when the priced re-reads are under 0.1% of workspace spend", () => {
    // 4,350 uUSD of carry against 4 turns x 10M uUSD = 0.011% of spend.
    seedXRead(10_000_000, 3);
    expect(evaluate().fired.find((f) => f.scopeKey.startsWith("D7-XREAD|"))).toBeUndefined();
  });

  function addNotReadEdit(sessionId: string, offset: number): string {
    const owner = addTurn(sessionId, offset, { costEquivU: 50_000 });
    const eventId = addEvent(sessionId, owner, offset, {
      tool: "Edit",
      exitClass: "ERROR",
      pathHash: "u7-edit-path",
    });
    db.prepare(
      `UPDATE tool_events SET tool_error_class = 'NOT_READ', tool_error_classifier_version = 'tool-error-1'
        WHERE event_id = ?`,
    ).run(eventId);
    return owner;
  }

  it("does not count a C3 (Edit before Read) failure run as a loop, and C3 claims its turns", () => {
    addSession("u7-c3");
    const owners = [0, 10, 20].map((offset) => addNotReadEdit("u7-c3", offset));
    // A real loop in the same session: four identical calls, three of them repeat-excess.
    for (let i = 0; i < 4; i++) {
      addSingleEventTurn(
        "u7-c3",
        60 + i,
        { tool: "ToolA", inputHash: "u7-same" },
        { costEquivU: 7_000 },
      );
    }

    const facts = evaluate().fired.find((f) => f.scopeKey === "D7|ws-d7")?.payload.facts as Record<
      string,
      unknown
    >;
    // Without the exclusion the three Edit failures were a same-tool ERROR run: error_loop 3, two
    // more repeat-excess events, and their turns' 100,000 uUSD priced as loop waste.
    expect(facts.error_loop_event_count).toBe(0);
    expect(facts.repeat_excess_event_count).toBe(3);
    expect(facts.repeat_excess_cost_u).toBe(21_000);

    const c3 = wastedTurnClaims(db, CTX).get("C3") ?? new Set<string>();
    for (const owner of owners) expect(c3.has(turnKey("u7-c3", owner))).toBe(true);
  });

  it("keeps a C5-shaped same-error run as D7's loop: C5 carries no $, D7 owns the economics", () => {
    addSession("u7-c5");
    for (const offset of [0, 10, 20]) {
      const owner = addTurn("u7-c5", offset, { costEquivU: 50_000 });
      const eventId = addEvent("u7-c5", owner, offset, { tool: "ToolB", exitClass: "ERROR" });
      db.prepare(
        `UPDATE tool_events SET tool_error_class = 'NOT_FOUND', tool_error_classifier_version = 'tool-error-1'
          WHERE event_id = ?`,
      ).run(eventId);
    }
    const facts = evaluate().fired.find((f) => f.scopeKey === "D7|ws-d7")?.payload.facts as Record<
      string,
      unknown
    >;
    expect(facts.error_loop_event_count).toBe(3);
  });
});
