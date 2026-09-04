/**
 * test/outcomes/derive.test.ts — deriveOutcome: all 5 branches.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  METHODOLOGY_VERSION,
  deriveOutcome,
  writeObservedOutcomes,
} from "../../src/outcomes/derive.js";
import type { FindingForDerivation, WorkItemForDerivation } from "../../src/outcomes/derive.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

function wi(state: string, checks?: string | null): WorkItemForDerivation {
  return {
    work_item_id: "gh:test/repo#1",
    state,
    checks_conclusion: checks ?? null,
  };
}

function finding(status: string, source = "UNRESOLVED_THREAD"): FindingForDerivation {
  return { status, source, human_state: null, extractor_version: "test-v1" };
}

describe("deriveOutcome — 5 branches", () => {
  it("branch 1: OPEN → IN_PROGRESS", () => {
    expect(deriveOutcome(wi("OPEN"), [])).toBe("IN_PROGRESS");
  });

  it("branch 2: CLOSED (abandoned) → OBSERVED_FAILURE", () => {
    expect(deriveOutcome(wi("CLOSED"), [])).toBe("OBSERVED_FAILURE");
  });

  it("branch 4: MERGED + checks=FAILURE → OBSERVED_FAILURE", () => {
    expect(deriveOutcome(wi("MERGED", "FAILURE"), [])).toBe("OBSERVED_FAILURE");
  });

  it("branch 5: MERGED + checks=SUCCESS + no deferred findings → OBSERVED_SUCCESS", () => {
    expect(deriveOutcome(wi("MERGED", "SUCCESS"), [])).toBe("OBSERVED_SUCCESS");
  });

  it("branch 5 (checks=NONE): MERGED + no CI + no deferred → OBSERVED_SUCCESS", () => {
    expect(deriveOutcome(wi("MERGED", "NONE"), [])).toBe("OBSERVED_SUCCESS");
  });

  it("COND-1: EXPERIMENTAL findings (UNRESOLVED_THREAD) are excluded from deferral denominator", () => {
    // UNRESOLVED_THREAD is EXPERIMENTAL — must NOT trigger WITH_DEFERRALS
    const findings = [finding("DEFERRED", "UNRESOLVED_THREAD")];
    expect(deriveOutcome(wi("MERGED", "SUCCESS"), findings)).toBe("OBSERVED_SUCCESS");
  });

  it("LLM+CONFIRMED gated finding triggers WITH_DEFERRALS", () => {
    const llmConfirmed: FindingForDerivation = {
      status: "DEFERRED",
      source: "LLM",
      human_state: "CONFIRMED",
      extractor_version: "llm-v1",
    };
    expect(deriveOutcome(wi("MERGED", "SUCCESS"), [llmConfirmed])).toBe(
      "OBSERVED_SUCCESS_WITH_DEFERRALS",
    );
  });

  it("LLM+unconfirmed does NOT trigger WITH_DEFERRALS", () => {
    const llmUnconf: FindingForDerivation = {
      status: "DEFERRED",
      source: "LLM",
      human_state: null,
      extractor_version: "llm-v1",
    };
    expect(deriveOutcome(wi("MERGED", "SUCCESS"), [llmUnconf])).toBe("OBSERVED_SUCCESS");
  });
});

describe("writeObservedOutcomes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryFixtureDb();
    // Add workspace mapping + work_item + session_work_link for sess-a1
    db.prepare(
      "UPDATE workspaces SET repo_owner='acme', repo_name='r' WHERE workspace_id='ws-alpha'",
    ).run();
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, checks_conclusion, synced_at)
       VALUES ('gh:acme/r#1', 'ws-alpha', 1, 'MERGED', 'SUCCESS', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO session_work_links (session_id, work_item_id, confidence, method)
       VALUES ('sess-a1', 'gh:acme/r#1', 1.0, 'MANUAL')`,
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it("writes OBSERVED_SUCCESS for a linked merged PR with no findings", () => {
    writeObservedOutcomes(db);
    const row = db
      .prepare(
        "SELECT outcome, methodology_version FROM observed_outcomes WHERE work_item_id='gh:acme/r#1'",
      )
      .get() as { outcome: string; methodology_version: string } | undefined;
    expect(row?.outcome).toBe("OBSERVED_SUCCESS");
    expect(row?.methodology_version).toBe(METHODOLOGY_VERSION);
  });

  it("is idempotent — running twice gives same result", () => {
    writeObservedOutcomes(db);
    writeObservedOutcomes(db);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM observed_outcomes").get() as { n: number })
      .n;
    expect(count).toBe(1);
  });

  it("skips UNLINKED work items (no session_work_links)", () => {
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:acme/r#999', 'ws-alpha', 999, 'MERGED', '2026-01-01T00:00:00Z')`,
    ).run();
    writeObservedOutcomes(db);
    const row = db
      .prepare("SELECT 1 FROM observed_outcomes WHERE work_item_id='gh:acme/r#999'")
      .get();
    expect(row).toBeUndefined();
  });
});
