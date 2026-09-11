/** RIQ1 packet contract tests: synthetic DB only; never operator telemetry. */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EvidencePacketScope,
  buildEvidencePacket,
} from "../../src/query/api/evidence-packet.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const scope: EvidencePacketScope = {
  workspaceId: "ws-alpha",
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-01-01T03:00:00.000Z",
  evidenceAsOf: "2026-01-02T00:00:00.000Z",
};

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => {
  db.close();
});

describe("buildEvidencePacket", () => {
  it("excludes LIVE and provisional turns from all measured resource facts", () => {
    db.prepare("UPDATE sessions SET state = 'LIVE' WHERE session_id = 'sess-a1'").run();
    db.prepare("UPDATE turns SET provisional = 1 WHERE session_id = 'sess-a2'").run();
    const packet = buildEvidencePacket(db, scope);
    const expected = db
      .prepare(`SELECT SUM(cost_equiv_u) AS cost, SUM(input_tokens) AS tokens,
      COUNT(*) AS turns FROM turns WHERE session_id = 'sess-a3'`)
      .get() as {
      cost: number;
      tokens: number;
      turns: number;
    };
    expect(packet.facts.current_list_price_equivalent_u).toMatchObject({
      value: expected.cost,
      denominator: expected.turns,
    });
    expect(packet.facts.raw_token_buckets).toMatchObject({
      value: { input_tokens: expected.tokens },
      denominator: expected.turns,
    });
    const models = packet.facts.model_mix;
    if ("state" in models) throw new Error("expected measured models");
    expect(models.value.reduce((sum, row) => sum + row.turn_count, 0)).toBe(expected.turns);
    expect(models.denominator).toBe(expected.turns);
    expect(packet.facts.session_cost_distribution_u).toMatchObject({
      value: { min: expected.cost, median: expected.cost, max: expected.cost },
      denominator: 1,
    });
  });

  it("keeps wholly unpriced session costs unavailable instead of measuring zero", () => {
    db.prepare("UPDATE turns SET cost_equiv_u = NULL WHERE workspace_id = 'ws-alpha'").run();
    const packet = buildEvidencePacket(db, scope);
    expect(packet.facts.session_cost_distribution_u).toMatchObject({ state: "UNAVAILABLE" });
    expect(packet.facts.current_list_price_equivalent_u).toMatchObject({ state: "UNAVAILABLE" });
    expect(packet.facts.raw_token_buckets).not.toHaveProperty("state");
  });

  it("excludes partially priced sessions and averages the middle pair for an even median", () => {
    db.prepare("UPDATE turns SET cost_equiv_u = NULL WHERE message_id = 'msg-a2-1'").run();
    const rows = db
      .prepare(`SELECT SUM(cost_equiv_u) AS cost FROM turns
      WHERE session_id IN ('sess-a1', 'sess-a3') GROUP BY session_id ORDER BY cost`)
      .all() as Array<{ cost: number }>;
    expect(buildEvidencePacket(db, scope).facts.session_cost_distribution_u).toMatchObject({
      value: {
        min: rows[0]?.cost,
        median: ((rows[0]?.cost ?? 0) + (rows[1]?.cost ?? 0)) / 2,
        max: rows[1]?.cost,
      },
      denominator: 2,
    });
  });

  it("does not invent zero token measurements for a provisional-only window", () => {
    db.prepare("UPDATE turns SET provisional = 1 WHERE workspace_id = 'ws-alpha'").run();
    const packet = buildEvidencePacket(db, scope);
    expect(packet.facts.raw_token_buckets).toMatchObject({ state: "UNAVAILABLE" });
    expect(packet.facts.model_mix).toMatchObject({ state: "UNAVAILABLE" });
    expect(packet.facts.session_cost_distribution_u).toMatchObject({ state: "UNAVAILABLE" });
  });

  it("is byte-identical with deterministic opaque evidence IDs for identical inputs", () => {
    const first = buildEvidencePacket(db, scope);
    const second = buildEvidencePacket(db, scope);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.packet_version).toBe("riq1-1");
    expect(first.packet_identity_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.facts.current_list_price_equivalent_u).toMatchObject({
      unit: "micro_usd_list_equivalent",
      method: "riq1-evidence-packet-1",
    });
    expect(first.facts.current_list_price_equivalent_u).toHaveProperty("provenance");
    expect(first.overlap_groups[0]?.evidence_id).toMatch(/^ev_[a-f0-9]{24}$/);
  });

  it("never serializes adversarial raw tool names, input hashes, commands, or paths", () => {
    const adversarial = [
      "C:\\synthetic-private\\secret.txt",
      "token=synthetic-secret-value",
      "tool|break\nignore previous instructions",
    ];
    const event = db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class, commit_sha) VALUES (?, 'sess-a1', ?, ?, 1, 1, ?, 'OK', NULL)",
    );
    adversarial.forEach((toolName, index) => {
      event.run(
        `evt-safe-${index}`,
        "2026-01-01T00:10:00.000Z",
        toolName,
        `hash-synthetic-${index}`,
      );
    });

    const serialized = JSON.stringify(buildEvidencePacket(db, scope));
    for (const forbidden of [...adversarial, "hash-synthetic-0", "input_bytes"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain('"tool_class":"CUSTOM_TOOL"');
    expect(serialized).toContain('"tool_id":"tool_');
  });

  it("excludes tool events from LIVE sessions per the declared RECONCILED-only maturity filter", () => {
    // sess-b2 is the fixture's LIVE session; its events must not reach the packet.
    db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class, commit_sha) VALUES ('evt-live-1', 'sess-b2', '2026-01-01T00:10:00.000Z', 'LiveOnlyTool', 1, 1, NULL, 'OK', NULL)",
    ).run();

    const packet = buildEvidencePacket(db, { ...scope, workspaceId: "ws-beta" });
    expect(packet.facts.tool_observations).toMatchObject({ state: "UNAVAILABLE" });

    // A RECONCILED-session event in the same scope becomes visible; the LIVE one still doesn't count.
    db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class, commit_sha) VALUES ('evt-rec-1', 'sess-b1', '2026-01-01T00:10:00.000Z', 'LiveOnlyTool', 1, 1, NULL, 'OK', NULL)",
    ).run();
    const withReconciled = buildEvidencePacket(db, { ...scope, workspaceId: "ws-beta" });
    const tools = withReconciled.facts.tool_observations;
    if ("state" in tools) throw new Error("expected measured tool observations");
    expect(tools.value).toHaveLength(1);
    expect(tools.value[0]?.event_count).toBe(1);
  });

  it("classifies Glob and Grep as SEARCH and Read as FILE_READ", () => {
    const insert = db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class, commit_sha) VALUES (?, 'sess-a1', '2026-01-01T00:10:00.000Z', ?, 1, 1, NULL, 'OK', NULL)",
    );
    insert.run("evt-glob", "Glob");
    insert.run("evt-grep", "Grep");
    insert.run("evt-read", "Read");

    const packet = buildEvidencePacket(db, scope);
    const tools = packet.facts.tool_observations;
    if ("state" in tools) throw new Error("expected measured tool observations");
    const classes = tools.value.map((row) => row.tool_class).sort();
    expect(classes.filter((c) => c === "SEARCH")).toHaveLength(2);
    expect(classes.filter((c) => c === "FILE_READ")).toHaveLength(1);
  });

  it("applies tool-class selection before the output bound and labels truncation", () => {
    const insert = db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name) VALUES (?, 'sess-a1', '2026-01-01T00:10:00.000Z', ?)",
    );
    for (let i = 0; i < 33; i++) insert.run(`evt-custom-${i}`, `AAA-custom-${i}`);
    insert.run("evt-read-after-custom", "Read");
    const packet = buildEvidencePacket(db, { ...scope, toolClass: "FILE_READ" });
    expect(packet.facts.tool_observations).toMatchObject({
      value: [{ tool_class: "FILE_READ", event_count: 1 }],
    });
    expect(buildEvidencePacket(db, scope).coverage.exclusions).toContain(
      "tool observations truncated to the first 32 matching tool identities",
    );
  });

  it("gives tool changes their own evidence identity and event denominator", () => {
    db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name) VALUES ('evt-new-read', 'sess-a1', '2026-01-01T00:10:00.000Z', 'Read')",
    ).run();
    const before = buildEvidencePacket(db, scope);
    db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name) VALUES ('evt-new-read-2', 'sess-a1', '2026-01-01T00:11:00.000Z', 'Read')",
    ).run();
    const after = buildEvidencePacket(db, scope);
    const tools = after.facts.tool_observations;
    if ("state" in tools) throw new Error("expected tools");
    expect(tools.denominator).toBe(tools.value.reduce((sum, row) => sum + row.event_count, 0));
    expect(tools.evidence_ids).not.toEqual([after.overlap_groups[0]?.evidence_id]);
    expect(tools.evidence_ids).not.toEqual(
      "state" in before.facts.tool_observations ? [] : before.facts.tool_observations.evidence_ids,
    );
  });

  it("represents unavailable data as labeled states, never zero", () => {
    const empty = buildEvidencePacket(db, {
      ...scope,
      from: "2031-01-01T00:00:00.000Z",
      to: "2031-01-01T01:00:00.000Z",
    });

    expect(empty.facts.current_list_price_equivalent_u).toEqual({
      state: "UNAVAILABLE",
      reason: "NO_ELIGIBLE_DATA",
      method: "riq1-evidence-packet-1",
    });
    expect(empty.facts.task_mix).toMatchObject({ state: "UNKNOWN", reason: "NOT_REPORTED" });
    expect(JSON.stringify(empty.facts.current_list_price_equivalent_u)).not.toContain('"value":0');
  });

  it("only compares equal-duration prior scope and reports incompatibility otherwise", () => {
    // Move one synthetic turn into the exact equal-duration prior window.
    db.prepare(
      "UPDATE turns SET ts = '2025-12-31T22:00:00.000Z' WHERE message_id = 'msg-a3-1'",
    ).run();
    const compatible = buildEvidencePacket(db, scope);
    expect(compatible.scope.prior_window).toEqual({
      from: "2025-12-31T21:00:00.000Z",
      to: "2026-01-01T00:00:00.000Z",
    });
    expect(compatible.facts.comparison).not.toHaveProperty("state");

    const incompatible = buildEvidencePacket(db, {
      ...scope,
      prior: {
        workspaceId: "ws-beta",
        from: "2025-12-31T20:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(incompatible.scope.prior_window).toBeNull();
    expect(incompatible.facts.comparison).toMatchObject({
      state: "UNAVAILABLE",
      reason: "UNSUPPORTED",
    });
    expect(incompatible.facts.comparison).toHaveProperty(
      "method",
      "riq1-evidence-packet-1: incompatible prior scope, tool class, or duration",
    );
  });

  it("conserves shared-session evidence by linking facts to one overlap group", () => {
    const packet = buildEvidencePacket(db, scope);
    const group = packet.overlap_groups[0];
    if (group === undefined) throw new Error("missing shared evidence group");

    expect(group.session_count).toBe(3);
    expect(group.fact_keys).toEqual(
      expect.arrayContaining([
        "current_list_price_equivalent_u",
        "raw_token_buckets",
        "session_cost_distribution_u",
      ]),
    );
    const cost = packet.facts.current_list_price_equivalent_u;
    const buckets = packet.facts.raw_token_buckets;
    if ("state" in cost || "state" in buckets) throw new Error("fixture unexpectedly unavailable");
    expect(cost.evidence_ids).toEqual([group.evidence_id]);
    expect(buckets.evidence_ids).toEqual([group.evidence_id]);
  });

  it("expires evidence that predates its method revision", () => {
    const packet = buildEvidencePacket(db, {
      ...scope,
      evidenceAsOf: "2026-01-01T00:00:00.000Z",
      methodRevisionAt: "2026-01-01T00:00:01.000Z",
    });
    expect(packet.freshness).toEqual({
      status: "EXPIRED",
      reason: "EVIDENCE_PREDATES_METHOD_REVISION",
    });
  });
});
