/**
 * test/ingest/enrichment-epoch.test.ts: every write that can change a row in an already-closed
 * ledger window moves `ledgerFingerprint` (through the enrichment epoch); hot-path writes to the
 * open window do not, so the closed-window aggregate cache stays warm in steady state.
 * Synthetic fixtures only (SEC-101).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { backfillTurnAgentIds } from "../../src/ingest/agent-id-backfill.js";
import { recomputeCompactionBoundaries } from "../../src/ingest/compaction-boundaries.js";
import {
  bumpEnrichmentEpoch,
  bumpEnrichmentEpochIfClosed,
  readEnrichmentEpoch,
} from "../../src/ingest/enrichment-epoch.js";
import { Ingestor } from "../../src/ingest/index.js";
import { repairToolErrorClasses } from "../../src/ingest/tool-error-repair.js";
import { ledgerFingerprint } from "../../src/query/api/ledger-aggregate.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, toJsonl, userPrompt, userToolResult } from "./synth.js";

// Default reset grid is Monday 00:00 UTC, so the newest closed boundary at NOW is 2026-09-28.
const NOW = new Date("2026-10-01T00:00:00.000Z");
const CLOSED_TS = "2026-09-15T12:00:00.000Z";
const OPEN_TS = "2026-09-30T12:00:00.000Z";
const CLOSED_WEEK = { from: "2026-09-14T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z" };
const SESSION = "epoch-session";
const OPTS = { now: () => NOW };

let db: Db;
let root: string;
let file: string;

beforeEach(() => {
  db = migratedMemDb();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-enrichment-epoch-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  file = path.join(root, "project", `${SESSION}.jsonl`);
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (lines: Array<Record<string, unknown>>): void =>
  fs.writeFileSync(file, toJsonl(lines));
const append = (lines: Array<Record<string, unknown>>): void =>
  fs.appendFileSync(file, toJsonl(lines));
const scan = (): void => {
  new Ingestor(db, [root], OPTS).runBackscan();
};
const epoch = (): string => readEnrichmentEpoch(db);
const toolUse = (id: string, ts: string) =>
  assistant({ id: `m-${id}`, session: SESSION, ts, toolUses: [{ id, name: "Read", input: {} }] });
const result = (id: string, ts: string) =>
  userToolResult({
    session: SESSION,
    ts,
    results: [{ toolUseId: id, text: "File not found: x", isError: true }],
  });

describe("enrichment epoch helper", () => {
  it("starts at 0 and counts bumps", () => {
    expect(epoch()).toBe("0");
    bumpEnrichmentEpoch(db);
    bumpEnrichmentEpoch(db);
    expect(epoch()).toBe("2");
  });

  it("bumps only for a ts at or before the closed boundary (or an unreadable ts)", () => {
    bumpEnrichmentEpochIfClosed(db, OPEN_TS, NOW);
    bumpEnrichmentEpochIfClosed(db, "2026-09-28T00:00:00.001Z", NOW);
    expect(epoch()).toBe("0");
    bumpEnrichmentEpochIfClosed(db, CLOSED_TS, NOW);
    expect(epoch()).toBe("1");
    bumpEnrichmentEpochIfClosed(db, null, NOW);
    bumpEnrichmentEpochIfClosed(db, "not a date", NOW);
    expect(epoch()).toBe("3");
  });

  it("the epoch moves the fingerprint of every window", () => {
    const f0 = ledgerFingerprint(db, CLOSED_WEEK);
    expect(ledgerFingerprint(db, CLOSED_WEEK)).toBe(f0);
    bumpEnrichmentEpoch(db);
    expect(ledgerFingerprint(db, CLOSED_WEEK)).not.toBe(f0);
  });
});

describe("ingest hot path", () => {
  it("open-window tool_use + result writes never bump the epoch", () => {
    write([toolUse("t1", OPEN_TS), result("t1", "2026-09-30T12:00:01.000Z")]);
    scan();
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_events").get()).toEqual({ n: 1 });
    expect(epoch()).toBe("0");
  });

  it("a result that enriches a closed-window tool event moves the closed window's fingerprint", () => {
    write([toolUse("t1", CLOSED_TS)]);
    scan();
    const e0 = epoch();
    const f0 = ledgerFingerprint(db, CLOSED_WEEK);

    append([result("t1", OPEN_TS)]); // arrives now, enriches the old row in place
    scan();
    expect(db.prepare("SELECT exit_class FROM tool_events WHERE event_id = 't1'").get()).toEqual({
      exit_class: "ERROR",
    });
    expect(epoch()).not.toBe(e0);
    expect(ledgerFingerprint(db, CLOSED_WEEK)).not.toBe(f0);
  });

  it("steady state: later open-window ingest and idle rescans leave the closed fingerprint alone", () => {
    write([toolUse("t1", CLOSED_TS), result("t1", CLOSED_TS)]);
    scan();
    const e0 = epoch();
    const f0 = ledgerFingerprint(db, CLOSED_WEEK);

    append([toolUse("t2", OPEN_TS), result("t2", "2026-09-30T12:00:01.000Z")]);
    scan();
    scan();
    expect(epoch()).toBe(e0);
    expect(ledgerFingerprint(db, CLOSED_WEEK)).toBe(f0);
  });

  it("a replay that re-enriches a closed metric event bumps the epoch", () => {
    write([userPrompt({ session: SESSION, ts: CLOSED_TS })]);
    scan();
    const e0 = epoch();
    db.prepare("DELETE FROM ingest_offsets").run(); // force a full re-read of the transcript
    scan();
    expect(epoch()).not.toBe(e0);
  });

  it("a replay of open-window metric events does not bump", () => {
    write([userPrompt({ session: SESSION, ts: OPEN_TS })]);
    scan();
    db.prepare("DELETE FROM ingest_offsets").run();
    scan();
    expect(epoch()).toBe("0");
  });

  it("a NEW closed-window tool event or local command does not bump; its replay does", () => {
    write([toolUse("t1", CLOSED_TS)]);
    scan();
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_events").get()).toEqual({ n: 1 });
    expect(epoch()).toBe("0"); // COUNT / MAX(rowid) already see a new row
    db.prepare("DELETE FROM ingest_offsets").run();
    scan(); // same tool_use again: the upsert rewrites an existing closed row
    expect(epoch()).not.toBe("0");
  });

  it("a NEW subagent_meta row for a session that spans the reset does not bump", () => {
    write([toolUse("t1", CLOSED_TS), toolUse("t2", OPEN_TS)]);
    scan();
    const e0 = epoch();
    const agentDir = path.join(root, "project", SESSION, "subagents");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "agent-b1.jsonl"), '{"type":"system"}\n');
    fs.writeFileSync(
      path.join(agentDir, "agent-b1.meta.json"),
      JSON.stringify({ agentType: "fork", spawnDepth: 1 }),
    );
    scan();
    expect(db.prepare("SELECT COUNT(*) AS n FROM subagent_meta").get()).toEqual({ n: 1 });
    expect(epoch()).toBe(e0);
  });

  it("a NEW subagent_meta row that arrives after its closed-window turns bumps (late meta.json)", () => {
    const agentDir = path.join(root, "project", SESSION, "subagents");
    fs.mkdirSync(agentDir, { recursive: true });
    write([toolUse("t1", CLOSED_TS)]);
    const agentFile = path.join(agentDir, "agent-c1.jsonl");
    fs.writeFileSync(
      agentFile,
      toJsonl([assistant({ id: "m-c1", session: SESSION, ts: CLOSED_TS, sidechain: true })]),
    ); // no meta.json yet
    scan();
    expect(db.prepare("SELECT COUNT(*) AS n FROM turns WHERE agent_id IS NOT NULL").get()).toEqual({
      n: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM subagent_meta").get()).toEqual({ n: 0 });
    const e0 = epoch();

    fs.writeFileSync(
      path.join(agentDir, "agent-c1.meta.json"),
      JSON.stringify({ agentType: "fork", spawnDepth: 1 }),
    );
    fs.appendFileSync(agentFile, '{"type":"system"}\n');
    scan();
    expect(db.prepare("SELECT COUNT(*) AS n FROM subagent_meta").get()).toEqual({ n: 1 });
    expect(epoch()).not.toBe(e0);
  });

  it("a changed subagent_meta row for a closed session bumps; an unchanged one does not", () => {
    const agentDir = path.join(root, "project", SESSION, "subagents");
    fs.mkdirSync(agentDir, { recursive: true });
    write([toolUse("t1", CLOSED_TS)]);
    fs.writeFileSync(path.join(agentDir, "agent-a1.jsonl"), '{"type":"system"}\n');
    const meta = path.join(agentDir, "agent-a1.meta.json");
    fs.writeFileSync(meta, JSON.stringify({ agentType: "fork", spawnDepth: 1 }));
    scan();
    expect(db.prepare("SELECT COUNT(*) AS n FROM subagent_meta").get()).toEqual({ n: 1 });
    const e0 = epoch();

    fs.appendFileSync(path.join(agentDir, "agent-a1.jsonl"), '{"type":"system"}\n');
    scan(); // same meta
    expect(epoch()).toBe(e0);

    fs.writeFileSync(meta, JSON.stringify({ agentType: "fork", spawnDepth: 2 }));
    fs.appendFileSync(path.join(agentDir, "agent-a1.jsonl"), '{"type":"system"}\n');
    scan();
    expect(epoch()).not.toBe(e0);
  });
});

function seedSession(): void {
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws', 'ws', '2026-09-01T00:00:00.000Z')",
  ).run();
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('s', 'ws', '/fixture/s.jsonl', 'LIVE', 0, 0, '[]')`,
  ).run();
}

describe("repair, backfill and flag jobs", () => {
  it("repairToolErrorClasses bumps once when it labels rows, not on the no-op rerun", () => {
    seedSession();
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class)
       VALUES ('e', 's', ?, 'Edit', 'ERROR')`,
    ).run(CLOSED_TS);
    db.prepare(
      "INSERT INTO tool_event_content (event_id, content_json, content_included) VALUES ('e', json_object('error', 'File not found: x'), 1)",
    ).run();
    expect(repairToolErrorClasses(db).reclassified).toBe(1);
    expect(epoch()).toBe("1");
    expect(repairToolErrorClasses(db).reclassified).toBe(0);
    expect(epoch()).toBe("1");
  });

  it("repairToolErrorClasses does not bump when it labels nothing", () => {
    seedSession();
    expect(repairToolErrorClasses(db).reclassified).toBe(0);
    expect(epoch()).toBe("0");
  });

  it("backfillTurnAgentIds bumps when it fills agent ids", async () => {
    const agentDir = path.join(root, "project", SESSION, "subagents");
    fs.mkdirSync(agentDir, { recursive: true });
    const agentFile = path.join(agentDir, "agent-a1.jsonl");
    fs.writeFileSync(
      agentFile,
      toJsonl([assistant({ id: "side", session: SESSION, ts: CLOSED_TS, sidechain: true })]),
    );
    scan();
    db.prepare("UPDATE turns SET agent_id = NULL").run();
    const e0 = epoch();
    expect(await backfillTurnAgentIds(db, [agentFile])).toBe(1);
    expect(epoch()).not.toBe(e0);
  });

  it("recomputeCompactionBoundaries bumps only when it flips a closed-window turn", () => {
    seedSession();
    const turn = (id: string, ts: string) =>
      db
        .prepare(
          `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version)
           VALUES (?, 's', 'ws', ?, 'claude-sonnet-4-6', 'ingest-3')`,
        )
        .run(id, ts);
    const boundary = (id: string, ts: string) =>
      db
        .prepare(
          `INSERT INTO ingest_metric_events
             (event_id, session_id, is_user_turn, is_compact_summary, is_api_error, is_interrupt,
              event_ts, boundary_kind)
           VALUES (?, 's', 0, 0, 0, 0, ?, 'compact-boundary')`,
        )
        .run(id, ts);
    turn("open-turn", OPEN_TS);
    boundary("b-open", "2026-09-30T11:00:00.000Z");
    expect(recomputeCompactionBoundaries(db, "s", NOW)).toBe(1);
    expect(epoch()).toBe("0");

    turn("closed-turn", CLOSED_TS);
    boundary("b-closed", "2026-09-15T11:00:00.000Z");
    expect(recomputeCompactionBoundaries(db, "s", NOW)).toBe(1);
    expect(epoch()).toBe("1");
  });
});
