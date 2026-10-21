/**
 * JMS U11 / U12 — calibration fixtures for "Judge my setup". Synthetic community-style setups (not the
 * author's workflow) pinned to the tier the rubric should give them. Fixed `now`; no wall clock.
 * Config comes from test/fixtures/jms-calibration/<name>/{claude,claude.json,repo}; usage is
 * seeded here from a small deterministic profile.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { gradeSetup } from "../../src/detector/setup-grade.js";
import { scanEnvironment } from "../../src/scanner/env-scan.js";

const NOW = new Date("2026-10-12T00:00:00.000Z");
const DAY = 86_400_000;
const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/jms-calibration",
);

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  seq = 0;
});
afterEach(() => db.close());

interface Profile {
  sessions: number;
  spanDays: number;
  /** Models cycled across sessions (one model per session, so no mid-session switching). */
  models: string[];
  /** Every Nth session dispatches subagent turns (0 = never). */
  subagentEvery: number;
  subagentModel: string;
  /** Every Nth session calls ExitPlanMode (0 = never). */
  planEvery: number;
  /** Every Nth session runs /clear (0 = never). */
  clearEvery: number;
  /** Every Nth session reads before its first edit (1 = always, 0 = never). */
  readEvery?: number;
  /** Extra main-chain turns per session on top of the 25..64 base (mean ~44); 10 user turns per session, so (44 + extra)/10 = steps per prompt. */
  extraTurns?: number;
  /** interrupt-cancel events per session. */
  interrupts?: number;
  /** Context tokens on every main-thread turn (default 20k). */
  contextTokens?: number;
}

function seedUsage(repoPath: string, p: Profile): void {
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, repo_path, registered_at) VALUES ('w1','w1',?,'2026-01-01T00:00:00.000Z')",
  ).run(repoPath);
  for (let i = 0; i < p.sessions; i++) {
    const sid = `s${i}`;
    const start = NOW.getTime() - (p.spanDays - (i * (p.spanDays - 0.5)) / p.sessions) * DAY;
    const at = (min: number): string => new Date(start + min * 60_000).toISOString();
    const turns = 25 + ((i * 7) % 40) + (p.extraTurns ?? 0); // base 25..64, a realistic spread (no runaway sessions)
    const model = p.models[i % p.models.length] as string;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
                               state, turn_count, cost_equiv_u, hygiene_flags, compaction_count)
         VALUES (?, 'w1', ?, ?, ?, 'RECONCILED', ?, 0, '[]', 0)`,
      ).run(sid, `/f/${sid}.jsonl`, at(0), at(turns), turns);
      const turn = db.prepare(
        `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
                            input_tokens, output_tokens, cache_read_tokens, parser_version)
         VALUES (?, ?, 'w1', ?, ?, ?, 2000, 400, ?, 'test')`,
      );
      const cacheRead = (p.contextTokens ?? 20_000) - 2000;
      for (let t = 0; t < turns; t++) turn.run(`m${seq++}`, sid, at(t), model, 0, cacheRead);
      if (p.subagentEvery > 0 && i % p.subagentEvery === 0) {
        for (let t = 0; t < 4; t++) turn.run(`m${seq++}`, sid, at(t), p.subagentModel, 1, 18000);
      }
      const tool = db.prepare(
        "INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_hash) VALUES (?, ?, ?, ?, ?)",
      );
      if (p.readEvery && i % p.readEvery === 0) {
        for (const name of ["Read", "Grep", "Glob"]) tool.run(`e${seq++}`, sid, at(4), name, null);
      }
      tool.run(`e${seq++}`, sid, at(5), "Edit", null);
      if (i % 3 !== 2) {
        // ~2/3 of editing sessions also run the tests
        const id = `e${seq++}`;
        tool.run(id, sid, at(6), "Bash", null);
        db.prepare(
          "INSERT INTO tool_event_metadata (event_id, block_index, is_test_command) VALUES (?, 0, 1)",
        ).run(id);
      }
      if (p.planEvery > 0 && i % p.planEvery === 0)
        tool.run(`e${seq++}`, sid, at(1), "ExitPlanMode", null);
      if (p.clearEvery > 0 && i % p.clearEvery === 0) {
        tool.run(
          `cmd-${(seq++).toString(16).padStart(20, "0")}`,
          sid,
          at(0),
          "local_command",
          "/clear",
        );
      }
      const ev = db.prepare(
        `INSERT INTO ingest_metric_events (event_id, session_id, user_turn_ts, is_user_turn,
           is_compact_summary, is_api_error, is_interrupt, event_ts, is_sidechain)
         VALUES (?, ?, ?, 1, 0, 0, 0, ?, 0)`,
      );
      for (let u = 0; u < 10; u++) ev.run(`u${seq++}`, sid, at(u), at(u));
      const interrupt = db.prepare(
        `INSERT INTO ingest_metric_events (event_id, session_id, user_turn_ts, is_user_turn,
           is_compact_summary, is_api_error, is_interrupt, classifier_label, event_ts, is_sidechain)
         VALUES (?, ?, NULL, 0, 0, 0, 0, 'interrupt-cancel', ?, 0)`,
      );
      for (let k = 0; k < (p.interrupts ?? 0); k++) interrupt.run(`i${seq++}`, sid, at(k));
    })();
  }
}

function gradeFixture(name: string, profile: Profile) {
  const dir = path.join(FIXTURES, name);
  seedUsage(path.join(dir, "repo"), profile);
  const scan = scanEnvironment(db, {
    claudeDir: path.join(dir, "claude"),
    claudeJsonPath: path.join(dir, "claude.json"),
  });
  return gradeSetup({ db, scan, now: NOW });
}

/** Competent but unceremonious: reads before about half its edits, about 6 steps per prompt. */
const COMPETENT: Omit<Profile, "models" | "subagentEvery" | "subagentModel"> = {
  sessions: 30,
  spanDays: 28,
  planEvery: 0,
  clearEvery: 0,
  readEvery: 2,
  extraTurns: 16,
};

/** Outcome-disciplined: explores before every edit and runs deep autonomous turns. No plan mode, no /clear. */
const DISCIPLINED = { ...COMPETENT, readEvery: 1, extraTurns: 60 };

describe("JMS U11 calibration fixtures", () => {
  it("fresh-install: near-empty config, 3 short sessions -> no tier (insufficient data)", () => {
    const g = gradeFixture("fresh-install", {
      sessions: 3,
      spanDays: 2,
      models: ["claude-sonnet-5-5"],
      subagentEvery: 0,
      subagentModel: "claude-sonnet-5-5",
      planEvery: 0,
      clearEvery: 0,
    });
    expect(g.tier).toBeNull();
    expect(g.overall === null || g.coverage < 0.5).toBe(true);
    expect(g.data_needed).not.toBeNull();
  });

  it("minimal-claude-md: short CLAUDE.md, one hook, one skill, healthy usage", () => {
    // Competent but unceremonious: only half its edits are preceded by reading.
    const g = gradeFixture("minimal-claude-md", {
      ...COMPETENT,
      models: ["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-opus-4-8"],
      subagentEvery: 3,
      subagentModel: "claude-haiku-4-5",
    });
    expect(g.caps).toEqual([]);
    expect(g.tier).toBe("Conductor"); // not mistaken for a weaker setup for lacking hooks/agents
  });

  it("sonnet-only: one model family, subagents on the same model, healthy usage", () => {
    const g = gradeFixture("sonnet-only", {
      ...COMPETENT,
      models: ["claude-sonnet-5-5"],
      subagentEvery: 3,
      subagentModel: "claude-sonnet-5-5",
    });
    expect(g.caps).toEqual([]);
    expect(g.tier).toBe("Conductor"); // held by G-explore: half its edits start blind
    expect(g.gates.find((x) => x.gate_id === "G-explore")?.holding).toBe(true);
  });

  it("no-subagents: never dispatches subagents, otherwise healthy", () => {
    const g = gradeFixture("no-subagents", {
      ...COMPETENT,
      models: ["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-opus-4-8"],
      subagentEvery: 0,
      subagentModel: "claude-sonnet-5-5",
    });
    expect(g.caps).toEqual([]);
    expect(g.tier).toBe("Conductor");
  });

  it("healthy fixtures separate into at least two tiers", () => {
    const tiers = new Set<string | null>();
    for (const [name, profile] of [
      ["minimal-claude-md", COMPETENT],
      ["sonnet-only", DISCIPLINED],
    ] as const) {
      db.exec(
        "DELETE FROM tool_events; DELETE FROM ingest_metric_events; DELETE FROM turns; DELETE FROM sessions; DELETE FROM workspaces;",
      );
      tiers.add(
        gradeFixture(name, {
          ...profile,
          models: ["claude-sonnet-5-5"],
          subagentEvery: 3,
          subagentModel: "claude-sonnet-5-5",
        }).tier,
      );
    }
    expect(tiers.size).toBeGreaterThanOrEqual(2);
  });

  // Anti-bias: with strong outcomes, neither "no subagents" nor "Sonnet only" is a ceiling, and
  // neither plan mode nor /clear is required.
  it("no-subagents with disciplined outcomes (zero plan mode, zero /clear) reaches God-tier", () => {
    const g = gradeFixture("no-subagents", {
      ...DISCIPLINED,
      models: ["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-opus-4-8"],
      subagentEvery: 0,
      subagentModel: "claude-sonnet-5-5",
    });
    expect(g.checks.find((c) => c.check_id === "subagent_use")?.result).toBe("FAIL");
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM tool_events WHERE tool_name='ExitPlanMode' OR tool_name='local_command'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(g.tier).toBe("God-tier");
  });

  it("sonnet-only with disciplined outcomes can reach God-tier", () => {
    const g = gradeFixture("sonnet-only", {
      ...DISCIPLINED,
      models: ["claude-sonnet-5-5"],
      subagentEvery: 3,
      subagentModel: "claude-sonnet-5-5",
    });
    expect(g.tier).toBe("God-tier");
  });

  it("runaway: very high steps per prompt with high interrupts does not pass autonomy_depth", () => {
    const g = gradeFixture("sonnet-only", {
      ...DISCIPLINED,
      extraTurns: 80, // ~12 steps per prompt before the runaway guard
      interrupts: 3, // 0.3 per prompt
      models: ["claude-sonnet-5-5"],
      subagentEvery: 3,
      subagentModel: "claude-sonnet-5-5",
    });
    expect(g.checks.find((c) => c.check_id === "interrupt_rate")?.result).toBe("FAIL");
    expect(g.checks.find((c) => c.check_id === "autonomy_depth")?.result).not.toBe("PASS");
  });

  it("degraded_context: a 1M-window model at 300k is fine, a 200k-window model at 160k is degraded", () => {
    const big = gradeFixture("sonnet-only", {
      ...DISCIPLINED,
      contextTokens: 300_000, // above 200k, so the model is provably a 1M window
      models: ["claude-opus-4-8"],
      subagentEvery: 3,
      subagentModel: "claude-sonnet-5-5",
    });
    expect(big.checks.find((c) => c.check_id === "degraded_context")).toMatchObject({
      result: "PASS",
      value: 0,
    });
    db.exec(
      "DELETE FROM tool_events; DELETE FROM ingest_metric_events; DELETE FROM turns; DELETE FROM sessions; DELETE FROM workspaces;",
    );
    const small = gradeFixture("sonnet-only", {
      ...DISCIPLINED,
      contextTokens: 160_000, // 80% of 200k
      models: ["claude-sonnet-5-5"],
      subagentEvery: 3,
      subagentModel: "claude-sonnet-5-5",
    });
    expect(small.checks.find((c) => c.check_id === "degraded_context")).toMatchObject({
      result: "FAIL",
      value: 1,
    });
    expect(small.gates.find((x) => x.gate_id === "G-context")?.satisfied).toBe(false);
    expect(small.tier).not.toBe("God-tier");
    db.exec(
      "DELETE FROM tool_events; DELETE FROM ingest_metric_events; DELETE FROM turns; DELETE FROM sessions; DELETE FROM workspaces;",
    );
    // 1M windows are capped at 400k absolute, not 70% (700k): recall drops well before 1M.
    const deep = gradeFixture("sonnet-only", {
      ...DISCIPLINED,
      contextTokens: 450_000,
      models: ["claude-opus-4-8"],
      subagentEvery: 3,
      subagentModel: "claude-sonnet-5-5",
    });
    expect(deep.checks.find((c) => c.check_id === "degraded_context")).toMatchObject({
      result: "FAIL",
      value: 1,
    });
  });
});
