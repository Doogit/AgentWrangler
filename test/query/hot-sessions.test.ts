import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hotSessionsByCost } from "../../src/query/spend.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => {
  db.close();
});

function ts(offsetMinutes: number): string {
  const d = new Date("2026-01-01T00:00:00.000Z");
  d.setMinutes(d.getMinutes() + offsetMinutes);
  return d.toISOString();
}

function insertSession(
  sessionId: string,
  lastTurnAt: string | null,
  turns: Array<{ id: string; ts: string; costU: number | null; provisional?: number }>,
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state)
     VALUES (?, 'ws-alpha', ?, ?, ?, 'RECONCILED')`,
  ).run(sessionId, `/fake/${sessionId}.jsonl`, turns[0]?.ts ?? null, lastTurnAt);
  for (const turn of turns) {
    db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, cost_equiv_u,
                          provisional, parser_version)
       VALUES (?, ?, 'ws-alpha', ?, 'claude-sonnet', ?, ?, 'test-v1')`,
    ).run(turn.id, sessionId, turn.ts, turn.costU, turn.provisional ?? 0);
  }
}

describe("hotSessionsByCost", () => {
  it("ranks every fixture session by total cost, including sub-threshold sessions", () => {
    const rows = hotSessionsByCost(db);
    const costs = rows.map((row) => row.cost_equiv_u);

    expect(rows[0]?.session_id).toBe("sess-b1");
    expect(
      costs.every((cost, index) => {
        const previous = costs[index - 1];
        return index === 0 || (previous !== undefined && previous >= cost);
      }),
    ).toBe(true);
    expect(rows.map((row) => row.session_id).sort()).toEqual(
      ["sess-a1", "sess-a2", "sess-a3", "sess-b1", "sess-b2"].sort(),
    );
  });

  it("exposes output/context split fields and dominant model", () => {
    const rows = hotSessionsByCost(db);

    for (const row of rows) {
      expect(row).toHaveProperty("total_output_tokens");
      expect(row).toHaveProperty("avg_output_tokens");
      expect(row).toHaveProperty("total_context_tokens");
      expect(row).toHaveProperty("avg_context_tokens");
      expect(row).toHaveProperty("model");
      expect(row).toHaveProperty("turns");
      expect(row).toHaveProperty("last_turn_at");
      expect(row.total_output_tokens).toEqual(expect.any(Number));
      expect(row.avg_output_tokens).toEqual(expect.any(Number));
      expect(row.total_context_tokens).toEqual(expect.any(Number));
      expect(row.avg_context_tokens).toEqual(expect.any(Number));
      expect(row.turns).toEqual(expect.any(Number));
      expect(row.model).toEqual(expect.any(String));
      expect(row.last_turn_at).toEqual(expect.any(String));
    }
  });

  it("includes provisional turns in the cost ranking", () => {
    // sess-b2's only turn is provisional=1 yet still ranks (cost view, not spend).
    const row = hotSessionsByCost(db).find((r) => r.session_id === "sess-b2");
    expect(row?.cost_equiv_u).toBe(1_600);
    expect(row?.turns).toBe(1);
  });

  it("selected window ranks by windowed sums but keeps lifetime last_turn_at and dominant model", () => {
    // [ts(5), ts(65)) holds a1-2 (14175), a1-3 (9000), a2-1 (18000) only.
    const rows = hotSessionsByCost(db, 20, { from: ts(5), to: ts(65) });
    expect(rows.map((r) => r.session_id)).toEqual(["sess-a1", "sess-a2"]);

    const a1 = rows[0];
    expect(a1?.cost_equiv_u).toBe(14_175 + 9_000);
    expect(a1?.turns).toBe(2);
    expect(a1?.last_turn_at).toBe(ts(30)); // lifetime, not window max

    const a2 = rows[1];
    expect(a2?.cost_equiv_u).toBe(18_000);
    expect(a2?.turns).toBe(1);
    expect(a2?.last_turn_at).toBe(ts(90));
    // Dominant model is all-time (1 sonnet + 1 haiku, tie -> model ASC), even
    // though only the sonnet turn falls inside the window.
    expect(a2?.model).toBe("claude-haiku");
  });

  it("window boundaries are half-open [from, to)", () => {
    // a1-2 sits exactly at ts(10); a1-3 exactly at ts(20).
    const rows = hotSessionsByCost(db, 20, { from: ts(10), to: ts(20) });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session_id).toBe("sess-a1");
    expect(rows[0]?.cost_equiv_u).toBe(14_175);
    expect(rows[0]?.turns).toBe(1);
  });

  it("breaks equal-cost ties by session_id ascending, including at the limit cut", () => {
    insertSession("sess-tie-b", null, [{ id: "msg-tie-b", ts: ts(400), costU: 999_999 }]);
    insertSession("sess-tie-a", null, [{ id: "msg-tie-a", ts: ts(401), costU: 999_999 }]);

    const all = hotSessionsByCost(db);
    expect(all.slice(0, 2).map((r) => r.session_id)).toEqual(["sess-tie-a", "sess-tie-b"]);

    // limit=1 must cut deterministically at the same tie order.
    const top = hotSessionsByCost(db, 1);
    expect(top.map((r) => r.session_id)).toEqual(["sess-tie-a"]);
  });

  it("falls back to the window's max turn ts when sessions.last_turn_at is null", () => {
    insertSession("sess-null-last", null, [
      { id: "msg-null-1", ts: ts(500), costU: 5 },
      { id: "msg-null-2", ts: ts(510), costU: 5 },
    ]);
    const row = hotSessionsByCost(db).find((r) => r.session_id === "sess-null-last");
    expect(row?.last_turn_at).toBe(ts(510));

    const windowed = hotSessionsByCost(db, 20, { from: ts(500), to: ts(505) }).find(
      (r) => r.session_id === "sess-null-last",
    );
    expect(windowed?.last_turn_at).toBe(ts(500));
  });

  it("ranks a session whose turns are all unpriced (NULL cost) at zero cost", () => {
    insertSession("sess-all-null", null, [
      { id: "msg-nullcost-1", ts: ts(600), costU: null },
      { id: "msg-nullcost-2", ts: ts(610), costU: null },
    ]);
    const row = hotSessionsByCost(db).find((r) => r.session_id === "sess-all-null");
    expect(row?.cost_equiv_u).toBe(0);
    expect(row?.turns).toBe(2);
    expect(row?.avg_output_tokens).toBe(0);
  });

  it("excludes sessions with no turns in the selected window", () => {
    const rows = hotSessionsByCost(db, 20, { from: ts(295), to: ts(310) });
    expect(rows.map((r) => r.session_id)).toEqual(["sess-b2"]);
    expect(rows[0]?.cost_equiv_u).toBe(1_600);
  });
});
