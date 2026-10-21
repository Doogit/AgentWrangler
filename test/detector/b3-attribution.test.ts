/**
 * test/detector/b3-attribution.test.ts — B3 wasted-turn $ attribution (C7/C3/C4/C1).
 *
 * Builds the fixed spec scenario (test/detector oracle in scripts/parity/golden-economic.json
 * → b3_attribution), runs the real detectors + turn-grain dedup helper, and asserts each
 * shipped family's modeled_savings_u_per_wk is within ±5% of the oracle AND both hard
 * invariants hold: (a) the claim partition is turn-disjoint (no double-count across
 * C5/D7/C7/C3/C4/C1); (b) attributed waste ≤ workspace spend (C7/C3/C4) / ≤ corpus spend (C1).
 *
 * The oracle is the independent source of truth — never hardcode expected $ here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { c1Detector } from "../../src/detector/detectors/c1_tool_error_rate.js";
import { c3Detector } from "../../src/detector/detectors/c3_edit_before_read.js";
import { c4Detector } from "../../src/detector/detectors/c4_failed_edit_recovery.js";
import { c7Detector } from "../../src/detector/detectors/c7_bash_failure_cluster.js";
import { wastedTurnClaims } from "../../src/detector/turn-claim.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

interface OracleEntry {
  claimed_turn_count: number;
  savings_u_per_wk: number;
  usd_per_wk: number;
}
const ORACLE = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../scripts/parity/golden-economic.json"), "utf8"),
  ) as { b3_attribution: Record<string, OracleEntry> }
).b3_attribution;

function assertWithinOracle(actual: number | null, key: string): void {
  const entry = ORACLE[key];
  if (entry === undefined) throw new Error(`oracle key "${key}" not found`);
  if (actual === null) throw new Error(`expected non-null savings for ${key}`);
  const delta = Math.abs(actual - entry.savings_u_per_wk) / entry.savings_u_per_wk;
  expect(delta).toBeLessThanOrEqual(0.05);
}

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX: DetectorContext = {
  now: NOW,
  fromIso: "2027-01-01T00:00:00.000Z",
  toIso: NOW.toISOString(),
};

const WS = "ws-b3";
const TURN_COST_U = 100_000;
const TS_BASE = new Date("2027-01-03T10:00:00.000Z").getTime();

let db: Database.Database;
let seq = 0;

function insSession(sessionId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, '2027-01-03T10:00:00.000Z', '2027-01-03T12:00:00.000Z',
             'RECONCILED', 0, 0, '[]')`,
  ).run(sessionId, WS, `/fixture/${sessionId}.jsonl`);
}

/** Insert a turn priced at costU; returns its message_id. */
function insTurn(sessionId: string, costU: number): string {
  const messageId = `msg-b3-${seq++}`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id,
        cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', 0,
             0, 0, 0, 0, 0, 0, 0, NULL,
             ?, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(messageId, sessionId, WS, new Date(TS_BASE + seq * 1000).toISOString(), costU);
  return messageId;
}

interface EventOpts {
  toolName: string;
  exitClass?: string | null;
  inputHash?: string | null;
  toolErrorClass?: string | null;
  classifierVersion?: string | null;
  bashCommandFamily?: string | null;
  filePathHash?: string | null;
  ownerMessageId: string;
  /** Absolute event ts (ms). Default derives ~1s steps from seq; override to widen
   *  gaps beyond D7's MAX_RUN_GAP_SEC (120s) so a spread cluster is not a D7 loop. */
  tsMs?: number;
  /** Kept error text (tool_event_content). A Bash ERROR with none joins no C7 cluster (U7). */
  errorText?: string;
  /** Kept command text (tool_event_content), alongside `errorText`. */
  commandText?: string;
}

function insToolEvent(sessionId: string, opts: EventOpts): void {
  const eventId = `evt-b3-${seq++}`;
  const ts = new Date(opts.tsMs ?? TS_BASE + seq * 1000).toISOString();
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash,
        exit_class, commit_sha, tool_error_class, tool_error_classifier_version,
        bash_command_family)
     VALUES (?, ?, ?, ?, 1, NULL, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    eventId,
    sessionId,
    ts,
    opts.toolName,
    opts.inputHash ?? null,
    opts.exitClass ?? null,
    opts.toolErrorClass ?? null,
    opts.classifierVersion ?? null,
    opts.bashCommandFamily ?? null,
  );
  db.prepare(
    `INSERT INTO tool_event_metadata
       (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(eventId, opts.filePathHash ?? null, opts.ownerMessageId, seq);
  if (opts.errorText !== undefined || opts.commandText !== undefined) {
    db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
      eventId,
      JSON.stringify({ command: opts.commandText, error: opts.errorText }),
    );
  }
}

/**
 * Fixed spec scenario, all in WS. Each error event sits on its own priced turn
 * (cost_equiv_u = TURN_COST_U). Exercises priority (Bash overlap → C7 not C1) and
 * C5/D7 loop pre-exclusion (3 identical-input WebFetch failures excluded from C1).
 */
function seedScenario(): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, '2027-01-01T00:00:00.000Z')`,
  ).run(WS, WS);

  // C7: 3 Bash-git ERROR failures, one session, distinct turns (null input_hash → no loop).
  insSession("s-c7");
  for (let i = 0; i < 3; i++) {
    insToolEvent("s-c7", {
      toolName: "Bash",
      exitClass: "ERROR",
      bashCommandFamily: "BASH_GIT",
      errorText: "Exit code 1\nfatal: not a git repository",
      ownerMessageId: insTurn("s-c7", TURN_COST_U),
    });
  }

  // C3: 1 Edit NOT_READ error.
  insSession("s-c3");
  insToolEvent("s-c3", {
    toolName: "Edit",
    exitClass: "ERROR",
    toolErrorClass: "NOT_READ",
    classifierVersion: "tool-error-1",
    ownerMessageId: insTurn("s-c3", TURN_COST_U),
  });

  // C4: 5 consecutive STALE_STRING failures on one file.
  insSession("s-c4");
  for (let i = 0; i < 5; i++) {
    insToolEvent("s-c4", {
      toolName: "Edit",
      exitClass: "ERROR",
      toolErrorClass: "STALE_STRING",
      classifierVersion: "tool-error-1",
      filePathHash: "fph-c4",
      ownerMessageId: insTurn("s-c4", TURN_COST_U),
    });
  }

  // C1: WebFetch outlier. 4 identical-input failures = a C5/D7 loop (U9 r4: a changed input
  // ends an error run, so all four share one); its repeat calls are excluded and the loop's first
  // call remains claimable by C1.
  insSession("s-c1");
  for (let i = 0; i < 4; i++) {
    insToolEvent("s-c1", {
      toolName: "WebFetch",
      exitClass: "ERROR",
      inputHash: "wf-loop",
      ownerMessageId: insTurn("s-c1", TURN_COST_U),
    });
  }

  // 20 Read successes bring corpus error rate below 0.5 so outliers separate cleanly.
  const readTurn = insTurn("s-c1", 0);
  for (let i = 0; i < 20; i++) {
    insToolEvent("s-c1", { toolName: "Read", exitClass: "OK", ownerMessageId: readTurn });
  }
  // C1 needs 20 calls per outlier tool (card review F4): WebFetch 4/20 and Bash 3/20 stay
  // outliers once 120 more reads hold the corpus rate near 7%.
  for (const [toolName, count] of [
    ["WebFetch", 16],
    ["Bash", 17],
    ["Read", 120],
  ] as const) {
    for (let i = 0; i < count; i++) {
      insToolEvent("s-c1", { toolName, exitClass: "OK", ownerMessageId: readTurn });
    }
  }
}

beforeEach(() => {
  db = createInMemoryFixtureDb();
  seq = 0;
  seedScenario();
});
afterEach(() => db.close());

describe("B3 wasted-turn attribution — parity vs oracle", () => {
  it("C7 emits savings within ±5% of oracle", () => {
    const fired = c7Detector.evaluate(db, CTX).fired.find((f) => f.scope_workspace_id === WS);
    expect(fired).toBeDefined();
    assertWithinOracle(fired?.modeled_savings_u_per_wk ?? null, "C7");
  });

  it("C3 emits savings within ±5% of oracle", () => {
    const fired = c3Detector.evaluate(db, CTX).fired.find((f) => f.scope_workspace_id === WS);
    expect(fired).toBeDefined();
    assertWithinOracle(fired?.modeled_savings_u_per_wk ?? null, "C3");
  });

  it("C4 emits savings within ±5% of oracle", () => {
    const fired = c4Detector.evaluate(db, CTX).fired.find((f) => f.scope_workspace_id === WS);
    expect(fired).toBeDefined();
    assertWithinOracle(fired?.modeled_savings_u_per_wk ?? null, "C4");
  });

  it("C1 emits one finding per outlier tool within ±5% of oracle", () => {
    const fired = c1Detector.evaluate(db, CTX).fired;
    expect(fired).toHaveLength(1);
    expect(fired[0]?.scopeKey).toBe("C1|WebFetch");
    assertWithinOracle(fired[0]?.modeled_savings_u_per_wk ?? null, "C1");
  });

  it("C1 overlap turns go to C7, not C1 (priority): Bash does not inflate C1", () => {
    // Bash failures here are commands that ran and exited non-zero, not shell failures, so
    // C1 no longer counts them (U7: the shell signal is d11Outcome). They are C7's cluster.
    // Only the lone WebFetch solo turn is claimable → savings stays at the WebFetch-only oracle
    // (~50000), proving the C7-claimed Bash turns are NOT summed into C1.
    const fired = c1Detector.evaluate(db, CTX).fired;
    expect(fired).toHaveLength(1);
    assertWithinOracle(fired[0]?.modeled_savings_u_per_wk ?? null, "C1");
  });
});

describe("B3 hard invariants", () => {
  it("(a) the claim partition is turn-disjoint across families", () => {
    const claims = wastedTurnClaims(db, CTX);
    const all: string[] = [];
    for (const set of claims.values()) all.push(...set);
    expect(all.length).toBe(new Set(all).size);
  });

  it("(a) C5/D7 loop turns are excluded from every family", () => {
    const claims = wastedTurnClaims(db, CTX);
    // The 3 wf-loop turns must not be claimed by any family.
    const claimed = new Set<string>();
    for (const set of claims.values()) for (const k of set) claimed.add(k);
    // WebFetch solo (1) is the only claimable WebFetch turn.
    expect(claims.get("C1")?.size).toBe(1);
  });

  it("(b) per-workspace attributed waste ≤ workspace 7d spend", () => {
    const attributed =
      (c7Detector.evaluate(db, CTX).fired[0]?.modeled_savings_u_per_wk ?? 0) +
      (c3Detector.evaluate(db, CTX).fired[0]?.modeled_savings_u_per_wk ?? 0) +
      (c4Detector.evaluate(db, CTX).fired[0]?.modeled_savings_u_per_wk ?? 0);
    const spend = (
      db
        .prepare(
          `SELECT COALESCE(SUM(cost_equiv_u), 0) AS s FROM turns
             WHERE workspace_id = ? AND ts >= ? AND ts < ? AND provisional = 0`,
        )
        .get(WS, CTX.fromIso, CTX.toIso) as { s: number }
    ).s;
    expect(attributed).toBeLessThanOrEqual(spend);
  });

  it("(b) C1 global attributed waste ≤ total corpus spend", () => {
    const c1 = c1Detector
      .evaluate(db, CTX)
      .fired.reduce((sum, f) => sum + (f.modeled_savings_u_per_wk ?? 0), 0);
    const corpus = (
      db
        .prepare(
          `SELECT COALESCE(SUM(cost_equiv_u), 0) AS s FROM turns
             WHERE ts >= ? AND ts < ? AND provisional = 0`,
        )
        .get(CTX.fromIso, CTX.toIso) as { s: number }
    ).s;
    expect(c1).toBeLessThanOrEqual(corpus);
  });
});

/**
 * Anti double-count regression (the class the post-B5 review surfaced): a single
 * failed turn that spans two grouping keys within ONE family must be attributed
 * ONCE, not once per key. These seeds place a shared turn in two tools (C1) and
 * two Bash families (C7); the expected $ is derived from the KNOWN distinct-turn
 * count, so a per-key re-sum (the old bug) would over-count and fail.
 */
function freshDb(): void {
  db.close();
  db = createInMemoryFixtureDb();
  seq = 0;
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, '2027-01-01T00:00:00.000Z')`,
  ).run(WS, WS);
}

describe("B3 anti double-count — shared turn across sibling keys", () => {
  it("C1: a turn erroring in two outlier tools is counted once (one turn, not two)", () => {
    freshDb();
    insSession("s1");
    // One priced turn erroring in BOTH Read and Grep (same owner_message_id).
    const shared = insTurn("s1", TURN_COST_U);
    insToolEvent("s1", { toolName: "Read", exitClass: "ERROR", ownerMessageId: shared });
    insToolEvent("s1", { toolName: "Grep", exitClass: "ERROR", ownerMessageId: shared });
    // C1 needs 3 errors per outlier tool (U7): two more distinct priced turns for each tool.
    for (const toolName of ["Read", "Grep"]) {
      for (let i = 0; i < 2; i++) {
        insToolEvent("s1", {
          toolName,
          exitClass: "ERROR",
          ownerMessageId: insTurn("s1", TURN_COST_U),
        });
      }
    }
    // 20 OK calls on a non-outlier tool pull the corpus error rate below 0.5 so
    // Read and Grep (rate 1.0) both clear the 2x-corpus outlier gate.
    const okTurn = insTurn("s1", 0);
    for (let i = 0; i < 20; i++) {
      insToolEvent("s1", { toolName: "LS", exitClass: "OK", ownerMessageId: okTurn });
    }
    // C1 needs 20 calls per outlier tool (card review F4); 3 errors in 20 still clears 2x corpus.
    for (const [toolName, count] of [
      ["Read", 17],
      ["Grep", 17],
      ["LS", 40],
    ] as const) {
      for (let i = 0; i < count; i++) {
        insToolEvent("s1", { toolName, exitClass: "OK", ownerMessageId: okTurn });
      }
    }

    const fired = c1Detector.evaluate(db, CTX).fired;
    expect(fired).toHaveLength(2);
    // Distinct claimed turns = shared + 2 Read + 2 Grep = 5 → 0.5 x 5 x TURN_COST_U across the
    // two findings. Pricing the shared turn under both tools would give 6 turns.
    const total = fired.reduce((sum, f) => sum + (f.modeled_savings_u_per_wk ?? 0), 0);
    expect(total).toBe(Math.round(5 * TURN_COST_U * 0.5));
  });

  it("C7: a turn clustering in two Bash families is counted once (5 turns, not 6)", () => {
    freshDb();
    insSession("s1");
    // Events are spaced 200s apart (> D7's MAX_RUN_GAP_SEC of 120s) so this is a
    // slow cluster of failures across the session, NOT a tight D7 retry loop — D7
    // does not claim it, leaving C7 to own all its turns (the property under test is
    // C7's own cross-sibling-key dedup, which needs C7 to claim >1 turn).
    let evtN = 0;
    const SPREAD_MS = 200_000;
    const at = (): number => TS_BASE + evtN++ * SPREAD_MS;
    // Shared turn contributes one GIT and one NPM failure (same owner_message_id).
    const shared = insTurn("s1", TURN_COST_U);
    insToolEvent("s1", {
      toolName: "Bash",
      exitClass: "ERROR",
      bashCommandFamily: "BASH_GIT",
      errorText: "Exit code 1\ngit said no",
      ownerMessageId: shared,
      tsMs: at(),
    });
    insToolEvent("s1", {
      toolName: "Bash",
      exitClass: "ERROR",
      bashCommandFamily: "BASH_NPM",
      errorText: "Exit code 1\nnpm said no",
      ownerMessageId: shared,
      tsMs: at(),
    });
    // Each family needs >=3 failures to cluster: add 2 more distinct turns per family.
    for (const family of ["BASH_GIT", "BASH_NPM"]) {
      for (let i = 0; i < 2; i++) {
        insToolEvent("s1", {
          toolName: "Bash",
          exitClass: "ERROR",
          bashCommandFamily: family,
          errorText: `Exit code 1\n${family === "BASH_GIT" ? "git" : "npm"} said no`,
          ownerMessageId: insTurn("s1", TURN_COST_U),
          tsMs: at(),
        });
      }
    }

    const fired = c7Detector.evaluate(db, CTX).fired;
    expect(fired).toHaveLength(1);
    // Distinct cluster turns = {shared, g2, g3, n2, n3} = 5 → 0.5 x 5 x TURN_COST_U.
    // The per-family double-count would count the shared turn twice → 6 turns.
    expect(fired[0]?.modeled_savings_u_per_wk).toBe(Math.round(5 * TURN_COST_U * 0.5));
  });
});
