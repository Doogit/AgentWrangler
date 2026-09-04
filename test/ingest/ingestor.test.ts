/**
 * test/ingest/ingestor.test.ts — Ingestion Spec §5 fixture suite (WP1).
 *
 * Covers: back-scan aggregates, duplicate-replay no-op, partial-line completion,
 * rotation re-scan equality, unknown-field tolerance, bad-JSON quarantine,
 * synthetic exclusion, distinct 5m/1h pricing, provisional→reconciled
 * transition, NFR-107 rebuild equality (quiescent), COND-4 sidechain
 * no-double-count, and a content-leak guard.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/open.js";
import { Ingestor, runBackscan } from "../../src/ingest/index.js";
import { reconcileSessions } from "../../src/ingest/reconcile.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, synthetic, toJsonl, userToolResult, writeCorpus } from "./synth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, "../fixtures/ingest");

// Far-future reference time ⇒ every 2026-01 fixture session is RECONCILED.
const QUIESCENT_NOW = () => new Date("2026-08-01T00:00:00.000Z");
const OPTS = { now: QUIESCENT_NOW, activityWindowSecs: 300 };

interface Agg {
  cost: number;
  turns: number;
}
interface WsAgg extends Agg {
  workspace_id: string;
}

function perWorkspace(db: Db): WsAgg[] {
  return db
    .prepare(
      `SELECT workspace_id,
              CAST(COALESCE(SUM(cost_equiv_u),0) AS INTEGER) AS cost,
              COUNT(*) AS turns
       FROM turns WHERE provisional = 0
       GROUP BY workspace_id ORDER BY workspace_id`,
    )
    .all() as WsAgg[];
}

function globalAgg(db: Db): Agg {
  return db
    .prepare(
      `SELECT CAST(COALESCE(SUM(cost_equiv_u),0) AS INTEGER) AS cost, COUNT(*) AS turns
       FROM turns WHERE provisional = 0`,
    )
    .get() as Agg;
}

function reconciledAggregateBytes(db: Db): string {
  return JSON.stringify({
    perWorkspace: perWorkspace(db),
    global: globalAgg(db),
    sessions: db
      .prepare(
        `SELECT session_id, workspace_id, first_turn_at, last_turn_at,
                state, turn_count, cost_equiv_u, hygiene_flags
         FROM sessions
         WHERE state = 'RECONCILED'
         ORDER BY workspace_id, session_id`,
      )
      .all(),
  });
}

let db: Db;
beforeEach(() => {
  db = migratedMemDb();
});
afterEach(() => db.close());

describe("back-scan aggregates over the committed corpus", () => {
  it("produces the documented per-workspace and global aggregates", () => {
    const health = runBackscan(db, [FIXTURE_ROOT], OPTS);

    expect(perWorkspace(db)).toEqual([
      { workspace_id: "proj-alpha", cost: 21_375, turns: 2 },
      { workspace_id: "proj-beta", cost: 5_950, turns: 3 },
      // proj-gamma: 2 subagent turns (msg-sub1: 200 + msg-sub2: 100 = 300 μUSD)
      { workspace_id: "proj-gamma", cost: 300, turns: 2 },
    ]);
    expect(globalAgg(db)).toEqual({ cost: 27_625, turns: 7 });

    expect(health.turnsIngested).toBe(7);
    expect(health.duplicateDrops).toBe(2);
    expect(health.syntheticExcluded).toBe(1);
    expect(health.linesQuarantined).toBe(1);
    expect(health.filesSeen).toBe(3);
    expect(health.filesParsed).toBe(3);
    expect(health.unknownFieldKinds.experimentalX).toBe(1);
  });

  it("yields between 100-file batches before the scan promise resolves", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-batched-yield-"));
    try {
      const dir = path.join(tmp, "proj-batched");
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 201; i++) {
        fs.writeFileSync(
          path.join(dir, `session-${i}.jsonl`),
          toJsonl([
            assistant({
              id: `batched-${i}`,
              session: `batched-session-${i}`,
              ts: "2026-01-03T00:00:00.000Z",
              input: 100,
              output: 10,
            }),
          ]),
        );
      }

      const events: string[] = [];
      const scan = new Ingestor(db, [tmp], OPTS)
        .runBackscanBatched()
        .then(() => events.push("resolved"));
      setImmediate(() => events.push("immediate"));

      await scan;
      expect(events).toEqual(["immediate", "resolved"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("produces byte-identical RECONCILED aggregates to the synchronous scan", async () => {
    runBackscan(db, [FIXTURE_ROOT], OPTS);
    const expected = reconciledAggregateBytes(db);

    const db2 = migratedMemDb();
    try {
      await new Ingestor(db2, [FIXTURE_ROOT], OPTS).runBackscanBatched();
      expect(reconciledAggregateBytes(db2)).toBe(expected);
    } finally {
      db2.close();
    }
  });

  it("counts genuine user turns and stores nullable thinking tokens", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-user-turns-"));
    try {
      const valuedTurn = assistant({
        id: "thinking-valued",
        session: "user-session",
        ts: "2026-01-03T00:00:00.000Z",
        input: 100,
        output: 10,
      });
      const valuedMessage = valuedTurn.message as Record<string, unknown>;
      const valuedUsage = valuedMessage.usage as Record<string, unknown>;
      valuedUsage.output_tokens_details = { thinking_tokens: 64 };

      const typedUser = {
        type: "user",
        promptSource: "typed",
        timestamp: "2026-01-03T00:00:01.000Z",
        sessionId: "user-session",
        message: { content: [] },
      };
      const queuedUser = {
        type: "user",
        promptSource: "queued",
        timestamp: "2026-01-03T00:00:02.000Z",
        sessionId: "user-session",
        message: { content: [] },
      };
      const toolResultCarrier = userToolResult({
        session: "user-session",
        ts: "2026-01-03T00:00:03.000Z",
        results: [{ toolUseId: "tool-carrier", text: "result" }],
      });
      toolResultCarrier.promptSource = "typed";

      writeCorpus(tmp, {
        "proj-user": {
          "s.jsonl": [
            valuedTurn,
            assistant({
              id: "thinking-null",
              session: "user-session",
              ts: "2026-01-03T00:00:04.000Z",
              input: 100,
              output: 10,
            }),
            typedUser,
            queuedUser,
            toolResultCarrier,
          ],
        },
      });

      runBackscan(db, [tmp], OPTS);

      const session = db
        .prepare("SELECT user_turn_count AS count FROM sessions WHERE session_id='user-session'")
        .get() as { count: number };
      expect(session.count).toBe(2);

      const valued = db
        .prepare("SELECT thinking_tokens AS tokens FROM turns WHERE message_id='thinking-valued'")
        .get() as { tokens: number | null };
      const missing = db
        .prepare("SELECT thinking_tokens AS tokens FROM turns WHERE message_id='thinking-null'")
        .get() as { tokens: number | null };
      expect(valued.tokens).toBe(64);
      expect(missing.tokens).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prices the 5m/1h cache-write split distinctly on the real turn", () => {
    runBackscan(db, [FIXTURE_ROOT], OPTS);
    // msg-a2: 2000×3 + 400×15 + 1000×0.3 + 500×3.75(5m) + 200×6(1h) = 15375
    const row = db
      .prepare("SELECT cost_equiv_u AS c FROM turns WHERE message_id='msg-a2'")
      .get() as {
      c: number;
    };
    expect(row.c).toBe(15_375);
  });

  it("harvests a commit SHA and a local_command into tool_events", () => {
    runBackscan(db, [FIXTURE_ROOT], OPTS);
    const git = db
      .prepare("SELECT commit_sha AS s FROM tool_events WHERE event_id='tu-1'")
      .get() as { s: string | null };
    expect(git.s).toBe("abcdef0123456789abcdef0123456789abcdef01");
    const cmd = db
      .prepare(
        "SELECT COUNT(*) AS n FROM tool_events WHERE tool_name='local_command' AND input_hash='/compact'",
      )
      .get() as { n: number };
    expect(cmd.n).toBe(1);
  });

  it("attaches tool_result bytes to the owning turn (size only, no content)", () => {
    runBackscan(db, [FIXTURE_ROOT], OPTS);
    const row = db
      .prepare("SELECT tool_result_bytes AS b FROM turns WHERE message_id='msg-a2'")
      .get() as { b: number | null };
    expect(row.b).toBeGreaterThan(0);
  });

  it("sets the COMPACT_MID_TASK hygiene flag on reconcile", () => {
    runBackscan(db, [FIXTURE_ROOT], OPTS);
    const s = db
      .prepare("SELECT state, hygiene_flags AS h FROM sessions WHERE session_id='session-a'")
      .get() as { state: string; h: string };
    expect(s.state).toBe("RECONCILED");
    expect(JSON.parse(s.h)).toContain("COMPACT_MID_TASK");
  });
});

describe("quarantine and exclusions", () => {
  it("quarantines the bad-JSON line as a pointer only (SEC-107)", () => {
    runBackscan(db, [FIXTURE_ROOT], OPTS);
    const rows = db.prepare("SELECT * FROM ingest_quarantine").all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    const r = rows[0] as Record<string, unknown>;
    expect(r.file_path).toContain("session-b.jsonl");
    expect(typeof r.line_no).toBe("number");
    expect(typeof r.error_class).toBe("string");
    // Only pointer columns exist — no content column on the table.
    expect(Object.keys(r).sort()).toEqual(
      ["error_class", "file_path", "line_no", "parser_version", "q_id", "seen_at"].sort(),
    );
  });

  it("excludes synthetic-model records from turns", () => {
    runBackscan(db, [FIXTURE_ROOT], OPTS);
    const n = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE model='<synthetic>'").get() as {
      n: number;
    };
    expect(n.n).toBe(0);
  });

  it("still ingests the turn carrying an unknown field", () => {
    runBackscan(db, [FIXTURE_ROOT], OPTS);
    const n = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE message_id='msg-b3'").get() as {
      n: number;
    };
    expect(n.n).toBe(1);
  });
});

describe("COND-4 — sidechain turns are counted exactly once", () => {
  it("dedupes the duplicated sidechain message and never double-counts", () => {
    runBackscan(db, [FIXTURE_ROOT], OPTS);
    const side = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE is_sidechain=1").get() as {
      n: number;
    };
    // msg-b2 deduped to 1 + msg-sub1 + msg-sub2 from the subagent fixture = 3
    expect(side.n).toBe(3);
    // 7 total reconciled turns: 2 proj-alpha + 3 proj-beta + 2 proj-gamma subagent
    expect(globalAgg(db).turns).toBe(7);
  });
});

describe("duplicate-replay is a no-op", () => {
  it("re-scanning identical files (offsets cleared) reproduces identical aggregates", () => {
    runBackscan(db, [FIXTURE_ROOT], OPTS);
    const before = { ws: perWorkspace(db), g: globalAgg(db) };

    // Force a full re-read by clearing offsets; message_id dedupe must absorb it.
    db.prepare("DELETE FROM ingest_offsets").run();
    runBackscan(db, [FIXTURE_ROOT], OPTS);

    expect(perWorkspace(db)).toEqual(before.ws);
    expect(globalAgg(db)).toEqual(before.g);
  });
});

describe("NFR-107 — rebuild equality over a quiescent corpus", () => {
  it("a fresh DB re-scanned from scratch yields identical RECONCILED aggregates", () => {
    runBackscan(db, [FIXTURE_ROOT], OPTS);
    const first = { ws: perWorkspace(db), g: globalAgg(db) };

    const db2 = migratedMemDb();
    try {
      runBackscan(db2, [FIXTURE_ROOT], OPTS);
      expect(perWorkspace(db2)).toEqual(first.ws);
      expect(globalAgg(db2)).toEqual(first.g);
    } finally {
      db2.close();
    }
  });
});

describe("partial-line completion across passes", () => {
  it("holds a partial trailing line and ingests it once completed", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-partial-"));
    try {
      const dir = path.join(tmp, "proj-p");
      fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, "s.jsonl");
      const l1 = JSON.stringify(
        assistant({
          id: "p1",
          session: "s",
          ts: "2026-01-03T00:00:00.000Z",
          input: 100,
          output: 10,
        }),
      );
      const l2 = JSON.stringify(
        assistant({
          id: "p2",
          session: "s",
          ts: "2026-01-03T00:01:00.000Z",
          input: 100,
          output: 10,
        }),
      );
      // First line complete, second line partial (no newline).
      fs.writeFileSync(fp, `${l1}\n${l2.slice(0, 20)}`);

      runBackscan(db, [tmp], OPTS);
      expect(globalAgg(db).turns).toBe(1);

      // Complete the partial line.
      fs.appendFileSync(fp, `${l2.slice(20)}\n`);
      runBackscan(db, [tmp], OPTS);
      expect(globalAgg(db).turns).toBe(2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("rotation re-scan equality", () => {
  it("a rotated file re-scans and dedupes to identical aggregates", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-rot-"));
    try {
      // Copy the committed corpus into a writable tmp root.
      for (const slug of ["proj-alpha", "proj-beta"]) {
        const srcDir = path.join(FIXTURE_ROOT, slug);
        const dstDir = path.join(tmp, slug);
        fs.mkdirSync(dstDir, { recursive: true });
        for (const f of fs.readdirSync(srcDir)) {
          fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
        }
      }

      const ing = new Ingestor(db, [tmp], OPTS);
      ing.runBackscan();
      const before = { ws: perWorkspace(db), g: globalAgg(db) };

      // Rotate session-a: reorder lines so the head bytes (hash) change.
      const p = path.join(tmp, "proj-alpha", "session-a.jsonl");
      const lines = fs
        .readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      fs.writeFileSync(p, `${[lines[1], lines[0], lines[2], lines[3]].join("\n")}\n`);

      ing.runBackscan();
      expect(perWorkspace(db)).toEqual(before.ws);
      expect(globalAgg(db)).toEqual(before.g);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("provisional → reconciled transition", () => {
  it("keeps a fresh session provisional then settles it once past the window", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-prov-"));
    try {
      writeCorpus(tmp, {
        "proj-live": {
          "s.jsonl": [
            assistant({
              id: "L1",
              session: "live-s",
              ts: "2026-08-01T12:00:00.000Z",
              input: 100,
              output: 10,
            }),
          ],
        },
      });

      let clock = new Date("2026-08-01T12:02:00.000Z"); // 2 min after last turn → LIVE
      const ing = new Ingestor(db, [tmp], { now: () => clock, activityWindowSecs: 300 });

      ing.runBackscan();
      const live = db.prepare("SELECT state FROM sessions WHERE session_id='live-s'").get() as {
        state: string;
      };
      expect(live.state).toBe("LIVE");
      expect(globalAgg(db).turns).toBe(0); // provisional excluded from reconciled aggregate

      clock = new Date("2026-08-01T13:00:00.000Z"); // > window → RECONCILED
      ing.runBackscan();
      const done = db.prepare("SELECT state FROM sessions WHERE session_id='live-s'").get() as {
        state: string;
      };
      expect(done.state).toBe("RECONCILED");
      expect(globalAgg(db).turns).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("reconcile work set", () => {
  it("excludes stale RECONCILED sessions", () => {
    db.prepare(
      `INSERT INTO workspaces (workspace_id, project_slug, registered_at)
       VALUES ('ws-reconcile-filter', 'reconcile-filter', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions
         (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
          state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES ('reconciled-stale', 'ws-reconcile-filter', 'stale-session-path',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
               'RECONCILED', 0, 0, '["ALREADY_SETTLED"]')`,
    ).run();

    reconcileSessions(db, "2026-08-01T00:00:00.000Z");

    const session = db
      .prepare("SELECT state, hygiene_flags FROM sessions WHERE session_id = 'reconciled-stale'")
      .get() as { state: string; hygiene_flags: string };
    expect(session).toEqual({ state: "RECONCILED", hygiene_flags: '["ALREADY_SETTLED"]' });
  });
});

describe("content-leak guard (SEC-101/107)", () => {
  it("stores no transcript prose in any ingested row", () => {
    runBackscan(db, [FIXTURE_ROOT], OPTS);
    const dump = JSON.stringify([
      db.prepare("SELECT * FROM turns").all(),
      db.prepare("SELECT * FROM tool_events").all(),
      db.prepare("SELECT * FROM ingest_quarantine").all(),
    ]);
    // "synthetic" appears only in fixture tool_result/command *content*, which is
    // never stored. Its absence proves content was discarded, not persisted.
    expect(dump).not.toContain("synthetic");
  });

  it("committed fixtures are small and structurally synthetic", () => {
    // Walk recursively so nested subagent fixtures
    // (<slug>/<uuid>/subagents/agent-*.jsonl) are size-checked too, not just
    // top-level session files.
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        return e.isDirectory() ? walk(full) : [full];
      });
    for (const file of walk(FIXTURE_ROOT)) {
      expect(fs.statSync(file).size).toBeLessThan(4096); // synthetic corpora stay tiny
    }
  });
});

describe("D7 privacy-safe tool-event metadata", () => {
  it("correlates result status and stores hashes plus structural order without content", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-d7-"));
    const rawPath = "C:/private/project/secret.ts";
    try {
      writeCorpus(tmp, {
        "proj-d7": {
          "d7.jsonl": [
            assistant({
              id: "d7-owner",
              session: "d7-session",
              ts: "2026-01-03T00:00:00.000Z",
              toolUses: [
                { id: "d7-test", name: "Bash", command: "npm test -- --runInBand" },
                { id: "d7-read", name: "Read", input: { file_path: rawPath } },
                { id: "d7-error", name: "Bash", command: "npm run build" },
              ],
            }),
            userToolResult({
              session: "d7-session",
              ts: "2026-01-03T00:00:01.000Z",
              results: [
                { toolUseId: "d7-test", text: "fabricated test failure", isError: true },
                { toolUseId: "d7-read", text: "fabricated read success", isError: false },
                { toolUseId: "d7-error", text: "fabricated build failure", isError: true },
              ],
            }),
          ],
        },
      });

      runBackscan(db, [tmp], OPTS);

      const events = db
        .prepare(
          `SELECT event_id, input_hash, result_bytes, exit_class
           FROM tool_events WHERE event_id LIKE 'd7-%' ORDER BY event_id`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(events).toHaveLength(3);
      expect(events.find((r) => r.event_id === "d7-test")?.exit_class).toBe("TEST_FAIL");
      expect(events.find((r) => r.event_id === "d7-read")?.exit_class).toBe("OK");
      expect(events.find((r) => r.event_id === "d7-error")?.exit_class).toBe("ERROR");
      expect(events.every((r) => typeof r.input_hash === "string")).toBe(true);
      expect(events.find((r) => r.event_id === "d7-read")?.result_bytes).toBe(
        "fabricated read success".length,
      );
      const ownerTurn = db
        .prepare("SELECT tool_result_bytes AS bytes FROM turns WHERE message_id='d7-owner'")
        .get() as { bytes: number };
      expect(ownerTurn.bytes).toBe(
        "fabricated test failure".length +
          "fabricated read success".length +
          "fabricated build failure".length,
      );

      const metadata = db
        .prepare(
          `SELECT event_id, file_path_hash, owner_message_id, block_index
           FROM tool_event_metadata WHERE event_id LIKE 'd7-%' ORDER BY block_index`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(metadata.map((r) => r.block_index)).toEqual([0, 1, 2]);
      expect(metadata.every((r) => r.owner_message_id === "d7-owner")).toBe(true);
      expect(metadata[1]?.file_path_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(metadata[0]?.file_path_hash).toBeNull();

      const persisted = JSON.stringify([events, metadata]);
      expect(persisted).not.toContain(rawPath);
      expect(persisted).not.toContain("npm test");
      expect(persisted).not.toContain("fabricated");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("enriches existing event rows on an explicit replay without duplicating them", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-d7-enrich-"));
    try {
      writeCorpus(tmp, {
        "proj-d7": {
          "enrich.jsonl": [
            assistant({
              id: "enrich-owner",
              session: "enrich-session",
              ts: "2026-01-03T00:00:00.000Z",
              toolUses: [
                {
                  id: "enrich-read",
                  name: "Read",
                  input: { file_path: "C:/private/enrich.ts" },
                },
              ],
            }),
            userToolResult({
              session: "enrich-session",
              ts: "2026-01-03T00:00:01.000Z",
              results: [{ toolUseId: "enrich-read", text: "ok", isError: false }],
            }),
          ],
        },
      });
      runBackscan(db, [tmp], OPTS);

      db.prepare(
        "UPDATE tool_events SET input_hash=NULL, result_bytes=NULL, exit_class=NULL WHERE event_id='enrich-read'",
      ).run();
      db.prepare(
        "UPDATE tool_event_metadata SET file_path_hash=NULL, owner_message_id=NULL WHERE event_id='enrich-read'",
      ).run();
      db.prepare("DELETE FROM ingest_offsets").run();

      runBackscan(db, [tmp], OPTS);
      const row = db
        .prepare(
          `SELECT te.input_hash, te.result_bytes, te.exit_class, tm.file_path_hash, tm.owner_message_id
           FROM tool_events te JOIN tool_event_metadata tm ON tm.event_id=te.event_id
           WHERE te.event_id='enrich-read'`,
        )
        .get() as Record<string, unknown>;
      expect(row.input_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.result_bytes).toBe(2);
      expect(row.exit_class).toBe("OK");
      expect(row.file_path_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.owner_message_id).toBe("enrich-owner");
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM tool_events WHERE event_id='enrich-read'")
        .get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("retains TEST_FAIL classification across an ingestor restart", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-d7-restart-"));
    try {
      const dir = path.join(tmp, "proj-d7");
      const file = path.join(dir, "restart.jsonl");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        file,
        toJsonl([
          assistant({
            id: "restart-owner",
            session: "restart-session",
            ts: "2026-01-03T00:00:00.000Z",
            toolUses: [{ id: "restart-test", name: "Bash", command: "npx vitest run" }],
          }),
        ]),
      );
      new Ingestor(db, [tmp], OPTS).runBackscan();

      const storedHint = db
        .prepare(
          "SELECT is_test_command AS isTest FROM tool_event_metadata WHERE event_id='restart-test'",
        )
        .get() as { isTest: number };
      expect(storedHint.isTest).toBe(1);

      fs.appendFileSync(
        file,
        toJsonl([
          userToolResult({
            session: "restart-session",
            ts: "2026-01-03T00:00:01.000Z",
            results: [{ toolUseId: "restart-test", text: "fabricated failure", isError: true }],
          }),
        ]),
      );
      // New instance has no in-memory test-command set and resumes from the DB offset.
      new Ingestor(db, [tmp], OPTS).runBackscan();

      const result = db
        .prepare(
          "SELECT result_bytes AS bytes, exit_class AS exitClass FROM tool_events WHERE event_id='restart-test'",
        )
        .get() as { bytes: number; exitClass: string };
      expect(result.bytes).toBe("fabricated failure".length);
      expect(result.exitClass).toBe("TEST_FAIL");
      const turn = db
        .prepare("SELECT tool_result_bytes AS bytes FROM turns WHERE message_id='restart-owner'")
        .get() as { bytes: number };
      expect(turn.bytes).toBe("fabricated failure".length);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("tail size guard — unchanged files are skipped (event-loop de-jam)", () => {
  it("skips an unchanged file on a second tick, then picks up appended lines", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-guard-"));
    try {
      const dir = path.join(tmp, "proj-guard");
      fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, "s.jsonl");
      fs.writeFileSync(
        fp,
        toJsonl([
          assistant({
            id: "g1",
            session: "guard-s",
            ts: "2026-01-03T00:00:00.000Z",
            input: 100,
            output: 10,
          }),
        ]),
      );

      const ing = new Ingestor(db, [tmp], OPTS);
      ing.ingestFile(fp, "proj-guard");
      const afterFirst = ing.healthSnapshot();
      expect(afterFirst.filesSeen).toBe(1);
      expect(afterFirst.turnsIngested).toBe(1);

      // Second tick, file byte-identical → size guard skips before touching the DB.
      ing.ingestFile(fp, "proj-guard");
      const afterSkip = ing.healthSnapshot();
      expect(afterSkip.filesSeen).toBe(1); // not even re-opened
      expect(afterSkip.turnsIngested).toBe(1);

      // Appending a line changes the size → guard passes → new turn ingested.
      fs.appendFileSync(
        fp,
        toJsonl([
          assistant({
            id: "g2",
            session: "guard-s",
            ts: "2026-01-03T00:01:00.000Z",
            input: 100,
            output: 10,
          }),
        ]),
      );
      ing.ingestFile(fp, "proj-guard");
      const afterAppend = ing.healthSnapshot();
      expect(afterAppend.filesSeen).toBe(2);
      expect(afterAppend.turnsIngested).toBe(2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("re-processes an unchanged-on-disk file after clearRuntimeState (post-reset rescan)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-guard-reset-"));
    try {
      const dir = path.join(tmp, "proj-reset");
      fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, "s.jsonl");
      fs.writeFileSync(
        fp,
        toJsonl([
          assistant({
            id: "r1",
            session: "reset-s",
            ts: "2026-01-03T00:00:00.000Z",
            input: 100,
            output: 10,
          }),
        ]),
      );

      const ing = new Ingestor(db, [tmp], OPTS);
      ing.ingestFile(fp, "proj-reset");
      expect(ing.healthSnapshot().filesSeen).toBe(1);

      // Simulate a DB reset: wipe rows + offsets, then clear runtime state.
      db.prepare("DELETE FROM turns").run();
      db.prepare("DELETE FROM ingest_offsets").run();
      ing.clearRuntimeState();

      // File is byte-identical on disk. Without clearing lastSize the guard would
      // skip it and never re-populate the wiped DB; the mandatory clear re-arms it.
      ing.ingestFile(fp, "proj-reset");
      expect(ing.healthSnapshot().filesSeen).toBe(2);
      const n = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE message_id='r1'").get() as {
        n: number;
      };
      expect(n.n).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("tail discovery cache", () => {
  it("does not repeat the recursive walk on unchanged tail ticks", () => {
    // node:fs ESM exports can't be spied, so assert the no-re-walk behavior
    // instead: add a file but reset the slug-dir mtime to the value the cache
    // already holds, so an incremental tail tick sees "unchanged" and must reuse
    // the cache. If it did re-walk, the new file would be ingested.
    vi.useFakeTimers();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-discovery-cache-"));
    let handle: { stop(): void } | undefined;
    try {
      const dir = path.join(tmp, "proj-cache");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "s.jsonl"),
        toJsonl([
          assistant({
            id: "cache-1",
            session: "cache-session",
            ts: "2026-01-03T00:00:00.000Z",
            input: 100,
            output: 10,
          }),
        ]),
      );

      // Pin the slug-dir mtime to an exact-millisecond value BEFORE warming, so
      // the value the cache captures has no sub-ms component we can't reproduce.
      const pinned = new Date("2026-01-03T12:00:00.000Z");
      fs.utimesSync(dir, pinned, pinned);

      const ing = new Ingestor(db, [tmp], {
        ...OPTS,
        tailIntervalMs: 1_000,
        discoveryIntervalMs: 60_000,
      });
      handle = ing.startTail(); // initial full scan warms the cache + ingests s.jsonl
      expect(ing.healthSnapshot().filesSeen).toBe(1);

      // Add a second transcript, then reset the slug-dir mtime back to the pinned
      // value so the incremental refresh's mtime gate reads "unchanged".
      fs.writeFileSync(
        path.join(dir, "s2.jsonl"),
        toJsonl([
          assistant({
            id: "cache-2",
            session: "cache-session-2",
            ts: "2026-01-03T00:01:00.000Z",
            input: 100,
            output: 10,
          }),
        ]),
      );
      fs.utimesSync(dir, pinned, pinned);

      // Several tail ticks, all under the 60s discovery (full-refresh) interval.
      vi.advanceTimersByTime(5_000);

      // s2 was never discovered → the tick reused the cache instead of re-walking.
      expect(ing.healthSnapshot().filesSeen).toBe(1);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM turns WHERE message_id='cache-2'").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
    } finally {
      handle?.stop();
      vi.useRealTimers();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("discovers a new transcript on the next tail tick after its slug mtime changes", () => {
    vi.useFakeTimers();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-discovery-new-file-"));
    let handle: { stop(): void } | undefined;
    try {
      const dir = path.join(tmp, "proj-new-file");
      fs.mkdirSync(dir, { recursive: true });
      const ing = new Ingestor(db, [tmp], {
        ...OPTS,
        tailIntervalMs: 1_000,
        discoveryIntervalMs: 60_000,
      });
      handle = ing.startTail();

      const beforeMtime = fs.statSync(dir).mtimeMs;
      const fp = path.join(dir, "new.jsonl");
      fs.writeFileSync(
        fp,
        toJsonl([
          assistant({
            id: "new-file-1",
            session: "new-file-session",
            ts: "2026-01-03T00:00:00.000Z",
            input: 100,
            output: 10,
          }),
        ]),
      );
      if (fs.statSync(dir).mtimeMs <= beforeMtime) {
        const forcedMtime = new Date(beforeMtime + 1_000);
        fs.utimesSync(dir, forcedMtime, forcedMtime);
      }

      vi.advanceTimersByTime(1_000);

      expect(ing.healthSnapshot().filesSeen).toBe(1);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM turns WHERE message_id='new-file-1'").get() as {
            n: number;
          }
        ).n,
      ).toBe(1);
    } finally {
      handle?.stop();
      vi.useRealTimers();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("back-scan performance (NFR-104)", () => {
  it("scans a multi-thousand-turn corpus quickly", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-perf-"));
    try {
      const lines = [];
      for (let i = 0; i < 2500; i++) {
        lines.push(
          assistant({
            id: `perf-${i}`,
            session: `sess-${i % 25}`,
            ts: `2026-05-01T00:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
            input: 100,
            output: 20,
          }),
        );
      }
      const dir = path.join(tmp, "proj-big");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "big.jsonl"), toJsonl(lines));

      const t0 = Date.now();
      const health = runBackscan(db, [tmp], OPTS);
      const elapsed = Date.now() - t0;

      expect(health.turnsIngested).toBe(2500);
      expect(elapsed).toBeLessThan(15_000);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
