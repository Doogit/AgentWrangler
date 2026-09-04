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
});
