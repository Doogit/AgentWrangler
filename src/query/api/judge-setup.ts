/**
 * src/query/api/judge-setup.ts — GET /api/judge-setup (JMS U5).
 *
 * Scans the environment, grades the setup through the engine (recordGradeSnapshot: a snapshot is
 * written only when the grade changes), and attaches the rubric metadata (R11) plus per-check
 * dollar figures. Dollars are computed per request and never stored in snapshots.
 *
 * Dollar rule: a failing / partial check that maps to a detector reads the allocated weekly
 * dollars of that detector's live recs, summable-basis recs only (the existing recs query;
 * nothing is recomputed here). No mapping, no priced rec or a non-summable basis -> null, and
 * the UI shows the check's citation instead.
 *
 * SEC-101: counts, ratios and static rubric metadata, plus the local paths of settings files that
 * hold an allow-all Bash rule (in-app only, ADR-112; the share card never reads them).
 */

import path from "node:path";
import type { Db } from "../../db/open.js";
import { CHECK_GUIDANCE } from "../../detector/check-guidance.js";
import {
  CATEGORIES,
  CHECKS,
  GATES,
  MIN_CATEGORY_CHECKS,
  MIN_COVERAGE,
  SEVERITY_WEIGHT,
  TIER_FLOORS,
  TIER_NAMES,
  type TierName,
} from "../../detector/check-registry.js";
import {
  DEFAULT_RUBRIC,
  type GradeDelta,
  type SetupGrade,
  recordGradeSnapshot,
  rubricVersion,
} from "../../detector/setup-grade.js";
import { scanEnvironment } from "../../scanner/env-scan.js";
import type { EnvScanOptions, EnvScanResult, SettingsScan } from "../../scanner/env-scan.js";
import type { RecommendationCard } from "./recommendations.js";

/**
 * check id -> detector whose recs price that check's gap. Only clearly matching pairs:
 * claude_md_lean (D1 always-loaded context), long_session_share (D2 long full-context sessions),
 * cache_read_health (B1 cache-read collapse), interrupt_rate (D14), denial_rate (C9).
 */
export const CHECK_DETECTORS: Readonly<Record<string, string>> = {
  claude_md_lean: "D1",
  long_session_share: "D2",
  cache_read_health: "B1",
  interrupt_rate: "D14",
  denial_rate: "C9",
};

const MICRO = 1_000_000;

export interface JudgeCheckDollars {
  check_id: string;
  /** Allocated $/week from priced, summable-basis recs; null when unpriced (show the citation). */
  dollars_per_week: number | null;
  detector_id: string | null;
  rec_ids: string[];
}

export interface JudgeTierGap {
  tier: TierName;
  /** Sum over the next-tier items that carry a figure; null when none do. */
  dollars_per_week: number | null;
  measured_items: number;
  total_items: number;
  /** "measured items only" when some items are unpriced (honest understatement); else null. */
  label: string | null;
}

export interface JudgeRubricCheck {
  check_id: string;
  category: string;
  severity: string;
  statement: string;
  source_url: string;
  source_date: string;
  version_tag: string;
  version_date: string;
  stale_after_days: number;
  scoring: { direction: "higher" | "lower"; pass: number; partial: number };
  cap: { tier: TierName; reason: string } | null;
  /** Step-by-step fix; absent when the statement says it all. */
  how_to?: readonly string[];
  /** What the check looks at, in plain words; absent on older envelopes. */
  measured?: string;
  /** The pass bar, in plain words; absent on older envelopes. */
  done_when?: string;
}

export interface JudgeRubric {
  version: string;
  tier_names: readonly TierName[];
  /** Overall-score floor per tier, aligned with `tier_names`. */
  tier_floors: readonly number[];
  min_coverage: number;
  min_category_checks: number;
  severity_weights: Record<string, number>;
  categories: { category: string; label: string; weight: number }[];
  gates: { gate_id: string; check_id: string; boundary: TierName; unmet: string }[];
  checks: JudgeRubricCheck[];
}

export interface JudgeSetupResponse {
  /** `overall_before_hold` is optional so older envelopes/fixtures still type-check; the UI falls back to `overall`. */
  grade: Omit<SetupGrade, "overall_before_hold"> & { overall_before_hold?: number | null };
  delta: GradeDelta | null;
  /** True when this request inserted a snapshot. */
  recorded: boolean;
  rubric: JudgeRubric;
  dollars: {
    per_check: JudgeCheckDollars[];
    next_tier_gap: JudgeTierGap | null;
  };
  /** Generic labels of scan surfaces that exist but could not be read; absent when none. */
  unreadable_surfaces?: string[];
  /** True when recommendations were still building, so `dollars` is unpriced; absent otherwise. */
  dollars_pending?: true;
  /** Settings files that hold an allow-all Bash rule; absent when none. */
  allow_all_bash_files?: string[];
  /** Where a failing check's misses come from, worst first; keyed by check_id, absent when none. */
  where?: Record<string, JudgeWhereRow[]>;
}

export interface JudgeWhereRow {
  /** Workspace name (repo name, else folder name). */
  label: string;
  /** Sessions here that missed the check. */
  missed: number;
  /** Sessions here the check counted. */
  total: number;
}

export interface JudgeSetupOptions {
  /** Live recommendation cards (the recs view's `active` list). Empty -> every dollar is null. */
  cards?: readonly RecommendationCard[];
  now?: Date;
  scan?: EnvScanOptions;
  /** A scan the caller already ran (off the event loop); skips the in-line disk scan. */
  envScan?: EnvScanResult;
  /** The grade of `envScan` as of `now`, computed off the event loop with it. */
  grade?: SetupGrade;
  /** `judgeWhere(db, grade)`, computed off the event loop with `grade`; used only when `grade` is given. */
  where?: Record<string, JudgeWhereRow[]>;
}

function buildRubric(): JudgeRubric {
  return {
    version: rubricVersion(DEFAULT_RUBRIC),
    tier_names: TIER_NAMES,
    tier_floors: TIER_FLOORS,
    min_coverage: MIN_COVERAGE,
    min_category_checks: MIN_CATEGORY_CHECKS,
    severity_weights: { ...SEVERITY_WEIGHT },
    categories: Object.entries(CATEGORIES)
      .map(([category, def]) => ({ category, label: def.label, weight: def.weight }))
      .sort((a, b) => (a.category < b.category ? -1 : 1)),
    gates: GATES.map((g) => ({
      gate_id: g.gate_id,
      check_id: g.check_id,
      boundary: g.boundary,
      unmet: g.unmet,
    })),
    checks: CHECKS.map((c) => {
      const guide = CHECK_GUIDANCE[c.check_id];
      const howTo = c.how_to ?? guide?.how_to;
      return {
        check_id: c.check_id,
        category: c.category,
        severity: c.severity,
        statement: c.statement,
        source_url: c.source_url,
        source_date: c.source_date,
        version_tag: c.version_tag,
        version_date: c.version_date,
        stale_after_days: c.stale_after_days,
        scoring: c.scoring,
        cap: c.cap ?? null,
        ...(howTo ? { how_to: howTo } : {}),
        ...(guide ? { measured: guide.measured, done_when: guide.done_when } : {}),
      };
    }),
  };
}

/** Allocated $/wk for one detector: priced + summable recs only; null when none qualify. */
function detectorDollars(
  cards: readonly RecommendationCard[],
  detectorId: string,
): { dollars: number | null; recIds: string[] } {
  let micro = 0;
  const recIds: string[] = [];
  for (const c of cards) {
    if (c.detector_id !== detectorId || c.safety_lane) continue;
    const u = c.allocated_u_per_wk;
    if (typeof u !== "number" || !Number.isFinite(u)) continue;
    if (c.estimate?.summable !== true) continue;
    micro += u;
    recIds.push(c.rec_id);
  }
  return recIds.length === 0
    ? { dollars: null, recIds }
    : { dollars: Math.round((micro / MICRO) * 100) / 100, recIds };
}

/** Per-check dollars plus the next-tier gap for a grade. Pure; nothing is stored. */
export function priceGrade(
  grade: SetupGrade,
  cards: readonly RecommendationCard[],
): JudgeSetupResponse["dollars"] {
  const perCheck: JudgeCheckDollars[] = grade.checks.map((o) => {
    const detector = CHECK_DETECTORS[o.check_id] ?? null;
    const failing = o.result === "FAIL" || o.result === "PARTIAL";
    const priced =
      detector !== null && failing
        ? detectorDollars(cards, detector)
        : { dollars: null, recIds: [] };
    return {
      check_id: o.check_id,
      dollars_per_week: priced.dollars,
      detector_id: detector,
      rec_ids: priced.recIds,
    };
  });

  let gap: JudgeTierGap | null = null;
  if (grade.next_tier) {
    const byId = new Map(perCheck.map((p) => [p.check_id, p.dollars_per_week]));
    const items = grade.next_tier.items;
    const figures = items.flatMap((i) => {
      const d = byId.get(i.check_id);
      return d === null || d === undefined ? [] : [d];
    });
    gap = {
      tier: grade.next_tier.tier,
      dollars_per_week:
        figures.length === 0 ? null : Math.round(figures.reduce((s, d) => s + d, 0) * 100) / 100,
      measured_items: figures.length,
      total_items: items.length,
      label: figures.length < items.length ? "measured items only" : null,
    };
  }

  return { per_check: perCheck, next_tier_gap: gap };
}

/** Generic labels for scan surfaces that exist but could not be read. No paths, no names. */
export function unreadableSurfaces(scan: EnvScanResult): string[] {
  const out: string[] = [];
  const settings = (s: SettingsScan, prefix: string) => {
    if (s.file === "unreadable") out.push(`${prefix}settings.json`);
    else {
      if (s.permissions.status === "unreadable") out.push(`${prefix}settings.json permissions`);
      if (s.hooks.status === "unreadable") out.push(`${prefix}settings.json hooks`);
    }
  };
  settings(scan.settings, "");
  if (scan.claudeMd.status === "unreadable") out.push("CLAUDE.md");
  if (scan.skills.status === "unreadable") out.push("skills");
  if (scan.agents.status === "unreadable") out.push("agents");
  if (scan.mcp.status === "unreadable") out.push("MCP config");

  const counts = { claudeMd: 0, settings: 0, mcp: 0, memory: 0 };
  for (const p of scan.projects) {
    if (p.claudeMd.status === "unreadable") counts.claudeMd++;
    if (p.claudeDir.status === "unreadable") counts.settings++;
    else if (p.claudeDir.data) {
      const s = p.claudeDir.data;
      if (
        s.file === "unreadable" ||
        s.permissions.status === "unreadable" ||
        s.hooks.status === "unreadable"
      ) {
        counts.settings++;
      }
    }
    if (p.mcpJson.status === "unreadable") counts.mcp++;
    if (p.memory.status === "unreadable") counts.memory++;
  }
  const plural = (n: number) => `${n} ${n === 1 ? "workspace" : "workspaces"}`;
  if (counts.claudeMd > 0) out.push(`project CLAUDE.md (${plural(counts.claudeMd)})`);
  if (counts.settings > 0) out.push(`project .claude settings (${plural(counts.settings)})`);
  if (counts.mcp > 0) out.push(`project .mcp.json (${plural(counts.mcp)})`);
  if (counts.memory > 0) out.push(`project memory (${plural(counts.memory)})`);
  return out;
}

/** The settings files the allow-all Bash count came from (same scopes as `allPermissions`). */
export function allowAllBashFiles(scan: EnvScanResult): string[] {
  const out: string[] = [];
  if (scan.settings.permissions.data?.allowAllBash) out.push("~/.claude/settings.json");
  for (const p of scan.projects) {
    const s = p.claudeDir.status === "ok" ? p.claudeDir.data : undefined;
    if (p.repoPath && s?.permissions.data?.allowAllBash) {
      out.push(path.join(p.repoPath, ".claude", "settings.json"));
    }
  }
  return out;
}

const WHERE_ROWS = 5;

/**
 * Workspaces with the most editing sessions that ran no test, over the grade's window. Same rule as
 * the grade's verify_test_loop signal (an Edit/Write/MultiEdit/NotebookEdit and an is_test_command
 * event in the same session).
 */
export function untestedEditWhere(db: Db, window: { from: string; to: string }): JudgeWhereRow[] {
  const rows = db
    .prepare(
      `WITH edits AS (
         SELECT DISTINCT session_id FROM tool_events
          WHERE ts >= ? AND ts < ? AND tool_name IN ('Edit','Write','MultiEdit','NotebookEdit')),
       tested AS (
         SELECT DISTINCT te.session_id FROM tool_events te
           JOIN tool_event_metadata m ON m.event_id = te.event_id AND m.is_test_command = 1
          WHERE te.ts >= ? AND te.ts < ?)
       SELECT COALESCE(w.repo_name, w.repo_path, w.discovered_cwd, w.project_slug) AS label,
              SUM(t.session_id IS NULL) AS missed, COUNT(*) AS total
         FROM edits e
         JOIN sessions s ON s.session_id = e.session_id
         JOIN workspaces w ON w.workspace_id = s.workspace_id
         LEFT JOIN tested t ON t.session_id = e.session_id
        GROUP BY w.workspace_id
       HAVING missed > 0
        ORDER BY missed DESC, label
        LIMIT ?`,
    )
    .all(window.from, window.to, window.from, window.to, WHERE_ROWS) as JudgeWhereRow[];
  return rows.map((r) => ({ ...r, label: path.basename(r.label) || r.label }));
}

/** The "where" rows for the grade's failing checks (SQL over tool_events; run with the grade, off the loop). */
export function judgeWhere(db: Db, grade: SetupGrade): Record<string, JudgeWhereRow[]> {
  const where: Record<string, JudgeWhereRow[]> = {};
  const testLoop = grade.checks.find((c) => c.check_id === "verify_test_loop");
  if (testLoop && (testLoop.result === "FAIL" || testLoop.result === "PARTIAL")) {
    const rows = untestedEditWhere(db, grade.window);
    if (rows.length > 0) where.verify_test_loop = rows;
  }
  return where;
}

export function getJudgeSetup(db: Db, opts: JudgeSetupOptions = {}): JudgeSetupResponse {
  const scan = opts.envScan ?? scanEnvironment(db, opts.scan);
  const unreadable = unreadableSurfaces(scan);
  const bashFiles = allowAllBashFiles(scan);
  const { grade, delta, recorded } = recordGradeSnapshot({
    db,
    scan,
    now: opts.now ?? new Date(),
    ...(opts.grade ? { grade: opts.grade } : {}),
  });
  const where = opts.grade && opts.where ? opts.where : judgeWhere(db, grade);
  return {
    grade,
    delta,
    recorded,
    rubric: buildRubric(),
    dollars: priceGrade(grade, opts.cards ?? []),
    ...(unreadable.length > 0 ? { unreadable_surfaces: unreadable } : {}),
    ...(bashFiles.length > 0 ? { allow_all_bash_files: bashFiles } : {}),
    ...(Object.keys(where).length > 0 ? { where } : {}),
  };
}
