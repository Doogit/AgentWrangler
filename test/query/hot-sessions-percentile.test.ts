import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getHotSessions } from "../../src/query/api/hot-sessions.js";
import { getSessionSpendPercentile } from "../../src/query/api/self-percentiles.js";
import { setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const REF = "2027-06-20T12:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});

afterEach(() => {
  db.close();
});

function insSessionWithTurn(sessionId: string, workspaceId: string, cost: number): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?,?,?,?,?,'RECONCILED',1,?,'[]')`,
  ).run(sessionId, workspaceId, `/fake/${sessionId}.jsonl`, REF, REF, cost);
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?,?,?,?, 'claude-sonnet',0, 0,0,0, 0,0,0, NULL,'snap-sonnet',?,'LIST_EQUIV',0,'test-v1')`,
  ).run(`t-${sessionId}`, sessionId, workspaceId, REF, cost);
}

describe("getHotSessions self-percentile enrichment", () => {
  it("attaches spend_percentile + n identical to getSessionSpendPercentile", () => {
    db.prepare(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('wsp','wsp',?)",
    ).run(REF);
    for (let cost = 1; cost <= 25; cost += 1) insSessionWithTurn(`p-${cost}`, "wsp", cost);

    const rows = getHotSessions(undefined, 100).filter((r) => r.workspace_id === "wsp");
    expect(rows.length).toBe(25);
    for (const row of rows) {
      const direct = getSessionSpendPercentile(db, row.session_id);
      expect(row.spend_percentile).toBe(direct.percentile);
      expect(row.spend_percentile_n).toBe(direct.n);
    }
    // The priciest session ranks at the top of its own workspace.
    const top = rows.find((r) => r.session_id === "p-25");
    expect(top?.spend_percentile).toBe(1);
    expect(top?.spend_percentile_n).toBe(25);
  });

  it("withholds the percentile (null) but still reports n below the n>=20 floor", () => {
    // The seeded fixture workspaces each hold fewer than 20 sessions. sess-a3 is
    // the latest in ws-alpha, so its anchored window sees all three peers.
    const rows = getHotSessions(undefined, 100);
    const alpha = rows.find((r) => r.session_id === "sess-a3");
    expect(alpha?.spend_percentile).toBeNull();
    expect(alpha?.spend_percentile_n).toBe(3); // ws-alpha has 3 sessions
  });
});
