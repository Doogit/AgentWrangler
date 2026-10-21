import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  C7_MIN_FAILURES,
  c7Detector,
} from "../../../src/detector/detectors/c7_bash_failure_cluster.js";
import { buildContext } from "../../../src/detector/engine.js";
import { findingIds } from "../../../src/detector/privacy-contract.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";
import { assertV2ProducerBoundary } from "../../fixtures/v2-producer-boundary.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
let db: Database.Database;
let sequence = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  sequence = 0;
  db.exec(`
    INSERT INTO workspaces (workspace_id, project_slug, registered_at)
    VALUES ('ws-c7', 'ws-c7', '${CTX.fromIso}');
    INSERT INTO sessions
      (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
    VALUES ('session-c7', 'ws-c7', '/fixture/c7.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'RECONCILED', 0, 0, '[]');
  `);
});

afterEach(() => db.close());

function addBash(
  family: "BASH_GIT" | "BASH_NPM" | "BASH_TEST" | null,
  exitClass: "ERROR" | "TEST_FAIL" | "OK" = "ERROR",
  options: {
    sidechain?: number;
    provisional?: number;
    costEquivU?: number;
    error?: string | null;
    command?: string;
  } = {},
): void {
  const suffix = sequence++;
  const eventId = `c7-event-${suffix}`;
  const messageId = `c7-message-${suffix}`;
  const ts = `2027-01-02T00:00:${String(suffix).padStart(2, "0")}.000Z`;
  if (options.costEquivU !== undefined) {
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain, provisional, parser_version, cost_equiv_u)
       VALUES (?, 'session-c7', 'ws-c7', ?, 'claude-sonnet', ?, ?, 'test-v1', ?)`,
    ).run(messageId, ts, options.sidechain ?? 0, options.provisional ?? 0, options.costEquivU);
  } else {
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain, provisional, parser_version)
       VALUES (?, 'session-c7', 'ws-c7', ?, 'claude-sonnet', ?, ?, 'test-v1')`,
    ).run(messageId, ts, options.sidechain ?? 0, options.provisional ?? 0);
  }
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class, bash_command_family)
     VALUES (?, 'session-c7', ?, 'Bash', ?, ?)`,
  ).run(eventId, ts, exitClass, family);
  db.prepare(
    `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
     VALUES (?, ?, ?, 0)`,
  ).run(eventId, messageId, suffix);
  // U7: a failure with no kept error text has no known cause and joins no cluster, so every
  // fixture failure carries text. The default differs per family, as the family once split clusters.
  const error = options.error === undefined ? `Exit code 1\n${family} said no` : options.error;
  if (error === null) return;
  db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
    eventId,
    JSON.stringify({ command: options.command ?? "x", error }),
  );
}

describe("C7 BASH_FAILURE_CLUSTER V2", () => {
  it("emits one per-session/family finding at the failure threshold", () => {
    for (let index = 0; index < C7_MIN_FAILURES; index++) addBash("BASH_NPM");

    const outcome = c7Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, c7Detector);

    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.payload).toMatchObject({
      version: 2,
      rule_id: "C7_BASH_FAILURE_CLUSTER",
      label: "BASH_FAILURE_CLUSTER",
      assessment: { posture: "REVIEW" },
      routing: { tier: "T3" },
      metrics: {
        BASH_COMMAND_FAMILY: { kind: "ENUM", value: "BASH_NPM" },
        BASH_FAILURE_COUNT: { kind: "COUNT", value: C7_MIN_FAILURES },
      },
    });
    expect(outcome.fired[0]?.payload.anchors).toHaveLength(C7_MIN_FAILURES);
    expect(JSON.stringify(outcome.fired)).not.toContain("c7-message");
  });

  it("clusters only failures with the same error, ignoring numbers (R2.10)", () => {
    addBash("BASH_NPM", "ERROR", { error: "Exit code 1\nError: Cannot find module 'a'" });
    addBash("BASH_NPM", "ERROR", { error: "Exit code 1\nnode:internal:301\nboom" });
    addBash("BASH_NPM", "ERROR", { error: "Exit code 2\nError: Cannot find module 'a'" });
    expect(c7Detector.evaluate(db, CTX).fired).toEqual([]);

    addBash("BASH_NPM", "ERROR", { error: "Exit code 1\n\nError: Cannot find module 'a'" });
    addBash("BASH_NPM", "ERROR", { error: "Exit code 1\r\nerror: cannot find module 'a'" });
    expect(c7Detector.evaluate(db, CTX).fired[0]?.payload.metrics?.BASH_FAILURE_COUNT).toEqual({
      kind: "COUNT",
      value: 3,
    });
  });

  it("ignores calls a hook or the harness blocked before they ran (R2.10, counted by C9)", () => {
    for (const error of [
      "PreToolUse:Bash hook error: Blocked command shape",
      "Blocked command shape (CLAUDE.md rules 1-3)",
      "<tool_use_error>Blocked: sleep 30</tool_use_error>",
    ]) {
      addBash("BASH_OTHER" as "BASH_NPM", "ERROR", { error });
    }
    expect(c7Detector.evaluate(db, CTX).fired).toEqual([]);
  });

  it("F32: the same guard deny text three times never ran, so it is no cluster", () => {
    for (let i = 0; i < 3; i++)
      addBash("BASH_OTHER" as "BASH_NPM", "ERROR", {
        error: "Blocked command shape (CLAUDE.md rules 1-3)",
      });
    expect(c7Detector.evaluate(db, CTX).fired).toEqual([]);
  });

  it("does not combine successes or different command families", () => {
    addBash("BASH_NPM");
    addBash("BASH_NPM", "OK");
    addBash("BASH_NPM");
    addBash("BASH_GIT");
    addBash("BASH_GIT", "TEST_FAIL");

    expect(c7Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("excludes sidechain and provisional failures and stays inactive below threshold", () => {
    for (let index = 0; index < C7_MIN_FAILURES - 1; index++) addBash("BASH_TEST");
    addBash("BASH_TEST", "ERROR", { sidechain: 1 });
    addBash("BASH_TEST", "ERROR", { provisional: 1 });

    expect(c7Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("keeps the five newest anchors when a failure cluster exceeds five rows", () => {
    for (let index = 0; index < 7; index++) addBash("BASH_NPM");

    expect(c7Detector.evaluate(db, CTX).fired[0]?.payload.anchors).toEqual(
      [2, 3, 4, 5, 6].map((index) => ({
        session_id: findingIds.session("session-c7"),
        timestamp: `2027-01-02T00:00:0${index}.000Z`,
        event_id: findingIds.event(`c7-event-${index}`),
      })),
    );
  });

  it("U7: failures with no kept error text have no known cause and never cluster", () => {
    for (let index = 0; index < 2 * C7_MIN_FAILURES; index++) {
      addBash("BASH_OTHER" as "BASH_NPM", "ERROR", { error: null });
    }
    expect(c7Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("U7: the same cause clusters across paths, hex ids, ANSI codes and command families", () => {
    addBash("BASH_NPM", "ERROR", {
      error: "Exit code 1\n\u001b[31mError\u001b[0m: ENOENT: no such file 'C:\\work\\a\\b.ts'",
    });
    addBash("BASH_GIT", "ERROR", {
      error: "Exit code 1\nError: ENOENT: no such file '/home/x/repo/src/c.ts'",
    });
    addBash("BASH_OTHER" as "BASH_NPM", "ERROR", {
      error: "Exit code 1\nError: ENOENT: no such file './d.ts'",
    });
    const fired = c7Detector.evaluate(db, CTX).fired;
    expect(fired).toHaveLength(1);
    expect(fired[0]?.payload.metrics?.BASH_FAILURE_COUNT).toEqual({ kind: "COUNT", value: 3 });
    // The card can name the cause: the commonest failure's exit code, first line, command head.
    expect(fired[0]?.payload.metrics).toMatchObject({
      FAILURE_EXIT_CODE: { kind: "TEXT", value: "1" },
      FAILURE_COMMAND_HEAD: { kind: "TEXT", value: "x" },
    });
  });

  it("U7: a failing test run, a user rejection and an expected exit are not failure clusters", () => {
    for (let index = 0; index < C7_MIN_FAILURES; index++) addBash("BASH_TEST", "TEST_FAIL");
    for (let index = 0; index < C7_MIN_FAILURES; index++) {
      addBash("BASH_GIT", "ERROR", {
        error: "Exit code 1\nthe user said no",
        command: "git diff --quiet",
      });
    }
    for (let index = 0; index < C7_MIN_FAILURES; index++) {
      addBash("BASH_OTHER" as "BASH_NPM", "ERROR", {
        error: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
      });
    }
    expect(c7Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("rcb-2: a failure with no command family (quoted exe path) still clusters as BASH_OTHER", () => {
    const error = "Exit code 1\nnode:internal/modules/cjs/loader:1228\nthrow err;";
    addBash("BASH_OTHER" as "BASH_NPM", "ERROR", { error, command: "node a.js" });
    addBash("BASH_OTHER" as "BASH_NPM", "ERROR", { error, command: "node b.js" });
    addBash(null, "ERROR", { error, command: '"C:\\Program Files\\nodejs\\node.exe" c.js' });
    const fired = c7Detector.evaluate(db, CTX).fired;
    expect(fired).toHaveLength(1);
    expect(fired[0]?.payload.metrics).toMatchObject({
      BASH_COMMAND_FAMILY: { kind: "ENUM", value: "BASH_OTHER" },
      BASH_FAILURE_COUNT: { kind: "COUNT", value: 3 },
    });
  });

  // RC-B (operator 2026-10-14): the emit-time 0.1% floor is gone; the recs view's de-minimis
  // floor routes small clusters to below_floor instead of the detector hiding them.
  it("RC-B: still emits a cluster that costs under 0.1% of the workspace's week", () => {
    // 3 failing turns at 1 u each, in a week where the workspace spent 1,000,000 u.
    for (let index = 0; index < C7_MIN_FAILURES; index++) {
      addBash("BASH_NPM", "ERROR", { costEquivU: 1 });
    }
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain, provisional, parser_version, cost_equiv_u)
       VALUES ('c7-big', 'session-c7', 'ws-c7', '2027-01-03T00:00:00.000Z', 'claude-sonnet', 0, 0, 'test-v1', 1000000)`,
    ).run();
    const outcome = c7Detector.evaluate(db, CTX);
    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.modeled_savings_u_per_wk).toBeLessThan(1000);
  });

  it("emits session_ids and a P-basis estimate equal to modeled_savings_u_per_wk", () => {
    // 3 BASH_GIT failures, each turn has cost_equiv_u = 2000
    for (let index = 0; index < C7_MIN_FAILURES; index++) {
      addBash("BASH_GIT", "ERROR", { costEquivU: 2000 });
    }

    const outcome = c7Detector.evaluate(db, CTX);
    const payload = outcome.fired[0]?.payload;

    expect(payload?.session_ids).toEqual(["session-c7"]);
    // 3 consecutive Bash ERRORs form a D7 loop; D7 owns the 2 repeat-excess turns (claim order
    // D7 excl first), so C7 claims only the first: summedCostU = 2000.
    // wsSpendU = 6000; modeledSavingsU = min(round(2000 × 0.5), 6000) = 1000
    // estimate basis P pass-through: rank_value_u_per_wk = modeled_savings_u_per_wk = 1000
    expect(payload?.estimate?.rank_value_u_per_wk).toBe(outcome.fired[0]?.modeled_savings_u_per_wk);
    expect(payload?.estimate).toMatchObject({
      basis: "P",
      rank_value_u_per_wk: 1000, // round(2000 × 0.5) = 1000
      summable: true,
    });
  });
});
