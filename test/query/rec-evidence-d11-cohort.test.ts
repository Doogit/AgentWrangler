import { afterEach, describe, expect, it } from "vitest";
import { RecEvidenceContext } from "../../src/query/api/rec-evidence.js";
import type { RecommendationCard } from "../../src/query/api/recommendations.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const FROM = "2027-01-01T00:00:00.000Z";
const TO = "2027-01-08T00:00:00.000Z";

const db = createInMemoryFixtureDb();
afterEach(() => {
  db.prepare("DELETE FROM tool_event_content WHERE event_id LIKE 'd11c-%'").run();
  db.prepare("DELETE FROM tool_events WHERE event_id LIKE 'd11c-%'").run();
  db.prepare("DELETE FROM turns WHERE message_id LIKE 'd11c-%'").run();
  db.prepare("DELETE FROM sessions WHERE session_id LIKE 'd11c-%'").run();
});

function failedCall(id: string, turns: number, error: string): void {
  db.prepare(`INSERT INTO sessions
    (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count)
    VALUES (?, 'ws-alpha', ?, ?, ?, 'RECONCILED', ?)`).run(id, `fixture/${id}`, FROM, FROM, turns);
  for (let n = 0; n < turns; n++) {
    db.prepare(`INSERT INTO turns
      (message_id, session_id, workspace_id, ts, model, parser_version)
      VALUES (?, ?, 'ws-alpha', ?, 'claude-sonnet', 'test')`).run(`${id}-turn-${n}`, id, FROM);
  }
  db.prepare(`INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class)
    VALUES (?, ?, ?, 'PowerShell', 'ERROR')`).run(`${id}-event`, id, FROM);
  db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
    `${id}-event`,
    JSON.stringify({ command: "do-thing", error }),
  );
}

function evidence(): { session_count: number | null; ids: string[] } | undefined {
  const rec = {
    rec_id: "d11c-rec",
    detector_id: "D11",
    scope_workspace_id: "ws-alpha",
    evidence: { session_ids: [], higher_error_tool: "PowerShell" },
    trigger: { session_ids: [], window: { from: FROM, to: TO }, facts: [] },
  } as unknown as RecommendationCard;
  new RecEvidenceContext(db).enrich(rec, { from: FROM, to: TO });
  const found = rec.trigger?.evidence;
  return (
    found && { session_count: found.session_count, ids: found.sessions.map((s) => s.session_id) }
  );
}

describe("D11 evidence cohort", () => {
  it("counts only sessions with a real shell failure", () => {
    failedCall("d11c-a-parser", 3, "Exit code 1\nParserError: Unexpected token '}' in expression");
    failedCall("d11c-b-hook", 5, "PreToolUse hook blocked this call");
    failedCall("d11c-c-script", 7, "Exit code 1\nscript ran and failed");
    const rec = {
      rec_id: "d11c-rec",
      detector_id: "D11",
      scope_workspace_id: "ws-alpha",
      evidence: { session_ids: [], higher_error_tool: "PowerShell" },
      trigger: {
        session_ids: ["d11c-a-parser", "d11c-b-hook", "d11c-c-script"],
        window: { from: FROM, to: TO },
        facts: [],
      },
    } as unknown as RecommendationCard;
    new RecEvidenceContext(db).enrich(rec, { from: FROM, to: TO });
    expect(rec.trigger?.evidence?.session_count).toBe(1);
    expect(rec.trigger?.evidence?.sessions[0]).toEqual({
      session_id: "d11c-a-parser",
      claimed_u: null,
      turn_count: 3,
    });
    // Listed sessions outside the cohort carry no turns.
    expect(rec.trigger?.evidence?.sessions[1]?.turn_count).toBe(0);
  });

  it("is empty when no call is a real shell failure", () => {
    failedCall("d11c-b-hook", 5, "PreToolUse hook blocked this call");
    failedCall("d11c-c-script", 7, "Exit code 1\nscript ran and failed");
    expect(evidence()).toEqual({ session_count: 0, ids: [] });
  });
});
