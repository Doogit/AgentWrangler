import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleC2 } from "./C2.js";

const NOW = new Date("2026-10-14T00:00:00.000Z"); // window [2026-10-07T00:00Z, 2026-10-14T00:00Z)

let n = 0;
function seed(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, file_path TEXT NOT NULL, state TEXT);
    CREATE TABLE turns (message_id TEXT PRIMARY KEY, session_id TEXT, is_sidechain INTEGER, agent_id TEXT, provisional INTEGER,
      ts TEXT, pricing_snapshot_id TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0);
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT,
      tool_error_class TEXT, tool_error_classifier_version TEXT);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, owner_message_id TEXT);
  `);
  db.prepare("INSERT INTO sessions VALUES ('sA','wsA','/nonexistent/a.jsonl','RECONCILED')").run();
  db.prepare("INSERT INTO sessions VALUES ('sL','wsL','/nonexistent/l.jsonl','LIVE')").run();
  const turn = (id: string, s: string, side: number, agent: string | null, prov: number): void => {
    db.prepare(
      "INSERT INTO turns (message_id, session_id, is_sidechain, agent_id, provisional) VALUES (?,?,?,?,?)",
    ).run(id, s, side, agent, prov);
  };
  turn("main", "sA", 0, null, 0);
  turn("subKnown", "sA", 1, "ag1", 0);
  turn("subUnknown", "sA", 1, null, 0);
  turn("prov", "sA", 0, null, 1);
  turn("liveTurn", "sL", 0, null, 0);
  return db;
}
function ev(
  db: Database.Database,
  s: string,
  owner: string,
  ts: string,
  tool = "Read",
  cls: string | null = "NOT_FOUND",
  ver: string | null = "tool-error-1",
): void {
  const id = `e${n++}`;
  db.prepare("INSERT INTO tool_events VALUES (?,?,?,?,?,?)").run(id, s, ts, tool, cls, ver);
  db.prepare("INSERT INTO tool_event_metadata VALUES (?,?)").run(id, owner);
}

describe("oracleC2", () => {
  it("counts NOT_FOUND Read/Grep/Glob calls on eligible turns in the window", () => {
    const db = seed();
    ev(db, "sA", "main", "2026-10-07T00:00:00.000Z", "Read"); // inclusive lower bound
    ev(db, "sA", "main", "2026-10-09T00:00:00.000Z", "Grep");
    ev(db, "sA", "main", "2026-10-10T00:00:00.000Z", "Glob");
    ev(db, "sA", "subKnown", "2026-10-11T00:00:00.000Z", "Read"); // subagent with agent id
    // Out of scope:
    ev(db, "sA", "main", "2026-10-14T00:00:00.000Z", "Read"); // exclusive upper bound
    ev(db, "sA", "main", "2026-10-06T23:59:59.000Z", "Read"); // before window
    ev(db, "sA", "subUnknown", "2026-10-11T00:00:00.000Z", "Read"); // sidechain, no agent id
    ev(db, "sA", "prov", "2026-10-11T00:00:00.000Z", "Read"); // provisional turn
    ev(db, "sL", "liveTurn", "2026-10-11T00:00:00.000Z", "Read"); // LIVE session
    ev(db, "sA", "main", "2026-10-11T00:00:00.000Z", "Read", "ERROR"); // other class
    ev(db, "sA", "main", "2026-10-11T00:00:00.000Z", "Read", "NOT_FOUND", "tool-error-0"); // other version
    const r = oracleC2(db, NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope.workspace_id).toBe("wsA");
    expect(r.findings[0]?.count).toBe(4);
    expect(r.findings[0]?.quantities.find((q) => q.name === "session_count")?.value).toBe(1);
  });

  it("near miss: same NOT_FOUND errors on a tool outside Read/Grep/Glob stay silent", () => {
    const db = seed();
    for (let i = 0; i < 4; i++) ev(db, "sA", "main", `2026-10-1${i}T00:00:00.000Z`, "Bash");
    expect(oracleC2(db, NOW).findings).toHaveLength(0);
  });

  // Reliability headline: full snapshot-priced cost of the recovery turn, main chain only.
  function rel(): Database.Database {
    const db = seed();
    db.prepare("INSERT INTO pricing_snapshots VALUES ('p1','[3,15,0.3,3.75,6]')").run();
    const t = (
      id: string,
      side: number,
      agent: string | null,
      ts: string,
      prov = 0,
      snap: string | null = "p1",
    ): void => {
      db.prepare("INSERT INTO turns VALUES (?,?,?,?,?,?,?,1000000,100000,2000000,10000,20000)").run(
        id,
        "sA",
        side,
        agent,
        prov,
        ts,
        snap,
      );
    };
    t("m1", 0, null, "2026-10-08T00:00:00.000Z"); // issuing (rows "main" has no ts; use own turns below)
    t("m2", 0, null, "2026-10-08T01:00:00.000Z"); // recovery for m1
    t("s1", 1, "ag1", "2026-10-08T02:00:00.000Z"); // issuing sub
    t("s2", 1, "ag1", "2026-10-08T03:00:00.000Z"); // recovery for s1
    return db;
  }
  // 3*1 + 15*0.1 + 0.3*2 + 3.75*0.01 + 6*0.02 = 3 + 1.5 + 0.6 + 0.0375 + 0.12 = 5.2575 $ => 5,257,500 u
  const FULL = 5_257_500;

  it("reliability: headline is the full recovery-turn cost (main), subagent shown apart", () => {
    const db = rel();
    ev(db, "sA", "m1", "2026-10-08T00:00:00.000Z");
    ev(db, "sA", "s1", "2026-10-08T02:00:00.000Z");
    const f = oracleC2(db, NOW).findings[0];
    expect(f?.count).toBe(2);
    expect(f?.modeled_u).toBe(FULL);
    expect(f?.quantities.find((q) => q.name === "subagent_reliability_u")?.value).toBe(FULL);
  });

  it("reliability: two issuing turns sharing one recovery turn price it once", () => {
    const db = rel();
    db.prepare(
      "INSERT INTO turns VALUES ('m0','sA',0,NULL,0,'2026-10-07T23:00:00.000Z',NULL,0,0,0,0,0)",
    ).run();
    ev(db, "sA", "m0", "2026-10-07T23:00:00.000Z");
    ev(db, "sA", "m1", "2026-10-08T00:00:00.000Z");
    // m0's recovery is m1 (priced), m1's recovery is m2 (priced)
    expect(oracleC2(db, NOW).findings[0]?.modeled_u).toBe(2 * FULL);
  });

  it("reliability near miss: recovery turn outside the window, provisional, or unpriced adds 0", () => {
    const db = rel();
    db.prepare(
      "INSERT INTO turns VALUES ('late','sA',0,NULL,0,'2026-10-14T00:00:00.000Z','p1',1000000,0,0,0,0)",
    ).run();
    ev(db, "sA", "late", "2026-10-13T00:00:00.000Z"); // wait: issuing 'late' has ts at upper bound; recovery none
    db.prepare("UPDATE turns SET provisional = 1 WHERE message_id = 'm2'").run();
    ev(db, "sA", "m1", "2026-10-08T00:00:00.000Z"); // m2 provisional, no later main turn: no claim
    const f = oracleC2(db, NOW).findings[0];
    expect(f?.count).toBe(2);
    expect(f?.modeled_u).toBe(0); // a real zero, finding still present
  });

  it("a single call fires (no minimum count)", () => {
    const db = seed();
    ev(db, "sA", "main", "2026-10-09T00:00:00.000Z", "Glob");
    expect(oracleC2(db, NOW).findings[0]?.count).toBe(1);
  });
});
