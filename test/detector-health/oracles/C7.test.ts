import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleC7 } from "./C7.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const D = "2027-01-02T00:00:";

function mkdb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT, input_hash TEXT,
      exit_class TEXT, result_bytes INTEGER, tool_error_class TEXT, bash_command_family TEXT);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, file_path_hash TEXT, owner_message_id TEXT,
      block_index INTEGER);
    CREATE TABLE tool_event_content (event_id TEXT PRIMARY KEY, content_json TEXT);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, is_sidechain INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, cache_write_other INTEGER DEFAULT 0,
      pricing_snapshot_id TEXT, cost_equiv_u REAL, provisional INTEGER DEFAULT 0);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', '[5, 25, 0.5, 6.25, 10]')").run();
  db.prepare("INSERT INTO sessions VALUES ('s1','RECONCILED')").run();
  return db;
}

let n = 0;
function turn(
  db: Database.Database,
  id: string,
  ts: string,
  input: number,
  cost = 1_000_000,
): void {
  db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, input_tokens, pricing_snapshot_id, cost_equiv_u) VALUES (?, 's1','w1',?,?,'p',?)",
  ).run(id, ts, input, cost);
}
function fail(
  db: Database.Database,
  owner: string,
  ts: string,
  command: string,
  error: string,
  fam: string | null = "git",
): void {
  const id = `e${n++}`;
  db.prepare("INSERT INTO tool_events VALUES (?, 's1', ?, 'Bash', NULL, 'ERROR', 10, NULL, ?)").run(
    id,
    ts,
    fam,
  );
  db.prepare("INSERT INTO tool_event_metadata VALUES (?, NULL, ?, 0)").run(id, owner);
  db.prepare("INSERT INTO tool_event_content VALUES (?, ?)").run(
    id,
    JSON.stringify({ command, error }),
  );
}
const ERR = "Exit code 128\nfatal: not a git repository";

function cluster(db: Database.Database, count: number): void {
  turn(db, "t1", `${D}00.000Z`, 1000);
  turn(db, "rec", `${D}30.000Z`, 1_000_000); // 1M input x $5/MTok = 5,000,000 µ$
  for (let i = 0; i < count; i++) fail(db, "t1", `${D}01.000Z`, `git cmd${i}`, ERR);
}

describe("oracleC7", () => {
  it("3 same-signature failures fire; headline = full recovery turn cost (no 0.5)", () => {
    const db = mkdb();
    cluster(db, 3);
    const r = oracleC7(db, NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope.key).toBe("C7|w1");
    expect(r.findings[0]?.count).toBe(3);
    expect(r.findings[0]?.modeled_u).toBeCloseTo(5_000_000, 3);
  });

  it("near miss: 2 failures (C7_MIN_FAILURES = 3) stay silent", () => {
    const db = mkdb();
    cluster(db, 2);
    expect(oracleC7(db, NOW).findings).toHaveLength(0);
  });

  it("benign failures (test run exiting non-zero) do not count", () => {
    const db = mkdb();
    turn(db, "t1", `${D}00.000Z`, 1000);
    turn(db, "rec", `${D}30.000Z`, 1_000_000);
    fail(db, "t1", `${D}01.000Z`, "npx vitest run a", "Exit code 1\nFAIL a");
    fail(db, "t1", `${D}01.000Z`, "npx vitest run b", "Exit code 1\nFAIL a");
    fail(db, "t1", `${D}01.000Z`, "npx vitest run c", "Exit code 1\nFAIL a");
    expect(oracleC7(db, NOW).findings).toHaveLength(0);
  });

  // C7@rcb-2: a quoted exe path gets no family at ingest; the failure still counts.
  it("a failure with no family label still counts", () => {
    const db = mkdb();
    turn(db, "t1", `${D}00.000Z`, 1000);
    turn(db, "rec", `${D}30.000Z`, 1_000_000);
    fail(db, "t1", `${D}01.000Z`, "foo", "Exit code 2\nboom", null);
    fail(db, "t1", `${D}01.000Z`, "foo2", "Exit code 2\nboom", null);
    fail(db, "t1", `${D}01.000Z`, "foo3", "Exit code 2\nboom", null);
    expect(oracleC7(db, NOW).findings[0]?.count).toBe(3);
  });

  it("masks numbers and paths so differing digits share one signature", () => {
    const db = mkdb();
    turn(db, "t1", `${D}00.000Z`, 1000);
    turn(db, "rec", `${D}30.000Z`, 1_000_000);
    fail(db, "t1", `${D}01.000Z`, "a", "Exit code 1\nerror at C:\\x\\y.ts line 12");
    fail(db, "t1", `${D}01.000Z`, "b", "Exit code 1\nerror at /home/z/q.ts line 99");
    fail(db, "t1", `${D}01.000Z`, "c", "Exit code 1\nerror at ./k.ts line 7");
    expect(oracleC7(db, NOW).findings[0]?.count).toBe(3);
  });

  it("a recovery turn outside the window gives a real $0 headline (finding still fires)", () => {
    const db = mkdb();
    turn(db, "t1", "2027-01-07T23:59:00.000Z", 1000);
    turn(db, "rec", "2027-01-08T00:00:30.000Z", 1_000_000); // after now
    for (let i = 0; i < 3; i++) fail(db, "t1", "2027-01-07T23:59:30.000Z", `git c${i}`, ERR);
    const f = oracleC7(db, NOW).findings[0];
    expect(f?.count).toBe(3);
    expect(f?.modeled_u).toBe(0);
  });

  it("D7 pre-exclusion: identical commands over 3 messages remove the later issuing turns", () => {
    const db = mkdb();
    for (let i = 0; i < 3; i++) turn(db, `t${i}`, `${D}0${i}.000Z`, 1000);
    turn(db, "rec", `${D}30.000Z`, 1_000_000);
    for (let i = 0; i < 3; i++) fail(db, `t${i}`, `${D}0${i}.500Z`, "git status", ERR);
    // t1 and t2 are excess; only t0 issues, its recovery turn is t1 (priced 1000 x $5 = 5,000 µ$).
    const f = oracleC7(db, NOW).findings[0];
    expect(f?.count).toBe(3);
    expect(f?.modeled_u).toBeCloseTo(5000, 3);
  });
});
