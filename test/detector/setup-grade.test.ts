import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { CATEGORIES, CHECKS, GATES } from "../../src/detector/check-registry.js";
import {
  DEFAULT_RUBRIC,
  type Rubric,
  gradeSetup,
  heldScore,
  recordGradeSnapshot,
  rubricVersion,
} from "../../src/detector/setup-grade.js";
import { resetDatabase } from "../../src/query/settings-store.js";
import type { EnvScanResult } from "../../src/scanner/env-scan.js";

const NOW = new Date("2026-10-12T00:00:00.000Z");
const DAY = 86_400_000;

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  seq = 0;
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('w1','w1','2026-01-01T00:00:00.000Z')",
  ).run();
});
afterEach(() => db.close());

interface SessionOpts {
  daysAgo: number;
  turns?: number;
  model?: string;
  sidechainTurns?: number;
  edit?: boolean;
  test?: boolean;
  plan?: boolean;
  clear?: boolean;
  userTurns?: number;
  compacted?: boolean;
  /** Three read/search calls before the first edit (default true). */
  reads?: boolean;
}

/** One synthetic session: turns, tool events, user-turn ledger rows. */
function seedSession(i: number, o: SessionOpts): void {
  const sid = `s${i}`;
  const start = NOW.getTime() - o.daysAgo * DAY;
  const at = (min: number): string => new Date(start + min * 60_000).toISOString();
  const turns = o.turns ?? 100; // 10 steps per prompt at 10 user turns (autonomy_depth PASS)
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
                             state, turn_count, cost_equiv_u, hygiene_flags, compaction_count)
       VALUES (?, 'w1', ?, ?, ?, 'RECONCILED', ?, 0, '[]', ?)`,
    ).run(sid, `/f/${sid}.jsonl`, at(0), at(turns), turns, o.compacted ? 1 : 0);
    const turn = db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
                          input_tokens, output_tokens, cache_read_tokens, parser_version)
       VALUES (?, ?, 'w1', ?, ?, ?, 100, 50, 20000, 'test')`,
    );
    for (let t = 0; t < turns; t++) {
      turn.run(`m${seq++}`, sid, at(t), o.model ?? "claude-sonnet-5-5", 0);
    }
    for (let t = 0; t < (o.sidechainTurns ?? 0); t++) {
      turn.run(`m${seq++}`, sid, at(t), "claude-haiku-4-5", 1);
    }
    const tool = db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_hash) VALUES (?, ?, ?, ?, ?)",
    );
    if (o.reads ?? true) {
      for (const name of ["Read", "Grep", "Glob"]) tool.run(`e${seq++}`, sid, at(4), name, null);
    }
    if (o.edit ?? true) tool.run(`e${seq++}`, sid, at(5), "Edit", null);
    if (o.test ?? true) {
      const id = `e${seq++}`;
      tool.run(id, sid, at(6), "Bash", null);
      db.prepare(
        "INSERT INTO tool_event_metadata (event_id, block_index, is_test_command) VALUES (?, 0, 1)",
      ).run(id);
    }
    if (o.plan) tool.run(`e${seq++}`, sid, at(1), "ExitPlanMode", null);
    if (o.clear)
      tool.run(
        `cmd-${(seq++).toString(16).padStart(20, "0")}`,
        sid,
        at(0),
        "local_command",
        "/clear",
      );
    const ev = db.prepare(
      `INSERT INTO ingest_metric_events (event_id, session_id, user_turn_ts, is_user_turn,
         is_compact_summary, is_api_error, is_interrupt, event_ts, is_sidechain)
       VALUES (?, ?, ?, 1, 0, 0, 0, ?, 0)`,
    );
    for (let u = 0; u < (o.userTurns ?? 10); u++) ev.run(`u${seq++}`, sid, at(u), at(u));
  })();
}

/** 30 sessions spread over 29 days, built to PASS every behavior check. */
function seedHealthy(): void {
  for (let i = 0; i < 30; i++) {
    seedSession(i, {
      daysAgo: 29.5 - i,
      model: i >= 24 ? "claude-haiku-4-5" : "claude-sonnet-5-5",
      sidechainTurns: i % 2 === 0 ? 5 : 0,
      plan: i % 4 === 0,
      clear: true,
    });
    // 95% of committed lines survive 14 days (edit_survival PASS)
    db.prepare(
      `INSERT INTO session_churn (session_id, status, window_days, authored_lines, churned_lines,
         churn_ratio, commit_count, commit_shas, measured_at)
       VALUES (?, 'MEASURED', 14, 100, 5, 0.05, 1, '[]', '2026-10-11T00:00:00.000Z')`,
    ).run(`s${i}`);
  }
}

function label(n: number, classifier: string): void {
  const ins = db.prepare(
    `INSERT INTO ingest_metric_events (event_id, session_id, user_turn_ts, is_user_turn,
       is_compact_summary, is_api_error, is_interrupt, classifier_label, event_ts, is_sidechain)
     VALUES (?, 's0', NULL, 0, 0, 0, 0, ?, ?, 0)`,
  );
  for (let k = 0; k < n; k++) {
    ins.run(`l${seq++}`, classifier, new Date(NOW.getTime() - DAY).toISOString());
  }
}

function healthyScan(over?: {
  allowAllBash?: boolean;
  defaultMode?: string | null;
  deny?: string[];
}): EnvScanResult {
  return {
    settings: {
      file: "ok",
      permissions: {
        status: "ok",
        data: {
          allow: ["Bash(npm test)"],
          deny: over?.deny ?? ["Read(./.env)"],
          ask: [],
          defaultMode: over?.defaultMode ?? "default",
          allowAllBash: over?.allowAllBash ?? false,
        },
      },
      hooks: {
        status: "ok",
        data: {
          events: [
            { event: "PostToolUse", matcherCount: 1, commandCount: 1 },
            { event: "PreToolUse", matcherCount: 1, commandCount: 1 },
          ],
        },
      },
    },
    claudeMd: { status: "ok", data: { lineCount: 120 } },
    skills: { status: "ok", data: { count: 2, names: ["a", "b"] } },
    agents: { status: "ok", data: { count: 1, names: ["x"] } },
    mcp: { status: "ok", data: { count: 2, names: ["m1", "m2"] } },
    projects: [
      {
        workspaceId: "w1",
        projectSlug: "w1",
        repoPath: "/r",
        state: { kind: "scanned" },
        claudeMd: { status: "ok", data: { lineCount: 80 } },
        claudeDir: { status: "absent" },
        mcpJson: { status: "absent" },
        memory: { status: "ok", data: { lineCount: 50 } },
      },
    ],
  };
}

const grade = (scan: EnvScanResult, rubric?: Rubric) =>
  gradeSetup({ db, scan, now: NOW, ...(rubric ? { rubric } : {}) });

describe("heldScore", () => {
  // Tier indexes: 0 Drifter, 1 Practitioner (40), 2 Operator (60), 3 Conductor (75), 4 God-tier (90)
  it("raw 62 (Operator) held at Practitioner shows 59", () => {
    expect(heldScore(62, 2, 1)).toBe(59);
  });
  it("raw exactly at the floor is still clamped under it", () => {
    expect(heldScore(60, 2, 1)).toBe(59);
    expect(heldScore(75, 3, 2)).toBe(74);
  });
  it("a gate hold clamps to the top of the awarded tier", () => {
    expect(heldScore(95, 4, 2)).toBe(74);
  });
  it("a raw score already inside the awarded tier is untouched", () => {
    expect(heldScore(52, 1, 1)).toBe(52);
    expect(heldScore(62, 2, 1) <= 62).toBe(true);
  });
});

describe("gradeSetup", () => {
  it("baseline: a healthy setup scores every category and reaches God-tier", () => {
    seedHealthy();
    const g = grade(healthyScan());
    expect(g.checks.filter((c) => c.result !== "PASS").map((c) => c.check_id)).toEqual([]);
    expect(g.categories.every((c) => c.status === "scored")).toBe(true);
    expect(g.overall).toBeGreaterThanOrEqual(90);
    expect(g.overall_before_hold).toBe(g.overall); // nothing holds: no clamp
    expect(g.tier).toBe("God-tier");
    expect(g.caps).toEqual([]);
    expect(g.gates.every((x) => x.satisfied)).toBe(true);
    expect(g.next_tier).toBeNull();
    expect(g.data_needed).toBeNull();
  });

  it("AE1: allow-all Bash caps at Practitioner with a reason and keeps the uncapped score", () => {
    seedHealthy();
    const base = grade(healthyScan());
    const g = grade(healthyScan({ allowAllBash: true }));
    expect(g.tier).toBe("Practitioner");
    expect(g.tier_by_score).toBe("God-tier");
    expect(g.caps).toEqual([
      expect.objectContaining({
        check_id: "no_allow_all_bash",
        tier: "Practitioner",
        binding: true,
      }),
    ]);
    expect(g.caps[0]?.reason).toMatch(/allow-all Bash/);
    expect(
      g.categories.filter((c) => c.status === "scored").every((c) => (c.score ?? 0) >= 90),
    ).toBe(
      false, // the security category itself loses points
    );
    // Shown score is clamped to the top of Practitioner (Operator floor 60 - 1); raw is kept.
    expect(g.overall_before_hold).toBeGreaterThanOrEqual(90);
    expect(g.overall).toBe(59);
    expect(g.overall_before_hold as number).toBeLessThanOrEqual(base.overall as number);
    expect(g.next_tier?.tier).toBe("Operator");
    expect(g.next_tier?.items[0]).toMatchObject({ kind: "cap", check_id: "no_allow_all_bash" });
  });

  it("caps bypass mode at Practitioner and a missing secrets-deny rule at Operator", () => {
    seedHealthy();
    const bypass = grade(healthyScan({ defaultMode: "bypassPermissions" }));
    expect(bypass.tier).toBe("Practitioner");
    expect(bypass.caps.map((c) => c.check_id)).toEqual(["safe_default_mode"]);

    const noDeny = grade(healthyScan({ deny: ["Bash(rm -rf:*)"] }));
    expect(noDeny.tier).toBe("Operator");
    expect(noDeny.caps).toEqual([
      expect.objectContaining({ check_id: "secrets_deny_rule", tier: "Operator" }),
    ]);
  });

  it("AE2: no delegation-eligible session -> delegation checks NO_DATA, category insufficient-data", () => {
    for (let i = 0; i < 12; i++) {
      seedSession(i, { daysAgo: 20 - i, turns: 10, edit: false, test: false });
    }
    const g = grade(healthyScan());
    const delegation = g.checks.filter((c) => c.category === "delegation");
    expect(delegation.map((c) => c.result)).toEqual(["NO_DATA", "NO_DATA"]);
    expect(delegation.every((c) => c.reason === "insufficient_sample")).toBe(true);
    const cat = g.categories.find((c) => c.category === "delegation");
    expect(cat).toMatchObject({ status: "insufficient-data", score: null, scored_checks: 0 });
  });

  it("AE8: scored categories under half the weight -> no tier, data-needed message", () => {
    // Perfect config where it exists, but no CLAUDE.md / projects scanned and zero observed behavior.
    const sparse: EnvScanResult = {
      ...healthyScan(),
      claudeMd: { status: "absent" },
      projects: [],
    };
    const g = grade(sparse);
    expect(g.coverage).toBeLessThan(0.5);
    expect(g.tier).toBeNull();
    expect(g.tier_by_score).toBeNull();
    expect(g.data_needed?.message).toMatch(/Not enough observed data/);
    expect(g.data_needed?.items.length).toBeGreaterThan(0);
    expect(g.data_needed?.items.some((s) => s.startsWith("degraded_context: needs observed"))).toBe(
      true,
    );
    expect(g.next_tier).toBeNull();
  });

  it("perfect config with zero observed behavior cannot mint a tier above the first gate", () => {
    const g = grade(healthyScan());
    expect(g.tier_by_score).toBe("God-tier");
    expect(g.tier).toBe("Operator");
    expect(g.gates.filter((x) => x.holding).map((x) => x.gate_id)).toEqual([
      "G-verify",
      "G-explore",
      "G-context",
    ]);
  });

  it("stale version tag -> NO_DATA, excluded from caps and scores", () => {
    seedHealthy();
    const rubric: Rubric = {
      ...DEFAULT_RUBRIC,
      checks: CHECKS.map((c) =>
        c.check_id === "no_allow_all_bash" ? { ...c, version_date: "2020-01-01" } : c,
      ),
    };
    const g = grade(healthyScan({ allowAllBash: true }), rubric);
    const stale = g.checks.find((c) => c.check_id === "no_allow_all_bash");
    expect(stale).toMatchObject({ result: "NO_DATA", reason: "stale", value: null });
    expect(g.caps).toEqual([]);
    expect(g.tier).toBe("God-tier");
    const sec = g.categories.find((c) => c.category === "permissions_security");
    expect(sec).toMatchObject({ status: "scored", scored_checks: 3, total_checks: 4, score: 100 });
  });

  it("a gate holds regardless of score (no observed verification loop passing)", () => {
    seedHealthy();
    db.prepare("UPDATE tool_event_metadata SET is_test_command = 0").run();
    const g = grade(healthyScan());
    expect(g.checks.find((c) => c.check_id === "verify_test_loop")?.result).toBe("FAIL");
    expect(g.overall_before_hold).toBeGreaterThanOrEqual(90);
    expect(g.overall).toBe(74); // top of Operator (Conductor floor 75 - 1)
    expect(g.tier_by_score).toBe("God-tier");
    expect(g.tier).toBe("Operator");
    expect(g.gates.find((x) => x.gate_id === "G-verify")).toMatchObject({
      satisfied: false,
      holding: true,
    });
    expect(g.next_tier?.tier).toBe("Conductor");
    expect(g.next_tier?.items.map((i) => i.check_id)).toContain("verify_test_loop");
  });

  it("gate check NO_DATA -> gate unsatisfied with a needs-observed message", () => {
    seedHealthy();
    db.prepare("DELETE FROM tool_events WHERE tool_name = 'Edit'").run();
    const g = grade(healthyScan());
    expect(g.checks.find((c) => c.check_id === "verify_test_loop")?.result).toBe("NO_DATA");
    const gate = g.gates.find((x) => x.gate_id === "G-verify");
    expect(gate?.satisfied).toBe(false);
    expect(gate?.message).toMatch(/^needs observed 5\+ sessions that edited files/);
    expect(g.tier).toBe("Operator");
  });

  it("config-only data with 90+ config scores is held at the first gated boundary", () => {
    const configIds = new Set([
      "no_allow_all_bash",
      "safe_default_mode",
      "secrets_deny_rule",
      "hooks_guard_tools",
      "claude_md_coverage",
      "skills_defined",
      "memory_enabled",
      "mcp_footprint",
      "hooks_configured",
      "verify_test_loop",
    ]);
    const rubric: Rubric = {
      checks: CHECKS.filter((c) => configIds.has(c.check_id)),
      gates: GATES,
      categories: {
        permissions_security: CATEGORIES.permissions_security,
        config_quality: CATEGORIES.config_quality,
        verification_practice: { label: "Verification practice", weight: 0.5 },
      },
    };
    const g = grade(healthyScan(), rubric); // empty DB: no observed behavior at all
    expect(g.overall_before_hold).toBeGreaterThanOrEqual(90);
    expect(g.overall).toBe(74);
    expect(g.tier_by_score).toBe("God-tier");
    expect(g.tier).toBe("Operator"); // tier below the Conductor boundary
    expect(g.gates.find((x) => x.gate_id === "G-verify")?.message).toMatch(/needs observed/);
  });

  it("a check below its minimum-data threshold is NO_DATA, and passes once met", () => {
    for (let i = 0; i < 4; i++) seedSession(i, { daysAgo: 20 - i * 3 });
    const before = grade(healthyScan()).checks.find((c) => c.check_id === "verify_test_loop");
    expect(before).toMatchObject({ result: "NO_DATA", reason: "insufficient_sample", sample: 4 });

    seedSession(4, { daysAgo: 8 });
    const after = grade(healthyScan()).checks.find((c) => c.check_id === "verify_test_loop");
    expect(after).toMatchObject({ result: "PASS", sample: 5, value: 1 });
  });

  it("a short observed window keeps behavior checks NO_DATA", () => {
    for (let i = 0; i < 12; i++) seedSession(i, { daysAgo: 3 });
    const g = grade(healthyScan());
    const verify = g.checks.find((c) => c.check_id === "verify_test_loop");
    expect(verify).toMatchObject({ result: "NO_DATA", reason: "insufficient_window" });
  });

  it("a category with zero eligible checks never emits a score", () => {
    for (let i = 0; i < 12; i++) seedSession(i, { daysAgo: 20 - i, turns: 10 });
    const g = grade(healthyScan());
    for (const cat of g.categories) {
      if (cat.scored_checks < 2) {
        expect(cat.score).toBeNull();
        expect(cat.status).toBe("insufficient-data");
      }
    }
    const zero = g.categories.filter((c) => c.scored_checks === 0);
    expect(zero.length).toBeGreaterThan(0);
    expect(zero.every((c) => c.score === null)).toBe(true);
  });

  it("uses denial and interrupt labels per user turn", () => {
    seedHealthy(); // 300 user turns
    label(20, "deny-rule"); // 20/300 = 0.067 > 0.05
    label(6, "interrupt-cancel"); // 0.02 -> PASS
    const g = grade(healthyScan());
    expect(g.checks.find((c) => c.check_id === "denial_rate")).toMatchObject({
      result: "FAIL",
      sample: 300,
    });
    expect(g.checks.find((c) => c.check_id === "interrupt_rate")?.result).toBe("PASS");
  });

  it("degraded_context sits at NO_DATA until enough main-thread turns exist", () => {
    for (let i = 0; i < 2; i++) seedSession(i, { daysAgo: 20 - i, turns: 10 });
    const none = grade(healthyScan()).checks.find((c) => c.check_id === "degraded_context");
    expect(none).toMatchObject({ result: "NO_DATA", reason: "insufficient_sample", sample: 20 });
  });

  it("explore_before_edit counts a plan or subagent before the edit, fails on a NOT_READ rejection", () => {
    // 12 sessions, one edit each. No reads except: 4 plan, 4 Task, 4 plain-read-only baseline.
    for (let i = 0; i < 12; i++) {
      seedSession(i, { daysAgo: 20 - i, turns: 10, reads: false, plan: i < 4 });
      if (i >= 4 && i < 8) {
        db.prepare(
          "INSERT INTO tool_events (event_id, session_id, ts, tool_name) VALUES (?, ?, ?, 'Task')",
        ).run(`task${i}`, `s${i}`, new Date(NOW.getTime() - (20 - i) * DAY + 60_000).toISOString());
      }
    }
    const share = () =>
      grade(healthyScan()).checks.find((c) => c.check_id === "explore_before_edit");
    expect(share()).toMatchObject({ value: 0.67, sample: 12 }); // 8 of 12 oriented, 4 edited blind
    db.prepare(
      "UPDATE tool_events SET tool_error_class='NOT_READ', tool_error_classifier_version='tool-error-1' WHERE session_id IN ('s0','s1') AND tool_name='Edit'",
    ).run();
    expect(share()?.value).toBe(0.5); // two oriented sessions now fail regardless
  });

  it("autonomy_depth: high steps per prompt passes, but not with a high interrupt rate", () => {
    seedHealthy(); // 300 user turns, 10 main-chain turns (steps) per user turn
    const autonomy = () => grade(healthyScan()).checks.find((c) => c.check_id === "autonomy_depth");
    expect(autonomy()).toMatchObject({ result: "PASS" });
    label(60, "interrupt-cancel"); // 0.2 per user turn > 0.15
    expect(autonomy()).toMatchObject({ result: "PARTIAL", value: 9.99 });
  });

  describe("edit_survival (AMF-CHECKS a)", () => {
    const churn = (sid: string, authored: number, churned: number, status = "MEASURED") =>
      db
        .prepare(
          `INSERT INTO session_churn (session_id, status, window_days, authored_lines, churned_lines,
             churn_ratio, commit_count, commit_shas, measured_at)
           VALUES (?, ?, 14, ?, ?, ?, 1, '[]', '2026-10-11T00:00:00.000Z')`,
        )
        .run(sid, status, authored, churned, authored === 0 ? null : churned / authored);
    const survival = () => grade(healthyScan()).checks.find((c) => c.check_id === "edit_survival");
    const seedWithoutChurn = () => {
      seedHealthy();
      db.prepare("DELETE FROM session_churn").run();
    };

    it("is NO_DATA under 20 sessions with measured committed lines", () => {
      seedWithoutChurn();
      for (let i = 0; i < 19; i++) churn(`s${i}`, 100, 10);
      churn("s19", 0, 0); // committed nothing measurable: not a sample
      churn("s20", 0, 0, "NO_REPO");
      expect(survival()).toMatchObject({
        result: "NO_DATA",
        reason: "insufficient_sample",
        sample: 19,
      });
    });

    it("scores lines that survive 14 days: PASS >= 0.8, PARTIAL >= 0.65, else FAIL", () => {
      seedHealthy();
      const rate = (churned: number) => {
        db.prepare("DELETE FROM session_churn").run();
        for (let i = 0; i < 20; i++) churn(`s${i}`, 100, churned);
        return survival();
      };
      expect(rate(20)).toMatchObject({ result: "PASS", value: 0.8, sample: 20 });
      expect(rate(21)).toMatchObject({ result: "PARTIAL", value: 0.79 });
      expect(rate(35)).toMatchObject({ result: "PARTIAL", value: 0.65 });
      expect(rate(36)).toMatchObject({ result: "FAIL", value: 0.64 });
    });

    it("weights by lines, counts PARTIAL rows' matured lines, and ignores sessions outside the window", () => {
      seedWithoutChurn();
      for (let i = 0; i < 19; i++) churn(`s${i}`, 10, 0);
      churn("s19", 810, 400, "PARTIAL"); // 1,000 lines in all, 400 churned
      seedSession(99, { daysAgo: 40 }); // before the 30-day window
      churn("s99", 10_000, 10_000);
      expect(survival()).toMatchObject({ result: "FAIL", value: 0.6, sample: 20 });
    });
  });

  it("determinism: the same DB + scan produce an identical grade", () => {
    seedHealthy();
    label(3, "hook-block");
    const scan = healthyScan({ allowAllBash: true });
    const a = grade(scan);
    const b = grade(scan);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("recordGradeSnapshot (U4)", () => {
  const record = (scan: EnvScanResult, rubric?: Rubric, now: Date = NOW) =>
    recordGradeSnapshot({ db, scan, now, ...(rubric ? { rubric } : {}) });
  const rows = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM setup_grade_snapshots").get() as { n: number }).n;

  it("first grade stores a snapshot and has no delta", () => {
    seedHealthy();
    const r = record(healthyScan());
    expect(r.recorded).toBe(true);
    expect(r.delta).toBeNull();
    expect(rows()).toBe(1);
  });

  it("a changed grade adds a snapshot and the delta is the diff to the previous one", () => {
    seedHealthy();
    const first = record(healthyScan());
    const r = record(healthyScan({ allowAllBash: true }));
    expect(r.recorded).toBe(true);
    expect(rows()).toBe(2);
    expect(r.delta).toMatchObject({
      previous_overall: first.grade.overall,
      current_overall: r.grade.overall,
      previous_tier: "God-tier",
      current_tier: "Practitioner",
      tier_changed: true,
      rubric_changed: false,
    });
    const score = (g: typeof r.grade) =>
      g.categories.find((c) => c.category === "config_quality")?.score as number;
    const cfg = r.delta?.categories.find((c) => c.category === "config_quality");
    expect(cfg?.previous).toBe(score(first.grade));
    expect(cfg?.current).toBe(score(r.grade));
  });

  it("an identical grade writes nothing and keeps the latest delta", () => {
    seedHealthy();
    record(healthyScan());
    const changed = record(healthyScan({ allowAllBash: true }));
    const total = db.prepare("SELECT total_changes() AS n").get();
    const again = record(
      healthyScan({ allowAllBash: true }),
      undefined,
      new Date(NOW.getTime() + 1000),
    );
    expect(again.recorded).toBe(false);
    expect(rows()).toBe(2);
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(total);
    expect(again.delta).toEqual(changed.delta);
  });

  it("flags a delta that crosses a rubric version change", () => {
    seedHealthy();
    record(healthyScan());
    const bumped: Rubric = {
      ...DEFAULT_RUBRIC,
      checks: CHECKS.map((c) => ({ ...c, version_tag: "cc-docs-2099-01" })),
    };
    const r = record(healthyScan(), bumped);
    expect(r.recorded).toBe(true);
    expect(r.delta?.rubric_changed).toBe(true);
    expect(r.delta?.previous_rubric_version).toBe(rubricVersion(DEFAULT_RUBRIC));
  });

  it("reset clears snapshots", () => {
    seedHealthy();
    record(healthyScan());
    expect(rows()).toBe(1);
    resetDatabase(db);
    expect(rows()).toBe(0);
  });

  it("migration 049 applies twice without error", () => {
    expect(() => runMigrations(db)).not.toThrow();
    const sql = readFileSync(
      new URL("../../src/db/migrations/049_setup_grade_snapshots.sql", import.meta.url),
      "utf8",
    );
    expect(() => db.exec(sql)).not.toThrow();
  });
});
