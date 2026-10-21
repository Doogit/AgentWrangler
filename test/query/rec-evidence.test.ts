import { afterEach, describe, expect, it } from "vitest";
import {
  recommendationTemplate,
  serializeModeledFormulaV1,
  serializeRecommendationPayloadV1,
} from "../../src/detector/privacy-contract.js";
import { recId } from "../../src/detector/rec-id.js";
import { RecEvidenceContext } from "../../src/query/api/rec-evidence.js";
import type { RecommendationCard } from "../../src/query/api/recommendations.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const FROM = "2027-01-01T00:00:00.000Z";
const TO = "2027-01-08T00:00:00.000Z";
const OLD_FROM = "2026-12-01T00:00:00.000Z";
const OLD_TO = "2026-12-08T00:00:00.000Z";

const db = createInMemoryFixtureDb();
afterEach(() => {
  db.prepare("DELETE FROM recommendations WHERE rec_id LIKE 'evidence-%'").run();
  db.prepare("DELETE FROM context_inventory WHERE probe_id LIKE 'evidence-%'").run();
  db.prepare("DELETE FROM subagent_meta WHERE agent_id LIKE 'evidence-%'").run();
  db.prepare("DELETE FROM tool_events WHERE event_id LIKE 'evidence-%'").run();
  db.prepare("DELETE FROM turns WHERE message_id LIKE 'evidence-%'").run();
  db.prepare("DELETE FROM sessions WHERE session_id LIKE 'evidence-%'").run();
});

function session(id: string, workspace = "ws-alpha", ts = FROM, turns = 1): void {
  db.prepare(`INSERT INTO sessions
    (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count)
    VALUES (?, ?, ?, ?, ?, 'RECONCILED', ?)`).run(id, workspace, `fixture/${id}`, ts, ts, turns);
  for (let n = 0; n < turns; n++) {
    db.prepare(`INSERT INTO turns
      (message_id, session_id, workspace_id, ts, model, parser_version)
      VALUES (?, ?, ?, ?, 'claude-sonnet', 'test')`).run(`${id}-turn-${n}`, id, workspace, ts);
  }
}

function card(detector: string, scope: string, ids: string[] = []): RecommendationCard {
  return {
    rec_id: `evidence-${detector}`,
    detector_id: detector,
    scope_workspace_id: scope,
    evidence: { session_ids: ids, higher_error_tool: "Bash" },
    trigger: { session_ids: ids.slice(0, 5), window: { from: FROM, to: TO }, facts: [] },
  } as unknown as RecommendationCard;
}

/**
 * What listing does: rank the stored sessions, list the first five (no call rows here), then
 * enrich. The card's evidence shows exactly the listed sessions (review 3 B8).
 */
function listRanked(rec: RecommendationCard): void {
  const context = new RecEvidenceContext(db);
  const stored = rec.evidence.session_ids as string[];
  const window = { from: FROM, to: TO };
  if (rec.trigger === undefined) throw new Error("trigger required");
  rec.trigger.session_ids = context
    .sessionRank({ ...rec, session_ids: stored }, window)
    .slice(0, 5);
  context.enrich(rec, window);
  expect(rec.trigger.evidence?.sessions.map((row) => row.session_id)).toEqual(
    rec.trigger.session_ids,
  );
}

describe("bounded recommendation evidence", () => {
  it("keeps the stored order for a detector without a cohort when no session has a claim", () => {
    const rec = card("D7", "ws-alpha", ["evidence-x", "evidence-y"]);
    expect(
      new RecEvidenceContext(db).sessionRank(
        { ...rec, session_ids: ["evidence-x", "evidence-y"] },
        { from: FROM, to: TO },
      ),
    ).toEqual(["evidence-x", "evidence-y"]);
  });

  it("keeps the evaluated W0 anchor when the request clock has advanced", () => {
    const rec = card("D11", "ws-alpha");
    rec.last_seen_week_start = OLD_FROM;
    rec.weeks_ago = 0;
    new RecEvidenceContext(db).enrich(rec, { from: FROM, to: TO });
    expect(rec.trigger?.window).toEqual({ from: OLD_FROM, to: OLD_TO });
  });

  it("counts all D11 error sessions across the anchor window and ranks by turns when claims are absent", () => {
    for (let n = 0; n < 7; n++) {
      const id = `evidence-a${n}`;
      session(id, "ws-alpha", FROM, n + 1);
      db.prepare(`INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class)
        VALUES (?, ?, ?, 'Bash', 'ERROR')`).run(`evidence-event-${n}`, id, FROM);
      db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
        `evidence-event-${n}`,
        JSON.stringify({ command: "x", error: "Exit code 1\nParserError: unexpected token" }),
      );
    }
    session("evidence-other", "ws-beta", FROM, 9);
    db.prepare(`INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class)
      VALUES ('evidence-other-event', 'evidence-other', ?, 'Bash', 'ERROR')`).run(FROM);
    session("evidence-old", "ws-alpha", OLD_FROM, 10);
    db.prepare(`INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class)
      VALUES ('evidence-old-event', 'evidence-old', ?, 'Bash', 'ERROR')`).run(OLD_FROM);
    const rec = card("D11", "ws-alpha", ["evidence-a0"]);
    listRanked(rec);
    expect(rec.trigger?.evidence?.session_count).toBe(7);
    expect(rec.trigger?.evidence?.sessions).toHaveLength(5);
    expect(rec.trigger?.evidence?.sessions.map((row) => row.session_id)).toEqual([
      "evidence-a6",
      "evidence-a5",
      "evidence-a4",
      "evidence-a3",
      "evidence-a2",
    ]);
    expect(rec.trigger?.evidence?.sessions.every((row) => row.claimed_u === null)).toBe(true);
  });

  it("uses C5's single finding session and its persisted evidence window", () => {
    session("evidence-c5", "ws-alpha", OLD_FROM, 3);
    session("evidence-current", "ws-alpha", FROM, 5);
    const rec = card("C5", "ws-alpha", ["evidence-c5"]);
    rec.evidence.window = { from: OLD_FROM, to: OLD_TO };
    new RecEvidenceContext(db).enrich(rec, { from: FROM, to: TO });
    expect(rec.trigger?.window).toEqual({ from: OLD_FROM, to: OLD_TO });
    expect(rec.trigger?.evidence).toEqual({
      session_count: 1,
      sessions: [{ session_id: "evidence-c5", claimed_u: null, turn_count: 3 }],
    });
  });

  it("leaves a D1 count unknown when the source identity is unproven", () => {
    const rec = card("D1", "ws-alpha", ["evidence-a"]);
    new RecEvidenceContext(db).enrich(rec, { from: FROM, to: TO });
    expect(rec.trigger?.evidence).toBeUndefined();
  });

  it("counts D1's exact source cohort and ranks priced claims before the five-session cap", () => {
    const template = recommendationTemplate("D1_CONTEXT_ALWAYS_LOADED");
    const payload = {
      version: 1 as const,
      template_id: "D1_CONTEXT_ALWAYS_LOADED" as const,
      facts: {
        component: "CLAUDE_MD",
        probe_id: "evidence-source",
        source_tokens: 12_000,
        source_target: 2_000,
        delta_context_tokens: 10_000,
        turns_per_week: 7,
        scope: "workspace",
        workspace_multiplier: 1,
        session_ids: ["evidence-d1-0"],
      },
    };
    db.prepare(`INSERT INTO context_inventory
      (probe_id, workspace_id, component, file_ref, file_hash, tokens, probed_at, attribution_version)
      VALUES ('evidence-source', 'ws-alpha', 'CLAUDE_MD', 'fixture/CLAUDE.md', 'hash', 12000, ?, 'test')`).run(
      FROM,
    );
    // d1ClaimProducer's claims carry the engine's deterministic rec_id (P3.L L2), independent
    // of any recommendations row — so the fixture's manually-inserted D1 rec must use that
    // same id (recId("D1", scopeWorkspaceId, scopeKey), scopeKey = d1ScopeKey(row)) for the
    // ledger join in rec-evidence.ts (line ~199) to find it.
    const d1RecId = recId("D1", "ws-alpha", "D1|ws-alpha|CLAUDE_MD|CLAUDE.md");
    db.prepare(`INSERT INTO recommendations
      (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
       modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
       state, created_at, contract_version, template_id, contract_status)
      VALUES (?, 'RULE', 'D1', ?, 'ws-alpha', ?, 1000, ?, ?, ?,
        'PROPOSED', ?, 1, 'D1_CONTEXT_ALWAYS_LOADED', 'V1_VALIDATED')`).run(
      d1RecId,
      template.category,
      template.lever,
      serializeModeledFormulaV1(payload),
      serializeRecommendationPayloadV1(payload),
      template.target_metric,
      FROM,
    );
    for (let n = 0; n < 7; n++) {
      const id = `evidence-d1-${n}`;
      session(id, "ws-alpha", FROM, 7 - n);
      db.prepare(`UPDATE turns SET cache_read_tokens = ?, pricing_snapshot_id = 'snap-sonnet'
        WHERE session_id = ?`).run(n === 0 ? 1 : n === 6 ? 10_000 : n * 100, id);
    }
    session("evidence-d1-other", "ws-beta", FROM, 12);
    session("evidence-d1-old", "ws-alpha", OLD_FROM, 12);
    session("evidence-d1-explore", "ws-alpha", FROM, 12);
    db.prepare(
      "UPDATE turns SET is_sidechain = 1, agent_id = 'evidence-agent' WHERE session_id = 'evidence-d1-explore'",
    ).run();
    db.prepare(`INSERT INTO subagent_meta (agent_id, session_id, agent_type)
      VALUES ('evidence-agent', 'evidence-d1-explore', 'Explore')`).run();
    const rec = card("D1", "ws-alpha", ["evidence-d1-0"]);
    rec.rec_id = d1RecId;
    rec.evidence = payload.facts;
    listRanked(rec);
    expect(rec.trigger?.evidence?.session_count).toBe(7);
    expect(rec.trigger?.evidence?.sessions).toHaveLength(5);
    expect(rec.trigger?.evidence?.sessions[0]).toMatchObject({
      session_id: "evidence-d1-6",
      // raw tokens = min(delta_context_tokens=10_000, cache_read=10_000) = 10_000; the ledger
      // claims round(10_000 × D1_D10_AVOIDANCE_FRACTION=0.5) = 5_000 × $0.30/MTok = 1_500 µUSD.
      claimed_u: 1_500,
      turn_count: 1,
    });
    expect(rec.trigger?.evidence?.sessions.map((item) => item.session_id)).not.toContain(
      "evidence-d1-0",
    );
    db.prepare("DELETE FROM recommendations WHERE rec_id = ?").run(d1RecId);
  });
});
