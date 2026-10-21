import { afterEach, describe, expect, it } from "vitest";
import { buildClaimLedger } from "../../src/detector/claim-ledger.js";
import { wastedTurnCensus } from "../../src/detector/turn-claim.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const ctx: DetectorContext = {
  now: new Date("2026-01-02T00:00:00.000Z"),
  fromIso: "2026-01-01T00:00:00.000Z",
  toIso: "2026-01-02T00:00:00.000Z",
};

type Db = ReturnType<typeof createInMemoryFixtureDb>;

// Sidechain failure pricing: a subagent failure is priced at the next turn of the SAME subagent.
// Fixture session sess-a1 (main turns msg-a1-1..3, 00:00 / 00:10 / 00:20).
describe("sidechain failure pricing", () => {
  const dbs: Db[] = [];
  const fixture = (): Db => {
    const db = createInMemoryFixtureDb();
    dbs.push(db);
    return db;
  };
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  const addTurn = (
    db: Db,
    id: string,
    at: string,
    side: number,
    agent: string | null,
    tokensIn = 11,
  ) =>
    db
      .prepare(
        `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id,
           input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
           cache_write_other, pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
         VALUES (?, 'sess-a1', 'ws-alpha', ?, 'claude-sonnet', ?, ?, ?, 7, 0, 0, 0, 0,
           'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
      )
      .run(id, at, side, agent, tokensIn);

  let seq = 0;
  function fail(db: Db, owner: string, at: string, tool = "Edit", errClass = "NOT_READ") {
    const id = `sf-${seq++}`;
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class,
         tool_error_class, tool_error_classifier_version)
       VALUES (?, 'sess-a1', ?, ?, 'ERROR', ?, 'tool-error-1')`,
    ).run(id, at, tool, errClass);
    db.prepare(
      "INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command) VALUES (?, ?, 0, 0)",
    ).run(id, owner);
    return id;
  }
  const c3 = (db: Db) =>
    buildClaimLedger(db, ctx).claims.filter((claim) => claim.detectorId === "C3");
  const turnKeys = (db: Db) => new Set(c3(db).map((claim) => claim.turnKey));

  it("census: the sidechain pass claims a subagent turn, the main pass does not", () => {
    const db = fixture();
    addTurn(db, "sa-1", "2026-01-01T01:00:00.000Z", 1, "agent-A");
    fail(db, "sa-1", "2026-01-01T01:00:30.000Z");
    expect(wastedTurnCensus(db, ctx).claims.get("C3")?.has("sess-a1|sa-1")).toBe(false);
    expect(wastedTurnCensus(db, ctx, "main").claims.get("C3")?.has("sess-a1|sa-1")).toBe(false);
    expect(wastedTurnCensus(db, ctx, "sidechain").claims.get("C3")?.has("sess-a1|sa-1")).toBe(true);
  });

  it("census: C9 and D14 stay empty on the sidechain pass", () => {
    const db = fixture();
    const census = wastedTurnCensus(db, ctx, "sidechain");
    expect(census.claims.get("C9")?.size ?? 0).toBe(0);
    expect(census.claims.get("D14")?.size ?? 0).toBe(0);
  });

  it("census: sidechain rows without agent_id are not a chain", () => {
    const db = fixture();
    addTurn(db, "sa-null", "2026-01-01T01:00:00.000Z", 1, null);
    fail(db, "sa-null", "2026-01-01T01:00:30.000Z");
    expect(wastedTurnCensus(db, ctx, "sidechain").claims.get("C3")?.size ?? 0).toBe(0);
  });

  it("prices the failure at the next turn of the same subagent", () => {
    const db = fixture();
    addTurn(db, "sa-1", "2026-01-01T01:00:00.000Z", 1, "agent-A");
    // Another subagent and the main chain have turns in between: R must not land on them.
    addTurn(db, "sb-1", "2026-01-01T01:01:00.000Z", 1, "agent-B", 33);
    addTurn(db, "main-x", "2026-01-01T01:02:00.000Z", 0, null, 44);
    addTurn(db, "sa-2", "2026-01-01T01:03:00.000Z", 1, "agent-A", 22);
    fail(db, "sa-1", "2026-01-01T01:00:30.000Z");
    const claims = c3(db);
    expect(new Set(claims.map((claim) => claim.turnKey))).toEqual(new Set(["sess-a1|sa-2"]));
    expect(claims.find((claim) => claim.component === "input")?.tokens).toBe(22);
    expect(
      claims.every(
        (claim) =>
          claim.lane === "reliability" && claim.slice === "turn:*" && claim.assumed === true,
      ),
    ).toBe(true);
  });

  it("tags subagent recovery claims sidechain and leaves main-chain ones untagged", () => {
    const db = fixture();
    addTurn(db, "sa-1", "2026-01-01T01:00:00.000Z", 1, "agent-A");
    addTurn(db, "sa-2", "2026-01-01T01:03:00.000Z", 1, "agent-A", 22);
    addTurn(db, "m-1", "2026-01-01T02:00:00.000Z", 0, null);
    addTurn(db, "m-2", "2026-01-01T02:03:00.000Z", 0, null, 55);
    fail(db, "sa-1", "2026-01-01T01:00:30.000Z");
    fail(db, "m-1", "2026-01-01T02:00:30.000Z");
    const byTurn = new Map(c3(db).map((claim) => [claim.turnKey, claim.sidechain]));
    expect(byTurn.get("sess-a1|sa-2")).toBe(true);
    expect(byTurn.has("sess-a1|m-2")).toBe(true);
    expect(byTurn.get("sess-a1|m-2")).toBeUndefined();
  });

  it("claims nothing when the subagent ended on the failure", () => {
    const db = fixture();
    addTurn(db, "sa-1", "2026-01-01T01:00:00.000Z", 1, "agent-A");
    addTurn(db, "sb-1", "2026-01-01T01:05:00.000Z", 1, "agent-B");
    fail(db, "sa-1", "2026-01-01T01:00:30.000Z");
    expect(c3(db)).toEqual([]);
  });

  it("prices two failures of one subagent turn as one recovery claim", () => {
    const db = fixture();
    addTurn(db, "sa-1", "2026-01-01T01:00:00.000Z", 1, "agent-A");
    addTurn(db, "sa-2", "2026-01-01T01:03:00.000Z", 1, "agent-A");
    fail(db, "sa-1", "2026-01-01T01:00:30.000Z");
    fail(db, "sa-1", "2026-01-01T01:00:40.000Z");
    const claims = c3(db);
    expect(claims.filter((claim) => claim.component === "input")).toHaveLength(1);
  });

  it("C7 counts failures per subagent, not per session", () => {
    const db = fixture();
    const bash = (owner: string, at: string) => {
      const id = `bf-${seq++}`;
      db.prepare(
        `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class, bash_command_family)
         VALUES (?, 'sess-a1', ?, 'Bash', 'ERROR', 'BASH_NPM')`,
      ).run(id, at);
      db.prepare(
        "INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command) VALUES (?, ?, 0, 0)",
      ).run(id, owner);
      db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
        id,
        JSON.stringify({ error: "Exit code 1\nboom" }),
      );
      // A success between failures keeps D7's loop matcher from excluding the cluster.
      db.prepare(
        `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class, input_hash)
         VALUES (?, 'sess-a1', ?, 'Read', 'OK', ?)`,
      ).run(`ok-${id}`, at.replace(":30.", ":45."), `h-${id}`);
      db.prepare(
        "INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command) VALUES (?, ?, 1, 0)",
      ).run(`ok-${id}`, owner);
    };
    for (const [id, agent, at] of [
      ["a1", "agent-A", "01:00"],
      ["a2", "agent-A", "01:10"],
      ["a3", "agent-A", "01:20"],
      ["a4", "agent-A", "01:30"],
      ["b1", "agent-B", "02:00"],
      ["b2", "agent-B", "02:10"],
    ] as const) {
      addTurn(db, id, `2026-01-01T${at}:00.000Z`, 1, agent);
    }
    // agent-A has three failures (a cluster); agent-B has two (no cluster), though 5 share the session.
    bash("a1", "2026-01-01T01:00:30.000Z");
    bash("a2", "2026-01-01T01:10:30.000Z");
    bash("a3", "2026-01-01T01:20:30.000Z");
    bash("b1", "2026-01-01T02:00:30.000Z");
    bash("b2", "2026-01-01T02:10:30.000Z");
    const c7 = wastedTurnCensus(db, ctx, "sidechain").claims.get("C7") ?? new Set();
    expect([...c7].sort()).toEqual(["sess-a1|a1", "sess-a1|a2", "sess-a1|a3"]);
  });
});
