import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { e2Detector } from "../../../src/detector/detectors/e2_main_thread_mechanical_runs.js";
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
});

afterEach(() => db.close());

function addSession(workspaceId: string, sessionId: string, state = "RECONCILED"): void {
  db.prepare(
    "INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
  ).run(workspaceId, workspaceId, CTX.fromIso);
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, '[]')`,
  ).run(sessionId, workspaceId, `/fixture/${sessionId}.jsonl`, CTX.fromIso, CTX.toIso, state);
}

interface TurnOptions {
  tools?: string[];
  family?: string;
  model?: string;
  read?: number;
  write?: number;
  output?: number;
  costU?: number;
  sidechain?: number;
  provisional?: number;
}

// Opus 5.5 list, $/MTok = µ$/token, written out here rather than read from src (review: the test
// must not grade the detector against a cost it invented): output 20, cache read 0.2, write 5m 5.
const OPUS_55 = { output: 20, read: 0.2, write5m: 5 };

/** One turn issuing `tools` (none = text only). Turns get strictly increasing timestamps. */
function addTurn(workspaceId: string, sessionId: string, options: TurnOptions = {}): string {
  const suffix = sequence++;
  const messageId = `e2-message-${suffix}`;
  const ts = new Date(Date.parse("2027-01-02T00:00:00.000Z") + suffix * 1_000).toISOString();
  const pricedU =
    (options.read ?? 0) * OPUS_55.read +
    (options.write ?? 0) * OPUS_55.write5m +
    (options.output ?? 100) * OPUS_55.output;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u,
        cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, 0, ?, 'LIST_EQUIV', ?, 'test-v1')`,
  ).run(
    messageId,
    sessionId,
    workspaceId,
    ts,
    options.model ?? "claude-opus-5-5",
    options.sidechain ?? 0,
    options.output ?? 100,
    options.read ?? 0,
    options.write ?? 0,
    options.costU ?? pricedU,
    options.provisional ?? 0,
  );
  (options.tools ?? []).forEach((tool, index) => {
    const eventId = `e2-event-${suffix}-${index}`;
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class, bash_command_family)
       VALUES (?, ?, ?, ?, 'OK', ?)`,
    ).run(eventId, sessionId, ts, tool, tool === "Bash" ? (options.family ?? "BASH_GIT") : null);
    db.prepare(
      "INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command) VALUES (?, NULL, ?, ?, 0)",
    ).run(eventId, messageId, index);
  });
  return messageId;
}

/**
 * An Edit turn at a `context` read, then `n` mechanical Bash turns that each grow the context by
 * 2K (read context + 2K·i, write 2K), output 100, priced at Opus 5.5.
 */
function addRun(
  workspaceId: string,
  sessionId: string,
  n: number,
  tools = ["Bash"],
  context = 400_000,
): void {
  addTurn(workspaceId, sessionId, { tools: ["Edit"], read: context });
  for (let i = 0; i < n; i++) {
    addTurn(workspaceId, sessionId, { tools, read: context + 2_000 * i, write: 2_000 });
  }
}

// A run of 4 at a 400K context. Actual, Opus 5.5: reads (400K+402K+404K+406K) × 0.2 = 322,400;
// writes 4 × 2K × 5 = 40,000; output 400 × 20 = 8,000 → 370,400.
// Sonnet 5 subagent (read 0.2, w5m 2.5, out 10): context 30K, 32K, 34K, 36K → 132,000 × 0.2 =
// 26,400; growth 4 × 2K × 2.5 = 20,000; output 400 × 10 = 4,000; dispatch write 30K × 2.5 =
// 75,000 → 125,400. Plus the main-model handoff turn, priced as the first run turn: 92,000.
const RUN4_ACTUAL = 370_400;
const RUN4_SUBAGENT = 125_400 + 92_000;

describe("E2 MAIN_THREAD_MECHANICAL_RUNS", () => {
  it("fires once per workspace with run cost, subagent cost and the saving", () => {
    addSession("ws-e2", "ws-e2-a");
    addRun("ws-e2", "ws-e2-a", 4);

    const outcome = e2Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, e2Detector);

    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    const finding = outcome.fired[0];
    expect(finding?.scopeKey).toBe("E2|ws-e2");
    expect(finding?.payload.metrics).toEqual({
      RUNS: { kind: "COUNT", value: 1 },
      RUN_TURNS: { kind: "COUNT", value: 4 },
      RUN_SESSIONS: { kind: "COUNT", value: 1 },
      RUN_COST_U: { kind: "NUMBER", value: RUN4_ACTUAL },
      SUBAGENT_COST_U: { kind: "NUMBER", value: RUN4_SUBAGENT },
      SAVING_U: { kind: "NUMBER", value: RUN4_ACTUAL - RUN4_SUBAGENT },
    });
    expect(finding?.payload).toMatchObject({
      version: 2,
      rule_id: "E2_MAIN_THREAD_MECHANICAL_RUNS",
      assessment: { posture: "REVIEW" },
      session_ids: ["ws-e2-a"],
    });
    expect(finding?.payload.anchors.map((anchor) => anchor.session_id)).toEqual([
      findingIds.session("ws-e2-a"),
    ]);
    // Assumed realizable fraction 0.5; non-summable (E1 and the carry cards price the same turns).
    const rank = (RUN4_ACTUAL - RUN4_SUBAGENT) * 0.5;
    expect(finding?.payload.estimate).toMatchObject({
      basis: "E",
      rank_value_u_per_wk: rank,
      summable: false,
    });
    expect(finding?.modeled_savings_u_per_wk).toBe(rank);
  });

  it("stays silent when the handoff turn eats the saving (Opus 5.5 at a 100K context)", () => {
    // Actual 32,000 + 32,400 + 32,800 + 33,200 = 130,400; subagent 125,400 + handoff 32,000 = 157,400: no saving.
    addSession("ws-e2", "ws-e2-a");
    addRun("ws-e2", "ws-e2-a", 4, ["Bash"], 100_000);

    expect(e2Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("needs three mechanical turns in a row", () => {
    addSession("ws-e2", "ws-e2-a");
    addRun("ws-e2", "ws-e2-a", 2);
    addRun("ws-e2", "ws-e2-a", 2);

    expect(e2Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("a text-only strong turn and sidechain or provisional turns do not break a run", () => {
    addSession("ws-e2", "ws-e2-a");
    addTurn("ws-e2", "ws-e2-a", { tools: ["Edit"], read: 400_000 });
    addTurn("ws-e2", "ws-e2-a", { tools: ["Read"], read: 400_000, write: 2_000 });
    addTurn("ws-e2", "ws-e2-a", { read: 402_000 });
    addTurn("ws-e2", "ws-e2-a", { tools: ["Edit"], sidechain: 1, model: "claude-sonnet-5" });
    addTurn("ws-e2", "ws-e2-a", { tools: ["Edit"], provisional: 1 });
    addTurn("ws-e2", "ws-e2-a", { tools: ["Grep"], read: 402_000, write: 2_000 });
    addTurn("ws-e2", "ws-e2-a", { tools: ["Glob", "Bash"], read: 404_000, write: 2_000 });

    const metrics = e2Detector.evaluate(db, CTX).fired[0]?.payload.metrics;
    // The text-only turn is neither counted nor a break; its context still counts as growth seen.
    expect(metrics).toMatchObject({
      RUNS: { kind: "COUNT", value: 1 },
      RUN_TURNS: { kind: "COUNT", value: 3 },
      // Read 400K, Grep 402K, Glob+Bash 404K, each writing 2K and printing 100: 277,200.
      RUN_COST_U: { kind: "NUMBER", value: 277_200 },
    });
  });

  it("an edit, a non-strong main turn, a long output or a mixed call breaks a run", () => {
    addSession("ws-e2", "ws-e2-a");
    const breaks: TurnOptions[] = [
      { tools: ["Edit"] },
      { tools: ["Bash"], model: "claude-sonnet-5" },
      { tools: ["Bash"], output: 300 },
      { tools: ["Bash", "Edit"] },
    ];
    for (const breaker of breaks) {
      addTurn("ws-e2", "ws-e2-a", { tools: ["Bash"] });
      addTurn("ws-e2", "ws-e2-a", { tools: ["Bash"] });
      addTurn("ws-e2", "ws-e2-a", breaker);
    }

    expect(e2Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("ignores LIVE sessions and stays silent under 1% of the workspace's window spend", () => {
    addSession("ws-e2", "ws-e2-live", "LIVE");
    addRun("ws-e2", "ws-e2-live", 6);
    expect(e2Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });

    addSession("ws-e2", "ws-e2-a");
    addRun("ws-e2", "ws-e2-a", 4);
    // Saving 153,000 µ$ against 153,000 / 1% = 15.3M: a big session pushes spend past it.
    addSession("ws-e2", "ws-e2-big");
    addTurn("ws-e2", "ws-e2-big", { tools: ["Edit"], costU: 16_000_000 });
    expect(e2Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });
});
