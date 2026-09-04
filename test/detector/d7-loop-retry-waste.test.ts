import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { d7Detector } from "../../src/detector/detectors/d7_loop_retry_waste.js";
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
  options: { provisional?: number; inputTokens?: number } = {},
): string {
  const messageId = `msg-d7-${sequence++}`;
  const ts = new Date(BASE + offsetSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?, ?, 'ws-d7', ?, 'claude-sonnet', 0,
             ?, 0, 0, 0, 0, 0, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', ?, 'test-v1')`,
  ).run(messageId, sessionId, ts, options.inputTokens ?? 100, options.provisional ?? 0);
  return messageId;
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
  } = {},
): string {
  const eventId = `event-d7-${sequence++}`;
  const ts = new Date(BASE + offsetSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
        input_hash, exit_class, commit_sha)
     VALUES (?, ?, ?, ?, 1, NULL, ?, ?, NULL)`,
  ).run(
    eventId,
    sessionId,
    ts,
    options.tool ?? "Bash",
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
  expect(fired.category).toBe("SESSION_HYGIENE");
  expect(fired.target_metric).toBe("loop_flagged_turn_share");
  expect(fired.modeled_savings_u_per_wk).toBeNull();
  return fired.evidence;
}

describe("D7 signal detection", () => {
  it("flags three consecutive calls with the same tool name and non-null input hash", () => {
    addSession("same-call");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("same-call", i, { tool: "Bash", inputHash: "same-input" });
    }

    const evidence = onlyEvidence(evaluate());
    expect(evidence.identical_call_event_count).toBe(3);
    expect(evidence.loop_flagged_turn_count).toBe(3);
    expect(evidence.owner_turn_metadata_coverage).toBe(1);
  });

  it("reports honest partial in-window owner-turn metadata coverage", () => {
    addSession("partial-coverage");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("partial-coverage", i, { tool: "Bash", inputHash: "same-input" });
    }
    const owner = addTurn("partial-coverage", 3);
    addEvent("partial-coverage", owner, 3, {
      tool: "Bash",
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
    expect(fired.modeled_formula.inputs.owner_turn_metadata_coverage).toBe(0.8);
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

  it("flags three consecutive TEST_FAIL events", () => {
    addSession("test-fail");
    for (let i = 0; i < 3; i++) {
      addSingleEventTurn("test-fail", i, {
        tool: "Bash",
        inputHash: `distinct-${i}`,
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
      ["two-calls", { tool: "Bash", inputHash: "same" }],
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
    expect(evidence.identical_call_event_count).toBe(3);
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
    expect(fired.modeled_formula.kind).toBe("DIRECTIONAL_UNVALIDATED");
    expect(fired.modeled_formula.inputs.owner_turn_metadata_coverage).toBe(1);
    expect(fired.modeled_formula.inputs.repeat_excess_event_count).toBe(2);
    expect(fired.modeled_formula.inputs.avoidance_fraction).toBeUndefined();
    expect(fired.modeled_formula.expression).toMatch(/not an avoidable-token or USD savings/);
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
    expect(serialized).toContain("Forward-only enrichment");
    expect(serialized).toContain("raw paths, path hashes, tool input/output, commands");
  });
});
