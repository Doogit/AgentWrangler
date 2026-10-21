import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleH1 } from "./H1.js";

const NOW = new Date("2026-10-14T00:00:00.000Z"); // window [2026-10-07T00:00Z, 2026-10-14T00:00Z)

function seed(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, file_path TEXT NOT NULL);
    CREATE TABLE ingest_metric_events (event_id TEXT PRIMARY KEY, session_id TEXT, event_ts TEXT,
      is_sidechain INTEGER, destructive_op TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT, interrupt_kind TEXT);
    CREATE TABLE tool_event_content (event_id TEXT PRIMARY KEY, content_json TEXT);
  `);
  for (const w of ["A", "B", "C"])
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(
      `s${w}`,
      `ws${w}`,
      `/nonexistent/${w}.jsonl`,
    );
  return db;
}
let n = 0;
const ev = (db: Database.Database, s: string, ts: string, op: string, side = 0): void =>
  void db
    .prepare("INSERT INTO ingest_metric_events VALUES (?,?,?,?,?)")
    .run(`e${n++}`, s, ts, side, op);

describe("oracleH1", () => {
  it("counts ran main-thread destructive ops per workspace x class; drops never-ran and sidechain-only", () => {
    const db = seed();
    // ws A rm-rf: 2 ran (one with no Bash row, one with an OK row), 1 hook-blocked (dropped), 1 sidechain -> count 2, side 1.
    ev(db, "sA", "2026-10-08T00:00:00.000Z", "rm-rf");
    ev(db, "sA", "2026-10-09T00:00:00.000Z", "rm-rf");
    db.prepare(
      `INSERT INTO tool_events VALUES ('t1','sA','2026-10-09T00:00:00.000Z','Bash',NULL)`,
    ).run();
    ev(db, "sA", "2026-10-10T00:00:00.000Z", "rm-rf");
    db.prepare(
      `INSERT INTO tool_events VALUES ('t2','sA','2026-10-10T00:00:00.000Z','Bash',NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO tool_event_content VALUES ('t2', '{"error":"PreToolUse:Bash hook error: blocked"}')`,
    ).run();
    ev(db, "sA", "2026-10-11T00:00:00.000Z", "rm-rf", 1);
    // ws A git-clean: only a human-denied call -> no finding.
    ev(db, "sA", "2026-10-11T00:00:00.000Z", "git-clean");
    db.prepare(
      `INSERT INTO tool_events VALUES ('t3','sA','2026-10-11T00:00:00.000Z','Bash','HUMAN_DENY')`,
    ).run();
    // ws B: only sidechain runs -> no finding. ws C: op just outside the window -> no finding.
    ev(db, "sB", "2026-10-09T00:00:00.000Z", "truncate", 1);
    ev(db, "sC", "2026-10-14T00:00:00.000Z", "sql-drop");

    const r = oracleH1(db, NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope.key).toBe("H1|wsA|rm-rf");
    expect(r.findings[0]?.count).toBe(2);
    expect(r.findings[0]?.quantities.find((q) => q.name === "sidechain_operations")?.value).toBe(1);
  });
});
