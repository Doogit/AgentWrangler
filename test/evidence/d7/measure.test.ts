import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { measureD7ForwardCoverage } from "../../../src/evidence/d7/measure.js";

const AS_OF = "2026-08-27T00:00:00.000Z";
const COMMIT = "a".repeat(40);
let db: Database.Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function open(looseStructuralKeys = false): Database.Database {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE sessions(session_id TEXT PRIMARY KEY, workspace_id TEXT, state TEXT);
    CREATE TABLE tool_events(event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, input_hash TEXT, exit_class TEXT);
    CREATE TABLE tool_event_metadata(event_id TEXT${looseStructuralKeys ? "" : " PRIMARY KEY"}, file_path_hash TEXT, owner_message_id TEXT);
    CREATE TABLE turns(message_id TEXT${looseStructuralKeys ? "" : " PRIMARY KEY"}, session_id TEXT, workspace_id TEXT, ts TEXT, provisional INTEGER);`);
  return db;
}
function insert(
  index: number,
  options: {
    metadata?: boolean;
    owner?: boolean;
    signal?: boolean;
    state?: string;
    provisional?: number;
    ownerTs?: string;
    eventTs?: string;
    workspace?: string;
    ownerWorkspace?: string;
    ownerSession?: string;
  } = {},
): void {
  const database = db ?? open();
  const session = `s-${index}`;
  const workspace = options.workspace ?? "ws-a";
  const event = `e-${index}`;
  const owner = `m-${index}`;
  database
    .prepare("INSERT INTO sessions VALUES (?, ?, ?)")
    .run(session, workspace, options.state ?? "RECONCILED");
  database
    .prepare("INSERT INTO tool_events VALUES (?, ?, ?, ?, ?)")
    .run(
      event,
      session,
      options.eventTs ?? "2026-08-20T00:00:00.000Z",
      options.signal === false ? null : "hash",
      null,
    );
  if (options.metadata !== false)
    database
      .prepare("INSERT INTO tool_event_metadata VALUES (?, ?, ?)")
      .run(event, null, options.owner === false ? null : owner);
  if (options.owner !== false)
    database
      .prepare("INSERT INTO turns VALUES (?, ?, ?, ?, ?)")
      .run(
        owner,
        options.ownerSession ?? session,
        options.ownerWorkspace ?? workspace,
        options.ownerTs ?? "2026-08-20T00:00:00.000Z",
        options.provisional ?? 0,
      );
}
function measure() {
  return measureD7ForwardCoverage({
    db: db ?? open(),
    repositories: [
      { workspaceId: "ws-a", owner: "private", repo: "private", reportAlias: "repo-001" },
    ],
    scratchDbSha256: "b".repeat(64),
    repoMapSha256: "c".repeat(64),
    sourceCommit: COMMIT,
    asOf: AS_OF,
    windowDays: 30,
  });
}

describe("D7 forward coverage", () => {
  it("marks a zero denominator insufficient with literal-zero privacy", () => {
    const report = measure();
    expect(report.status).toBe("DATA_INSUFFICIENT");
    expect(report.covered.eventCoverage).toBeNull();
    expect(report.privacy).toEqual({
      sessionIdN: 0,
      workspaceIdN: 0,
      eventIdN: 0,
      hashN: 0,
      pathN: 0,
      transcriptN: 0,
    });
  });
  it("is sufficient at twenty fully covered sessions and has deterministic cohorts", () => {
    open();
    for (let i = 0; i < 20; i += 1) insert(i);
    const report = measure();
    expect(report.status).toBe("SUFFICIENT");
    expect(report.covered).toMatchObject({
      sessionsN: 20,
      eventsN: 20,
      sessionCoverage: 1,
      eventCoverage: 1,
    });
    expect(report.byUtcDay.map((row) => row.cohort)).toEqual(["2026-08-20"]);
    expect(report.byWorkspaceAlias.map((row) => row.cohort)).toEqual(["repo-001"]);
  });
  it("uses exact 0.8 thresholds and classifies missing coverage", () => {
    open();
    for (let i = 0; i < 20; i += 1) insert(i, i < 4 ? { metadata: false } : {});
    const report = measure();
    expect(report.status).toBe("SUFFICIENT");
    expect(report.covered.eventCoverage).toBe(0.8);
    expect(report.exclusions.missingMetadataN).toBe(4);
  });
  it("counts missing owners and missing signals without removing their events from the denominator", () => {
    open();
    insert(1, { owner: false });
    insert(2, { signal: false });
    const report = measure();
    expect(report.status).toBe("INSUFFICIENT");
    expect(report.denominator.toolEventsN).toBe(2);
    expect(report.exclusions).toMatchObject({ missingOwnerTurnN: 1, noSignalInputN: 1 });
  });
  it("excludes LIVE and out-of-window events while counting provisional owners as uncovered", () => {
    open();
    insert(1, { state: "LIVE" });
    insert(2, { eventTs: AS_OF });
    insert(3, { provisional: 1 });
    const report = measure();
    expect(report.denominator.toolEventsN).toBe(1);
    expect(report.covered.eventsN).toBe(0);
    expect(report.exclusions.missingOwnerTurnN).toBe(1);
  });
  it("applies independent half-open event and owner boundaries", () => {
    open();
    insert(1, { eventTs: "2026-07-28T00:00:00.000Z", ownerTs: "2026-07-28T00:00:00.000Z" });
    insert(2, { ownerTs: AS_OF });
    const report = measure();
    expect(report.denominator.toolEventsN).toBe(2);
    expect(report.covered.eventsN).toBe(1);
    expect(report.exclusions.missingOwnerTurnN).toBe(1);
  });
  it("refuses incomplete in-window measurement for malformed, workspace, and unmapped invariants", () => {
    open();
    insert(1, { eventTs: "2026-08-20-not-a-date" });
    insert(2, { ownerWorkspace: "ws-other" });
    insert(3, { workspace: "ws-unmapped" });
    const report = measure();
    expect(report.status).toBe("DATA_INSUFFICIENT");
    expect(report.exclusions.malformedTimestampN).toBe(1);
    expect(report.exclusions.invariantFailureN).toBeGreaterThan(0);
  });
  it("fails closed on an unplaceable malformed reconciled timestamp", () => {
    open();
    for (let i = 0; i < 20; i += 1) insert(i);
    insert(20, { eventTs: "not-a-timestamp" });
    const report = measure();
    expect(report.denominator.toolEventsN).toBe(20);
    expect(report.exclusions.malformedTimestampN).toBe(1);
    expect(report.status).toBe("DATA_INSUFFICIENT");
    expect(report.decision.replayProofEligible).toBe(false);
  });
  it("counts malformed owner timestamps and duplicate structural joins as invariants", () => {
    open(true);
    insert(1, { ownerTs: "not-a-date" });
    insert(2);
    db?.prepare("INSERT INTO tool_event_metadata VALUES (?, ?, ?)").run("e-2", null, "m-2");
    const report = measure();
    expect(report.status).toBe("DATA_INSUFFICIENT");
    expect(report.exclusions.malformedTimestampN).toBe(1);
    expect(report.exclusions.invariantFailureN).toBe(1);
  });
  it("uses UTC calendar days and deterministic approved aliases without leaking repository identity", () => {
    open();
    insert(1, {
      eventTs: "2026-08-20T23:30:00-02:00",
      ownerTs: "2026-08-20T23:30:00-02:00",
    });
    const report = measure();
    expect(report.byUtcDay.map((row) => row.cohort)).toEqual(["2026-08-21"]);
    expect(JSON.stringify(report)).not.toContain("private");
  });
  it("refuses a human-readable report alias before it can enter durable output", () => {
    open();
    insert(1);
    expect(() =>
      measureD7ForwardCoverage({
        db: db as Database.Database,
        repositories: [
          {
            workspaceId: "ws-a",
            owner: "acme",
            repo: "secret-service",
            reportAlias: "acme-secret-service",
          },
        ],
        scratchDbSha256: "b".repeat(64),
        repoMapSha256: "c".repeat(64),
        sourceCommit: COMMIT,
        asOf: AS_OF,
        windowDays: 30,
      }),
    ).toThrow("d7_repository_map_invalid");
  });
});
