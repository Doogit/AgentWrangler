import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  C5_CEU_HIGH_THRESHOLD,
  C5_CEU_MEDIUM_THRESHOLD,
  C5_MIN_IDENTICAL_ERRORS,
  c5CeuBand,
  c5Detector,
  c5FindingDescriptor,
} from "../../../src/detector/detectors/c5_same_error_loop.js";
import { buildContext } from "../../../src/detector/engine.js";
import {
  assertFindingEnvelopeV2,
  createFindingEnvelopeV2,
  findingIds,
} from "../../../src/detector/privacy-contract.js";
import { seedListPrices } from "../../../src/ingest/pricing.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";
import { assertV2ProducerBoundary } from "../../fixtures/v2-producer-boundary.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
let db: Database.Database;
let sequence = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  sequence = 0;
  db.exec(`
    INSERT INTO workspaces (workspace_id, project_slug, registered_at)
    VALUES ('ws-c5', 'ws-c5', '${CTX.fromIso}');
    INSERT INTO sessions
      (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
    VALUES ('session-c5-a', 'ws-c5', '/fixture/c5-a.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'RECONCILED', 0, 0, '[]'),
           ('session-c5-b', 'ws-c5', '/fixture/c5-b.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'RECONCILED', 0, 0, '[]');
  `);
});

afterEach(() => db.close());

function addError(
  sessionId: "session-c5-a" | "session-c5-b",
  toolName: string,
  errorClass: "NOT_FOUND" | "NOT_READ" | "STALE_STRING" | null,
  options: {
    sidechain?: number;
    provisional?: number;
    exitClass?: "OK" | "ERROR";
    model?: string;
    outputTokens?: number;
    pricingSnapshotId?: string;
    inputBytes?: number;
    resultBytes?: number;
    errorText?: string | null;
    at?: string;
  } = {},
): void {
  const suffix = sequence++;
  const eventId = `c5-event-${suffix}`;
  const messageId = `c5-message-${suffix}`;
  const ts = options.at ?? `2027-01-02T00:00:${String(suffix).padStart(2, "0")}.000Z`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, pricing_snapshot_id, cost_equiv_u,
        cost_claim, provisional, parser_version)
     VALUES (?, ?, 'ws-c5', ?, ?, ?, 0, ?, 0, 0, 0, 0, ?, 0,
             'LIST_EQUIV', ?, 'test-v1')`,
  ).run(
    messageId,
    sessionId,
    ts,
    options.model ?? "claude-sonnet-4-6",
    options.sidechain ?? 0,
    options.outputTokens ?? 0,
    options.pricingSnapshotId ?? null,
    options.provisional ?? 0,
  );
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, input_bytes, result_bytes, exit_class, tool_error_class, tool_error_classifier_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    sessionId,
    ts,
    toolName,
    options.inputBytes ?? 0,
    options.resultBytes ?? 0,
    options.exitClass ?? (errorClass === null ? "OK" : "ERROR"),
    errorClass,
    errorClass === null ? null : "tool-error-1",
  );
  db.prepare(
    `INSERT INTO tool_event_metadata
       (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
     VALUES (?, NULL, ?, ?, 0)`,
  ).run(eventId, messageId, suffix);
  // U7: a failure with no kept error text joins no loop, so a classified fixture error carries
  // text naming its class unless the test says otherwise (`errorText: null` keeps none).
  const errorText =
    options.errorText === undefined
      ? errorClass === null
        ? null
        : `${errorClass.toLowerCase()} error`
      : options.errorText;
  if (errorText !== null) {
    db.prepare(
      `INSERT INTO tool_event_content (event_id, content_json)
       VALUES (?, ?)`,
    ).run(eventId, JSON.stringify({ error: errorText }));
  }
}

describe("C5 SAME_ERROR_LOOP V2 (U7: no classifier gate)", () => {
  it("fires on an unclassified shell error repeated in three turns", () => {
    for (let index = 0; index < C5_MIN_IDENTICAL_ERRORS; index++) {
      addError("session-c5-a", "Bash", null, {
        exitClass: "ERROR",
        errorText: "Exit code 2\ncannot open the config file",
      });
    }
    const outcome = c5Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
  });

  it("U9 r2: the same error text spread over an hour and a half is not a retry loop", () => {
    for (const at of [
      "2027-01-02T05:24:00.000Z",
      "2027-01-02T06:00:00.000Z",
      "2027-01-02T06:49:00.000Z",
    ]) {
      addError("session-c5-a", "Bash", null, {
        exitClass: "ERROR",
        errorText: "Exit code 2\ncannot open the config file",
        at,
      });
    }
    expect(c5Detector.evaluate(db, CTX).fired).toHaveLength(0);
    // The same three errors a few minutes apart are a loop.
    for (const at of [
      "2027-01-03T05:24:00.000Z",
      "2027-01-03T05:27:00.000Z",
      "2027-01-03T05:31:00.000Z",
    ]) {
      addError("session-c5-a", "Bash", null, {
        exitClass: "ERROR",
        errorText: "Exit code 2\ncannot open the config file",
        at,
      });
    }
    expect(c5Detector.evaluate(db, CTX).fired).toHaveLength(1);
  });

  it("U9 r7: a not-read Write belongs to C3 and a guard block to C9, so neither is a C5 loop", () => {
    const notRead =
      "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>";
    const blocked =
      "Blocked command shape (CLAUDE.md rules 1-3 + destructive git): cd&&-prefix / in-place edits (sed -i, perl -i, python -c) / heredoc edits (<<) / tmp writes / git reset --hard / git clean / git stash -u. Use a bare cd then bare commands.";
    for (let index = 0; index < C5_MIN_IDENTICAL_ERRORS; index++) {
      addError("session-c5-a", "Write", null, { exitClass: "ERROR", errorText: notRead });
      addError("session-c5-b", "Bash", null, { exitClass: "ERROR", errorText: blocked });
    }
    // F32: a guard's own deny text has no "hook error" prefix and no ingest label C5 can join to
    // the call, but a shell error without "Exit code N" never ran.
    expect(c5Detector.evaluate(db, CTX).fired).toHaveLength(0);
  });

  it("F32: shell errors that never ran and settings deny-rule texts are no C5 loop", () => {
    for (let index = 0; index < C5_MIN_IDENTICAL_ERRORS; index++) {
      addError("session-c5-a", "Bash", null, {
        exitClass: "ERROR",
        errorText: "<tool_use_error>Blocked: standalone sleep 90.</tool_use_error>",
      });
      addError("session-c5-a", "PowerShell", null, {
        exitClass: "ERROR",
        errorText: "Blocked PowerShell shape: in-place edit",
      });
      addError("session-c5-b", "Edit", null, {
        exitClass: "ERROR",
        errorText: "Permission to use Edit has been denied.",
      });
    }
    expect(c5Detector.evaluate(db, CTX).fired).toEqual([]);
    // Control: the same shell failure that ran ("Exit code N") still loops.
    for (let index = 0; index < C5_MIN_IDENTICAL_ERRORS; index++) {
      addError("session-c5-a", "PowerShell", null, {
        exitClass: "ERROR",
        errorText: "Exit code 1\nBlocked PowerShell shape: in-place edit",
      });
    }
    expect(c5Detector.evaluate(db, CTX).fired).toHaveLength(1);
  });

  it("does not loop on a user rejection or a hook block, and needs error text", () => {
    for (let index = 0; index < C5_MIN_IDENTICAL_ERRORS; index++) {
      addError("session-c5-a", "Edit", null, {
        exitClass: "ERROR",
        errorText:
          "The user doesn't want to proceed with this tool use. The tool use was rejected.",
      });
      addError("session-c5-a", "Bash", null, {
        exitClass: "ERROR",
        errorText: "PreToolUse:Bash hook error: Blocked command shape",
      });
      addError("session-c5-a", "WebFetch", null, { exitClass: "ERROR", errorText: null });
    }
    expect(c5Detector.evaluate(db, CTX).fired).toEqual([]);
  });

  it("counts distinct turns: parallel calls of one turn are not retries", () => {
    // Three identical errors, all on one owner turn.
    const messageId = "c5-parallel-turn";
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
          cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u,
          cost_claim, provisional, parser_version)
       VALUES (?, 'session-c5-a', 'ws-c5', '2027-01-02T01:00:00.000Z', 'claude-sonnet-4-6', 0, 0, 0,
               0, 0, 0, 0, 0, 'LIST_EQUIV', 0, 'test-v1')`,
    ).run(messageId);
    for (let index = 0; index < C5_MIN_IDENTICAL_ERRORS; index++) {
      const eventId = `c5-parallel-${index}`;
      db.prepare(
        `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes, exit_class)
         VALUES (?, 'session-c5-a', ?, 'Bash', 0, 0, 'ERROR')`,
      ).run(eventId, `2027-01-02T01:00:0${index}.000Z`);
      db.prepare(
        `INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
         VALUES (?, NULL, ?, ?, 0)`,
      ).run(eventId, messageId, index);
      db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
        eventId,
        JSON.stringify({ error: "Exit code 1\nsame text" }),
      );
    }
    expect(c5Detector.evaluate(db, CTX).fired).toEqual([]);
  });
});

describe("C5 SAME_ERROR_LOOP V2", () => {
  it("assigns deterministic CEU magnitude bands at the documented thresholds", () => {
    expect(c5CeuBand(C5_CEU_MEDIUM_THRESHOLD - 0.001)).toBe("LOW");
    expect(c5CeuBand(C5_CEU_MEDIUM_THRESHOLD)).toBe("MEDIUM");
    expect(c5CeuBand(C5_CEU_HIGH_THRESHOLD - 0.001)).toBe("MEDIUM");
    expect(c5CeuBand(C5_CEU_HIGH_THRESHOLD)).toBe("HIGH");
  });

  it("emits one privacy-safe per-session finding at three identical classified errors", () => {
    for (let index = 0; index < C5_MIN_IDENTICAL_ERRORS; index++) {
      addError("session-c5-a", "PrivateMcpTool", "NOT_FOUND");
    }

    const outcome = c5Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, c5Detector);

    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.payload).toMatchObject({
      version: 2,
      rule_id: "C5_SAME_ERROR_LOOP",
      label: "SAME_ERROR_LOOP",
      routing: { tier: "T3" },
      assessment: { posture: "REVIEW" },
      metrics: {
        ERROR_LOOP_COUNT: { kind: "COUNT", value: 1 },
        REPEATED_ERROR_COUNT: { kind: "COUNT", value: 3 },
        LOOP_EXCESS_ERROR_COUNT: { kind: "COUNT", value: 1 },
        AFFECTED_TOOL_COUNT: { kind: "COUNT", value: 1 },
        AFFECTED_ERROR_CLASS_COUNT: { kind: "COUNT", value: 1 },
      },
    });
    expect(outcome.fired[0]?.payload.anchors).toHaveLength(3);
    // ADR-112 amendment (2026-09-25): in-app findings carry the real tool name as free text;
    // the closed error class is still grouping-only.
    expect(outcome.fired[0]?.payload).toMatchObject({
      metrics: { TOP_LOOP_TOOL: { kind: "TEXT", value: "PrivateMcpTool" } },
    });
    const serialized = JSON.stringify(outcome.fired[0]?.payload);
    expect(serialized).not.toContain("NOT_FOUND");
  });

  it("still validates a finding persisted before the TEXT metrics existed", () => {
    for (let index = 0; index < C5_MIN_IDENTICAL_ERRORS; index++) {
      addError("session-c5-a", "Read", "NOT_FOUND");
    }
    // Rebuild the envelope (fresh digest) as a pre-TEXT producer would have written it.
    const { evidence_digest: _digest, ...body } = structuredClone(
      c5Detector.evaluate(db, CTX).fired[0]?.payload,
    ) as unknown as { evidence_digest: string; metrics: Record<string, unknown> };
    const { TOP_LOOP_TOOL: _tool, TOP_LOOP_ERROR_TEXT: _text, ...legacyMetrics } = body.metrics;
    const legacy = createFindingEnvelopeV2(
      { ...body, metrics: legacyMetrics } as never,
      c5FindingDescriptor,
    );
    expect(() => assertFindingEnvelopeV2(legacy, c5FindingDescriptor)).not.toThrow();
    // A non-TEXT metric is still required.
    const { ERROR_LOOP_COUNT: _count, ...missingCount } = legacyMetrics;
    expect(() =>
      createFindingEnvelopeV2({ ...body, metrics: missingCount } as never, c5FindingDescriptor),
    ).toThrow(/finding metrics keys/);
  });

  it("does not combine different sessions, tools, or error classes", () => {
    for (let index = 0; index < 2; index++) addError("session-c5-a", "Read", "NOT_FOUND");
    addError("session-c5-a", "Edit", "NOT_FOUND");
    addError("session-c5-a", "Read", "NOT_READ");
    addError("session-c5-b", "Read", "NOT_FOUND");

    expect(c5Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("clusters retained error text across classes after normalization", () => {
    for (const errorClass of ["NOT_FOUND", "NOT_READ", "STALE_STRING"] as const) {
      addError("session-c5-a", "Read", errorClass, { errorText: "  Missing\nfixture file  " });
    }

    const outcome = c5Detector.evaluate(db, CTX);

    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.payload.metrics).toMatchObject({
      REPEATED_ERROR_COUNT: { kind: "COUNT", value: C5_MIN_IDENTICAL_ERRORS },
      AFFECTED_ERROR_CLASS_COUNT: { kind: "COUNT", value: 3 },
    });
  });

  it("keeps distinct retained error texts in separate clusters despite one class", () => {
    for (const errorText of ["missing alpha", "missing beta", "missing gamma"]) {
      addError("session-c5-a", "Read", "NOT_FOUND", { errorText });
    }

    expect(c5Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("weights output once and only applies M(N) to call/result byte spans", () => {
    seedListPrices(db, CTX.toIso);
    for (let index = 0; index < 4; index++) {
      addError("session-c5-a", "Read", "NOT_FOUND", {
        outputTokens: 100,
        inputBytes: 34,
        resultBytes: 34,
        pricingSnapshotId: "list-sonnet-4-v2",
      });
    }

    const finding = c5Detector.evaluate(db, CTX).fired[0]?.payload;

    expect(finding?.ceu).toMatchObject({ provenance: "ESTIMATED" });
    expect(finding?.metrics).toMatchObject({
      // Two excess errors: output is 100 × 5 each, while 20 proxy tokens per
      // call/result span receive only the cache floor multiplier (1.35).
      CONSERVATIVE_FLOOR_CEU: { kind: "NUMBER", value: 1_054 },
    });
    // N is 2 then 1, so only the 20-token cached spans change by M(N):
    // (20 × 1.45) + (20 × 1.35), plus 2 × (100 × 5).
    expect(finding?.ceu?.value).toBe(1_056);
  });

  it("fails closed to the conservative CEU floor when N has an unverified boundary", () => {
    seedListPrices(db, CTX.toIso);
    for (let index = 0; index < 3; index++) {
      addError("session-c5-a", "Read", "NOT_FOUND", {
        outputTokens: 100,
        inputBytes: 34,
        resultBytes: 34,
        pricingSnapshotId: "list-sonnet-4-v2",
      });
    }
    db.prepare(
      `INSERT INTO ingest_metric_events
         (event_id, session_id, is_user_turn, is_compact_summary, is_api_error, is_interrupt,
          event_ts, event_position, boundary_kind, boundary_verification, is_sidechain)
       VALUES ('c5-unverified-boundary', 'session-c5-a', 0, 0, 0, 0,
               '2027-01-02T00:00:02.000Z', 3, 'cache-read-collapse', 'UNVERIFIED', 0)`,
    ).run();

    const finding = c5Detector.evaluate(db, CTX).fired[0]?.payload;

    expect(finding?.ceu).toEqual({ value: 527, band: "LOW", provenance: "FLOOR" });
    expect(finding?.metrics).toMatchObject({
      CONSERVATIVE_FLOOR_CEU: { kind: "NUMBER", value: 527 },
    });
  });

  it("fails closed to the cached-span floor when per-turn output pricing is absent", () => {
    seedListPrices(db, CTX.toIso);
    for (let index = 0; index < 4; index++) {
      addError("session-c5-a", "Read", "NOT_FOUND", {
        outputTokens: 100,
        inputBytes: 34,
        resultBytes: 34,
      });
    }

    const finding = c5Detector.evaluate(db, CTX).fired[0]?.payload;

    // Missing snapshot provenance omits the output term rather than assigning
    // a list-price ratio; the full expected loop estimate is therefore absent.
    expect(finding?.ceu).toEqual({ value: 54, band: "LOW", provenance: "FLOOR" });
    expect(finding?.metrics).toMatchObject({
      CONSERVATIVE_FLOOR_CEU: { kind: "NUMBER", value: 54 },
    });
  });

  it("selects the highest per-error CEU anchors rather than the oldest or newest five", () => {
    seedListPrices(db, CTX.toIso);
    for (const outputTokens of [0, 0, 500, 400, 300, 200, 100, 1]) {
      addError("session-c5-a", "Read", "NOT_FOUND", {
        outputTokens,
        pricingSnapshotId: "list-sonnet-4-v2",
      });
    }

    const finding = c5Detector.evaluate(db, CTX).fired[0]?.payload;

    expect(finding?.anchors).toEqual(
      [2, 3, 4, 5, 6].map((index) => ({
        session_id: findingIds.session("session-c5-a"),
        event_id: findingIds.event(`c5-event-${index}`),
        timestamp: `2027-01-02T00:00:${String(index).padStart(2, "0")}.000Z`,
      })),
    );
    expect(finding?.metrics).toMatchObject({
      ERROR_LOOP_COUNT: { kind: "COUNT", value: 1 },
      LOOP_EXCESS_ERROR_COUNT: { kind: "COUNT", value: 6 },
    });
  });

  it("breaks equal reclaimable-CEU anchor ties by recency and emits chronologically", () => {
    seedListPrices(db, CTX.toIso);
    for (let index = 0; index < 8; index++) {
      addError("session-c5-a", "Read", "NOT_FOUND", {
        outputTokens: 100,
        pricingSnapshotId: "list-sonnet-4-v2",
      });
    }

    expect(c5Detector.evaluate(db, CTX).fired[0]?.payload.anchors).toEqual(
      [3, 4, 5, 6, 7].map((index) => ({
        session_id: findingIds.session("session-c5-a"),
        event_id: findingIds.event(`c5-event-${index}`),
        timestamp: `2027-01-02T00:00:${String(index).padStart(2, "0")}.000Z`,
      })),
    );
  });

  it("excludes sidechain, provisional, and absent classifier evidence", () => {
    for (let index = 0; index < 2; index++) addError("session-c5-a", "Read", "NOT_FOUND");
    addError("session-c5-a", "Read", "NOT_FOUND", { sidechain: 1 });
    addError("session-c5-a", "Read", "NOT_FOUND", { provisional: 1 });
    addError("session-c5-a", "Read", null, { exitClass: "ERROR" });

    expect(c5Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("emits session_ids and an O-basis estimate from the conservative CEU floor", () => {
    seedListPrices(db, CTX.toIso);
    // 4 errors → 2 excess errors; no pricing snapshot → output weight null → outputCeu = 0
    // Each excess error: callAndResultTokens = (34+34)/3.4 = 20; floor CEU = 27 each → total = 54
    // rank = round(54 × LIST_PRICES["sonnet-4"][0]) = round(54 × 3) = 162
    for (let index = 0; index < 4; index++) {
      addError("session-c5-a", "Read", "NOT_FOUND", { inputBytes: 34, resultBytes: 34 });
    }

    const outcome = c5Detector.evaluate(db, CTX);
    const payload = outcome.fired[0]?.payload;

    expect(payload?.session_ids).toEqual(["session-c5-a"]);
    // D7 owns loop economics; C5 exposes advisory severity/ranking only.
    expect(outcome.fired[0]?.modeled_savings_u_per_wk).toBeNull();
    expect(payload?.estimate).toMatchObject({
      basis: "O",
      rank_value_u_per_wk: 162, // 54 × 3 (sonnet-4 own-tier input; PRICE-O55-F1, was opus 5 → 270)
      summable: false,
    });
  });
});
