/**
 * RC-B invariant: every Usage patterns row with occurrences leads to a real recommendation (a
 * hand-off, active or "Small fix", or "No fix this week"), or is on the allow-list below with a
 * reason.
 *
 * Data: the shared seed DB fires no cause on its own (only D5), so the live-DB shape that RC-B
 * fixed is planted on top: a 3-failure Bash cluster costing 0.0003% of its workspace's week
 * (live 7d: SHELL_FAILS_IN_BURSTS at 0.028% showed "No fix yet").
 *
 * Graded two ways: through the production join (`createHandoffSource` + `joinHandoffs` over a real
 * detector run and recs build), and against an independent oracle: direct SQL on
 * `recommendations` (PROPOSED rows) mapped with `causeForKey`, not through the recs view or join.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHandoffSource, joinHandoffs } from "../../src/daemon/diagnostics-snapshot.js";
import type { RecsSnapshotService } from "../../src/daemon/recs-snapshot.js";
import type { openDb } from "../../src/db/open.js";
import { buildContext, runDetectors } from "../../src/detector/engine.js";
import { causeForKey } from "../../src/query/api/diagnostics-causes.js";
import { buildDiagnosticsTriage } from "../../src/query/api/diagnostics-triage.js";
import { buildRecommendations } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createFixtureDb } from "../fixtures/seed.js";

const AS_OF = new Date("2026-01-08T00:00:00.000Z");

/** Causes that may show occurrences with no rec behind them, each with its reason. */
const ALLOW: Readonly<Record<string, string>> = {};

/** Three same-signature Bash failures in one reconciled session, plus a 1,000,000 u turn. */
function plantSmallShellCluster(db: ReturnType<typeof openDb>): void {
  db.exec(`
    INSERT INTO workspaces (workspace_id, project_slug, registered_at)
    VALUES ('ws-rcb', 'ws-rcb', '2026-01-01T00:00:00.000Z');
    INSERT INTO sessions
      (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
    VALUES ('s-rcb', 'ws-rcb', '/fixture/rcb.jsonl', '2026-01-07T00:00:00.000Z', '2026-01-07T01:00:00.000Z',
            'RECONCILED', 0, 0, '[]');
  `);
  const turn = db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, provisional, parser_version, cost_equiv_u)
     VALUES (?, 's-rcb', 'ws-rcb', ?, 'claude-sonnet', 0, 0, 'test-v1', ?)`,
  );
  for (let i = 0; i < 3; i++) {
    const ts = `2026-01-07T00:00:0${i}.000Z`;
    turn.run(`m-rcb-${i}`, ts, 1);
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class, bash_command_family)
       VALUES (?, 's-rcb', ?, 'Bash', 'ERROR', 'BASH_NPM')`,
    ).run(`e-rcb-${i}`, ts);
    db.prepare(
      `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
       VALUES (?, ?, ?, 0)`,
    ).run(`e-rcb-${i}`, `m-rcb-${i}`, i);
    db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
      `e-rcb-${i}`,
      JSON.stringify({ command: "npm run x", error: "Exit code 1\nnpm said no" }),
    );
  }
  turn.run("m-rcb-big", "2026-01-07T00:30:00.000Z", 1_000_000);
}

/**
 * RC-D14: a plain Esc (a user record, classifier-2) with no prompt after it, in its own reconciled
 * session: the stopped response, the Esc, then the re-plan turn.
 */
function plantUncorrectedEsc(db: ReturnType<typeof openDb>): void {
  db.exec(`
    INSERT INTO sessions
      (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
    VALUES ('s-d14', 'ws-rcb', '/fixture/d14.jsonl', '2026-01-07T02:00:00.000Z', '2026-01-07T02:01:00.000Z',
            'RECONCILED', 0, 0, '[]');
    INSERT INTO turns
      (message_id, session_id, workspace_id, ts, model, is_sidechain, provisional, parser_version, cost_equiv_u)
    VALUES ('m-d14-stopped', 's-d14', 'ws-rcb', '2026-01-07T02:00:00.000Z', 'claude-sonnet', 0, 0, 'test-v1', 10),
           ('m-d14-replan', 's-d14', 'ws-rcb', '2026-01-07T02:00:30.000Z', 'claude-sonnet', 0, 0, 'test-v1', 10);
    INSERT INTO ingest_metric_events
      (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error,
       is_interrupt, classifier_label, classifier_version, event_ts, is_sidechain)
    VALUES ('esc-d14', 's-d14', NULL, 0, 0, 0, 1, 'interrupt-cancel', 'classifier-2',
            '2026-01-07T02:00:01.000Z', 0);
  `);
}

describe("RC-B: every counted cause leads to a rec", () => {
  let root: string;
  let db: ReturnType<typeof openDb>;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-cause-rec-"));
    db = createFixtureDb(path.join(root, "seed.sqlite"));
    plantSmallShellCluster(db);
    plantUncorrectedEsc(db);
    runDetectors(db, buildContext(AS_OF));
    setQueryDb(db);
  }, 60_000);

  afterAll(() => {
    resetQueryDb();
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("joins a hand-off or quiet marker for every row with occurrences, matching the SQL oracle", async () => {
    const response = buildRecommendations(undefined, AS_OF);
    const recs = { get: () => Promise.resolve(response) } as unknown as RecsSnapshotService;
    const candidates = await createHandoffSource(recs, db, 10_000).get();
    expect(Array.isArray(candidates)).toBe(true);

    const view = joinHandoffs(buildDiagnosticsTriage(db, 7, AS_OF, { warn: () => {} }), candidates);
    const rows = [
      ...view.avoidable.causes,
      ...view.reliability.causes,
      ...(view.reliability.risk ? [view.reliability.risk] : []),
    ].filter((row) => row.occurrences > 0);
    // Not vacuous: the planted cluster is counted and handed off to its C7 card. (Before RC-B the
    // 0.1% floor dropped it: its claimed cost is 1 u of ~1,000,003 u.)
    const shell = rows.find((row) => row.cause_id === "SHELL_FAILS_IN_BURSTS");
    expect(shell?.handoff?.rec_id).toMatch(/^rec-C7-/);
    // RC-D14: the planted Esc is counted under its cause and handed off to its D14 card.
    const esc = rows.find((row) => row.cause_id === "INTERRUPTED_OR_CANCELLED");
    expect(esc?.occurrences).toBeGreaterThan(0);
    expect(esc?.handoff?.rec_id).toMatch(/^rec-D14-/);

    // Oracle: causes with a PROPOSED rec, by direct SQL.
    const proposed = new Set<string>();
    for (const r of db
      .prepare(
        "SELECT detector_id, COALESCE(rule_id, template_id) AS key FROM recommendations WHERE state = 'PROPOSED'",
      )
      .all() as Array<{ detector_id: string; key: string | null }>) {
      if (r.key === null) continue;
      try {
        proposed.add(causeForKey(r.detector_id, r.key).cause_id);
      } catch {
        // A key outside the cause registry (EXCLUDED_KEYS) backs no row.
      }
    }

    const joinedGaps = rows
      .filter((row) => row.handoff === null && row.fix_quiet !== true)
      .map((row) => row.cause_id)
      .filter((id) => !(id in ALLOW));
    const oracleGaps = rows
      .map((row) => row.cause_id)
      .filter((id) => !proposed.has(id) && !(id in ALLOW));
    expect(joinedGaps).toEqual([]);
    expect(oracleGaps).toEqual([]);
  }, 60_000);
});
