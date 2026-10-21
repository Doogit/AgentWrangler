import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/db/migrate.js";
import { findingIds } from "../../../src/detector/privacy-contract.js";
import type {
  AvoidableCauseFigure,
  AvoidableProvider,
} from "../../../src/query/api/diagnostics-avoidable.js";
import {
  type AvoidableRow,
  type DiagnosticsTriageView,
  buildDiagnosticsTriage,
} from "../../../src/query/api/diagnostics-triage.js";

// Expected values below are derived by hand from each fixture (plan U3b "Test scenarios"), not
// from running the code.

const AS_OF = new Date("2027-01-08T00:00:00.000Z");
const WS = "ws-triage";
const IN_WINDOW_MS = new Date("2027-01-03T10:00:00.000Z").getTime();

let db: Database.Database;
let sequence = 0;
let warnings: string[] = [];

const at = (offsetSeconds: number): string =>
  new Date(IN_WINDOW_MS + offsetSeconds * 1_000).toISOString();

function addSession(sessionId: string, title: string | null = null, lastTurnAt = at(0)): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags, title)
     VALUES (?, ?, '/fixture/triage.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]', ?)`,
  ).run(sessionId, WS, "2026-12-01T00:00:00.000Z", lastTurnAt, title);
}

function addTurn(sessionId: string, ts: string, costU = 100, contextTokens = 0): string {
  const messageId = `turn-${sequence++}`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id,
        cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet', 0, ?, 0, 0, 0, 0, 0, 0, NULL,
             ?, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(messageId, sessionId, WS, ts, contextTokens, costU);
  return messageId;
}

function addEvent(
  sessionId: string,
  toolName: string,
  ts: string,
  options: {
    turn?: string;
    exitClass?: "ERROR" | "OK";
    family?: string;
    interruptKind?: "HUMAN_DENY";
    command?: string;
    error?: string;
    resultBytes?: number;
  } = {},
): string {
  const eventId = `event-${sequence++}`;
  const messageId = options.turn ?? addTurn(sessionId, ts);
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash,
        exit_class, commit_sha, tool_error_class, tool_error_classifier_version,
        bash_command_family, interrupt_kind, interrupt_classifier_version)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(
    eventId,
    sessionId,
    ts,
    toolName,
    options.resultBytes ?? null,
    `hash-${eventId}`,
    options.exitClass ?? "OK",
    options.family ?? null,
    options.interruptKind ?? null,
    options.interruptKind === undefined ? null : "interrupt-1",
  );
  db.prepare(
    `INSERT INTO tool_event_metadata
       (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
     VALUES (?, NULL, ?, ?, 0)`,
  ).run(eventId, messageId, sequence);
  if (options.command !== undefined || options.error !== undefined)
    db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
      eventId,
      JSON.stringify({ command: options.command, error: options.error }),
    );
  return eventId;
}

function addIngest(
  sessionId: string,
  ts: string,
  options: { label?: string; destructiveOp?: string },
): void {
  db.prepare(
    `INSERT INTO ingest_metric_events
       (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error,
        is_interrupt, classifier_label, command_shape, event_ts, is_sidechain, destructive_op)
     VALUES (?, ?, NULL, 0, 0, 0, 0, ?, NULL, ?, 0, ?)`,
  ).run(
    `metric-${sequence++}`,
    sessionId,
    options.label ?? null,
    ts,
    options.destructiveOp ?? null,
  );
}

type Anchor = { session: string; ts: string; event?: string; message?: string };

function addV2Finding(detectorId: string, ruleId: string, anchors: Anchor[]): void {
  const evidence = {
    rule_id: ruleId,
    anchors: anchors.map((a) => ({
      session_id: findingIds.session(a.session),
      timestamp: a.ts,
      ...(a.event === undefined ? {} : { event_id: findingIds.event(a.event) }),
      ...(a.message === undefined ? {} : { message_id: findingIds.message(a.message) }),
    })),
  };
  db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
        modeled_formula_json, evidence_json, target_metric, state, created_at,
        contract_version, rule_id, contract_status)
     VALUES (?, 'RULE', ?, 'CONTEXT', ?, 'x', '{}', ?, 'x', 'PROPOSED', '2027-01-01',
             2, ?, 'V2_VALIDATED')`,
  ).run(`rec-${sequence++}`, detectorId, WS, JSON.stringify(evidence), ruleId);
}

function addV1Finding(
  detectorId: string,
  templateId: string,
  facts: Record<string, unknown>,
  options: { weekStart?: string; savingsU?: number; workspace?: string } = {},
): void {
  const ws = options.workspace ?? WS;
  db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
        modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric, state,
        created_at, contract_version, template_id, contract_status)
     VALUES (?, 'RULE', ?, 'CONTEXT', ?, 'x', ?, '{}', ?, 'x', 'PROPOSED', '2027-01-01',
             1, ?, 'V1_VALIDATED')`,
  ).run(
    `rec-${sequence++}`,
    detectorId,
    ws,
    options.savingsU ?? null,
    JSON.stringify({ version: 1, template_id: templateId, facts }),
    templateId,
  );
  db.prepare(
    `INSERT INTO detector_week_results
       (detector_id, scope_key, week_start, scope_workspace_id, fired, evaluated_at)
     VALUES (?, ?, ?, ?, 1, '2027-01-08T00:00:00.000Z')`,
  ).run(detectorId, `key-${sequence++}`, options.weekStart ?? "2027-01-04T00:00:00.000Z", ws);
}

const D2_FACTS = (sessionIds: string[]) => ({
  session_ids: sessionIds,
  qualifying_session_count: sessionIds.length,
  qualifying_turn_count: 400,
  raw_context_average_tokens_per_turn: 150_000.4,
  cap_weighted_burn_tokens_per_week: 1,
  cache_read_tokens_per_week: 1,
  cap_read_coefficient: 0.1,
});

function build(provider?: AvoidableProvider): DiagnosticsTriageView {
  return buildDiagnosticsTriage(db, 7, AS_OF, {
    ...(provider === undefined ? {} : { provider }),
    warn: (message) => warnings.push(message),
  });
}

const avoidable = (view: DiagnosticsTriageView, causeId: string): AvoidableRow => {
  const row = view.avoidable.causes.find((c) => c.cause_id === causeId);
  if (row === undefined) throw new Error(`no row ${causeId}`);
  return row;
};

const stub =
  (figures: Record<string, number | null>): AvoidableProvider =>
  () => ({
    causes: new Map(
      Object.entries(figures).map(([causeId, u]): [string, AvoidableCauseFigure] => [
        causeId,
        {
          avoidable_u: u,
          prev_avoidable_u: null,
          basis: u === null ? null : "LEDGER",
          coverage: "ALL",
        },
      ]),
    ),
    tile_u: Object.values(figures).reduce<number>((sum, u) => sum + (u ?? 0), 0),
  });

/**
 * Three spend causes over a window whose spend is exactly 10,000 µ$:
 * CONTEXT_TOO_LARGE 2 sessions (V1 D2), CACHE_REBUILT_MID_SESSION 2 sessions (V2 B4),
 * TOOL_RESULTS_TOO_LARGE 1 session (V2 A1).
 */
function threeSpendCauses(): void {
  const [t1, , t3, t4] = ["s1", "s2", "s3", "s4"].map((s) => addTurn(s, at(0), 2_500)) as [
    string,
    string,
    string,
    string,
  ];
  addV1Finding("D2", "D2_LONG_FULL_CONTEXT", D2_FACTS(["s1", "s2"]));
  addV2Finding("B4", "B4_MID_SESSION_PREFIX_BREAK", [
    { session: "s3", ts: at(0), message: t3 },
    { session: "s4", ts: at(0), message: t4 },
  ]);
  addV2Finding("A1", "A1_TOOL_RESULT_BLOAT", [{ session: "s1", ts: at(0), message: t1 }]);
}

beforeEach(() => {
  // Migrated but unseeded: every row is the test's.
  db = new Database(":memory:");
  runMigrations(db);
  sequence = 0;
  warnings = [];
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
  ).run(WS, WS, "2026-12-01T00:00:00.000Z");
  for (const s of ["s1", "s2", "s3", "s4"]) addSession(s, `Title ${s}`);
});
afterEach(() => db.close());

describe("buildDiagnosticsTriage (P4 U3b)", () => {
  describe("avoidable causes", () => {
    it("shows a V1 D2 finding in the window with no timing and a fact-line example", () => {
      addTurn("s1", at(0), 100);
      addTurn("s2", at(0), 900);
      addV1Finding("D2", "D2_LONG_FULL_CONTEXT", D2_FACTS(["s1", "s2"]));
      // Weeks match by (detector, workspace): this workspace's fired week ends before the window.
      addV1Finding("D2", "D2_LONG_FULL_CONTEXT", D2_FACTS(["s3"]), {
        weekStart: "2026-12-01T00:00:00.000Z",
        workspace: "ws-other",
      });

      const row = avoidable(build(), "CONTEXT_TOO_LARGE");
      expect(row.sessions_affected).toBe(2);
      expect(row.occurrences).toBe(2);
      expect(row.count_unit).toBe("sessions");
      expect(row.patterns).toEqual([
        { label: "Long session, no compaction", code: "D2_LONG_FULL_CONTEXT", count: 2 },
      ]);
      expect(row.when).toBeNull();
      // The highest-spend named session, with no turn.
      expect(row.example).toEqual({
        session_id: "s2",
        title: "Title s2",
        text: null,
        figure_line: "2 long sessions averaged 150,000 context tokens a turn",
      });
    });

    it("places V2 anchors in six position buckets; the example is the costliest, most recent", () => {
      // s1 has 6 turns; the anchored calls sit in turns 4 and 5 (0-based), equal cost.
      const turns: string[] = [0, 1, 2, 3, 4, 5].map((i) =>
        addTurn("s1", at(i * 10), i >= 4 ? 500 : 10),
      );
      const [fifth, sixth] = turns.slice(4) as [string, string];
      const early = addEvent("s1", "Bash", at(41), {
        turn: fifth,
        resultBytes: 1_024_000,
        command: "synthetic-cat first.log",
      });
      const late = addEvent("s1", "Bash", at(51), {
        turn: sixth,
        resultBytes: 2_048_000,
        command: "synthetic-cat second.log",
      });
      addV2Finding("A1", "A1_TOOL_RESULT_BLOAT", [
        { session: "s1", ts: at(41), event: early },
        { session: "s1", ts: at(51), event: late },
        { session: "s1", ts: "2026-12-01T00:00:00.000Z", event: early },
      ]);

      const row = avoidable(build(), "TOOL_RESULTS_TOO_LARGE");
      expect(row.occurrences).toBe(1);
      expect(row.patterns).toEqual([{ label: "Oversized tool result", code: "A1", count: 1 }]);
      expect(row.when).toEqual({
        buckets: [0, 0, 0, 0, 1, 1],
        weight: "occurrences",
        heaviest: "late",
      });
      expect(row.example).toEqual({
        session_id: "s1",
        title: "Title s1",
        message_id: sixth,
        turn_index: 5,
        text: "synthetic-cat second.log",
        figure_line: "Bash returned 2,000 KB",
      });
    });

    it("resolves a message anchor to its turn, with a context-token figure", () => {
      const [firstTurn] = [0, 1].map((i) => addTurn("s2", at(i), 300, 120_000)) as [string, string];
      addV2Finding("B4", "B4_MID_SESSION_PREFIX_BREAK", [
        { session: "s2", ts: at(0), message: firstTurn },
      ]);

      const row = avoidable(build(), "CACHE_REBUILT_MID_SESSION");
      expect(row.when?.buckets).toEqual([1, 0, 0, 0, 0, 0]);
      expect(row.when?.heaviest).toBe("early");
      expect(row.example).toEqual({
        session_id: "s2",
        title: "Title s2",
        message_id: firstTurn,
        turn_index: 0,
        text: null,
        figure_line: "120,000 context tokens in this turn",
      });
    });

    it("with the default provider: no shares, ordered by occurrences then name, nothing folds", () => {
      threeSpendCauses();

      const view = build();
      expect(view.avoidable.causes.map((c) => [c.cause_id, c.rank, c.featured])).toEqual([
        // 2 occurrences each; "Context grows…" sorts before "The cache…".
        ["CONTEXT_TOO_LARGE", 1, true],
        ["CACHE_REBUILT_MID_SESSION", 2, false],
        ["TOOL_RESULTS_TOO_LARGE", 3, false],
      ]);
      for (const row of view.avoidable.causes) {
        expect(row.share).toBeNull();
        expect(row.avoidable_u).toBeNull();
        expect(row.coverage).toBeNull();
        expect(row.folded).toBe(false);
        expect(row.trend_basis).toBe("session_rate");
      }
      expect(view.avoidable.banner).toBeNull();
      expect(view.tiles.avoidable_u).toBeNull();
      expect(view.tiles.avoidable_share).toBeNull();
      expect(view.tiles.spend_u).toBe(10_000);
    });

    it("ranks 3%, then 0.4% (folded), then the cause with no figure, with no banner", () => {
      threeSpendCauses();

      const view = build(
        stub({
          TOOL_RESULTS_TOO_LARGE: 300,
          CACHE_REBUILT_MID_SESSION: 40,
          CONTEXT_TOO_LARGE: null,
        }),
      );
      expect(
        view.avoidable.causes.map((c) => [c.cause_id, c.rank, c.share, c.folded, c.featured]),
      ).toEqual([
        ["TOOL_RESULTS_TOO_LARGE", 1, 0.03, false, true],
        ["CACHE_REBUILT_MID_SESSION", 2, 0.004, true, false],
        ["CONTEXT_TOO_LARGE", 3, null, false, false],
      ]);
      expect(view.avoidable.banner).toBeNull();
      expect(avoidable(view, "TOOL_RESULTS_TOO_LARGE").coverage).toBe("ALL");
      expect(view.tiles.avoidable_u).toBe(340);
      expect(view.tiles.avoidable_share).toBe(0.034);
    });

    it("AE2: a cause with no figure ranks after every cause with one, whatever its count", () => {
      threeSpendCauses();

      // CONTEXT_TOO_LARGE has 2 sessions, TOOL_RESULTS_TOO_LARGE 1.
      const view = build(stub({ TOOL_RESULTS_TOO_LARGE: 1, CONTEXT_TOO_LARGE: null }));
      const order = view.avoidable.causes.map((c) => c.cause_id);
      expect(order.indexOf("TOOL_RESULTS_TOO_LARGE")).toBeLessThan(
        order.indexOf("CONTEXT_TOO_LARGE"),
      );
    });

    it("AE3: all estimated causes under 1%, one not estimated → banner with a count of 1", () => {
      threeSpendCauses();

      const view = build(
        stub({
          TOOL_RESULTS_TOO_LARGE: 80,
          CACHE_REBUILT_MID_SESSION: 40,
          CONTEXT_TOO_LARGE: null,
        }),
      );
      expect(view.avoidable.banner).toEqual({ not_estimated_count: 1 });
      expect(view.avoidable.causes.map((c) => [c.cause_id, c.folded])).toEqual([
        ["TOOL_RESULTS_TOO_LARGE", false],
        ["CACHE_REBUILT_MID_SESSION", true],
        ["CONTEXT_TOO_LARGE", false],
      ]);
    });

    it("is a lower bound when a contributing V1 session list has 20 ids", () => {
      const ids = Array.from({ length: 20 }, (_, i) => `v1-${i}`);
      addTurn("s1", at(0));
      addV1Finding("D2", "D2_LONG_FULL_CONTEXT", D2_FACTS(ids));
      addV1Finding("D9", "D9_BACKGROUND_SESSION", {
        workspace_id: "w",
        fork_count: 3,
        session_ids: ids.slice(0, 19),
      });

      const view = build();
      expect(avoidable(view, "CONTEXT_TOO_LARGE").sessions_affected_is_lower_bound).toBe(true);
      expect(avoidable(view, "SUBAGENTS_COST_MORE_THAN_RETURN").sessions_affected).toBe(19);
      expect(
        avoidable(view, "SUBAGENTS_COST_MORE_THAN_RETURN").sessions_affected_is_lower_bound,
      ).toBe(false);
    });

    it("skips a finding with an unknown key with one warning, and an excluded key silently", () => {
      addTurn("s1", at(0));
      addV2Finding("A1", "A1_NOT_A_RULE", [{ session: "s1", ts: at(0) }]);
      addV1Finding("D5", "D5_LIMIT_BURN_WARNING", {
        forecast_state: "WARNING",
        session_ids: ["s1"],
        tokens_used: 1,
        limit_tokens: null,
        projected_exhaustion_jd: null,
        limit_scale_legacy: false,
      });

      const view = build();
      expect(view.avoidable.causes).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("A1");
      expect(warnings[0]).toContain("A1_NOT_A_RULE");
    });

    it("lists affected sessions by occurrences, then the most recent", () => {
      for (const s of ["s1", "s2", "s3"]) addTurn(s, at(0));
      db.prepare("UPDATE sessions SET last_turn_at = ? WHERE session_id = ?").run(at(100), "s3");
      addV2Finding("A1", "A1_TOOL_RESULT_BLOAT", [
        { session: "s1", ts: at(0) },
        { session: "s2", ts: at(0) },
        { session: "s3", ts: at(0) },
      ]);
      addV1Finding("D6", "D6_TOOL_RESULT_BLOAT", {
        workspace_id: "w",
        session_ids: ["s2"],
        session_count: 1,
        tool_result_bytes: 1,
        session_cap_weighted_tokens: 1,
        bloat_share: 0.5,
        turn_count: 1,
        bytes_per_token: 4,
      });

      expect(avoidable(build(), "TOOL_RESULTS_TOO_LARGE").sessions).toEqual([
        { session_id: "s2", title: "Title s2", occurrences: 2 },
        { session_id: "s3", title: "Title s3", occurrences: 1 },
        { session_id: "s1", title: "Title s1", occurrences: 1 },
      ]);
    });
  });

  describe("reliability", () => {
    it("caps a rejection's wait at 30 min, adds 0 with no earlier deny, and labels the breakdown", () => {
      addTurn("s1", at(0));
      addTurn("s2", at(0));
      const base = "2027-01-03T";
      const deny = (session: string, ts: string) =>
        addEvent(session, "Bash", ts, { interruptKind: "HUMAN_DENY" });
      deny("s1", `${base}09:00:00.000Z`);
      addIngest("s1", `${base}09:02:00.000Z`, { label: "user-rejected" }); // 2 min
      deny("s1", `${base}09:20:00.000Z`);
      addIngest("s1", `${base}10:05:00.000Z`, { label: "user-rejected" }); // 45 min → 30
      addIngest("s2", `${base}08:30:00.000Z`, { label: "user-rejected" }); // no deny → 0
      addIngest("s2", `${base}08:40:00.000Z`, { label: "hook-block" }); // instant → 0

      const view = build();
      const blocked = view.reliability.causes.find((c) => c.cause_id === "BLOCKED_BY_PERMISSIONS");
      expect(blocked?.occurrences).toBe(4);
      expect(blocked?.cost).toEqual({ wait_ms: 1_920_000, replan_u: null });
      expect(blocked?.breakdown).toEqual([
        { label: "rejected by you", count: 3 },
        { label: "hook", count: 1 },
      ]);
      expect(blocked?.count_unit).toBe("events");
      expect(blocked?.patterns).toEqual([
        { label: "Blocked by permissions", code: "C9", count: 4 },
      ]);
    });

    it("keeps the risk row out of the ranking, last, even when its share is the largest", () => {
      for (const s of ["s1", "s2", "s3", "s4"]) addTurn(s, at(0));
      addIngest("s1", at(5), { label: "deny-rule" });
      for (const s of ["s1", "s2", "s3"]) addIngest(s, at(6), { destructiveOp: "rm-rf" });

      const view = build();
      expect(view.reliability.causes.map((c) => [c.cause_id, c.rank, c.featured])).toEqual([
        ["BLOCKED_BY_PERMISSIONS", 1, true],
      ]);
      const risk = view.reliability.risk;
      expect(risk?.cause_id).toBe("DESTRUCTIVE_COMMANDS_RAN");
      expect(risk?.risk).toBe(true);
      expect(risk?.rank).toBe(0);
      expect(risk?.featured).toBe(false);
      expect(risk?.share).toBe(0.75);
      expect(risk?.breakdown).toEqual([{ label: "rm -rf", count: 3 }]);
      expect(risk).not.toHaveProperty("cost");
      expect(view.tiles.fix_ready).toEqual({ n: 0, m: 1 });
    });

    it("ranks by % of sessions, then events, then name; mixed-unit rows say occurrences", () => {
      for (const s of ["s1", "s2", "s3", "s4"]) addTurn(s, at(0));
      // Blocks: 1 session, 3 events. Edits (C6 anchors): 2 sessions.
      for (const offset of [5, 6, 7]) addIngest("s1", at(offset), { label: "hook-block" });
      addV2Finding("C6", "C6_EDIT_FLIP_FLOP", [
        { session: "s2", ts: at(10) },
        { session: "s3", ts: at(10) },
      ]);

      const causes = build().reliability.causes;
      expect(causes.map((c) => [c.cause_id, c.rank])).toEqual([
        ["EDITS_FAIL_OR_UNDONE", 1],
        ["BLOCKED_BY_PERMISSIONS", 2],
      ]);
      expect(causes[0]?.count_unit).toBe("occurrences");
      expect(causes[0]?.trend_basis).toBe("session_rate");
      expect(causes[0]?.cost).toEqual({ wait_ms: null, replan_u: null });
    });

    it("measures each rejection from the latest deny in its own session, in the window", () => {
      addTurn("s1", at(0));
      addTurn("s2", at(0));
      const base = "2027-01-03T";
      const deny = (session: string, ts: string) =>
        addEvent(session, "Bash", ts, { interruptKind: "HUMAN_DENY" });
      deny("s1", `${base}08:00:00.000Z`);
      deny("s1", `${base}09:00:00.000Z`);
      addIngest("s1", `${base}09:02:00.000Z`, { label: "user-rejected" }); // latest deny: 2 min
      deny("s1", `${base}09:20:00.000Z`);
      deny("s1", `${base}09:50:00.000Z`);
      addIngest("s1", `${base}10:05:00.000Z`, { label: "user-rejected" }); // latest deny: 15 min
      addIngest("s1", `${base}10:10:00.000Z`, { label: "hook-block" }); // after a deny, still 0
      // s1's 08:00 deny is another session's: s2 adds 0.
      addIngest("s2", `${base}08:30:00.000Z`, { label: "user-rejected" });
      // Before the window: not counted.
      deny("s1", "2026-12-31T23:00:00.000Z");
      addIngest("s1", "2026-12-31T23:10:00.000Z", { label: "user-rejected" });

      const blocked = build().reliability.causes.find(
        (c) => c.cause_id === "BLOCKED_BY_PERMISSIONS",
      );
      expect(blocked?.occurrences).toBe(4);
      expect(blocked?.cost.wait_ms).toBe(17 * 60_000);
    });

    it("lists the most frequent commands by shell family, at most 3", () => {
      const fail = (command: string, offset: number) =>
        addEvent("s1", "Bash", at(offset), {
          exitClass: "ERROR",
          family: "BASH_GIT",
          command,
          error: "Exit code 1\nsynthetic refusal",
        });
      // One C7 burst of shell failures (same family, within the burst gap).
      fail("git -C x diff main", 0);
      fail("git diff --stat", 300);
      fail("git status", 600);
      // Test, lint and build runs are expected failures (not C7 occurrences), so use other commands.
      fail("npm install", 900);
      fail("npx tsx script.ts", 1200);

      const shell = build().reliability.causes.find((c) => c.cause_id === "SHELL_FAILS_IN_BURSTS");
      expect(shell?.occurrences).toBe(5);
      // "git diff" names two different commands; the 1-count ties go by text, and the cap cuts "npx".
      expect(shell?.top_commands).toEqual([
        { text: "git diff", count: 2 },
        { text: "git status", count: 1 },
        { text: "npm install", count: 1 },
      ]);
      // RC-A U1: tool-event causes break down by tool name; blocks (ingest events) have none.
      expect(shell?.by_tool).toEqual([{ label: "Bash", count: 5 }]);
    });

    it("leaves the tool breakdown empty for causes without tool events", () => {
      addTurn("s1", at(0));
      addTurn("s2", at(0));
      addIngest("s1", at(5), { label: "hook-block" });
      addV2Finding("C6", "C6_EDIT_FLIP_FLOP", [{ session: "s2", ts: at(10) }]);

      const causes = build().reliability.causes;
      expect(causes.map((c) => [c.cause_id, c.by_tool])).toEqual([
        ["EDITS_FAIL_OR_UNDONE", []],
        ["BLOCKED_BY_PERMISSIONS", []],
      ]);
    });

    it("breaks equal session shares by events, then by name", () => {
      for (const s of ["s1", "s2", "s3", "s4"]) addTurn(s, at(0));
      for (const offset of [5, 6, 7]) addIngest("s1", at(offset), { label: "hook-block" });
      addV2Finding("C6", "C6_EDIT_FLIP_FLOP", [{ session: "s2", ts: at(10) }]);
      addV2Finding("G11", "G11_HIGH_SPEND_OBSERVED_FAILURE", [{ session: "s3", ts: at(10) }]);

      expect(build().reliability.causes.map((c) => c.cause_id)).toEqual([
        "BLOCKED_BY_PERMISSIONS",
        "EDITS_FAIL_OR_UNDONE",
        "TOOLS_FAIL_MORE_THAN_USUAL",
      ]);
    });
  });

  describe("avoidable details (review additions)", () => {
    it("picks the costliest anchor turn for the example, even when an earlier one", () => {
      const turns: string[] = [0, 1, 2, 3, 4, 5].map((i) =>
        addTurn("s1", at(i * 10), i === 1 ? 900 : 500),
      );
      addV2Finding("B4", "B4_MID_SESSION_PREFIX_BREAK", [
        { session: "s1", ts: at(10), message: turns[1] as string },
        { session: "s1", ts: at(40), message: turns[4] as string },
      ]);

      expect(avoidable(build(), "CACHE_REBUILT_MID_SESSION").example?.turn_index).toBe(1);
    });

    it("buckets by position within the session's own length", () => {
      const twelve: string[] = Array.from({ length: 12 }, (_, i) => addTurn("s2", at(i)));
      addV2Finding(
        "B4",
        "B4_MID_SESSION_PREFIX_BREAK",
        [1, 6, 11].map((i) => ({ session: "s2", ts: at(i), message: twelve[i] as string })),
      );
      const three: string[] = [0, 1, 2].map((i) => addTurn("s3", at(i)));
      addV2Finding("A1", "A1_TOOL_RESULT_BLOAT", [
        { session: "s3", ts: at(1), message: three[1] as string },
      ]);

      const view = build();
      // 12 turns: index 1 → 0, 6 → 3, 11 → 5; the three thirds tie, so the earliest wins.
      expect(avoidable(view, "CACHE_REBUILT_MID_SESSION").when).toEqual({
        buckets: [1, 0, 0, 1, 0, 1],
        weight: "occurrences",
        heaviest: "early",
      });
      // 3 turns: index 1 → bucket 2.
      expect(avoidable(view, "TOOL_RESULTS_TOO_LARGE").when).toEqual({
        buckets: [0, 0, 1, 0, 0, 0],
        weight: "occurrences",
        heaviest: "middle",
      });
    });

    it("counts D7's most-read calls toward timing only inside the window", () => {
      addTurn("s1", at(0), 900);
      const before = addEvent("s2", "Read", "2026-12-28T10:00:00.000Z");
      const inside = addEvent("s2", "Read", at(5));
      addV1Finding("D7", "D7_CROSS_SESSION_REREAD", {
        workspace_id: "w",
        redundant_path_count: 2,
        total_redundant_read_count: 9,
        total_redundant_result_bytes: 1,
        max_path_read_count: 5,
        max_path_session_count: 2,
        session_ids: ["s1"],
        top_read_event_ids: [before, inside],
      });

      const row = avoidable(build(), "SAME_FILES_REREAD_ACROSS_SESSIONS");
      // s2 has 2 turns; the in-window read owns the second (index 1 of 2 → bucket 3).
      expect(row.when?.buckets).toEqual([0, 0, 0, 1, 0, 0]);
      expect(row.example).toEqual({
        session_id: "s1",
        title: "Title s1",
        text: null,
        figure_line: "2 files were re-read 9 times across sessions",
      });
    });

    it("takes the V1 example from the finding with the largest headline", () => {
      addTurn("s1", at(0));
      addTurn("s2", at(0));
      addV1Finding("D2", "D2_LONG_FULL_CONTEXT", D2_FACTS(["s1"]), { savingsU: 10 });
      addV1Finding(
        "D2",
        "D2_LONG_FULL_CONTEXT",
        { ...D2_FACTS(["s2"]), qualifying_session_count: 7 },
        { savingsU: 500 },
      );
      addV1Finding("D6", "D6_TOOL_RESULT_BLOAT", {
        workspace_id: "w",
        session_ids: ["s1"],
        session_count: 3,
        tool_result_bytes: 1,
        session_cap_weighted_tokens: 1,
        bloat_share: 0.256,
        turn_count: 1,
        bytes_per_token: 4,
      });
      addV1Finding("D12", "D12_SUBAGENT_OVERSPAWN", {
        workspace_id: "w",
        sidechain_result_bytes: 51_200,
        sidechain_turn_count: 4,
        sidechain_session_count: 1,
        session_ids: ["s2"],
      });

      const view = build();
      expect(avoidable(view, "CONTEXT_TOO_LARGE").example).toMatchObject({
        session_id: "s2",
        figure_line: "7 long sessions averaged 150,000 context tokens a turn",
      });
      expect(avoidable(view, "TOOL_RESULTS_TOO_LARGE").example?.figure_line).toBe(
        "Tool output was 26% of context across 3 sessions",
      );
      expect(avoidable(view, "SUBAGENTS_COST_MORE_THAN_RETURN").example?.figure_line).toBe(
        "Subagents returned 50 KB across 4 turns",
      );
    });

    it("is a V2 lower bound only when a capped anchor list has an in-window hit", () => {
      const capped = (session: string, inWindow: boolean) =>
        [0, 1, 2, 3, 4].map((i) => ({
          session,
          ts: inWindow && i === 0 ? at(0) : `2026-12-0${i + 1}T00:00:00.000Z`,
        }));
      addTurn("s1", at(0));
      addV2Finding("A1", "A1_TOOL_RESULT_BLOAT", capped("s1", true));
      addV2Finding("B4", "B4_MID_SESSION_PREFIX_BREAK", capped("s2", false));
      addV2Finding("B1", "B1_CACHE_READ_COLLAPSE", [{ session: "s3", ts: at(0) }]);

      const view = build();
      expect(avoidable(view, "TOOL_RESULTS_TOO_LARGE").sessions_affected_is_lower_bound).toBe(true);
      expect(avoidable(view, "CACHE_REBUILT_MID_SESSION").sessions_affected_is_lower_bound).toBe(
        false,
      );
    });

    it("never folds the featured row; folds below 0.5% and banners below 1%, exclusive", () => {
      threeSpendCauses();

      const tiny = build(stub({ TOOL_RESULTS_TOO_LARGE: 40, CACHE_REBUILT_MID_SESSION: 20 }));
      expect(tiny.avoidable.causes.map((c) => [c.cause_id, c.featured, c.folded])).toEqual([
        ["TOOL_RESULTS_TOO_LARGE", true, false],
        ["CACHE_REBUILT_MID_SESSION", false, true],
        ["CONTEXT_TOO_LARGE", false, false],
      ]);
      // CONTEXT_TOO_LARGE has no figure, so it is not estimated (coverage null).
      expect(avoidable(tiny, "CONTEXT_TOO_LARGE").coverage).toBeNull();

      // Exactly 1% and exactly 0.5% of 10,000 µ$.
      const edge = build(stub({ TOOL_RESULTS_TOO_LARGE: 100, CACHE_REBUILT_MID_SESSION: 50 }));
      expect(edge.avoidable.banner).toBeNull();
      expect(avoidable(edge, "CACHE_REBUILT_MID_SESSION").folded).toBe(false);
      expect(edge.reliability.risk).toBeNull();
      expect(edge.tiles.fix_ready).toEqual({ n: 0, m: 3 });
    });

    it("lists a cause with a figure but no findings in the window", () => {
      addTurn("s1", at(0), 10_000);

      const row = avoidable(
        build(stub({ MODEL_BIGGER_THAN_NEEDED: 200 })),
        "MODEL_BIGGER_THAN_NEEDED",
      );
      expect(row).toMatchObject({ rank: 1, occurrences: 0, share: 0.02, avoidable_u: 200 });
    });

    describe("trend", () => {
      const PREVIOUS = new Date("2026-12-28T10:00:00.000Z").getTime();
      const X = Array.from({ length: 10 }, (_, i) => `x${i}`);
      /** 10 sessions in both windows; A1 names all 10 now and 5 before. History reaches back. */
      function tenAndFive(): void {
        for (const s of X) addSession(s);
        addTurn("x0", "2026-12-20T00:00:00.000Z", 0);
        for (const s of X) {
          addTurn(s, at(0));
          addTurn(s, new Date(PREVIOUS).toISOString());
        }
        addV2Finding("A1", "A1_TOOL_RESULT_BLOAT", [
          ...X.map((session) => ({ session, ts: at(1) })),
          ...X.slice(0, 5).map((session) => ({
            session,
            ts: new Date(PREVIOUS + 1_000).toISOString(),
          })),
        ]);
      }

      it("rises on the affected-session rate before figures exist", () => {
        tenAndFive();
        const row = avoidable(build(), "TOOL_RESULTS_TOO_LARGE");
        expect([row.trend, row.trend_basis]).toEqual(["rising", "session_rate"]);
      });

      it("follows the spend share once the provider has both windows' figures", () => {
        tenAndFive();
        // 300 of 1,000 now vs 900 of 1,000 before: falling, though the session rate rises.
        const provider: AvoidableProvider = () => ({
          causes: new Map([
            [
              "TOOL_RESULTS_TOO_LARGE",
              { avoidable_u: 300, prev_avoidable_u: 900, basis: "LEDGER", coverage: "ALL" },
            ],
          ]),
          tile_u: 300,
        });
        const row = avoidable(build(provider), "TOOL_RESULTS_TOO_LARGE");
        expect([row.trend, row.trend_basis]).toEqual(["falling", "spend_share"]);
      });
    });
  });

  it("gives spend 0, sessions 0 and null shares with no NaN when the window has no turns", () => {
    addIngest("s1", at(5), { label: "hook-block" });
    addV2Finding("A1", "A1_TOOL_RESULT_BLOAT", [{ session: "s1", ts: at(0) }]);

    const view = build();
    expect(view.tiles).toMatchObject({
      spend_u: 0,
      session_count: 0,
      avoidable_share: null,
      friction_share: null,
    });
    for (const row of [...view.avoidable.causes, ...view.reliability.causes])
      expect(row.share).toBeNull();
    // JSON.stringify would turn NaN into null, so walk the object itself.
    const numbers: number[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "number") numbers.push(value);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(view);
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers.every(Number.isFinite)).toBe(true);
    expect(view.window_days).toBe(7);
    expect(view.as_of).toBe(AS_OF.toISOString());
  });

  it("RC-B U3: every one of the 16 causes is either ranked or silent, never both", () => {
    addIngest("s1", at(5), { label: "hook-block" });
    addV2Finding("A1", "A1_TOOL_RESULT_BLOAT", [{ session: "s1", ts: at(0) }]);

    const view = build();
    const ranked = [
      ...view.avoidable.causes,
      ...view.reliability.causes,
      ...(view.reliability.risk ? [view.reliability.risk] : []),
    ].map((r) => r.cause_id);
    const silent = [...(view.avoidable.silent ?? []), ...(view.reliability.silent ?? [])];
    expect(ranked).toContain("TOOL_RESULTS_TOO_LARGE");
    expect(silent.map((s) => s.cause_id)).not.toContain("TOOL_RESULTS_TOO_LARGE");
    expect(new Set([...ranked, ...silent.map((s) => s.cause_id)]).size).toBe(16);
    expect(ranked.length + silent.length).toBe(16);
    expect(view.avoidable.silent?.map((s) => s.cause_id)).toContain("MODEL_BIGGER_THAN_NEEDED");
    expect(silent.every((s) => s.name.length > 0)).toBe(true);
  });
});
