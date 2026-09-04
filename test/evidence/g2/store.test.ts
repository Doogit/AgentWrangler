import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { isG2JudgeOptIn, persistJudgeVerdicts } from "../../../src/evidence/g2/store.js";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE user_config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    );
    CREATE TABLE review_findings (
      finding_id TEXT PRIMARY KEY,
      source TEXT,
      human_state TEXT,
      confidence REAL
    );
  `);
  return db;
}

describe("G2 judge store", () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close();
    }
  });

  it("recognizes only an explicit true opt-in", () => {
    const db = createDb();
    databases.push(db);

    expect(isG2JudgeOptIn(db)).toBe(false);

    db.prepare("INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)").run(
      "g2_claude_judge_opt_in",
      "true",
      "2026-09-03T00:00:00.000Z",
    );
    expect(isG2JudgeOptIn(db)).toBe(true);

    db.prepare("UPDATE user_config SET value = ? WHERE key = ?").run(
      "false",
      "g2_claude_judge_opt_in",
    );
    expect(isG2JudgeOptIn(db)).toBe(false);
  });

  it("persists verdict state, confidence, and LLM source without opinion text", () => {
    const db = createDb();
    databases.push(db);
    const insertFinding = db.prepare(
      "INSERT INTO review_findings (finding_id, source, human_state, confidence) VALUES (?, 'DEFERRAL_SECTION', NULL, NULL)",
    );
    insertFinding.run("finding-confirmed");
    insertFinding.run("finding-rejected");
    insertFinding.run("finding-untouched");

    persistJudgeVerdicts(db, [
      { findingId: "finding-confirmed", verdict: "CONFIRMED", confidence: 0.9 },
      { findingId: "finding-rejected", verdict: "REJECTED", confidence: 0.4 },
    ]);

    const getFinding = db.prepare(
      "SELECT finding_id, source, human_state, confidence FROM review_findings WHERE finding_id = ?",
    );
    const confirmed = getFinding.get("finding-confirmed") as Record<string, unknown>;
    const rejected = getFinding.get("finding-rejected") as Record<string, unknown>;
    const untouched = getFinding.get("finding-untouched") as Record<string, unknown>;

    expect(confirmed).toMatchObject({
      finding_id: "finding-confirmed",
      source: "LLM",
      human_state: "CONFIRMED",
      confidence: 0.9,
    });
    expect(rejected).toMatchObject({
      finding_id: "finding-rejected",
      source: "LLM",
      human_state: "REJECTED",
      confidence: 0.4,
    });
    expect(Object.keys(confirmed)).toEqual(["finding_id", "source", "human_state", "confidence"]);
    expect(untouched).toMatchObject({
      finding_id: "finding-untouched",
      source: "DEFERRAL_SECTION",
      human_state: null,
      confidence: null,
    });
  });
});
