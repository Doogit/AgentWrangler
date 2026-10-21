import { readFileSync, readdirSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { h1FindingDescriptor } from "../../src/detector/detectors/h1_destructive_operations.js";
import { buildContext, runDetectors as runDetectorsCore } from "../../src/detector/engine.js";
import {
  findingDescriptor,
  registeredFindingDescriptors,
} from "../../src/detector/finding-registry.js";
import { runDetectors } from "../../src/detector/index.js";
import {
  type RecommendationPayloadV1,
  assertDiagnosticFindingV1,
  assertFindingEnvelopeV2,
  assertRecommendationPayloadV1,
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
  serializeDiagnosticFindingV1,
  serializeFindingEnvelopeV2,
} from "../../src/detector/privacy-contract.js";
import { DETECTORS } from "../../src/detector/registry.js";
import type { Detector, DetectorV2 } from "../../src/detector/types.js";
import { projectLine } from "../../src/ingest/parser.js";
import { getEfficiencyHeadroom } from "../../src/query/api/efficiency-headroom.js";
import { listLedger } from "../../src/query/api/recommendations-ledger.js";
import { getRecommendationCard } from "../../src/query/api/recommendations.js";
import { getTrends } from "../../src/query/api/trends.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { trustedRecommendationContract } from "../../src/query/recommendation-contract.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2026-09-15T12:00:00.000Z");

const TEST_V2_DESCRIPTOR = defineFindingDescriptorV2({
  owner_detector_id: "D11",
  rule_id: "TEST_RULE",
  labels: ["HIGH_ERROR_RATE"],
  metrics: {
    ERROR_COUNT: { kind: "COUNT", max: 10_000 },
    ERROR_RATIO: { kind: "RATIO" },
    TOOL_CLASS: { kind: "ENUM", values: ["SHELL", "FILESYSTEM"] },
  },
  facets: ["impact", "ceu", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "ASSERTED",
      provenance: { source: "RULE", version: "rule-1" },
    },
    routing: { tier: "T3" },
  },
  presentation: {
    category: "TOOLING",
    lever: "Use the measured lower-error path.",
    target_metric: "error_ratio",
    title: "High error rate",
  },
} as const);

function validV2Body() {
  return {
    version: 2 as const,
    rule_id: "TEST_RULE",
    label: "HIGH_ERROR_RATE",
    assessment: TEST_V2_DESCRIPTOR.defaults.assessment,
    routing: { tier: "T3" as const },
    window: { from: "2026-09-08T12:00:00.000Z", to: NOW.toISOString() },
    anchors: [
      {
        session_id: findingIds.session("123e4567-e89b-42d3-a456-426614174000"),
        timestamp: "2026-09-14T12:00:00.000Z",
        event_id: findingIds.event("toolu_01ABCDEF23456789"),
        turn_index: 4,
        byte_offset: 128,
      },
    ],
    impact: {
      kind: "FRICTION" as const,
      severity: "MEDIUM" as const,
      direction: "REDUCE" as const,
    },
    ceu: { value: 120, band: "LOW" as const, provenance: "MEASURED" as const },
    verdict: { value: "CONFIRMED" as const, method: "RULE" as const },
    metrics: {
      ERROR_COUNT: { kind: "COUNT" as const, value: 5 },
      ERROR_RATIO: { kind: "RATIO" as const, value: 0.1 },
      TOOL_CLASS: { kind: "ENUM" as const, value: "SHELL" },
    },
  };
}

function validD11Payload(): unknown {
  return {
    version: 1,
    template_id: "D11_TOOL_ERROR_RATE",
    facts: {
      bash_error_ratio: 0.1,
      powershell_error_ratio: 0,
      bash_call_count: 50,
      powershell_call_count: 50,
      bash_error_count: 5,
      powershell_error_count: 0,
      preferred_tool: "PowerShell",
      higher_error_tool: "Bash",
    },
  };
}

function seedD11(db: Database.Database): void {
  const ts = "2026-09-14T12:00:00.000Z";
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
       state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('sec-session', 'ws-alpha', '/discarded/source.jsonl', ?, ?,
       'RECONCILED', 1, 0, '[]')`,
  ).run(ts, ts);
  const insert = db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class)
     VALUES (?, 'sec-session', ?, ?, 0, 0, NULL, ?)`,
  );
  for (let index = 0; index < 50; index++) {
    insert.run(`bash-${index}`, ts, "Bash", index < 5 ? "ERROR" : "OK");
    insert.run(`powershell-${index}`, ts, "PowerShell", "OK");
    // D11 counts only failures the shell caused (review 3 B3).
    if (index < 5)
      db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
        `bash-${index}`,
        JSON.stringify({
          error: `Exit code 127\n/usr/bin/bash: line 1: x${index}: command not found`,
        }),
      );
  }
}

afterEach(() => resetQueryDb());

describe("SEC-101 detector serialization", () => {
  it("keeps every registered V2 detector aligned with its trusted descriptor", () => {
    const v2Detectors = DETECTORS.filter(
      (detector): detector is DetectorV2 => detector.contractVersion === 2,
    );
    expect(v2Detectors.map((detector) => detector.id)).toEqual([
      "A1",
      "A2",
      "B1",
      "B2",
      "B3",
      "B4",
      "C1",
      "C2",
      "C3",
      "C4",
      "C5",
      "C6",
      "C7",
      "C9",
      "C11",
      "D14",
      "E1",
      "E2",
      "G11",
      "H1",
    ]);
    const boundaryInvocations = readdirSync("test/detector/wave1")
      .filter((file) => file.endsWith(".test.ts"))
      .flatMap((file) =>
        [
          ...readFileSync(`test/detector/wave1/${file}`, "utf8").matchAll(
            /assertV2ProducerBoundary\(db,\s*CTX,\s*([a-z]\d+)Detector\)/g,
          ),
        ].map((match) => match[1]?.toUpperCase()),
      );
    expect(boundaryInvocations).toHaveLength(v2Detectors.length);
    expect([...new Set(boundaryInvocations)].sort()).toEqual(
      v2Detectors.map((detector) => detector.id).sort(),
    );
    expect(registeredFindingDescriptors()).toEqual(
      v2Detectors.map((detector) => detector.descriptor),
    );
    expect(new Set(v2Detectors.map((detector) => detector.id)).size).toBe(v2Detectors.length);
    expect(new Set(v2Detectors.map((detector) => detector.descriptor.rule_id)).size).toBe(
      v2Detectors.length,
    );
    for (const detector of v2Detectors) {
      expect(detector.descriptor.owner_detector_id).toBe(detector.id);
      expect(findingDescriptor(detector.descriptor.rule_id)).toBe(detector.descriptor);
    }
  });

  it("builds a canonical V2 envelope only from validated structural data", () => {
    const envelope = createFindingEnvelopeV2(validV2Body(), TEST_V2_DESCRIPTOR);
    expect(envelope.evidence_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertFindingEnvelopeV2(envelope, TEST_V2_DESCRIPTOR)).not.toThrow();
    expect(JSON.parse(serializeFindingEnvelopeV2(envelope, TEST_V2_DESCRIPTOR))).toEqual(envelope);
    expect(createFindingEnvelopeV2(validV2Body(), TEST_V2_DESCRIPTOR)).toEqual(envelope);

    const changed = createFindingEnvelopeV2(
      {
        ...validV2Body(),
        metrics: { ...validV2Body().metrics, ERROR_COUNT: { kind: "COUNT", value: 6 } },
      },
      TEST_V2_DESCRIPTOR,
    );
    expect(changed.evidence_digest).not.toBe(envelope.evidence_digest);
  });

  it("requires assessment and routing defaults, including H1's report-only route", () => {
    const body = validV2Body();
    for (const assessment of [
      { ...body.assessment, kind: "CORRELATIONAL" as const },
      { ...body.assessment, posture: "REVIEW" as const },
      {
        ...body.assessment,
        provenance: { ...body.assessment.provenance, source: "CLASSIFIER" as const },
      },
      {
        ...body.assessment,
        provenance: { ...body.assessment.provenance, version: "rule-2" },
      },
    ]) {
      expect(() => createFindingEnvelopeV2({ ...body, assessment }, TEST_V2_DESCRIPTOR)).toThrow(
        /assessment must match descriptor defaults/,
      );
    }
    expect(() =>
      createFindingEnvelopeV2({ ...body, routing: { tier: "INVESTIGATE" } }, TEST_V2_DESCRIPTOR),
    ).toThrow(/routing tier must match descriptor defaults/);
    const forgedForRead = {
      ...createFindingEnvelopeV2(body, TEST_V2_DESCRIPTOR),
      assessment: { ...body.assessment, posture: "REVIEW" as const },
    };
    expect(() => assertFindingEnvelopeV2(forgedForRead, TEST_V2_DESCRIPTOR)).toThrow(
      /assessment must match descriptor defaults/,
    );
    expect(() =>
      createFindingEnvelopeV2(
        {
          ...body,
          routing: { tier: "T3", artifact_id: findingIds.artifact("review-artifact") },
        },
        TEST_V2_DESCRIPTOR,
      ),
    ).not.toThrow();
    expect(() =>
      createFindingEnvelopeV2(
        { ...body, routing: { tier: "T3", escalation: "W3_CONFIRMATION" } },
        TEST_V2_DESCRIPTOR,
      ),
    ).not.toThrow();

    const h1Body = {
      version: 2 as const,
      rule_id: h1FindingDescriptor.rule_id,
      label: "DESTRUCTIVE_OPERATION_REPORTED",
      assessment: h1FindingDescriptor.defaults.assessment,
      routing: h1FindingDescriptor.defaults.routing,
      window: { from: "2026-09-08T12:00:00.000Z", to: NOW.toISOString() },
      anchors: [
        {
          session_id: findingIds.session("h1-session"),
          timestamp: "2026-09-14T12:00:00.000Z",
          event_id: findingIds.event("h1-event"),
        },
      ],
      impact: { kind: "RISK" as const, severity: "HIGH" as const, direction: "NONE" as const },
      verdict: { value: "SUPPORTED" as const, method: "RULE" as const },
      metrics: {
        DESTRUCTIVE_OPERATION: { kind: "ENUM" as const, value: "RM_RF" },
        OPERATION_COUNT: { kind: "COUNT" as const, value: 1 },
      },
    };
    expect(() =>
      createFindingEnvelopeV2(
        { ...h1Body, assessment: { ...h1Body.assessment, posture: "ASSERTED" } },
        h1FindingDescriptor,
      ),
    ).toThrow(/assessment must match descriptor defaults/);
    expect(() =>
      createFindingEnvelopeV2({ ...h1Body, routing: { tier: "T2" } }, h1FindingDescriptor),
    ).toThrow(/routing tier must match descriptor defaults/);
  });

  it("fails V2 closed on content, vocabulary drift, unsafe anchors, and malformed facets", () => {
    const body = validV2Body();
    const anchor = body.anchors[0];
    if (anchor === undefined) throw new Error("fixture anchor missing");
    expect(() =>
      createFindingEnvelopeV2(
        { ...body, content: "private transcript" } as unknown as typeof body,
        TEST_V2_DESCRIPTOR,
      ),
    ).toThrow(/unknown|missing/);
    expect(() =>
      createFindingEnvelopeV2({ ...body, label: "private transcript" }, TEST_V2_DESCRIPTOR),
    ).toThrow(/label/);
    expect(() =>
      createFindingEnvelopeV2(
        {
          ...body,
          metrics: { ...body.metrics, COMMAND: { kind: "ENUM", value: "private transcript" } },
        },
        TEST_V2_DESCRIPTOR,
      ),
    ).toThrow(/keys/);
    expect(() =>
      createFindingEnvelopeV2(
        {
          ...body,
          metrics: { ...body.metrics, ERROR_RATIO: { kind: "RATIO", value: Number.NaN } },
        },
        TEST_V2_DESCRIPTOR,
      ),
    ).toThrow(/finite/);
    expect(() =>
      createFindingEnvelopeV2(
        {
          ...body,
          metrics: { ...body.metrics, TOOL_CLASS: { kind: "ENUM", value: "COMMAND_TEXT" } },
        },
        TEST_V2_DESCRIPTOR,
      ),
    ).toThrow(/enum/);
    expect(() =>
      createFindingEnvelopeV2(
        { ...body, anchors: Array.from({ length: 6 }, () => anchor) },
        TEST_V2_DESCRIPTOR,
      ),
    ).toThrow(/one to five/);
    expect(() =>
      createFindingEnvelopeV2(
        { ...body, anchors: [{ ...anchor, timestamp: "2026-02-30T12:00:00.000Z" }] },
        TEST_V2_DESCRIPTOR,
      ),
    ).toThrow(/timestamp/);
    expect(() =>
      createFindingEnvelopeV2(
        { ...body, ceu: { ...body.ceu, value: Number.POSITIVE_INFINITY } },
        TEST_V2_DESCRIPTOR,
      ),
    ).toThrow(/finite/);
    const fallbackSession = findingIds.session("prompt_response_private_text");
    const fallbackMessage = findingIds.message("123e4567-e89b-42d3-a456-426614174000");
    const fallbackEvent = findingIds.event("toolu_user_authored_secret");
    expect(fallbackSession).toMatch(/^sid_[0-9a-f]{64}$/);
    expect(fallbackMessage).toMatch(/^mid_[0-9a-f]{64}$/);
    expect(fallbackEvent).toMatch(/^eid_[0-9a-f]{64}$/);
    expect(JSON.stringify([fallbackSession, fallbackMessage, fallbackEvent])).not.toMatch(
      /prompt|response|private|authored|secret|123e4567/,
    );
    expect(() =>
      createFindingEnvelopeV2(
        {
          ...body,
          anchors: [{ ...anchor, session_id: "sid_private_transcript" }],
        } as unknown as typeof body,
        TEST_V2_DESCRIPTOR,
      ),
    ).toThrow(/SESSION identifier/);
    expect(() => findingIds.session("")).toThrow(/bounded source identifier/);
  });

  it("rejects stale or forged V2 structural digests", () => {
    const envelope = createFindingEnvelopeV2(validV2Body(), TEST_V2_DESCRIPTOR);
    expect(() =>
      assertFindingEnvelopeV2({ ...envelope, evidence_digest: "0".repeat(64) }, TEST_V2_DESCRIPTOR),
    ).toThrow(/mismatch/);
    expect(() =>
      assertFindingEnvelopeV2(
        { ...envelope, evidence_digest: "raw-content-hash" },
        TEST_V2_DESCRIPTOR,
      ),
    ).toThrow(/sha256/);
  });

  it("canonicalizes ingestion fallback IDs before they enter a V2 envelope", () => {
    const rawSessionId = "prompt_response_private_text";
    const rawMessageId = "123e4567-e89b-42d3-a456-426614174000";
    const projection = projectLine(
      JSON.stringify({
        type: "assistant",
        session_id: rawSessionId,
        timestamp: "2026-09-14T12:00:00.000Z",
        message: {
          id: rawMessageId,
          model: "claude-sonnet-4-6",
          content: [],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }),
      { defaultSessionId: "fallback-file-stem" },
    );
    if (projection.kind !== "record" || projection.turn === null) {
      throw new Error("expected projected turn");
    }
    const envelope = createFindingEnvelopeV2(
      {
        ...validV2Body(),
        anchors: [
          {
            session_id: findingIds.session(projection.turn.sessionId),
            message_id: findingIds.message(projection.turn.messageId),
            timestamp: projection.turn.ts,
          },
        ],
      },
      TEST_V2_DESCRIPTOR,
    );
    const serialized = serializeFindingEnvelopeV2(envelope, TEST_V2_DESCRIPTOR);
    expect(serialized).not.toContain(rawSessionId);
    expect(serialized).not.toContain(rawMessageId);
    expect(envelope.anchors[0]?.session_id).toMatch(/^sid_[0-9a-f]{64}$/);
    expect(envelope.anchors[0]?.message_id).toMatch(/^mid_[0-9a-f]{64}$/);
  });

  it("rejects unknown, missing, invalid-enum, non-finite, and content-bearing recommendation facts", () => {
    expect(() => assertRecommendationPayloadV1(validD11Payload(), "D11")).not.toThrow();
    const base = validD11Payload() as { facts: Record<string, unknown> };
    expect(() => assertRecommendationPayloadV1({ ...base, content: "private transcript" })).toThrow(
      /keys/,
    );
    expect(() => {
      const { bash_call_count: _removed, ...facts } = base.facts;
      assertRecommendationPayloadV1({ ...base, facts });
    }).toThrow(/keys/);
    expect(() =>
      assertRecommendationPayloadV1({
        ...base,
        facts: { ...base.facts, preferred_tool: "cmd.exe" },
      }),
    ).toThrow(/enum/);
    expect(() =>
      assertRecommendationPayloadV1({
        ...base,
        facts: { ...base.facts, bash_error_ratio: Number.NaN },
      }),
    ).toThrow(/finite/);
    expect(() =>
      assertRecommendationPayloadV1({
        ...base,
        facts: { ...base.facts, command: "private transcript" },
      }),
    ).toThrow(/keys/);
  });

  it("uses a separate exact diagnostic contract and rejects impossible UTC timestamps", () => {
    const finding = {
      version: 1,
      category: "PRIVACY",
      label: "PRIVACY_REJECTED",
      anchor: { session_id: "session-8f4a2c", timestamp: NOW.toISOString() },
      ceu: { value: 4, band: "LOW", provenance: "MEASURED" },
    };
    expect(JSON.parse(serializeDiagnosticFindingV1(finding))).toEqual(finding);
    expect(() =>
      assertDiagnosticFindingV1({
        ...finding,
        anchor: { ...finding.anchor, timestamp: "2026-02-30T12:00:00.000Z" },
      }),
    ).toThrow(/timestamp/);
    expect(() => assertDiagnosticFindingV1({ ...finding, message: "private transcript" })).toThrow(
      /keys/,
    );
  });

  it("runs a registered emitter through engine, SQLite, and the query API", () => {
    const db = createInMemoryFixtureDb();
    try {
      seedD11(db);
      runDetectors(db, { now: NOW });
      const row = db
        .prepare(
          `SELECT rec_id, detector_id, category, lever, modeled_formula_json, evidence_json,
                target_metric, state, contract_version, template_id, contract_status, rule_id
           FROM recommendations WHERE detector_id = 'D11'`,
        )
        .get() as Record<string, unknown>;
      expect(row).toMatchObject({
        detector_id: "D11",
        state: "PROPOSED",
        contract_version: 1,
        template_id: "D11_TOOL_ERROR_RATE",
        contract_status: "V1_VALIDATED",
      });
      for (const mismatch of [
        { ...row, category: "LIMIT" },
        { ...row, lever: "tampered lever" },
        { ...row, target_metric: "other_metric" },
      ]) {
        expect(
          trustedRecommendationContract(
            mismatch as Parameters<typeof trustedRecommendationContract>[0],
          ),
        ).toBeNull();
      }
      const stored = JSON.parse(row.evidence_json as string) as { facts: Record<string, unknown> };
      // P2 WIRE adds the optional session_ids fact; every other fact is unchanged.
      expect(stored.facts.session_ids).toEqual(expect.any(Array));
      const { session_ids: _sessionIds, ...legacyFacts } = stored.facts;
      expect({ ...stored, facts: legacyFacts }).toEqual(validD11Payload());
      expect(row.evidence_json).not.toContain("private transcript");
      expect(
        trustedRecommendationContract({
          ...(row as unknown as Parameters<typeof trustedRecommendationContract>[0]),
          rule_id: "TEST_RULE",
        }),
      ).toBeNull();
      const { rule_id: _omittedRuleId, ...missingRuleId } = row;
      expect(
        trustedRecommendationContract(
          missingRuleId as unknown as Parameters<typeof trustedRecommendationContract>[0],
        ),
      ).toBeNull();

      setQueryDb(db);
      const card = getRecommendationCard(row.rec_id as string);
      expect(card).toMatchObject({
        detector_id: "D11",
        category: "TOOLING",
        target_metric: "shell_error_rate",
        actionability_ok: true,
      });
      expect(card?.steps[0]).toEqual({ kind: "route_tool", from: "Bash", to: "PowerShell" });
    } finally {
      db.close();
    }
  });

  it("F2: a pass that does not re-emit a rec still rewrites its reworded presentation text", () => {
    const db = createInMemoryFixtureDb();
    try {
      seedD11(db);
      runDetectors(db, { now: NOW });
      // A lever reworded after this row was written; the closed week is never re-emitted.
      db.prepare(
        "UPDATE recommendations SET lever = 'old lever text' WHERE detector_id = 'D11'",
      ).run();
      runDetectorsCore(db, buildContext(NOW), []);
      const row = db
        .prepare(
          `SELECT detector_id, category, lever, target_metric, evidence_json, contract_version,
                  template_id, contract_status, rule_id
             FROM recommendations WHERE detector_id = 'D11'`,
        )
        .get() as Parameters<typeof trustedRecommendationContract>[0];
      expect(trustedRecommendationContract(row)).not.toBeNull();
      expect(row.lever).not.toBe("old lever text");
    } finally {
      db.close();
    }
  });

  it("runs V2 through the single engine write boundary and fail-closed trusted reader", () => {
    const db = createInMemoryFixtureDb();
    const envelope = createFindingEnvelopeV2(validV2Body(), TEST_V2_DESCRIPTOR);
    const detector: DetectorV2 = {
      contractVersion: 2,
      descriptor: TEST_V2_DESCRIPTOR,
      id: "D11",
      name: "V2_TEST",
      evaluate: () => ({
        status: "ACTIVE",
        note: "test finding",
        fired: [
          {
            scopeKey: "v2-test",
            scope_workspace_id: "ws-alpha",
            modeled_savings_u_per_wk: 120,
            payload: envelope,
          },
        ],
      }),
    };
    try {
      runDetectorsCore(db, buildContext(NOW), [detector]);
      const row = db
        .prepare(
          `SELECT detector_id, evidence_json, contract_version, template_id,
                  contract_status, rule_id, category, lever, target_metric
             FROM recommendations WHERE detector_id='D11'`,
        )
        .get() as Record<string, unknown>;
      expect(row).toMatchObject({
        detector_id: "D11",
        contract_version: 2,
        template_id: null,
        contract_status: "V2_VALIDATED",
        rule_id: "TEST_RULE",
        category: "TOOLING",
        lever: TEST_V2_DESCRIPTOR.presentation.lever,
        target_metric: "error_ratio",
      });
      const trusted = trustedRecommendationContract(
        row as unknown as Parameters<typeof trustedRecommendationContract>[0],
        (ruleId) => (ruleId === TEST_V2_DESCRIPTOR.rule_id ? TEST_V2_DESCRIPTOR : null),
      );
      expect(trusted?.version).toBe(2);
      expect(trusted?.payload).toEqual(envelope);

      const wrongOwnerDescriptor = defineFindingDescriptorV2({
        ...TEST_V2_DESCRIPTOR,
        owner_detector_id: "D12",
        rule_id: "OTHER_RULE",
      });
      const wrongOwnerEnvelope = createFindingEnvelopeV2(
        { ...validV2Body(), rule_id: "OTHER_RULE" },
        wrongOwnerDescriptor,
      );
      const wrongOwnerDetector: DetectorV2 = {
        ...detector,
        descriptor: wrongOwnerDescriptor,
        evaluate: () => ({
          status: "ACTIVE",
          note: "wrong owner",
          fired: [
            {
              scopeKey: "wrong-owner",
              scope_workspace_id: "ws-alpha",
              modeled_savings_u_per_wk: 1,
              payload: wrongOwnerEnvelope,
            },
          ],
        }),
      };
      expect(() => runDetectorsCore(db, buildContext(NOW), [wrongOwnerDetector])).toThrow(
        /cannot emit rule/,
      );

      const staleV1: Detector = {
        contractVersion: 1,
        id: "D11",
        name: "STALE_V1",
        evaluate: () => ({
          status: "ACTIVE",
          note: "stale writer",
          fired: [
            {
              scopeKey: "v2-test",
              scope_workspace_id: "ws-alpha",
              modeled_savings_u_per_wk: 1,
              payload: validD11Payload() as RecommendationPayloadV1,
            },
          ],
        }),
      };
      runDetectorsCore(db, buildContext(NOW), [staleV1]);
      expect(
        db
          .prepare(
            "SELECT contract_version, contract_status, rule_id FROM recommendations WHERE detector_id='D11'",
          )
          .get(),
      ).toEqual({ contract_version: 2, contract_status: "V2_VALIDATED", rule_id: "TEST_RULE" });

      for (const mismatch of [
        { ...row, contract_status: "V1_VALIDATED" },
        { ...row, contract_version: 1 },
        { ...row, template_id: "D11_TOOL_ERROR_RATE" },
        { ...row, rule_id: "OTHER_RULE" },
        { ...row, detector_id: "D12" },
        { ...row, category: "LIMIT" },
        { ...row, lever: "tampered lever" },
        { ...row, target_metric: "other_metric" },
        { ...row, evidence_json: JSON.stringify({ ...envelope, label: "PRIVATE_TEXT" }) },
      ]) {
        expect(
          trustedRecommendationContract(
            mismatch as Parameters<typeof trustedRecommendationContract>[0],
            (ruleId) => (ruleId === TEST_V2_DESCRIPTOR.rule_id ? TEST_V2_DESCRIPTOR : null),
          ),
        ).toBeNull();
      }
    } finally {
      db.close();
    }
  });

  it("fails closed on legacy rows, then upgrades the same rec id while preserving lifecycle", () => {
    const db = createInMemoryFixtureDb();
    try {
      seedD11(db);
      runDetectors(db, { now: NOW });
      const recId = (
        db.prepare("SELECT rec_id FROM recommendations WHERE detector_id='D11'").get() as {
          rec_id: string;
        }
      ).rec_id;
      db.prepare(
        `UPDATE recommendations SET state='ADOPTED', adopted_at=?, contract_version=NULL,
           template_id=NULL, contract_status='LEGACY_UNVERIFIED', evidence_json='{"content":"legacy"}'
         WHERE rec_id=?`,
      ).run(NOW.toISOString(), recId);
      setQueryDb(db);
      expect(getRecommendationCard(recId)).toBeNull();
      expect(listLedger().data?.entries).toEqual([]);
      expect(
        getTrends({ from: "2026-09-14T00:00:00.000Z", to: "2026-09-16T00:00:00.000Z" }, "day").data
          ?.adoption_markers,
      ).toEqual([]);
      expect(
        getEfficiencyHeadroom(db, {
          from: "2026-09-14T00:00:00.000Z",
          to: "2026-09-16T00:00:00.000Z",
        }).data?.opportunities,
      ).toEqual([]);

      runDetectors(db, { now: NOW });
      expect(
        db
          .prepare(
            "SELECT state, adopted_at, contract_version, contract_status FROM recommendations WHERE rec_id=?",
          )
          .get(recId),
      ).toEqual({
        state: "ADOPTED",
        adopted_at: NOW.toISOString(),
        contract_version: 1,
        contract_status: "V1_VALIDATED",
      });
      expect(getRecommendationCard(recId)?.state).toBe("ADOPTED");
    } finally {
      db.close();
    }
  });

  it("migrates 022 data, discards raw classifier paths, and enforces DB constraints", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db, "022_classifier_boundaries");
      db.prepare(
        "INSERT INTO ingest_classifier_baselines(file_path, seeded_offset) VALUES (?, 12)",
      ).run("C:/Users/operator/private.jsonl");
      db.prepare(
        `INSERT INTO recommendations
          (rec_id, provenance, detector_id, category, lever, modeled_formula_json,
           evidence_json, target_metric, state, created_at)
         VALUES ('legacy', 'RULE', 'D11', 'TOOLING', 'legacy', '{}',
           '{"content":"legacy"}', 'metric', 'PROPOSED', ?)`,
      ).run(NOW.toISOString());
      db.prepare(
        `INSERT INTO workspaces (workspace_id, project_slug, registered_at)
         VALUES ('legacy-shell-workspace', 'legacy-shell-workspace', ?)`,
      ).run(NOW.toISOString());
      db.prepare(
        `INSERT INTO sessions
          (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
           state, turn_count, cost_equiv_u, hygiene_flags)
         VALUES ('legacy-shell-session', 'legacy-shell-workspace', '/fixture/legacy-shell.jsonl',
           ?, ?, 'RECONCILED', 0, 0, '[]')`,
      ).run(NOW.toISOString(), NOW.toISOString());
      db.prepare(
        `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_hash)
         VALUES ('legacy-shell-event', 'legacy-shell-session', ?, 'Bash', ?)`,
      ).run(NOW.toISOString(), "4".repeat(64));
      expect(runMigrations(db)).toEqual([
        "023_privacy_contract",
        "024_finding_contract_v2",
        "025_tool_error_classifier",
        "026_recommendation_contract_guards",
        "027_handler_recommendation_storage",
        "028_tool_event_content",
        "029_subagent_meta",
        "030_detector_week_results",
        "031_detector_status_live",
        "032_session_title",
        "033_compaction_positions",
        "034_ingest_metric_events_session_position",
        "035_rec_lifecycle",
        "036_rec_lifecycle_actions",
        "037_subagent_meta_session_index",
        "038_turns_agent_id",
        "039_unrestrict_app_content",
        "040_ledger_daily",
        "041_perf_indexes",
        "042_limit_snapshots",
        "043_tool_error_labels_v2",
        "044_c6_edit_string_hashes",
        "045_catalog_items",
        "046_detector_contract_v2",
        "047_ingest_metric_events_event_ts",
        "048_ingest_offset_identity",
        "049_setup_grade_snapshots",
        "050_setup_grade_indexes",
        "051_judge_verdicts",
        "052_classifier_version_2",
        "053_turns_grade_cover",
      ]);
      expect(
        db.prepare("SELECT contract_status FROM recommendations WHERE rec_id='legacy'").get(),
      ).toEqual({ contract_status: "LEGACY_UNVERIFIED" });
      expect(() =>
        db
          .prepare(
            `INSERT INTO recommendations
            (rec_id, provenance, detector_id, category, lever, modeled_formula_json,
             evidence_json, target_metric, state, created_at, contract_version,
             template_id, contract_status, rule_id)
           VALUES ('v1-null-version', 'RULE', 'D1', 'CONTEXT', 'x', '{}', '{}',
             'avg_context_per_turn', 'PROPOSED', ?, NULL, 'D1_CONTEXT_ALWAYS_LOADED',
             'V1_VALIDATED', NULL)`,
          )
          .run(NOW.toISOString()),
      ).toThrow(/invalid recommendation contract tuple/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO recommendations
            (rec_id, provenance, detector_id, category, lever, modeled_formula_json,
             evidence_json, target_metric, state, created_at, contract_version,
             contract_status, rule_id)
           VALUES ('v2-storage', 'RULE', 'TEST', 'TOOLING', 'trusted copy', '{}', '{}',
             'error_ratio', 'PROPOSED', ?, 2, 'V2_VALIDATED', 'TEST_RULE')`,
          )
          .run(NOW.toISOString()),
      ).not.toThrow();
      expect(() =>
        db
          .prepare("UPDATE recommendations SET template_id='FORGED' WHERE rec_id='v2-storage'")
          .run(),
      ).toThrow(/invalid recommendation contract tuple/);
      expect(() =>
        db
          .prepare("UPDATE recommendations SET contract_version=NULL WHERE rec_id='v2-storage'")
          .run(),
      ).toThrow(/invalid recommendation contract tuple/);
      expect(() =>
        db
          .prepare(
            "UPDATE recommendations SET contract_status='UNVALIDATED' WHERE rec_id='v2-storage'",
          )
          .run(),
      ).toThrow(/CHECK|invalid recommendation contract tuple/);
      expect(
        db
          .prepare("PRAGMA table_info(ingest_classifier_baselines)")
          .all()
          .map((row: unknown) => (row as { name: string }).name),
      ).toEqual(["file_path_hash", "seeded_offset"]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM ingest_classifier_baselines").get()).toEqual({
        n: 0,
      });
      expect(
        db.prepare("SELECT input_hash FROM tool_events WHERE event_id='legacy-shell-event'").get(),
      ).toEqual({ input_hash: null });

      const insert = db.prepare(
        `INSERT INTO ingest_metric_events
          (event_id, session_id, is_user_turn, is_compact_summary, is_api_error, is_interrupt,
           cc_version, classifier_version, event_ts)
         VALUES (?, 's', 0, 0, 0, 0, ?, ?, ?)`,
      );
      expect(() => insert.run("ok", "2.1.19", "classifier-1", NOW.toISOString())).not.toThrow();
      expect(() =>
        insert.run("bad-version", "2.1.19/private", "classifier-1", NOW.toISOString()),
      ).toThrow(/contract/);
      expect(() =>
        insert.run("bad-classifier", "2.1.19", "classifier-3", NOW.toISOString()),
      ).toThrow(/contract/);
      expect(() =>
        insert.run("bad-ts", "2.1.19", "classifier-1", "2026-02-30T12:00:00.000Z"),
      ).toThrow(/contract/);
    } finally {
      db.close();
    }
  });

  it("keeps a structural privacy manifest in lockstep with every U9-owned table", () => {
    const db = createInMemoryFixtureDb();
    try {
      const manifest = {
        recommendations: [
          "rec_id",
          "provenance",
          "detector_id",
          "analysis_run_id",
          "category",
          "scope_workspace_id",
          "lever",
          "modeled_savings_u_per_wk",
          "modeled_formula_json",
          "evidence_json",
          "target_metric",
          "state",
          "created_at",
          "adopted_at",
          "dismissed_until",
          "contract_version",
          "template_id",
          "contract_status",
          "rule_id",
        ],
        tool_events: [
          "event_id",
          "session_id",
          "ts",
          "tool_name",
          "input_bytes",
          "result_bytes",
          "input_hash",
          "exit_class",
          "commit_sha",
          "tool_error_class",
          "tool_error_classifier_version",
          "bash_command_family",
          "interrupt_kind",
          "interrupt_classifier_version",
        ],
        ingest_metric_events: [
          "event_id",
          "session_id",
          "user_turn_ts",
          "is_user_turn",
          "is_compact_summary",
          "is_api_error",
          "is_interrupt",
          "classifier_label",
          "command_shape",
          "destructive_op",
          "cc_version",
          "classifier_version",
          "event_ts",
          "event_position",
          "boundary_kind",
          "boundary_verification",
          "is_sidechain",
        ],
        ingest_classifier_baselines: ["file_path_hash", "seeded_offset"],
      } as const;

      for (const [table, expectedColumns] of Object.entries(manifest)) {
        const actualColumns = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row: unknown) => (row as { name: string }).name);
        expect(actualColumns, table).toEqual(expectedColumns);
      }

      expect(() =>
        db
          .prepare(
            `INSERT INTO ingest_metric_events
              (event_id, session_id, classifier_label, command_shape, destructive_op,
               classifier_version, boundary_kind, boundary_verification)
             VALUES ('manifest-bad', 's', 'private content', 'git status', 'private content',
               'private content', 'private content', 'private content')`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
