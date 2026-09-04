/**
 * src/detector/practice-registry.ts — BM1 published-best-practice scorecard.
 *
 * The registry is DATA, not a code path: a typed list of the published Claude
 * Code best practices, each carrying its own citation (source_url + source_date)
 * so a practice that drifts with harness versions is visibly stale and updating
 * one is a data edit. Status is COMPUTED on request from existing aggregates
 * (turns / sessions / context_inventory / recommendations / detector statuses)
 * and is never stored.
 *
 * §0.5 tier compliance: this is a measurement surface, not a rec — it emits zero
 * new advice sentences. ATTENTION rows deep-link to an existing artifact via
 * `artifact_link` (null when none exists); the UI renders status + citation only.
 *
 * SEC-101: every entry field is static public metadata (URLs, dates, numbers)
 * and every computed input is an existing count/ratio — no transcript content.
 *
 * Excluded from v1 (spec §BM1): the effort/thinking practice (spec-prohibited
 * advisory — spec-d11-effort-mismatch.md:8-10); prompt structural-ordering (not
 * observable locally); "agent teams use 7× tokens" (no local lever).
 */

import { readFileSync } from "node:fs";
import type { Db } from "../db/open.js";
import { getOffloadShare } from "../query/api/offload-share.js";
import { getDetectorStatuses } from "./index.js";

export type PracticeStatus = "PASS" | "ATTENTION" | "NO_DATA";

export interface PracticeThreshold {
  /** Numeric threshold, or null for a trend-only / detector-owned practice. */
  value: number | null;
  rationale: string;
}

export interface PracticeEntry {
  /** "P1".."P8". */
  practice_id: string;
  /** One sentence, quoting/paraphrasing the cited source. */
  statement: string;
  /** Primary Anthropic doc/blog the practice is grounded in. */
  source_url: string;
  /** Publication or fetched date (ISO yyyy-mm-dd). */
  source_date: string;
  threshold: PracticeThreshold;
  /** Query/detector id that computes the status (documentation of the binding). */
  signal: string;
  /** Computed per request; never stored. */
  status: PracticeStatus;
  /** Route of the existing intervention artifact, or null. */
  artifact_link: string | null;
}

/** Window the scorecard was computed over. */
export interface PracticesResult {
  practices: PracticeEntry[];
  window: { from: string; to: string };
}

// ── Thresholds (registry-declared; UNVALIDATED defaults, tooltip-surfaced) ────
/** P1: ATTENTION when this week's cache-read ratio is this many points below the trailing-median. */
const P1_ATTENTION_DROP_PTS = 10;
/** P1: minimum priced-input volume (input + cache_read tokens) for the current week to be judged. */
const P1_MIN_WEEK_VOLUME_TOKENS = 50_000;
/** P1: minimum number of prior weeks with data before a median comparison is trustworthy. */
const P1_MIN_PRIOR_WEEKS = 4;
/** P2: ATTENTION when more than this fraction of non-trivial sessions switched models. */
const P2_ATTENTION_FRACTION = 0.2;
/** P2: a session is "non-trivial" at or above this many non-sidechain turns in the window. */
const P2_MIN_SESSION_TURNS = 5;
/** P5: official CLAUDE.md line ceiling (Source C, code.claude.com/docs/en/costs). */
const P5_MAX_CLAUDE_MD_LINES = 200;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// ── Editorial registry (authored direct — statements + citations) ─────────────
/**
 * Static half of each entry. `status` is filled by getPractices; the literal
 * "NO_DATA" here is a placeholder that is always overwritten before return.
 */
const REGISTRY: readonly Omit<PracticeEntry, "status">[] = [
  {
    practice_id: "P1",
    statement:
      "Watch cache-read health — a few points of cache-miss rate dramatically affect cost and latency.",
    source_url:
      "https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything",
    source_date: "2026-04-30",
    threshold: {
      value: P1_ATTENTION_DROP_PTS,
      rationale:
        "Trend-only (no published absolute threshold): ATTENTION when this week's cache-read ratio is >10 points below the trailing-8-week median; NO_DATA under minimum weekly volume.",
    },
    signal: "cache_read_ratio_wk",
    artifact_link: null,
  },
  {
    practice_id: "P2",
    statement: "Don't switch models mid-session — switching forces a cache rebuild.",
    source_url:
      "https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything",
    source_date: "2026-04-30",
    threshold: {
      value: P2_ATTENTION_FRACTION * 100,
      rationale:
        "ATTENTION when >20% of the week's non-trivial sessions (≥5 non-sidechain turns) used more than one model.",
    },
    signal: "distinct_model_per_session_wk",
    artifact_link: null,
  },
  {
    practice_id: "P3",
    statement:
      "Respect the cache-TTL cadence — an idle gap longer than the TTL re-writes the whole context at base price.",
    source_url:
      "https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything",
    source_date: "2026-04-30",
    threshold: {
      value: null,
      rationale:
        "Detector-owned threshold: status follows the D8 CACHE_WRITE_CHURN detector, which flags TTL-crossing cache-write spikes (subscription TTL 1h / API 5m).",
    },
    signal: "D8",
    artifact_link: "/settings",
  },
  {
    practice_id: "P4",
    statement: "Use /clear between tasks — stale context bills on every subsequent message.",
    source_url: "https://code.claude.com/docs/en/costs",
    source_date: "2026-09-02",
    threshold: {
      value: null,
      rationale:
        "Binary: ATTENTION whenever the D2 SESSION_LONG_FULL_CONTEXT detector is firing in-window.",
    },
    signal: "D2",
    artifact_link: "/recommendations",
  },
  {
    practice_id: "P5",
    statement:
      "Keep CLAUDE.md lean — the docs recommend under 200 lines; it loads into context every session.",
    source_url: "https://code.claude.com/docs/en/costs",
    source_date: "2026-09-02",
    threshold: {
      value: P5_MAX_CLAUDE_MD_LINES,
      rationale:
        "PASS at or below the official 200-line CLAUDE.md ceiling (Source C), ATTENTION above it.",
    },
    signal: "claude_md_line_count",
    artifact_link: null,
  },
  {
    practice_id: "P6",
    statement:
      "Right-size the model — Opus costs ~5× more than Sonnet per token; reserve it for complex tasks.",
    source_url: "https://code.claude.com/docs/en/costs",
    source_date: "2026-09-02",
    threshold: {
      value: null,
      rationale: "Binary: ATTENTION whenever the D4 MODEL_MISMATCH detector is firing in-window.",
    },
    signal: "D4",
    artifact_link: "/recommendations",
  },
  {
    practice_id: "P7",
    statement:
      "Offload to subagents — specialized subagents return 1–2k-token summaries despite consuming tens of thousands internally.",
    source_url: "https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents",
    source_date: "2025-09-29",
    threshold: {
      value: null,
      rationale:
        "Trend-only: the source gives a shape, not a target, so no threshold is claimed — the observed offload share is rendered alongside the citation (PASS when observable, NO_DATA otherwise).",
    },
    signal: "getOffloadShare",
    artifact_link: null,
  },
  {
    practice_id: "P8",
    statement:
      "Keep the tool catalog stable and small — any tool-set change invalidates the cache.",
    source_url:
      "https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything",
    source_date: "2026-04-30",
    threshold: {
      value: null,
      rationale:
        "Partial: status is computed from the installed tool-catalog footprint only (D10 CATALOG_FOOTPRINT, config-state); the loaded-vs-installed gap is a UI tooltip disclosure.",
    },
    signal: "D10",
    artifact_link: null,
  },
] as const;

// ── Status computation ────────────────────────────────────────────────────────

/** Map a live detector status to a practice status. */
export function detectorPracticeStatus(kind: string | undefined): PracticeStatus {
  if (kind === "ACTIVE") return "ATTENTION";
  if (kind === "INACTIVE") return "PASS";
  return "NO_DATA"; // NOT_EVALUATED | BLOCKED | absent
}

interface RatioRow {
  read: number;
  base: number;
}

/** Cache-read ratio and its priced-input volume over [fromIso, toIso). */
function cacheReadRatio(
  db: Db,
  fromIso: string,
  toIso: string,
): { ratio: number | null; volume: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cache_read_tokens),0) AS read,
              COALESCE(SUM(input_tokens + cache_read_tokens),0) AS base
         FROM turns
        WHERE ts >= ? AND ts < ? AND provisional = 0`,
    )
    .get(fromIso, toIso) as RatioRow;
  return { ratio: row.base === 0 ? null : row.read / row.base, volume: row.base };
}

/** P1: current-week cache-read ratio vs trailing-8-week median. */
function computeP1(db: Db, toIso: string): PracticeStatus {
  const end = new Date(toIso).getTime();
  const current = cacheReadRatio(db, new Date(end - WEEK_MS).toISOString(), toIso);
  if (current.ratio === null || current.volume < P1_MIN_WEEK_VOLUME_TOKENS) return "NO_DATA";

  const priors: number[] = [];
  for (let i = 1; i <= 8; i++) {
    const wTo = new Date(end - i * WEEK_MS).toISOString();
    const wFrom = new Date(end - (i + 1) * WEEK_MS).toISOString();
    const r = cacheReadRatio(db, wFrom, wTo);
    if (r.ratio !== null) priors.push(r.ratio);
  }
  if (priors.length < P1_MIN_PRIOR_WEEKS) return "NO_DATA";

  priors.sort((a, b) => a - b);
  const mid = Math.floor(priors.length / 2);
  const median =
    priors.length % 2 === 0
      ? ((priors[mid - 1] ?? 0) + (priors[mid] ?? 0)) / 2
      : (priors[mid] ?? 0);
  const dropPts = (median - current.ratio) * 100;
  return dropPts > P1_ATTENTION_DROP_PTS ? "ATTENTION" : "PASS";
}

interface SessionModelRow {
  session_id: string;
  mc: number;
  tc: number;
}

/** P2: fraction of non-trivial sessions in-window that used more than one model. */
function computeP2(db: Db, fromIso: string, toIso: string): PracticeStatus {
  const rows = db
    .prepare(
      `SELECT session_id, COUNT(DISTINCT model) AS mc, COUNT(*) AS tc
         FROM turns
        WHERE ts >= ? AND ts < ? AND provisional = 0 AND is_sidechain = 0
        GROUP BY session_id
       HAVING tc >= ?`,
    )
    .all(fromIso, toIso, P2_MIN_SESSION_TURNS) as SessionModelRow[];
  if (rows.length === 0) return "NO_DATA";
  const switched = rows.filter((r) => r.mc > 1).length;
  return switched / rows.length > P2_ATTENTION_FRACTION ? "ATTENTION" : "PASS";
}

interface ClaudeMdRow {
  file_ref: string;
}

/** P5: line count of the most-recently-probed CLAUDE.md against the 200-line ceiling. */
function computeP5(db: Db): PracticeStatus {
  const row = db
    .prepare(
      `SELECT file_ref
         FROM context_inventory
        WHERE component = 'CLAUDE_MD'
        ORDER BY probed_at DESC
        LIMIT 1`,
    )
    .get() as ClaudeMdRow | undefined;
  if (!row) return "NO_DATA";
  try {
    // Structural read only: the line count leaves this surface, never the content (SEC-101).
    const text = readFileSync(row.file_ref, "utf8");
    const lines = text.length === 0 ? 0 : text.split("\n").length;
    return lines <= P5_MAX_CLAUDE_MD_LINES ? "PASS" : "ATTENTION";
  } catch {
    return "NO_DATA";
  }
}

/** P7: offload share is observable → PASS (trend-only), else NO_DATA. No ATTENTION line. */
function computeP7(db: Db, fromIso: string, toIso: string): PracticeStatus {
  const share = getOffloadShare(db, { workspaceId: null, from: fromIso, to: toIso }).data
    ?.offload_share;
  return share === null || share === undefined ? "NO_DATA" : "PASS";
}

/**
 * Compute the practice scorecard over [from, to). Detector-backed practices
 * (P3/P4/P6/P8) read the live detector statuses anchored at `to`; the rest read
 * existing aggregates directly.
 */
export function getPractices(db: Db, opts: { from: string; to: string }): PracticesResult {
  const { from, to } = opts;
  const detectorStatus = new Map<string, string>();
  for (const s of getDetectorStatuses(db, { now: new Date(to) })) {
    detectorStatus.set(s.detector_id, s.status);
  }

  const practices = REGISTRY.map((entry): PracticeEntry => {
    let status: PracticeStatus;
    switch (entry.practice_id) {
      case "P1":
        status = computeP1(db, to);
        break;
      case "P2":
        status = computeP2(db, from, to);
        break;
      case "P5":
        status = computeP5(db);
        break;
      case "P7":
        status = computeP7(db, from, to);
        break;
      default:
        // P3→D8, P4→D2, P6→D4, P8→D10 (signal is the detector id).
        status = detectorPracticeStatus(detectorStatus.get(entry.signal));
    }
    return { ...entry, status };
  });

  return { practices, window: { from, to } };
}
