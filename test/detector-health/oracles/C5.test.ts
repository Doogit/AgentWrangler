import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleC5 } from "./C5.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");

function mkdb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT, exit_class TEXT);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, owner_message_id TEXT, block_index INTEGER DEFAULT 0);
    CREATE TABLE tool_event_content (event_id TEXT PRIMARY KEY, content_json TEXT);
    CREATE TABLE turns (message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT,
      is_sidechain INTEGER DEFAULT 0, provisional INTEGER DEFAULT 0);
  `);
  db.prepare("INSERT INTO sessions VALUES ('s1','RECONCILED')").run();
  return db;
}
let n = 0;
function err(
  db: Database.Database,
  ts: string,
  error: string,
  opts: { tool?: string; command?: string; sidechain?: number } = {},
): void {
  n++;
  const id = `e${n}`;
  const tool = opts.tool ?? "Edit";
  db.prepare("INSERT INTO turns VALUES (?, 's1', 'w1', ?, ?, 0)").run(
    `m${n}`,
    ts,
    opts.sidechain ?? 0,
  );
  db.prepare("INSERT INTO tool_events VALUES (?, 's1', ?, ?, 'ERROR')").run(id, ts, tool);
  db.prepare("INSERT INTO tool_event_metadata (event_id, owner_message_id) VALUES (?, ?)").run(
    id,
    `m${n}`,
  );
  db.prepare("INSERT INTO tool_event_content VALUES (?, ?)").run(
    id,
    JSON.stringify({ error, command: opts.command }),
  );
}

describe("oracleC5", () => {
  it("fires on 3 identical errors on 3 turns within the gap", () => {
    const db = mkdb();
    for (const t of ["00:00:00", "00:00:02", "00:00:04"])
      err(db, `2027-01-02T${t}.000Z`, "  String to replace  not found ");
    const r = oracleC5(db, NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.count).toBe(1);
    expect(r.findings[0]?.quantities.find((q) => q.name === "repeated_errors")?.value).toBe(3);
  });

  it("near miss: 2 errors is silent", () => {
    const db = mkdb();
    for (const t of ["00:00:00", "00:00:02"]) err(db, `2027-01-02T${t}.000Z`, "same error");
    expect(oracleC5(db, NOW).findings).toHaveLength(0);
  });

  it("near miss: a gap over 10 minutes splits the run; exactly 10 minutes does not", () => {
    const split = mkdb();
    for (const t of ["00:00:00", "00:00:01", "00:10:02"])
      err(split, `2027-01-02T${t}.000Z`, "same error");
    expect(oracleC5(split, NOW).findings).toHaveLength(0);
    const edge = mkdb();
    for (const t of ["00:00:00", "00:05:00", "00:15:00"])
      err(edge, `2027-01-02T${t}.000Z`, "same error");
    expect(oracleC5(edge, NOW).findings).toHaveLength(1);
  });

  it("drops benign (test command exit 1) and sidechain errors", () => {
    const db = mkdb();
    for (const t of ["00:00:00", "00:00:02", "00:00:04"])
      err(db, `2027-01-02T${t}.000Z`, "Exit code 1\nFAIL", {
        tool: "Bash",
        command: "npx vitest run",
      });
    for (const t of ["01:00:00", "01:00:02", "01:00:04"])
      err(db, `2027-01-02T${t}.000Z`, "boom", { sidechain: 1 });
    expect(oracleC5(db, NOW).findings).toHaveLength(0);
  });
});
