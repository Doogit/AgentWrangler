/**
 * src/detector/setup-grade.ts — "Judge my setup" deterministic grading engine (JMS U3).
 *
 * checks -> category scores -> overall -> tier band -> gates -> security caps.
 *
 * Computed ON REQUEST from a Db + an EnvScanResult: no ingest/boot hooks. gradeSetup is pure;
 * recordGradeSnapshot (U4) wraps it and writes a snapshot only when the grade changes. Same
 * DB + scan + `now` -> byte-identical result: no wall clock, no randomness, sorted lists.
 *
 * Rules (spec):
 *  - A check is NO_DATA when stale (version_date older than stale_after_days), when its eligible
 *    sample or observed window is under the registry minimum, or when its signal is unreadable.
 *    NO_DATA never scores and never triggers a cap.
 *  - Category score = severity-weighted earned/available over scored checks. Fewer scored checks
 *    than MIN_CATEGORY_CHECKS -> insufficient-data (score null, excluded from the overall).
 *  - Gates: a gate is satisfied only by a PASS on its defining check. NO_DATA leaves it unsatisfied
 *    ("needs observed X"), so config-only data cannot release a gated tier boundary.
 *  - Caps: a FAIL on a cap-bearing check limits the tier; the uncapped score/tier are retained.
 *  - Scored categories under MIN_COVERAGE of total weight -> no tier, a data-needed message.
 *
 * SEC-101: reads counts/ratios only. No transcript content.
 */

import { createHash } from "node:crypto";
import type { Db } from "../db/open.js";
import type { EnvScanResult, PermissionsInfo } from "../scanner/env-scan.js";
import {
  CATEGORIES,
  CHECKS,
  type CategoryDef,
  type CheckCategory,
  type CheckEntry,
  type CheckResult,
  type EligibilityCondition,
  GATES,
  type GateDef,
  MIN_CATEGORY_CHECKS,
  MIN_COVERAGE,
  SEVERITY_WEIGHT,
  TIER_FLOORS,
  TIER_NAMES,
  type TierName,
} from "./check-registry.js";
import { LARGE_WINDOW, STANDARD_WINDOW, contextWindowFor } from "./model-windows.js";

// ── Public shapes ─────────────────────────────────────────────────────────────

export interface Rubric {
  checks: readonly CheckEntry[];
  gates: readonly GateDef[];
  categories: Record<string, CategoryDef>;
}

export const DEFAULT_RUBRIC: Rubric = { checks: CHECKS, gates: GATES, categories: CATEGORIES };

export interface GradeInput {
  db: Db;
  scan: EnvScanResult;
  /** Window end. Required (no wall clock inside the engine). */
  now: Date | string;
  /** Default 30. */
  windowDays?: number;
  rubric?: Rubric;
  /** recordGradeSnapshot only: a grade the caller already computed (off the event loop) for this scan and `now`. */
  grade?: SetupGrade;
}

export type NoDataReason = "stale" | "insufficient_sample" | "insufficient_window" | "no_signal";

export interface CheckOutcome {
  check_id: string;
  category: CheckCategory;
  severity: CheckEntry["severity"];
  result: CheckResult;
  /** Observed signal value; null when none could be read. */
  value: number | null;
  /** Eligible sample size under the check's named condition. */
  sample: number;
  reason: NoDataReason | null;
  /** "needs observed …" text for NO_DATA outcomes. */
  needs: string | null;
}

export interface CategoryOutcome {
  category: string;
  label: string;
  weight: number;
  status: "scored" | "insufficient-data";
  /** 0..100, or null when insufficient-data. */
  score: number | null;
  scored_checks: number;
  total_checks: number;
}

export interface GateOutcome {
  gate_id: string;
  check_id: string;
  boundary: TierName;
  satisfied: boolean;
  /** True when this unsatisfied gate is actually holding the tier down. */
  holding: boolean;
  /** Set when unsatisfied. */
  message: string | null;
}

export interface CapOutcome {
  check_id: string;
  tier: TierName;
  reason: string;
  /** True when the cap sits below the tier the score earned. */
  binding: boolean;
}

export interface NextTierItem {
  kind: "gate" | "cap" | "check";
  check_id: string;
  message: string;
}

export interface SetupGrade {
  window: { from: string; to: string };
  checks: CheckOutcome[];
  categories: CategoryOutcome[];
  /** Share of total category weight that is scored. */
  coverage: number;
  /**
   * Score shown to the user (0..100); null when no category scored. Equals the weighted average
   * unless a cap or gate holds the tier below what that average earns, in which case it is clamped
   * to the top of the awarded tier so the number always matches the level.
   */
  overall: number | null;
  /** Raw weighted average of scored categories, before any cap/gate clamp. Equals `overall` when nothing holds. */
  overall_before_hold: number | null;
  /** Tier the score alone earns (before gates and caps); null when coverage is under the minimum. */
  tier_by_score: TierName | null;
  /** Final tier after gates and caps; null = no tier. */
  tier: TierName | null;
  gates: GateOutcome[];
  caps: CapOutcome[];
  /** Concrete items when no tier can be awarded; null otherwise. */
  data_needed: { message: string; items: string[] } | null;
  /** What would move the grade to the tier above; null when no tier or already top. */
  next_tier: { tier: TierName; items: NextTierItem[] } | null;
}

// ── Window helpers ────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const DELEGATION_MIN_TURNS = 20;
const LONG_SESSION_TURNS = 60;
const RUNAWAY_SESSION_TURNS = 150;
const MODEL_SWITCH_MIN_TURNS = 5;
const MAX_NEXT_TIER_CHECKS = 8;
const SECRETS_RULE = /(\.env\b|secret|credential|\.pem\b|id_rsa|\.key\b)/i;
const EDIT_TOOLS = "('Edit','Write','MultiEdit','NotebookEdit')";
/**
 * A turn is "degraded" at min(70% of its model's window, 400k). The absolute cap comes from
 * long-context recall falling off well before 1M (MRCR v2 at 256k vs 1M, Opus 4.6 system card,
 * 2026-02); research note `.claude/audits/2026-10-13-jms-u12.md`.
 */
const degradedFloor = (window: number): number => Math.min(0.7 * window, 400_000);

const round2 = (n: number): number => Math.round(n * 100) / 100;

interface Ctx {
  db: Db;
  scan: EnvScanResult;
  from: string;
  to: string;
  spanDays: number;
  /** Per-gradeSetup-call memo for window queries shared by several checks (never outlives the call). */
  memo: Map<string, unknown>;
}

function memoized<T>(c: Ctx, key: string, compute: () => T): T {
  if (c.memo.has(key)) return c.memo.get(key) as T;
  const v = compute();
  c.memo.set(key, v);
  return v;
}

interface SessionRow {
  session_id: string;
  n: number;
  first_ts: string;
}

/** Sessions with at least one main-thread turn in the window, with their turn count. */
function mainSessions(c: Ctx): SessionRow[] {
  return memoized(c, "mainSessions", () => {
    const bySession = new Map<string, SessionRow>();
    for (const g of turnGroups(c)) {
      if (g.is_sidechain !== 0) continue;
      const s = bySession.get(g.session_id);
      if (!s)
        bySession.set(g.session_id, { session_id: g.session_id, n: g.n, first_ts: g.first_ts });
      else {
        s.n += g.n;
        if (g.first_ts < s.first_ts) s.first_ts = g.first_ts;
      }
    }
    return [...bySession.values()];
  });
}

interface TurnGroup {
  session_id: string;
  is_sidechain: number;
  model: string;
  n: number;
  first_ts: string;
  /** SUM(input_tokens + cache_read_tokens) */
  priced: number | null;
  /** SUM(cache_read_tokens) */
  cache_read: number | null;
  /** MAX(context_tokens) */
  max_ctx: number | null;
  /** Turns at or above the degraded floor of a standard / large window. */
  over_std: number | null;
  over_large: number | null;
}

/**
 * One pass over the window's non-provisional turns; every turn-based signal reads from this.
 * INDEXED BY: without stats the planner seeks the ts index and looks up every turn row; the
 * covering index (migration 053) reads index pages only, already in GROUP BY order.
 */
function turnGroups(c: Ctx): TurnGroup[] {
  return memoized(
    c,
    "turnGroups",
    () =>
      c.db
        .prepare(
          `SELECT session_id, is_sidechain, model, COUNT(*) AS n, MIN(ts) AS first_ts,
                  SUM(input_tokens + cache_read_tokens) AS priced,
                  SUM(cache_read_tokens) AS cache_read,
                  MAX(context_tokens) AS max_ctx,
                  SUM(context_tokens >= ?) AS over_std,
                  SUM(context_tokens >= ?) AS over_large
             FROM turns INDEXED BY idx_turns_grade_cover
            WHERE ts >= ? AND ts < ? AND provisional = 0
            GROUP BY session_id, is_sidechain, model
            ORDER BY session_id`,
        )
        .all(
          degradedFloor(STANDARD_WINDOW),
          degradedFloor(LARGE_WINDOW),
          c.from,
          c.to,
        ) as TurnGroup[],
  );
}

const mainTurnGroups = (c: Ctx): TurnGroup[] => turnGroups(c).filter((g) => g.is_sidechain === 0);
const mainTurnCount = (c: Ctx): number => mainTurnGroups(c).reduce((s, g) => s + g.n, 0);

function toolSessions(c: Ctx, where: string): Set<string> {
  return memoized(c, `toolSessions:${where}`, () => {
    const rows = c.db
      .prepare(
        `SELECT DISTINCT te.session_id AS session_id FROM tool_events te
        WHERE te.ts >= ? AND te.ts < ? AND ${where}`,
      )
      .all(c.from, c.to) as { session_id: string }[];
    return new Set(rows.map((r) => r.session_id));
  });
}

function count(c: Ctx, sql: string, ...extra: unknown[]): number {
  const row = c.db.prepare(sql).get(c.from, c.to, ...extra) as { n: number | null } | undefined;
  return row?.n ?? 0;
}

const share = (num: number, den: number): number | null => (den === 0 ? null : num / den);

/** Tools that read the code (orientation). Bash is not counted: it cannot be told apart from running things. */
/** Read/search calls before a session's first edit that count as exploring on their own. */
const ORIENTATION_MIN_READS = 3;

/**
 * Edit sessions: a session passes when ORIENTATION_MIN_READS read/search calls, or any
 * ExitPlanMode or subagent dispatch, came before its first edit; it fails when it had an edit
 * rejected for not reading first (the C3 NOT_READ label), whatever else it did. Session-level (not
 * split at /clear) and not sidechain-filtered: one indexed aggregate keeps the judge route fast.
 */
function editSessions(c: Ctx): { total: number; passing: number } {
  return memoized(c, "editSessions", () => {
    const rows = c.db
      .prepare(
        `WITH fe AS (
           SELECT session_id, MIN(ts) AS fts FROM tool_events
            WHERE ts >= ? AND ts < ? AND tool_name IN ('Edit','Write','MultiEdit','NotebookEdit')
            GROUP BY session_id)
         SELECT
           (SELECT COUNT(*) FROM tool_events r
             WHERE r.session_id = fe.session_id AND r.ts >= ? AND r.ts < fe.fts
               AND r.tool_name IN ('Read','Grep','Glob','LS','NotebookRead')) AS n,
           EXISTS (SELECT 1 FROM tool_events p
             WHERE p.session_id = fe.session_id AND p.ts >= ? AND p.ts < fe.fts
               AND p.tool_name IN ('ExitPlanMode','Task','Agent')) AS planned,
           EXISTS (SELECT 1 FROM tool_events x
             WHERE x.session_id = fe.session_id AND x.ts >= ? AND x.ts < ?
               AND x.tool_name IN ('Edit','Write') AND x.tool_error_class = 'NOT_READ'
               AND x.tool_error_classifier_version = 'tool-error-1') AS not_read
           FROM fe`,
      )
      .all(c.from, c.to, c.from, c.from, c.from, c.to) as {
      n: number;
      planned: number;
      not_read: number;
    }[];
    const passing = rows.filter(
      (r) => (r.n >= ORIENTATION_MIN_READS || r.planned === 1) && r.not_read === 0,
    ).length;
    return { total: rows.length, passing };
  });
}

/**
 * Committed lines of the window's main sessions as the churn collector measured them 14 days after
 * each commit (`session_churn`). Rows with no authored lines (NO_REPO, nothing matured) are not samples.
 */
function churnTotals(c: Ctx): { sessions: number; authored: number; churned: number } {
  return memoized(c, "churnTotals", () => {
    const inWindow = new Set(mainSessions(c).map((s) => s.session_id));
    const rows = c.db
      .prepare(
        "SELECT session_id, authored_lines, churned_lines FROM session_churn WHERE authored_lines > 0",
      )
      .all() as { session_id: string; authored_lines: number; churned_lines: number }[];
    const totals = { sessions: 0, authored: 0, churned: 0 };
    for (const r of rows) {
      if (!inWindow.has(r.session_id)) continue;
      totals.sessions++;
      totals.authored += r.authored_lines;
      totals.churned += r.churned_lines;
    }
    return totals;
  });
}

/** Window (tokens) per model: observed max context decides 200k vs 1M (see model-windows.ts). */
function degradedContextShare(c: Ctx): number | null {
  const maxByModel = new Map<string, number>();
  for (const g of turnGroups(c)) {
    maxByModel.set(g.model, Math.max(maxByModel.get(g.model) ?? 0, g.max_ctx ?? 0));
  }
  let hits = 0;
  for (const g of mainTurnGroups(c)) {
    const large = contextWindowFor(g.model, maxByModel.get(g.model)) === LARGE_WINDOW;
    hits += (large ? g.over_large : g.over_std) ?? 0;
  }
  return share(hits, mainTurnCount(c));
}

function modelFamily(model: string): string {
  const m = /(opus|sonnet|haiku|fable)/i.exec(model);
  return m?.[1] ? m[1].toLowerCase() : model;
}

// ── Config helpers (U2 scan shape) ────────────────────────────────────────────

function allPermissions(scan: EnvScanResult): PermissionsInfo[] {
  const out: PermissionsInfo[] = [];
  if (scan.settings.permissions.status === "ok" && scan.settings.permissions.data) {
    out.push(scan.settings.permissions.data);
  }
  for (const p of scan.projects) {
    const s = p.claudeDir.status === "ok" ? p.claudeDir.data : undefined;
    if (s?.permissions.status === "ok" && s.permissions.data) out.push(s.permissions.data);
  }
  return out;
}

function hookCommands(scan: EnvScanResult, events?: readonly string[]): number {
  let total = 0;
  const tally = (surface: EnvScanResult["settings"]["hooks"]): void => {
    if (surface.status !== "ok" || !surface.data) return;
    for (const e of surface.data.events) {
      if (!events || events.includes(e.event)) total += e.commandCount;
    }
  };
  tally(scan.settings.hooks);
  for (const p of scan.projects) {
    if (p.claudeDir.status === "ok" && p.claudeDir.data) tally(p.claudeDir.data.hooks);
  }
  return total;
}

/** User-level settings.json unreadable -> permission/hook facts are indeterminate. */
const settingsReadable = (scan: EnvScanResult): boolean => scan.settings.file !== "unreadable";

function namedCount(surface: EnvScanResult["skills"]): number | null {
  if (surface.status === "unreadable") return null;
  return surface.status === "ok" && surface.data ? surface.data.count : 0;
}

// ── Signals: id -> value (null = unreadable / unobservable) ───────────────────

type Signal = (c: Ctx) => number | null;

const SIGNALS: Record<string, Signal> = {
  // behavior
  degraded_context_turn_share: degradedContextShare,
  compaction_share_long(c) {
    const long = mainSessions(c).filter((s) => s.n >= LONG_SESSION_TURNS);
    if (long.length === 0) return null;
    const compacted = new Set(
      (
        c.db.prepare("SELECT session_id FROM sessions WHERE compaction_count > 0").all() as {
          session_id: string;
        }[]
      ).map((r) => r.session_id),
    );
    return long.filter((s) => compacted.has(s.session_id)).length / long.length;
  },
  runaway_session_share(c) {
    const all = mainSessions(c);
    return share(all.filter((s) => s.n >= RUNAWAY_SESSION_TURNS).length, all.length);
  },
  opus_turn_share(c) {
    const total = mainTurnCount(c);
    const opus = mainTurnGroups(c)
      .filter((g) => /opus/i.test(g.model))
      .reduce((s, g) => s + g.n, 0);
    return share(opus, total);
  },
  model_switch_share(c) {
    const models = new Map<string, Set<string>>();
    for (const g of mainTurnGroups(c)) {
      const m = models.get(g.session_id) ?? new Set<string>();
      m.add(g.model);
      models.set(g.session_id, m);
    }
    const sessions = mainSessions(c).filter((s) => s.n >= MODEL_SWITCH_MIN_TURNS);
    return share(
      sessions.filter((s) => (models.get(s.session_id)?.size ?? 0) > 1).length,
      sessions.length,
    );
  },
  model_family_count(c) {
    const models = new Set(mainTurnGroups(c).map((g) => g.model));
    return models.size === 0 ? null : new Set([...models].map(modelFamily)).size;
  },
  subagent_session_share(c) {
    const eligible = mainSessions(c).filter((s) => s.n >= DELEGATION_MIN_TURNS);
    if (eligible.length === 0) return null;
    const side = new Set(
      turnGroups(c)
        .filter((g) => g.is_sidechain === 1)
        .map((g) => g.session_id),
    );
    return eligible.filter((s) => side.has(s.session_id)).length / eligible.length;
  },
  edit_sessions_with_tests_share(c) {
    const edits = toolSessions(c, `te.tool_name IN ${EDIT_TOOLS}`);
    if (edits.size === 0) return null;
    const tests = toolSessions(
      c,
      "te.event_id IN (SELECT m.event_id FROM tool_event_metadata m WHERE m.is_test_command = 1)",
    );
    let both = 0;
    for (const s of edits) if (tests.has(s)) both++;
    return both / edits.size;
  },
  explore_before_edit_share(c) {
    const { total, passing } = editSessions(c);
    return share(passing, total);
  },
  edit_survival_share(c) {
    const { authored, churned } = churnTotals(c);
    return share(authored - churned, authored);
  },
  cache_read_ratio(c) {
    const groups = turnGroups(c);
    return share(
      groups.reduce((s, g) => s + (g.cache_read ?? 0), 0),
      groups.reduce((s, g) => s + (g.priced ?? 0), 0),
    );
  },
  interrupt_per_user_turn(c) {
    return share(labelCount(c, ["interrupt-cancel"]), userTurns(c));
  },
  // Main-thread model responses (each usually one tool call) per prompt: read from the shared turn
  // pass, because counting main-thread tool_events needs a per-call sidechain join (~150 ms live).
  steps_per_user_turn(c) {
    const value = share(mainTurnCount(c), userTurns(c));
    if (value === null) return null;
    const interrupts = share(labelCount(c, ["interrupt-cancel"]), userTurns(c)) ?? 0;
    const interruptPartial = CHECKS.find((e) => e.check_id === "interrupt_rate")?.scoring.partial;
    const autonomyPass = CHECKS.find((e) => e.check_id === "autonomy_depth")?.scoring.pass;
    // Runaway guard: deep autonomy that is constantly interrupted cannot PASS.
    return interruptPartial !== undefined &&
      autonomyPass !== undefined &&
      interrupts > interruptPartial
      ? Math.min(value, autonomyPass - 0.01)
      : value;
  },
  denial_per_user_turn(c) {
    return share(labelCount(c, ["deny-rule", "hook-block", "user-rejected"]), userTurns(c));
  },

  // config (U2 scan)
  allow_all_bash_count: (c) =>
    settingsReadable(c.scan) ? allPermissions(c.scan).filter((p) => p.allowAllBash).length : null,
  bypass_mode_count: (c) =>
    settingsReadable(c.scan)
      ? allPermissions(c.scan).filter((p) => p.defaultMode === "bypassPermissions").length
      : null,
  secrets_deny_present: (c) =>
    settingsReadable(c.scan)
      ? allPermissions(c.scan).some((p) =>
          p.deny.some((rule) => /^Read/.test(rule.trim()) && SECRETS_RULE.test(rule)),
        )
        ? 1
        : 0
      : null,
  pretooluse_hook_count: (c) =>
    settingsReadable(c.scan) ? hookCommands(c.scan, ["PreToolUse"]) : null,
  verification_hook_count: (c) =>
    settingsReadable(c.scan) ? hookCommands(c.scan, ["PostToolUse", "Stop", "SubagentStop"]) : null,
  hook_command_count: (c) => (settingsReadable(c.scan) ? hookCommands(c.scan) : null),
  claude_md_max_lines(c) {
    const lines: number[] = [];
    if (c.scan.claudeMd.status === "ok" && c.scan.claudeMd.data) {
      lines.push(c.scan.claudeMd.data.lineCount);
    }
    for (const p of c.scan.projects) {
      if (p.claudeMd.status === "ok" && p.claudeMd.data) lines.push(p.claudeMd.data.lineCount);
    }
    return lines.length === 0 ? null : Math.max(...lines);
  },
  memory_max_lines(c) {
    const lines = c.scan.projects.flatMap((p) =>
      p.memory.status === "ok" && p.memory.data ? [p.memory.data.lineCount] : [],
    );
    return lines.length === 0 ? null : Math.max(...lines);
  },
  project_claude_md_share(c) {
    const scanned = c.scan.projects.filter(
      (p) => p.state.kind === "scanned" && p.claudeMd.status !== "unreadable",
    );
    return share(scanned.filter((p) => p.claudeMd.status === "ok").length, scanned.length);
  },
  skill_count: (c) => namedCount(c.scan.skills),
  agent_count: (c) => namedCount(c.scan.agents),
  mcp_server_count: (c) => namedCount(c.scan.mcp),
  memory_present(c) {
    if (c.scan.projects.length === 0) return null;
    const withMemory = c.scan.projects.some(
      (p) => p.memory.status === "ok" && (p.memory.data?.lineCount ?? 0) > 0,
    );
    return withMemory ? 1 : 0;
  },
};

function userTurns(c: Ctx): number {
  return memoized(c, "userTurns", () =>
    count(
      c,
      `SELECT COUNT(*) AS n FROM ingest_metric_events
      WHERE is_user_turn = 1 AND is_sidechain = 0
        AND COALESCE(event_ts, user_turn_ts) >= ? AND COALESCE(event_ts, user_turn_ts) < ?`,
    ),
  );
}

function labelCount(c: Ctx, labels: readonly string[]): number {
  return count(
    c,
    `SELECT COUNT(*) AS n FROM ingest_metric_events
      WHERE COALESCE(event_ts, user_turn_ts) >= ? AND COALESCE(event_ts, user_turn_ts) < ?
        AND classifier_label IN (${labels.map(() => "?").join(",")})`,
    ...labels,
  );
}

/** Signal ids the engine can evaluate (registry tests assert every entry binds to one). */
export function signalIds(): string[] {
  return Object.keys(SIGNALS).sort();
}

// ── Eligible sample per named condition ───────────────────────────────────────

const SAMPLES: Record<EligibilityCondition, (c: Ctx) => number> = {
  config_scan: () => 1,
  sessions: (c) => mainSessions(c).length,
  delegation_eligible_sessions: (c) =>
    mainSessions(c).filter((s) => s.n >= DELEGATION_MIN_TURNS).length,
  long_sessions: (c) => mainSessions(c).filter((s) => s.n >= LONG_SESSION_TURNS).length,
  edit_sessions: (c) => toolSessions(c, `te.tool_name IN ${EDIT_TOOLS}`).size,
  edit_sessions_oriented: (c) => editSessions(c).total,
  turns: (c) => mainTurnCount(c),
  user_turns: (c) => userTurns(c),
  priced_input_tokens: (c) => turnGroups(c).reduce((s, g) => s + (g.priced ?? 0), 0),
  churn_sessions: (c) => churnTotals(c).sessions,
};

// ── Check evaluation ──────────────────────────────────────────────────────────

function isStale(entry: CheckEntry, nowMs: number): boolean {
  const verified = Date.parse(`${entry.version_date}T00:00:00.000Z`);
  return Number.isNaN(verified) || nowMs - verified > entry.stale_after_days * DAY_MS;
}

function grade(entry: CheckEntry, value: number): CheckResult {
  const { direction, pass, partial } = entry.scoring;
  const meets = (limit: number): boolean =>
    direction === "higher" ? value >= limit : value <= limit;
  if (meets(pass)) return "PASS";
  return meets(partial) ? "PARTIAL" : "FAIL";
}

function evaluate(entry: CheckEntry, c: Ctx, nowMs: number): CheckOutcome {
  const base = { check_id: entry.check_id, category: entry.category, severity: entry.severity };
  const noData = (
    reason: NoDataReason,
    value: number | null,
    sample: number,
    needs: string,
  ): CheckOutcome => ({ ...base, result: "NO_DATA", value, sample, reason, needs });

  if (isStale(entry, nowMs)) {
    return noData(
      "stale",
      null,
      0,
      `rubric re-verification (${entry.version_tag} is older than ${entry.stale_after_days} days)`,
    );
  }
  const { eligibility } = entry;
  if (c.spanDays < eligibility.min_window_days) {
    return noData(
      "insufficient_window",
      null,
      0,
      `${eligibility.min_window_days}+ days of history`,
    );
  }
  const sample = SAMPLES[eligibility.condition](c);
  if (sample < eligibility.min_sample) {
    return noData("insufficient_sample", null, sample, eligibility.needs);
  }
  const signal = SIGNALS[entry.signal];
  const value = signal ? signal(c) : null;
  if (value === null) return noData("no_signal", null, sample, eligibility.needs);
  return {
    ...base,
    result: grade(entry, value),
    value: round2(value),
    sample,
    reason: null,
    needs: null,
  };
}

// ── Aggregation ───────────────────────────────────────────────────────────────

const POINTS: Record<CheckResult, number> = { PASS: 1, PARTIAL: 0.5, FAIL: 0, NO_DATA: 0 };

function scoreCategories(
  outcomes: readonly CheckOutcome[],
  categories: Record<string, CategoryDef>,
): CategoryOutcome[] {
  return Object.keys(categories)
    .sort()
    .map((key): CategoryOutcome => {
      const def = categories[key] as CategoryDef;
      const mine = outcomes.filter((o) => o.category === key);
      const scored = mine.filter((o) => o.result !== "NO_DATA");
      let earned = 0;
      let available = 0;
      for (const o of scored) {
        const w = SEVERITY_WEIGHT[o.severity];
        earned += w * POINTS[o.result];
        available += w;
      }
      const sufficient = scored.length >= MIN_CATEGORY_CHECKS && available > 0;
      return {
        category: key,
        label: def.label,
        weight: def.weight,
        status: sufficient ? "scored" : "insufficient-data",
        score: sufficient ? round2((100 * earned) / available) : null,
        scored_checks: scored.length,
        total_checks: mine.length,
      };
    });
}

function tierIndexForScore(overall: number): number {
  let idx = 0;
  TIER_FLOORS.forEach((floor, i) => {
    if (overall >= floor) idx = i;
  });
  return idx;
}

/** Shown score: the raw score, clamped under the next tier's floor when a cap/gate holds the tier below it. */
export function heldScore(raw: number, scoreIdx: number, finalIdx: number): number {
  return finalIdx < scoreIdx ? Math.min(raw, (TIER_FLOORS[finalIdx + 1] as number) - 1) : raw;
}

const tierName = (idx: number): TierName => TIER_NAMES[Math.max(0, idx)] as TierName;
const tierIdx = (t: TierName): number => TIER_NAMES.indexOf(t);

function dataNeededItems(
  outcomes: readonly CheckOutcome[],
  categories: readonly CategoryOutcome[],
): string[] {
  const weight = new Map(categories.map((c) => [c.category, c.weight]));
  return outcomes
    .filter((o) => o.result === "NO_DATA")
    .sort(
      (a, b) =>
        (weight.get(b.category) ?? 0) - (weight.get(a.category) ?? 0) ||
        SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
        (a.check_id < b.check_id ? -1 : 1),
    )
    .map((o) => `${o.check_id}: needs observed ${o.needs ?? "more data"}`);
}

/** Grade a setup. Pure read; deterministic for a given (db, scan, now, windowDays, rubric). */
export function gradeSetup(input: GradeInput): SetupGrade {
  const rubric = input.rubric ?? DEFAULT_RUBRIC;
  const toMs = new Date(input.now).getTime();
  const to = new Date(toMs).toISOString();
  const from = new Date(toMs - (input.windowDays ?? 30) * DAY_MS).toISOString();

  const firstTs = (
    input.db
      .prepare("SELECT MIN(ts) AS t FROM turns WHERE ts >= ? AND ts < ? AND provisional = 0")
      .get(from, to) as { t: string | null }
  ).t;
  const spanDays = firstTs === null ? 0 : Math.floor((toMs - Date.parse(firstTs)) / DAY_MS);
  const ctx: Ctx = { db: input.db, scan: input.scan, from, to, spanDays, memo: new Map() };

  const checks = rubric.checks.map((e) => evaluate(e, ctx, toMs));
  const categories = scoreCategories(checks, rubric.categories);

  const totalWeight = categories.reduce((s, c) => s + c.weight, 0);
  const scored = categories.filter((c) => c.status === "scored");
  const scoredWeight = scored.reduce((s, c) => s + c.weight, 0);
  const coverage = totalWeight === 0 ? 0 : round2(scoredWeight / totalWeight);
  const rawOverall =
    scoredWeight === 0
      ? null
      : round2(scored.reduce((s, c) => s + c.weight * (c.score as number), 0) / scoredWeight);

  const byId = new Map(checks.map((o) => [o.check_id, o]));
  const entryById = new Map(rubric.checks.map((e) => [e.check_id, e]));

  const gates = rubric.gates.map((g): GateOutcome => {
    const o = byId.get(g.check_id);
    const satisfied = o?.result === "PASS";
    let message: string | null = null;
    if (!satisfied) {
      message =
        !o || o.result === "NO_DATA"
          ? `needs observed ${o?.needs ?? g.check_id}`
          : `${g.unmet} (${g.check_id}: ${o.result})`;
    }
    return {
      gate_id: g.gate_id,
      check_id: g.check_id,
      boundary: g.boundary,
      satisfied,
      holding: false,
      message,
    };
  });
  const caps: CapOutcome[] = rubric.checks.flatMap((e) =>
    e.cap && byId.get(e.check_id)?.result === "FAIL"
      ? [{ check_id: e.check_id, tier: e.cap.tier, reason: e.cap.reason, binding: false }]
      : [],
  );

  const coverageOk = coverage >= MIN_COVERAGE && rawOverall !== null;
  const scoreIdx = coverageOk ? tierIndexForScore(rawOverall as number) : null;
  let finalIdx = scoreIdx;
  if (scoreIdx !== null) {
    for (const g of gates) {
      if (!g.satisfied && tierIdx(g.boundary) <= scoreIdx) {
        g.holding = true;
        finalIdx = Math.min(finalIdx as number, tierIdx(g.boundary) - 1);
      }
    }
    for (const cap of caps) {
      if (tierIdx(cap.tier) < scoreIdx) cap.binding = true;
      finalIdx = Math.min(finalIdx as number, tierIdx(cap.tier));
    }
  }

  // A held tier shows a score that matches it: clamp to just under the next tier's floor.
  const overall =
    rawOverall !== null && scoreIdx !== null && finalIdx !== null
      ? heldScore(rawOverall, scoreIdx, finalIdx)
      : rawOverall;

  const dataNeeded = coverageOk
    ? null
    : {
        message: `Not enough observed data to award a tier: scored categories cover ${Math.round(coverage * 100)}% of the rubric (need ${Math.round(MIN_COVERAGE * 100)}%).`,
        items: dataNeededItems(checks, categories),
      };

  let nextTier: SetupGrade["next_tier"] = null;
  if (finalIdx !== null && scoreIdx !== null && finalIdx < TIER_NAMES.length - 1) {
    const nextIdx = finalIdx + 1;
    const items: NextTierItem[] = [];
    for (const cap of caps) {
      if (tierIdx(cap.tier) <= finalIdx)
        items.push({ kind: "cap", check_id: cap.check_id, message: cap.reason });
    }
    for (const g of gates) {
      if (!g.satisfied && tierIdx(g.boundary) <= nextIdx) {
        items.push({ kind: "gate", check_id: g.check_id, message: g.message as string });
      }
    }
    if (scoreIdx < nextIdx) {
      const listed = new Set(items.map((i) => i.check_id));
      const movers = checks
        .filter((o) => o.result !== "PASS" && !listed.has(o.check_id))
        .sort(
          (a, b) =>
            SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
            (a.check_id < b.check_id ? -1 : 1),
        )
        .slice(0, MAX_NEXT_TIER_CHECKS);
      for (const o of movers) {
        items.push({
          kind: "check",
          check_id: o.check_id,
          message:
            o.result === "NO_DATA"
              ? `needs observed ${o.needs ?? o.check_id}`
              : (entryById.get(o.check_id)?.statement ?? o.check_id),
        });
      }
    }
    nextTier = { tier: tierName(nextIdx), items };
  }

  return {
    window: { from, to },
    checks,
    categories,
    coverage,
    overall,
    overall_before_hold: rawOverall,
    tier_by_score: scoreIdx === null ? null : tierName(scoreIdx),
    tier: finalIdx === null ? null : tierName(finalIdx),
    gates,
    caps,
    data_needed: dataNeeded,
    next_tier: nextTier,
  };
}

// ── Snapshots + delta (JMS U4) ────────────────────────────────────────────────

export interface CategoryDelta {
  category: string;
  previous: number | null;
  current: number | null;
  /** current - previous; null when either side has no score. */
  change: number | null;
}

/** Change between two consecutive grade snapshots. Scores and tiers only (no $). */
export interface GradeDelta {
  previous_computed_at: string;
  previous_overall: number | null;
  current_overall: number | null;
  overall_change: number | null;
  previous_tier: TierName | null;
  current_tier: TierName | null;
  tier_changed: boolean;
  categories: CategoryDelta[];
  previous_rubric_version: string;
  current_rubric_version: string;
  /** True when the two grades were computed under different registry versions. */
  rubric_changed: boolean;
}

export interface GradeRecord {
  grade: SetupGrade;
  /** Latest snapshot vs the one before it; null while only one snapshot exists. */
  delta: GradeDelta | null;
  /** True when this call inserted a snapshot (the grade changed). */
  recorded: boolean;
}

interface SnapshotRow {
  computed_at: string;
  overall: number | null;
  tier: TierName | null;
  category_scores: string;
  rubric_version: string;
  content_hash: string;
}

/**
 * Tag for engine-level scoring rules that change scores without touching any check. Bump it when
 * such a rule changes so the delta flags rubric_changed. held-score: a held tier clamps the score.
 */
export const SCORING_RULES_TAG = "held-score-u12-2026-10";

/** Registry version tag(s) a rubric was built under, plus the scoring-rules tag. */
export function rubricVersion(rubric: Rubric): string {
  return [...new Set([...rubric.checks.map((c) => c.version_tag), SCORING_RULES_TAG])]
    .sort()
    .join("+");
}

function scoreMap(grade: SetupGrade): Record<string, number | null> {
  return Object.fromEntries(grade.categories.map((c) => [c.category, c.score]));
}

/** Comparable grade content: excludes window/computed_at and raw signal values. */
function gradeContent(grade: SetupGrade, version: string) {
  return {
    version,
    overall: grade.overall,
    tier: grade.tier,
    categories: scoreMap(grade),
    gates: grade.gates.map((g) => [g.gate_id, g.satisfied, g.holding]),
    caps: grade.caps.map((c) => [c.check_id, c.tier, c.binding]),
    checks: grade.checks.map((c) => [c.check_id, c.result]),
  };
}

function deltaBetween(prev: SnapshotRow, cur: SnapshotRow): GradeDelta {
  const p = JSON.parse(prev.category_scores) as Record<string, number | null>;
  const c = JSON.parse(cur.category_scores) as Record<string, number | null>;
  const categories = [...new Set([...Object.keys(p), ...Object.keys(c)])].sort().map((k) => {
    const previous = p[k] ?? null;
    const current = c[k] ?? null;
    return {
      category: k,
      previous,
      current,
      change: previous === null || current === null ? null : round2(current - previous),
    };
  });
  return {
    previous_computed_at: prev.computed_at,
    previous_overall: prev.overall,
    current_overall: cur.overall,
    overall_change:
      prev.overall === null || cur.overall === null ? null : round2(cur.overall - prev.overall),
    previous_tier: prev.tier,
    current_tier: cur.tier,
    tier_changed: prev.tier !== cur.tier,
    categories,
    previous_rubric_version: prev.rubric_version,
    current_rubric_version: cur.rubric_version,
    rubric_changed: prev.rubric_version !== cur.rubric_version,
  };
}

/**
 * Grade, then persist a snapshot only when the grade content differs from the latest snapshot
 * (an unchanged grade issues no write). Returns the grade plus the delta between the two newest
 * snapshots (null until a second distinct grade exists).
 */
export function recordGradeSnapshot(input: GradeInput): GradeRecord {
  const grade = input.grade ?? gradeSetup(input);
  const version = rubricVersion(input.rubric ?? DEFAULT_RUBRIC);
  const hash = createHash("sha256")
    .update(JSON.stringify(gradeContent(grade, version)))
    .digest("hex");
  const cols = "computed_at, overall, tier, category_scores, rubric_version, content_hash";

  const latest = input.db
    .prepare(`SELECT ${cols} FROM setup_grade_snapshots ORDER BY snapshot_id DESC LIMIT 1`)
    .get() as SnapshotRow | undefined;
  const recorded = latest?.content_hash !== hash;
  if (recorded) {
    input.db
      .prepare(
        `INSERT INTO setup_grade_snapshots
           (computed_at, overall, tier, category_scores, gate_state, cap_state, check_results,
            rubric_version, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grade.window.to,
        grade.overall,
        grade.tier,
        JSON.stringify(scoreMap(grade)),
        JSON.stringify(grade.gates),
        JSON.stringify(grade.caps),
        JSON.stringify(grade.checks),
        version,
        hash,
      );
  }

  const [cur, prev] = input.db
    .prepare(`SELECT ${cols} FROM setup_grade_snapshots ORDER BY snapshot_id DESC LIMIT 2`)
    .all() as SnapshotRow[];
  return { grade, delta: cur && prev ? deltaBetween(prev, cur) : null, recorded };
}
