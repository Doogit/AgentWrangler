/**
 * test/detector-health/pipeline.ts — DH1c: trace one detector past evaluate() through the
 * daemon's own stages: detector pass (runHistoryWalk) → recommendations rows →
 * /api/recommendations buckets → Diagnostics triage.
 */

import type { Db } from "../../src/db/open.js";
import { runHistoryWalk } from "../../src/detector/engine.js";
import { writeLedgerDaily } from "../../src/detector/ledger-daily.js";
import { recId } from "../../src/detector/rec-id.js";
import { CAUSES } from "../../src/query/api/diagnostics-causes.js";
import { buildDiagnosticsTriage } from "../../src/query/api/diagnostics-triage.js";
import {
  type RecommendationCard,
  type RecommendationsView,
  buildRecommendations,
  headlineSavings,
} from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";

export const BUCKETS = [
  "active",
  "limit_warnings",
  "below_floor",
  "adopted",
  "dismissed",
  "history",
] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface PipelineTrace {
  detector_id: string;
  status: string;
  note: string;
  rec_rows: number;
  /** rec_id count per API bucket; a rec in none of them is counted in `absent`. */
  buckets: Partial<Record<Bucket, number>>;
  absent: number;
  /** Visible cards (active + limit_warnings) with a title. */
  titled: number;
  /** Visible cards by what their headline shows (see `headlineKind`). */
  headline: Partial<Record<HeadlineKind, number>>;
  /** Distinct `moneySanity` flags across visible cards. */
  sanity: string[];
  /** Per visible card: the figures behind its headline (µ$/wk). */
  money: Array<{
    kind: HeadlineKind;
    headline: number | null;
    modeled: number | null;
    reliability: number | null;
    range: [number, number] | null;
    pct_of_weekly_spend: number | null;
    /** Card scope workspace (null = global); lets DH3 oracles compare per workspace. */
    scope_workspace_id?: string | null;
    /** Headline count: C9 DENIAL_COUNT, other safety OPERATION_COUNT, C2 ERROR_COUNT, B4 EVENT_COUNT; null otherwise. */
    count?: number | null;
    /** The rec scope key (e.g. "C1|<tool>"); lets DH3 oracles compare per scope when findings are global. */
    scope_key?: string | null;
    /** Numeric evidence metrics on the card (B4: CURRENT_CACHE_CREATION_TOKENS, REWRITE_COST_U); secondary checks. */
    metrics?: Record<string, number>;
  }>;
  /** Diagnostics avoidable-spend cause ids whose pattern for this detector counts > 0. */
  diag_causes: string[];
  /** Of `diag_causes`, those showing $ (ledger `avoidable_u` or F9 `standalone_u`), not "Not estimated". */
  diag_priced: string[];
  diag_warnings: string[];
  /** Where the finding stops: null = reached Recs or Diagnostics. */
  drop: string | null;
}

/** Pattern code → detector id, from the same cause keys the triage uses. */
const CODE_TO_DETECTOR = new Map<string, string>();
for (const c of CAUSES)
  for (const k of c.keys) {
    CODE_TO_DETECTOR.set(k.detector_id, k.detector_id);
    CODE_TO_DETECTOR.set(k.id, k.detector_id);
  }

export type HeadlineKind =
  | "limit-warning"
  | "safety-count"
  | "net-$"
  | "reliability-upper-bound"
  | "standalone-$"
  | "folded"
  | "not-estimated";

/**
 * What the card headline shows. Mirrors SavingsMeter (src/ui/lib/rec-presentation.tsx); keep the
 * two in step. A $0 net figure is still "net-$": the calculation ran.
 */
export function headlineKind(card: RecommendationCard): HeadlineKind {
  if (card.category === "LIMIT") return "limit-warning";
  if (card.safety_lane) return "safety-count";
  if (card.allocated_u_per_wk === null) {
    if (typeof card.reliability_u_per_wk === "number") return "reliability-upper-bound";
    const m = card.modeled_savings_u_per_wk;
    if (typeof m === "number" && m > 0 && card.estimate?.summable === false) return "standalone-$";
    // Mirrors FOLDED_HEADLINE_OWNER (a .tsx module, not importable here).
    if (card.detector_id === "B4" || card.detector_id === "B2") return "folded";
    return "not-estimated";
  }
  return headlineSavings(card) === null ? "not-estimated" : "net-$";
}

/**
 * Sanity flags on the card's $ figures. A $0 is not a failure by itself, but on a finding that
 * fired it is flagged for review. The cap: a saving cannot exceed its scope's weekly spend.
 */
/** Safety-card headline count. Mirrors SavingsMeter's metricCount (a .tsx module, not importable here). */
function safetyCount(card: RecommendationCard): number | null {
  // C2 shows ERROR_COUNT (lookups); B4 shows EVENT_COUNT (breaks in the workspace); B2 shows
  // RESUME_COUNT (resumes after the cache expired, F29).
  const code =
    card.detector_id === "C2"
      ? "ERROR_COUNT"
      : card.detector_id === "B4"
        ? "EVENT_COUNT"
        : card.detector_id === "B2"
          ? "RESUME_COUNT"
          : card.safety_lane
            ? card.detector_id === "C9"
              ? "DENIAL_COUNT"
              : "OPERATION_COUNT"
            : null;
  if (code === null) return null;
  const entry = (card.evidence.metrics as Record<string, { value?: unknown }> | undefined)?.[code];
  return typeof entry?.value === "number" && Number.isFinite(entry.value) ? entry.value : null;
}

export function moneySanity(card: RecommendationCard): string[] {
  const flags: string[] = [];
  const figures = {
    headline: headlineSavings(card),
    modeled: card.modeled_savings_u_per_wk,
    reliability: card.reliability_u_per_wk ?? null,
  };
  for (const [name, v] of Object.entries(figures)) {
    if (v === null || v === undefined) continue;
    if (!Number.isFinite(v)) flags.push(`${name} not finite`);
    else if (v < 0) flags.push(`${name} negative`);
  }
  const kind = headlineKind(card);
  if (kind === "net-$" && figures.headline === 0) flags.push("$0 on a fired finding");
  // F7: the headline is main-chain only; subagent failures show beside it ("+ $x/wk in subagents").
  if (kind === "reliability-upper-bound" && figures.reliability === 0)
    flags.push(
      (card.reliability_sidechain_u_per_wk ?? 0) > 0
        ? "$0 main-chain upper bound (subagent $ shown)"
        : "$0 upper bound on a fired finding",
    );
  if (kind === "not-estimated")
    flags.push(
      figures.modeled !== null || (card.range_u_per_wk != null && card.range_u_per_wk[1] > 0)
        ? "figure computed but card shows Not estimated"
        : "no figure computed",
    );
  if (card.pct_of_weekly_spend != null && card.pct_of_weekly_spend > 100)
    flags.push("saving > scope weekly spend");
  // The range brackets the modeled figure; a net headline may sit below it (overlaps removed).
  const range = card.range_u_per_wk;
  const m = figures.modeled;
  if (range && m !== null && (m < range[0] || m > range[1]))
    flags.push("modeled outside its range");
  if (range && kind === "net-$" && figures.headline !== null && figures.headline > range[1])
    flags.push("net headline above its range");
  return flags;
}

/** `afterWalk` runs between the detector pass and the read paths (seeded-fault meta-test). */
export async function tracePipeline(
  db: Db,
  detectorId: string,
  NOW: Date,
  afterWalk?: (db: Db) => void,
): Promise<PipelineTrace> {
  const [trace] = await tracePipelines(db, [detectorId], NOW, afterWalk);
  return trace as PipelineTrace;
}

/** One walk and one read of each path, traced for every id (DH4 runs all 31 on a live copy). */
export async function tracePipelines(
  db: Db,
  detectorIds: string[],
  NOW: Date,
  afterWalk?: (db: Db) => void,
): Promise<PipelineTrace[]> {
  // Same order as src/daemon/history-worker.ts: the walk, then the daily ledger Diagnostics reads.
  const walk = await runHistoryWalk(db, NOW);
  writeLedgerDaily(db, NOW);
  afterWalk?.(db);

  setQueryDb(db);
  let view: RecommendationsView;
  try {
    const res = buildRecommendations(undefined, NOW);
    if (!res.data) throw new Error(`buildRecommendations: no data (${JSON.stringify(res.meta)})`);
    view = res.data;
  } finally {
    resetQueryDb();
  }

  const warnings: string[] = [];
  const triage = buildDiagnosticsTriage(db, 7, NOW, { warn: (m) => warnings.push(m) });

  return detectorIds.map((id) => traceOne(db, id, walk.statuses, view, triage, warnings, NOW));
}

/** Numeric `evidence.metrics.*.value` entries (a card's or a stored rec's). */
function numericMetrics(evidence: unknown): Record<string, number> {
  const raw = (evidence as { metrics?: Record<string, { value?: unknown }> } | null)?.metrics ?? {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw))
    if (typeof v?.value === "number" && Number.isFinite(v.value)) out[k] = v.value;
  return out;
}

function traceOne(
  db: Db,
  detectorId: string,
  statuses: Awaited<ReturnType<typeof runHistoryWalk>>["statuses"],
  view: RecommendationsView,
  triage: ReturnType<typeof buildDiagnosticsTriage>,
  warnings: string[],
  NOW: Date,
): PipelineTrace {
  const st = statuses.find((s) => s.detector_id === detectorId);
  const recIds = (
    db
      .prepare("SELECT rec_id FROM recommendations WHERE detector_id = ?")
      .all(detectorId) as Array<{
      rec_id: string;
    }>
  ).map((r) => r.rec_id);

  const buckets: Partial<Record<Bucket, number>> = {};
  const placed = new Set<string>();
  let titled = 0;
  const headline: Partial<Record<HeadlineKind, number>> = {};
  const sanity: string[] = [];
  const money: PipelineTrace["money"] = [];
  // rec_id → scope key, from the same (detector, workspace, key) triples the engine hashes into rec_id.
  const scopeKeyOf = new Map<string, string>();
  for (const k of db
    .prepare(
      "SELECT DISTINCT scope_key, scope_workspace_id FROM detector_week_results WHERE detector_id = ?",
    )
    .all(detectorId) as Array<{ scope_key: string; scope_workspace_id: string | null }>)
    scopeKeyOf.set(recId(detectorId, k.scope_workspace_id, k.scope_key), k.scope_key);
  for (const b of BUCKETS) {
    for (const card of view[b] ?? []) {
      if (card.detector_id !== detectorId) continue;
      buckets[b] = (buckets[b] ?? 0) + 1;
      placed.add(card.rec_id);
      if (b === "active" || b === "limit_warnings") {
        if (card.title) titled += 1;
        const k = headlineKind(card);
        headline[k] = (headline[k] ?? 0) + 1;
        for (const f of moneySanity(card)) if (!sanity.includes(f)) sanity.push(f);
        money.push({
          kind: k,
          headline: headlineSavings(card),
          modeled: card.modeled_savings_u_per_wk,
          reliability: card.reliability_u_per_wk ?? null,
          range: card.range_u_per_wk ?? null,
          count: safetyCount(card),
          pct_of_weekly_spend: card.pct_of_weekly_spend,
          scope_workspace_id: card.scope_workspace_id,
          scope_key: scopeKeyOf.get(card.rec_id) ?? null,
          metrics: numericMetrics(card.evidence),
        });
      }
    }
  }
  const absent = recIds.filter((id) => !placed.has(id)).length;

  const diag_warnings = warnings
    .filter((m) => m.includes(`(${detectorId},`))
    .map((m) => m.replace(/finding \S+ /, "finding "));
  // Only the avoidable section is built from detector recs; reliability rows come from the census.
  const diagRows = triage.avoidable.causes.filter((r) =>
    r.patterns.some((p) => p.count > 0 && CODE_TO_DETECTOR.get(p.code) === detectorId),
  );
  const diag_causes = diagRows.map((r) => r.cause_id);
  const diag_priced = diagRows
    .filter((r) => r.avoidable_u !== null || (r.standalone_u ?? 0) > 0)
    .map((r) => r.cause_id);

  const visible = (buckets.active ?? 0) + (buckets.limit_warnings ?? 0);
  let drop: string | null = null;
  if (st?.status !== "ACTIVE") drop = `detector pass: ${st?.status ?? "missing"}`;
  else if (recIds.length === 0) drop = "no rec row";
  else if (visible === 0 && diag_causes.length === 0)
    drop = absent > 0 ? "rec row not in /api/recommendations or Diagnostics" : "not visible";

  return {
    detector_id: detectorId,
    status: st?.status ?? "missing",
    note: st?.note ?? "",
    rec_rows: recIds.length,
    buckets,
    absent,
    titled,
    headline,
    sanity,
    money,
    diag_causes,
    diag_priced,
    diag_warnings,
    drop,
  };
}
