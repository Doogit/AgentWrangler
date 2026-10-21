import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/db/migrate.js";
import { a1FindingDescriptor } from "../../../src/detector/detectors/a1_tool_result_bloat.js";
import { b4FindingDescriptor } from "../../../src/detector/detectors/b4_mid_session_prefix_break.js";
import { c1FindingDescriptor } from "../../../src/detector/detectors/c1_tool_error_rate.js";
import { c2FindingDescriptor } from "../../../src/detector/detectors/c2_content_not_found.js";
import { c4FindingDescriptor } from "../../../src/detector/detectors/c4_failed_edit_recovery.js";
import { c5FindingDescriptor } from "../../../src/detector/detectors/c5_same_error_loop.js";
import { c7FindingDescriptor } from "../../../src/detector/detectors/c7_bash_failure_cluster.js";
import { c9FindingDescriptor } from "../../../src/detector/detectors/c9_denial_friction.js";
import { d14FindingDescriptor } from "../../../src/detector/detectors/d14_interrupt_cancel.js";
import { g11FindingDescriptor } from "../../../src/detector/detectors/g11_high_spend_failure.js";
import { h1FindingDescriptor } from "../../../src/detector/detectors/h1_destructive_operations.js";
import {
  type FindingDescriptorV2,
  createFindingEnvelopeV2,
  findingIds,
} from "../../../src/detector/privacy-contract.js";
import { resetQueryDb, setQueryDb } from "../../../src/query/db-context.js";

import {
  type DiagnosticRecommendationRow,
  diagnosticCategoryForRule,
  getSessionDiagnostics,
  projectDiagnosticsRows,
} from "../../../src/query/api/diagnostics.js";

const AS_OF = new Date("2026-09-16T23:59:59.999Z");

function row(): DiagnosticRecommendationRow {
  const envelope = createFindingEnvelopeV2(
    {
      version: 2,
      rule_id: c1FindingDescriptor.rule_id,
      label: "TOOL_ERROR_RATE_OUTLIER",
      assessment: c1FindingDescriptor.defaults.assessment,
      routing: c1FindingDescriptor.defaults.routing,
      window: { from: "2026-09-09T00:00:00.000Z", to: "2026-09-16T00:00:00.000Z" },
      anchors: [
        { session_id: findingIds.session("actual-session"), timestamp: "2026-09-15T00:00:00.000Z" },
      ],
      impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
      verdict: { value: "SUPPORTED", method: "RULE" },
      metrics: {
        TOOL_CALL_COUNT: { kind: "COUNT", value: 10 },
        TOOL_ERROR_COUNT: { kind: "COUNT", value: 2 },
        TOOL_ERROR_RATE: { kind: "RATIO", value: 0.2 },
        CORPUS_CALL_COUNT: { kind: "COUNT", value: 20 },
        CORPUS_ERROR_COUNT: { kind: "COUNT", value: 2 },
        CORPUS_ERROR_RATE: { kind: "RATIO", value: 0.1 },
        RATE_MULTIPLE: { kind: "NUMBER", value: 2 },
      },
    },
    c1FindingDescriptor,
  );
  return {
    rec_id: "fixture-rec",
    scope_workspace_id: "workspace-a",
    evidence_json: JSON.stringify(envelope),
    detector_id: "C1",
    category: c1FindingDescriptor.presentation.category,
    lever: c1FindingDescriptor.presentation.lever,
    target_metric: c1FindingDescriptor.presentation.target_metric,
    contract_version: 2,
    template_id: null,
    contract_status: "V2_VALIDATED",
    rule_id: c1FindingDescriptor.rule_id,
  };
}

describe("projectDiagnosticsRows", () => {
  it("projects a real direct FindingEnvelopeV2 without exposing non-structural fields", () => {
    const anchor = projectDiagnosticsRows([row()], {
      routeSessionIds: new Map([[findingIds.session("actual-session"), "actual-session"]]),
      asOf: AS_OF,
    }).categories[0]?.anchors[0];
    expect(anchor).toMatchObject({
      session_id: "actual-session",
      label: "TOOL_ERROR_RATE_OUTLIER",
    });
    expect(JSON.stringify(anchor)).not.toContain("metrics");
  });

  it("returns only structural SEC-101-safe anchor fields", () => {
    const anchor = projectDiagnosticsRows([row()], { asOf: AS_OF }).categories[0]?.anchors[0];
    expect(anchor).toBeDefined();
    if (anchor === undefined) throw new Error("expected a projected anchor");
    expect(Object.keys(anchor).sort()).toEqual(["ceu", "label", "session_id", "timestamp"]);
    expect(JSON.stringify(anchor)).not.toContain("metrics");
  });

  it("resolves a structural pseudonym to the existing session-detail route", () => {
    const routeIds = new Map([[findingIds.session("actual-session"), "actual-local-session-id"]]);
    const anchor = projectDiagnosticsRows([row()], {
      routeSessionIds: routeIds,
      asOf: AS_OF,
    }).categories[0]?.anchors[0];
    expect(anchor?.session_id).toBe("actual-local-session-id");
  });

  it("excludes persisted anchors outside the current seven-day window", () => {
    const result = projectDiagnosticsRows([row()], {
      asOf: new Date("2026-09-24T00:00:00.000Z"),
    });
    expect(result.categories.every((category) => category.anchors.length === 0)).toBe(true);
    expect(result.session_count).toBe(0);
    expect(result.workspace_count).toBe(0);
  });

  it("counts the workspace represented by anchors on a global finding", () => {
    const global = { ...row(), scope_workspace_id: null };
    const result = projectDiagnosticsRows([global], {
      workspaceIdsBySession: new Map([
        [findingIds.session("actual-session"), "workspace-from-session"],
      ]),
      asOf: AS_OF,
    });
    expect(result.session_count).toBe(1);
    expect(result.workspace_count).toBe(1);
  });
  it("resolves a message-anchored finding outside the owner detector list to its turn", () => {
    const envelope = createFindingEnvelopeV2(
      {
        version: 2,
        rule_id: b4FindingDescriptor.rule_id,
        label: "MID_SESSION_CREATION_SPIKE",
        assessment: b4FindingDescriptor.defaults.assessment,
        routing: b4FindingDescriptor.defaults.routing,
        window: { from: "2026-09-09T00:00:00.000Z", to: "2026-09-16T00:00:00.000Z" },
        anchors: [
          {
            session_id: findingIds.session("actual-session"),
            timestamp: "2026-09-15T00:00:00.000Z",
            message_id: findingIds.message("synthetic-message"),
          },
        ],
        impact: { kind: "TOKEN_WASTE", severity: "HIGH", direction: "REDUCE" },
        verdict: { value: "CONFIRMED", method: "RULE" },
        metrics: {
          GAP_DURATION_MS: { kind: "DURATION_MS", value: 1_000 },
          MAX_GAP_DURATION_MS: { kind: "DURATION_MS", value: 300_000 },
          PREVIOUS_CACHE_CREATION_TOKENS: { kind: "TOKENS", value: 100 },
          CURRENT_CACHE_CREATION_TOKENS: { kind: "TOKENS", value: 50_000 },
          CREATION_THRESHOLD_TOKENS: { kind: "TOKENS", value: 20_000 },
          CREATION_RATIO_THRESHOLD: { kind: "NUMBER", value: 3 },
        },
      },
      b4FindingDescriptor,
    );
    const messageRow: DiagnosticRecommendationRow = {
      ...row(),
      evidence_json: JSON.stringify(envelope),
      detector_id: "B4",
      category: b4FindingDescriptor.presentation.category,
      lever: b4FindingDescriptor.presentation.lever,
      target_metric: b4FindingDescriptor.presentation.target_metric,
      rule_id: b4FindingDescriptor.rule_id,
    };
    const projected = projectDiagnosticsRows([messageRow], {
      routeSessionIds: new Map([[findingIds.session("actual-session"), "actual-session"]]),
      routeMessageIds: new Map([[findingIds.message("synthetic-message"), "synthetic-message"]]),
      turnsByMessage: new Map([
        [
          findingIds.message("synthetic-message"),
          { message_id: "synthetic-message", turn_index: 4 },
        ],
      ]),
      asOf: AS_OF,
    }).categories.flatMap((category) => category.anchors)[0];
    expect(projected).toMatchObject({ message_id: "synthetic-message", turn_index: 4 });
  });
  it("maps registered detector rule IDs to errors", () => {
    expect(diagnosticCategoryForRule("C4_FAILED_EDIT_RECOVERY_LOOP")).toBe("errors");
    expect(diagnosticCategoryForRule("G11_HIGH_SPEND_OBSERVED_FAILURE")).toBe("errors");
    expect(diagnosticCategoryForRule("D2")).toBe("errors");
  });
});

// The `getDiagnostics` owner-anchor tests left with `getDiagnostics` (P4 U4 swapped the route to
// the triage view); the per-session route below still resolves owners the same way.
describe("getSessionDiagnostics owner anchors", () => {
  afterEach(() => resetQueryDb());

  it("resolves missing message and turn fields through each event's owning turn", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db);
      setQueryDb(db);
      db.prepare(
        "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
      ).run("fixture-workspace", "fixture-project", "2026-09-22T00:00:00.000Z");
      db.prepare(
        "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES (?, ?, ?, ?)",
      ).run("fixture-session", "fixture-workspace", "fixture-transcript", "RECONCILED");
      const insertTurn = db.prepare(`INSERT INTO turns
        (message_id, session_id, workspace_id, ts, model, parser_version)
        VALUES (?, 'fixture-session', 'fixture-workspace', ?, 'fixture-model', 'fixture-parser')`);
      const insertEvent = db.prepare(`INSERT INTO tool_events
        (event_id, session_id, ts, tool_name) VALUES (?, 'fixture-session', ?, 'Bash')`);
      const insertOwner = db.prepare(`INSERT INTO tool_event_metadata
        (event_id, owner_message_id, block_index, is_test_command) VALUES (?, ?, 0, 0)`);
      const insertRecommendation = db.prepare(`INSERT INTO recommendations
        (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
         modeled_formula_json, evidence_json, target_metric, state, created_at,
         contract_version, contract_status, rule_id)
        VALUES (?, 'RULE', ?, ?, 'fixture-workspace', ?, '{}', ?, ?, 'PROPOSED', ?, 2, 'V2_VALIDATED', ?)`);
      insertTurn.run("fixture-turn-before", "2026-09-22T00:00:00.000Z");
      const descriptors: FindingDescriptorV2[] = [
        c1FindingDescriptor,
        c4FindingDescriptor,
        c5FindingDescriptor,
        c7FindingDescriptor,
        d14FindingDescriptor,
        g11FindingDescriptor,
        // Not in OWNER_ANCHOR_DETECTORS: resolves through its tool event id.
        c2FindingDescriptor,
      ];
      const expected = new Map<string, { message_id: string; turn_index: number }>();
      for (const [index, descriptor] of descriptors.entries()) {
        const timestamp = new Date(Date.UTC(2026, 8, 22, 0, index + 1)).toISOString();
        const messageId = `fixture-message-${index}`;
        const eventId = `fixture-event-${index}`;
        insertTurn.run(messageId, timestamp);
        insertEvent.run(eventId, timestamp);
        insertOwner.run(eventId, messageId);
        const metrics = Object.fromEntries(
          Object.entries(descriptor.metrics).map(([name, definition]) => [
            name,
            {
              kind: definition.kind,
              value:
                definition.kind === "ENUM"
                  ? (definition.values?.[0] ?? "FIXTURE")
                  : definition.kind === "OPAQUE_ID"
                    ? findingIds.workItem("fixture-work-item")
                    : definition.kind === "TEXT"
                      ? "fixture text".slice(0, definition.max ?? 12)
                      : 1,
            },
          ]),
        );
        const envelope = createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: descriptor.rule_id,
            label: descriptor.labels[0] ?? "FIXTURE",
            assessment: descriptor.defaults.assessment,
            routing: descriptor.defaults.routing,
            window: { from: "2026-09-21T00:00:00.000Z", to: "2026-09-23T00:00:00.000Z" },
            anchors: [
              {
                session_id: findingIds.session("fixture-session"),
                timestamp,
                ...(descriptor.owner_detector_id === "G11"
                  ? {}
                  : { event_id: findingIds.event(eventId) }),
              },
            ],
            impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
            ...(descriptor.facets.includes("ceu")
              ? { ceu: { value: 1, band: "LOW" as const, provenance: "FLOOR" as const } }
              : {}),
            verdict: { value: "SUPPORTED", method: "RULE" },
            metrics,
          },
          descriptor,
        );
        insertRecommendation.run(
          `fixture-rec-${index}`,
          descriptor.owner_detector_id,
          descriptor.presentation.category,
          descriptor.presentation.lever,
          JSON.stringify(envelope),
          descriptor.presentation.target_metric,
          timestamp,
          descriptor.rule_id,
        );
        expected.set(descriptor.labels[0] ?? "FIXTURE", {
          message_id: messageId,
          turn_index: index + 1,
        });
      }
      const anchors = getSessionDiagnostics("fixture-session").data ?? [];
      expect(anchors).toHaveLength(descriptors.length);
      for (const anchor of anchors) {
        expect(anchor.message_id).toBeTruthy();
        expect(anchor.turn_index).not.toBeNull();
        expect(anchor.turn_index).not.toBeUndefined();
        const owningTurn = expected.get(anchor.label);
        expect(owningTurn).toBeDefined();
        if (owningTurn === undefined) throw new Error("unexpected diagnostic anchor label");
        expect(anchor).toMatchObject(owningTurn);
      }
    } finally {
      resetQueryDb();
      db.close();
    }
  });

  it("resolves A1 tool owners and C9/H1 metric events with timestamp ties, retaining unowned anchors", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db);
      setQueryDb(db);
      db.prepare(
        "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
      ).run("fixture-workspace", "fixture-project", "2026-09-22T00:00:00.000Z");
      db.prepare(
        "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES (?, ?, ?, ?)",
      ).run("fixture-session", "fixture-workspace", "fixture-transcript", "RECONCILED");
      const turn = db.prepare(`INSERT INTO turns
        (message_id, session_id, workspace_id, ts, model, parser_version)
        VALUES (?, 'fixture-session', 'fixture-workspace', ?, 'fixture-model', 'fixture-parser')`);
      turn.run("fixture-earlier", "2026-09-22T00:00:00.000Z");
      turn.run("fixture-tie-a", "2026-09-22T00:01:00.000Z");
      turn.run("fixture-tie-z", "2026-09-22T00:01:00.000Z");
      turn.run("fixture-later", "2026-09-22T00:03:00.000Z");
      db.prepare(
        "INSERT INTO tool_events (event_id, session_id, ts, tool_name) VALUES (?, ?, ?, ?)",
      ).run("fixture-a1-event", "fixture-session", "2026-09-22T00:02:00.000Z", "Bash");
      db.prepare(
        "INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command) VALUES (?, ?, 0, 0)",
      ).run("fixture-a1-event", "fixture-tie-a");
      const metricEvent = db.prepare(`INSERT INTO ingest_metric_events
        (event_id, session_id, is_user_turn, is_compact_summary, is_api_error, is_interrupt, event_ts,
         is_sidechain, classifier_label, destructive_op)
        VALUES (?, 'fixture-session', 0, 0, 0, 0, ?, 0, ?, ?)`);
      metricEvent.run("fixture-c9-event", "2026-09-22T00:01:00.000Z", "hook-block", null);
      metricEvent.run("fixture-h1-event", "2026-09-22T00:02:00.000Z", null, "rm-rf");
      metricEvent.run("fixture-unowned-event", "2026-09-21T23:59:00.000Z", "hook-block", null);
      const insertRecommendation = db.prepare(`INSERT INTO recommendations
        (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
         modeled_formula_json, evidence_json, target_metric, state, created_at,
         contract_version, contract_status, rule_id)
        VALUES (?, 'RULE', ?, ?, 'fixture-workspace', ?, '{}', ?, ?, 'PROPOSED', ?, 2, 'V2_VALIDATED', ?)`);
      for (const [recId, descriptor, eventId, timestamp] of [
        ["fixture-a1-rec", a1FindingDescriptor, "fixture-a1-event", "2026-09-22T00:02:00.000Z"],
        ["fixture-c9-rec", c9FindingDescriptor, "fixture-c9-event", "2026-09-22T00:01:00.000Z"],
        ["fixture-h1-rec", h1FindingDescriptor, "fixture-h1-event", "2026-09-22T00:02:00.000Z"],
        [
          "fixture-unowned-rec",
          h1FindingDescriptor,
          "fixture-unowned-event",
          "2026-09-21T23:59:00.000Z",
        ],
      ] as const) {
        const metrics = Object.fromEntries(
          Object.entries(descriptor.metrics).map(([name, definition]) => [
            name,
            {
              kind: definition.kind,
              value: definition.kind === "ENUM" ? definition.values?.[0] : 1,
            },
          ]),
        );
        const envelope = createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: descriptor.rule_id,
            label: descriptor.labels[0] ?? "FIXTURE",
            assessment: descriptor.defaults.assessment,
            routing: descriptor.defaults.routing,
            window: { from: "2026-09-21T00:00:00.000Z", to: "2026-09-23T00:00:00.000Z" },
            anchors: [
              {
                session_id: findingIds.session("fixture-session"),
                timestamp,
                event_id: findingIds.event(eventId),
              },
            ],
            impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
            verdict: { value: "SUPPORTED", method: "RULE" },
            metrics,
          },
          descriptor,
        );
        insertRecommendation.run(
          recId,
          descriptor.owner_detector_id,
          descriptor.presentation.category,
          descriptor.presentation.lever,
          JSON.stringify(envelope),
          descriptor.presentation.target_metric,
          timestamp,
          descriptor.rule_id,
        );
      }
      const sessionAnchors = getSessionDiagnostics("fixture-session").data ?? [];
      expect(sessionAnchors).toHaveLength(4);
      expect(sessionAnchors.map((anchor) => anchor.category)).toEqual([
        "token_waste",
        "denials",
        "destructive_ops",
        "destructive_ops",
      ]);
      expect(sessionAnchors.map((anchor) => anchor.turn_index)).toEqual([1, 2, 2, undefined]);
      expect(sessionAnchors.find((anchor) => anchor.label === "HOOK_BLOCK")).toMatchObject({
        message_id: "fixture-tie-z",
        turn_index: 2,
      });
      expect(
        sessionAnchors.find(
          (anchor) =>
            anchor.label === "DESTRUCTIVE_OPERATION_REPORTED" &&
            anchor.timestamp === "2026-09-22T00:02:00.000Z",
        ),
      ).toMatchObject({ message_id: "fixture-tie-z", turn_index: 2 });
    } finally {
      resetQueryDb();
      db.close();
    }
  });
});
