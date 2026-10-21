import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkFriction, countC5, countD11, runCli } from "./friction-oracle.js";

const from = "2026-09-01T00:00:00.000Z";
const to = "2026-09-08T00:00:00.000Z";
let dir: string;
let db: Database.Database;
let dbPath: string;

function event(
  session: string,
  tool: string,
  exit: string | null,
  index: number,
  options: { text?: string; className?: string; version?: string; owner?: string } = {},
) {
  const eventId = `${session}-${tool}-${index}`;
  db.prepare("INSERT INTO tool_events VALUES (?,?,?,?,?,?,?)").run(
    eventId,
    session,
    from,
    tool,
    exit,
    options.className ?? null,
    options.version ?? null,
  );
  if (options.owner) {
    db.prepare("INSERT INTO tool_event_metadata VALUES (?,?)").run(eventId, options.owner);
    if (options.text !== undefined)
      db.prepare("INSERT INTO tool_event_content VALUES (?,?)").run(
        eventId,
        JSON.stringify({ error: options.text }),
      );
  }
}
function finding(detector: "D11" | "C5", evidence: object, workspace = "w1") {
  db.prepare("INSERT INTO recommendations VALUES (?,?,?,?,?)").run(
    detector,
    workspace,
    JSON.stringify(evidence),
    detector === "D11" ? "V1_VALIDATED" : "V2_VALIDATED",
    "RULE",
  );
}
function seed() {
  db.prepare(
    "INSERT INTO sessions VALUES ('s1','w1','RECONCILED'),('s2','w2','RECONCILED'),('live','w1','LIVE')",
  ).run();
  db.prepare("INSERT INTO turns VALUES ('t1','s1',0,0),('side','s1',1,0),('prov','s1',0,1)").run();
  db.prepare("INSERT INTO detector_week_marks VALUES (?,?,?)").run(from, to, "C5,D11@workspace-v2");
  for (let i = 0; i < 50; i++) {
    event("s1", "Bash", i < 5 ? "ERROR" : null, i);
    event("s1", "PowerShell", i < 2 ? "ERROR" : null, i);
    event("s2", "Bash", "ERROR", i);
    event("live", "Bash", "ERROR", i);
  }
  event("s1", "Read", "ERROR", 100, {
    text: "  Secret VALUE\n Failed ",
    className: "CLASS_A",
    version: "tool-error-1",
    owner: "t1",
  });
  event("s1", "Read", "ERROR", 101, {
    text: "secret  value failed",
    className: "CLASS_B",
    version: "tool-error-1",
    owner: "t1",
  });
  event("s1", "Read", "ERROR", 102, {
    text: "SECRET VALUE FAILED",
    className: "CLASS_A",
    version: "tool-error-1",
    owner: "t1",
  });
  event("s1", "Read", "ERROR", 103, {
    className: "FALLBACK",
    version: "tool-error-1",
    owner: "t1",
  });
  event("s1", "Read", "ERROR", 104, {
    className: "FALLBACK",
    version: "tool-error-1",
    owner: "t1",
  });
  event("s1", "Read", "ERROR", 105, {
    className: "FALLBACK",
    version: "tool-error-1",
    owner: "t1",
  });
  event("s1", "Read", "ERROR", 106, {
    text: "ignored",
    className: "OTHER",
    version: "tool-error-1",
    owner: "side",
  });
  event("s1", "Read", "ERROR", 107, {
    text: "ignored",
    className: "OTHER",
    version: "tool-error-1",
    owner: "prov",
  });
  event("s1", "Read", "ERROR", 108, {
    text: "ignored",
    className: "OTHER",
    version: "old",
    owner: "t1",
  });
  finding("D11", {
    facts: {
      last_seen_week_start: from,
      bash_call_count: 50,
      bash_error_count: 5,
      powershell_call_count: 50,
      powershell_error_count: 2,
      bash_error_ratio: 0.1,
      powershell_error_ratio: 0.04,
      preferred_tool: "PowerShell",
      higher_error_tool: "Bash",
    },
  });
  finding("C5", {
    window: { from, to },
    recency: { last_seen_week_start: from },
    session_ids: ["s1"],
    metrics: {
      ERROR_LOOP_COUNT: { value: 2 },
      REPEATED_ERROR_COUNT: { value: 6 },
      LOOP_EXCESS_ERROR_COUNT: { value: 2 },
      AFFECTED_TOOL_COUNT: { value: 1 },
      AFFECTED_ERROR_CLASS_COUNT: { value: 3 },
    },
  });
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "friction-oracle-"));
  dbPath = path.join(dir, "fixture.sqlite");
  db = new Database(dbPath);
  db.exec(`CREATE TABLE sessions(session_id TEXT,workspace_id TEXT,state TEXT);
    CREATE TABLE turns(message_id TEXT,session_id TEXT,is_sidechain INTEGER,provisional INTEGER);
    CREATE TABLE tool_events(event_id TEXT,session_id TEXT,ts TEXT,tool_name TEXT,exit_class TEXT,
      tool_error_class TEXT,tool_error_classifier_version TEXT);
    CREATE TABLE tool_event_metadata(event_id TEXT,owner_message_id TEXT);
    CREATE TABLE tool_event_content(event_id TEXT,content_json TEXT);
    CREATE TABLE detector_week_marks(week_start TEXT,week_end TEXT,detector_ids TEXT);
    CREATE TABLE recommendations(detector_id TEXT,scope_workspace_id TEXT,evidence_json TEXT,
      contract_status TEXT,provenance TEXT);`);
  seed();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("friction count oracle", () => {
  it("matches independent reconciled counts, direction, and normalized C5 groups", () => {
    expect(countD11(db, { from, to })).toMatchObject([
      { workspace: "w1", bashCalls: 50, bashErrors: 5 },
    ]);
    expect(countC5(db, { from, to })).toMatchObject([
      { workspace: "w1", session: "s1", loops: 2, repeated: 6, excess: 2, tools: 1, classes: 3 },
    ]);
    expect(checkFriction(db).status).toBe("PASS");
    expect(JSON.stringify(checkFriction(db))).not.toContain("Secret VALUE");
  });
  it("fails on a count mismatch", () => {
    db.prepare(
      "UPDATE recommendations SET evidence_json=json_set(evidence_json,'$.facts.bash_error_count',4) WHERE detector_id='D11'",
    ).run();
    expect(checkFriction(db)).toMatchObject({
      status: "FAIL",
      issues: [{ code: "FACT_COUNT_MISMATCH" }],
    });
  });
  it("fails when C5 loop facts disagree with normalized groups", () => {
    db.prepare(
      "UPDATE recommendations SET evidence_json=json_set(evidence_json,'$.metrics.AFFECTED_ERROR_CLASS_COUNT.value',2) WHERE detector_id='C5'",
    ).run();
    expect(checkFriction(db).issues).toContainEqual(
      expect.objectContaining({
        detector: "C5",
        status: "FAIL",
        code: "FACT_COUNT_MISMATCH",
      }),
    );
  });
  it("detects an omitted workspace finding within the evaluated window", () => {
    for (let i = 0; i < 50; i++) event("s2", "PowerShell", null, i);
    const report = checkFriction(db);
    expect(report.status).toBe("UNPROVEN");
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        detector: "D11",
        code: "EXPECTED_FINDING_MISSING",
      }),
    );
  });
  it("checks the latest marked cohort even when only older valid findings exist", () => {
    const nextFrom = "2026-09-08T00:00:00.000Z";
    const nextTo = "2026-09-15T00:00:00.000Z";
    db.prepare("INSERT INTO detector_week_marks VALUES (?,?,?)").run(
      nextFrom,
      nextTo,
      "C5,D11@workspace-v2",
    );
    db.prepare("INSERT INTO sessions VALUES ('s3','w2','RECONCILED')").run();
    db.prepare("INSERT INTO turns VALUES ('t3','s3',0,0)").run();
    for (let i = 1000; i < 1050; i++) {
      event("s2", "Bash", "ERROR", i);
      event("s2", "PowerShell", null, i);
      db.prepare("UPDATE tool_events SET ts=? WHERE event_id IN (?,?)").run(
        nextFrom,
        `s2-Bash-${i}`,
        `s2-PowerShell-${i}`,
      );
    }
    for (let i = 0; i < 3; i++) {
      event("s3", "Read", "ERROR", i, {
        text: " latest error ",
        className: "LATE",
        version: "tool-error-1",
        owner: "t3",
      });
      db.prepare("UPDATE tool_events SET ts=? WHERE event_id=?").run(nextFrom, `s3-Read-${i}`);
    }
    const report = checkFriction(db);
    expect(report.status).toBe("UNPROVEN");
    expect(report.checked).toEqual({ D11: 0, C5: 0 });
    expect(report.historicalChecked).toEqual({ D11: 1, C5: 1 });
    expect(
      report.issues
        .filter((i) => i.code === "EXPECTED_FINDING_MISSING")
        .map((i) => i.detector)
        .sort(),
    ).toEqual(["C5", "D11"]);
  });
  it("reports retired global D11 evidence separately from current certification", () => {
    db.prepare("INSERT INTO recommendations VALUES ('D11',NULL,?,'V1_VALIDATED','RULE')").run(
      JSON.stringify({ facts: { last_seen_week_start: "2026-08-01T00:00:00.000Z" } }),
    );
    const report = checkFriction(db);
    expect(report.status).toBe("PASS");
    expect(report.historicalIssues).toContainEqual(
      expect.objectContaining({
        detector: "D11",
        code: "WINDOW_OR_MARK_MISSING",
      }),
    );
  });
  it("handles a zero lower shell rate and null exit classes", () => {
    db.prepare(
      "UPDATE tool_events SET exit_class=NULL WHERE session_id='s1' AND tool_name='PowerShell'",
    ).run();
    const counts = countD11(db, { from, to });
    expect(counts).toMatchObject([{ psErrors: 0, preferred: "PowerShell", higher: "Bash" }]);
  });
  it("keeps missing marks and missing detector evidence unproven", () => {
    db.prepare("DELETE FROM detector_week_marks").run();
    expect(checkFriction(db).status).toBe("UNPROVEN");
    db.prepare("DELETE FROM recommendations").run();
    expect(checkFriction(db).status).toBe("UNPROVEN");
  });
  it("uses persisted windows, not current time", () => {
    db.prepare("UPDATE detector_week_marks SET week_end='2026-09-09T00:00:00.000Z'").run();
    expect(checkFriction(db).status).toBe("UNPROVEN");
  });
  it("returns CLI status codes and never prints raw content", () => {
    const messages: string[] = [];
    const original = console.log;
    console.log = (value: unknown) => {
      messages.push(String(value));
    };
    try {
      expect(runCli(["--db", dbPath])).toBe(0);
      db.prepare("DELETE FROM recommendations WHERE detector_id='C5'").run();
      expect(runCli(["--db", dbPath])).toBe(3);
      db.prepare(
        "UPDATE recommendations SET evidence_json=json_set(evidence_json,'$.facts.bash_error_count',4)",
      ).run();
      expect(runCli(["--db", dbPath])).toBe(1);
      expect(runCli([])).toBe(2);
      expect(messages.join(" ")).not.toContain("Secret VALUE");
    } finally {
      console.log = original;
    }
  });
});
