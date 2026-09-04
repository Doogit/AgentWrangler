import type { GlobalOverview } from "../../query/api/overview";
import type { RecommendationCard } from "../../query/api/recommendations";
import type { CacheWriteTrend } from "../../query/api/trends";
import type { HotSessionRow } from "../../query/spend";
import {
  type PromptArtifactFlavor,
  buildPromptArtifact,
} from "../recommendations/prompt-templates";
import { type FrictionBand, frictionBand } from "../sessions/FrictionCell";

const MICRO_USD_PER_USD = 1_000_000;
const MAX_HOT_SESSIONS = 5;
const MAX_ACTIONS = 3;

/** One window's raw feeds. `prior` deltas compare against a second window of the same shape. */
export interface BriefWindow {
  overview: GlobalOverview;
  hotSessions: HotSessionRow[];
  cacheTrend: CacheWriteTrend;
}

export interface BriefInput {
  scopeLabel: string;
  scopeWorkspaceId: string | null;
  overview: GlobalOverview;
  hotSessions: HotSessionRow[];
  cacheTrend: CacheWriteTrend;
  recs: RecommendationCard[];
  /** Prior 7-day window feeds; omitted (or empty) → deltas render "—". */
  prior?: BriefWindow;
}

/** A current value with an optional prior-window comparison. `prior`/`delta` null when the prior window is empty. */
export interface BriefDelta {
  current: number;
  prior: number | null;
  delta: number | null;
}

/** One-line verdict summary (no dollar headline beyond the cap-weighted equivalent). */
export interface BriefVerdict {
  cost_usd: number;
  hot_session_count: number;
  /** Worst per-session friction band across the scope's hot sessions; null when none. */
  peak_friction: FrictionBand | null;
}

export interface BriefSession {
  session_id: string;
  usd: number;
  turns: number;
  avg_context_tokens: number;
  model: string;
}

export interface BriefContextPerTurn {
  model: string;
  turns: number;
  avg_context_per_turn: number;
  avg_output_per_turn: number;
  usd_per_turn: number | null;
}

export interface BriefModelMix {
  model: string;
  turns: number;
}

export interface BriefCacheMix {
  bucket_count: number;
  spike_bucket_count: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  cache_read_share: number;
  turns: number;
}

export interface BriefLever {
  id: string;
  detector_id: string;
  lever: string;
  flavor: PromptArtifactFlavor;
  modeled_savings_usd_per_wk: number | null;
  prompt: string;
}

export interface Brief {
  scope: {
    label: string;
    workspace_id: string | null;
  };
  verdict: BriefVerdict;
  deltas: {
    spend_usd: BriefDelta;
    cache_write_share: BriefDelta;
    hot_session_count: BriefDelta;
  };
  /** Top-N recommendations in rank order — the "do these three things" list. */
  actions: BriefLever[];
  overview: {
    cost_usd: number;
    turns: number;
    turns_total: number;
  };
  attribution: {
    hot_sessions: BriefSession[];
    context_per_turn: BriefContextPerTurn[];
    model_mix: BriefModelMix[];
    cache_mix: BriefCacheMix;
  };
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function microUsdToUsd(value: number): number {
  return finite(value) / MICRO_USD_PER_USD;
}

function cacheWriteShare(trend: CacheWriteTrend): number {
  let write = 0;
  let read = 0;
  for (const bucket of trend.buckets) {
    write += finite(bucket.cache_creation_tokens);
    read += finite(bucket.cache_read_tokens);
  }
  const total = write + read;
  return total === 0 ? 0 : write / total;
}

function scopedHotSessions(
  rows: HotSessionRow[],
  scopeWorkspaceId: string | null,
): HotSessionRow[] {
  return rows.filter(
    (session) => scopeWorkspaceId === null || session.workspace_id === scopeWorkspaceId,
  );
}

const BAND_SEVERITY: Record<FrictionBand, number> = { LOW: 0, ELEVATED: 1, HIGH: 2 };

/** Worst per-session friction band across the scope's hot sessions (not an average). */
function peakFriction(rows: HotSessionRow[]): FrictionBand | null {
  if (rows.length === 0) return null;
  let worst: FrictionBand = "LOW";
  for (const session of rows) {
    const band = frictionBand({
      api_error_count: session.api_error_count,
      tool_error_count: session.tool_error_count,
      test_fail_count: session.test_fail_count,
      compaction_count: session.compaction_count,
      interrupt_count: session.interrupt_count,
      user_turn_count: session.user_turn_count,
      turn_count: session.turns,
    });
    if (BAND_SEVERITY[band] > BAND_SEVERITY[worst]) worst = band;
  }
  return worst;
}

function makeDelta(current: number, prior: number | null): BriefDelta {
  return { current, prior, delta: prior === null ? null : current - prior };
}

function compareHotSessions(a: HotSessionRow, b: HotSessionRow): number {
  return (
    finite(b.cost_equiv_u) - finite(a.cost_equiv_u) || a.session_id.localeCompare(b.session_id)
  );
}

function compareLevers(a: BriefLever, b: BriefLever): number {
  const flavorOrder = Number(a.flavor !== "TURNKEY") - Number(b.flavor !== "TURNKEY");
  const aSavings = a.modeled_savings_usd_per_wk ?? Number.NEGATIVE_INFINITY;
  const bSavings = b.modeled_savings_usd_per_wk ?? Number.NEGATIVE_INFINITY;
  return (
    flavorOrder ||
    bSavings - aSavings ||
    a.detector_id.localeCompare(b.detector_id) ||
    a.id.localeCompare(b.id)
  );
}

/** Builds a pure, already-fetched-data brief suitable for browser rendering or export. */
export function buildBrief(input: BriefInput): Brief {
  const hotSessions = input.hotSessions
    .filter(
      (session) =>
        input.scopeWorkspaceId === null || session.workspace_id === input.scopeWorkspaceId,
    )
    .slice()
    .sort(compareHotSessions)
    .slice(0, MAX_HOT_SESSIONS)
    .map((session) => ({
      session_id: session.session_id,
      usd: microUsdToUsd(session.cost_equiv_u),
      turns: finite(session.turns),
      avg_context_tokens: finite(session.avg_context_tokens),
      model: session.model,
    }));

  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let cacheTurns = 0;
  for (const bucket of input.cacheTrend.buckets) {
    cacheWriteTokens += finite(bucket.cache_creation_tokens);
    cacheReadTokens += finite(bucket.cache_read_tokens);
    cacheTurns += finite(bucket.turns);
  }
  const cacheTotalTokens = cacheWriteTokens + cacheReadTokens;

  const levers = input.recs
    .map((rec) => {
      const artifact = buildPromptArtifact(rec);
      if (artifact === null) return null;
      return {
        id: rec.rec_id,
        detector_id: rec.detector_id,
        lever: rec.lever,
        flavor: artifact.flavor,
        modeled_savings_usd_per_wk:
          rec.modeled_savings_u_per_wk === null
            ? null
            : microUsdToUsd(rec.modeled_savings_u_per_wk),
        prompt: artifact.text,
      };
    })
    .filter((lever): lever is BriefLever => lever !== null)
    .sort(compareLevers);

  const scopedCurrent = scopedHotSessions(input.hotSessions, input.scopeWorkspaceId);
  // "Empty prior window" (no reconciled or provisional turns) → deltas render "—",
  // never a misleading +100% jump off a zero baseline.
  const priorWindow =
    input.prior !== undefined && finite(input.prior.overview.turns_total) > 0 ? input.prior : null;

  return {
    scope: {
      label: input.scopeLabel,
      workspace_id: input.scopeWorkspaceId,
    },
    verdict: {
      cost_usd: microUsdToUsd(input.overview.cost_equiv_u),
      hot_session_count: scopedCurrent.length,
      peak_friction: peakFriction(scopedCurrent),
    },
    deltas: {
      spend_usd: makeDelta(
        microUsdToUsd(input.overview.cost_equiv_u),
        priorWindow === null ? null : microUsdToUsd(priorWindow.overview.cost_equiv_u),
      ),
      cache_write_share: makeDelta(
        cacheWriteShare(input.cacheTrend),
        priorWindow === null ? null : cacheWriteShare(priorWindow.cacheTrend),
      ),
      hot_session_count: makeDelta(
        scopedCurrent.length,
        priorWindow === null
          ? null
          : scopedHotSessions(priorWindow.hotSessions, input.scopeWorkspaceId).length,
      ),
    },
    actions: levers.slice(0, MAX_ACTIONS),
    overview: {
      cost_usd: microUsdToUsd(input.overview.cost_equiv_u),
      turns: finite(input.overview.turns),
      turns_total: finite(input.overview.turns_total),
    },
    attribution: {
      hot_sessions: hotSessions,
      context_per_turn: input.overview.context_per_turn.map((row) => ({
        model: row.model,
        turns: finite(row.n),
        avg_context_per_turn: finite(row.avg_context_per_turn),
        avg_output_per_turn: finite(row.avg_output_per_turn),
        // usd_per_turn already arrives in USD (SUM(cost_equiv_u)/COUNT/1e6) — do NOT re-divide.
        usd_per_turn: row.usd_per_turn === null ? null : finite(row.usd_per_turn),
      })),
      model_mix: input.overview.model_mix.map((row) => ({
        model: row.model,
        turns: finite(row.turns),
      })),
      cache_mix: {
        bucket_count: input.cacheTrend.buckets.length,
        spike_bucket_count: input.cacheTrend.spike_buckets.length,
        cache_write_tokens: cacheWriteTokens,
        cache_read_tokens: cacheReadTokens,
        cache_read_share: cacheTotalTokens === 0 ? 0 : cacheReadTokens / cacheTotalTokens,
        turns: cacheTurns,
      },
    },
  };
}

function numberText(value: number): string {
  return finite(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/** Renders a prior-window comparison as "prior X, delta Y" (or "—" when absent). */
function deltaText(delta: BriefDelta): string {
  const prior = delta.prior === null ? "—" : numberText(delta.prior);
  const change = delta.delta === null ? "—" : numberText(delta.delta);
  return `${numberText(delta.current)} (prior ${prior}, delta ${change})`;
}

/** Serializes a brief with list anchors on every body line for SEC-101 parity. */
export function briefToMarkdown(brief: Brief): string {
  const lines = [
    `# Brief: ${brief.scope.label}`,
    "",
    "## Verdict",
    `- Cost equivalent USD: ${numberText(brief.verdict.cost_usd)}`,
    `- Hot sessions: ${numberText(brief.verdict.hot_session_count)}`,
    `- Peak friction: ${brief.verdict.peak_friction ?? "none"}`,
    "",
    "## Change vs prior 7 days",
    `- Spend equivalent USD: ${deltaText(brief.deltas.spend_usd)}`,
    `- Cache-write share: ${deltaText(brief.deltas.cache_write_share)}`,
    `- Hot sessions: ${deltaText(brief.deltas.hot_session_count)}`,
    "",
    "## Do these three things",
    `- Actions: ${numberText(brief.actions.length)}`,
  ];

  brief.actions.forEach((action, index) => {
    lines.push(`### ${index + 1}. ${action.detector_id}: ${action.id}`);
    lines.push(`- Lever: ${action.lever}`);
    lines.push(`- Mode: ${action.flavor}`);
    lines.push(
      `- Modeled savings USD/week: ${action.modeled_savings_usd_per_wk === null ? "0" : numberText(action.modeled_savings_usd_per_wk)}`,
    );
    lines.push("- Prompt artifact:");
    lines.push(action.prompt);
  });

  lines.push(
    "",
    "<details>",
    "",
    "## Attribution",
    `- Hot sessions: ${numberText(brief.attribution.hot_sessions.length)}`,
    ...brief.attribution.hot_sessions.map(
      (session) =>
        `- Session ${session.session_id}: USD ${numberText(session.usd)}, turns ${numberText(session.turns)}, context ${numberText(session.avg_context_tokens)}, model ${session.model}`,
    ),
    `- Context models: ${numberText(brief.attribution.context_per_turn.length)}`,
    ...brief.attribution.context_per_turn.map((row) => {
      const usd =
        row.usd_per_turn === null ? "unpriced 0" : `USD/turn ${numberText(row.usd_per_turn)}`;
      return `- Model ${row.model}: turns ${numberText(row.turns)}, context/turn ${numberText(row.avg_context_per_turn)}, output/turn ${numberText(row.avg_output_per_turn)}, ${usd}`;
    }),
    `- Model mix entries: ${numberText(brief.attribution.model_mix.length)}`,
    ...brief.attribution.model_mix.map(
      (row) => `- Model mix ${row.model}: turns ${numberText(row.turns)}`,
    ),
    `- Cache mix: ${numberText(brief.attribution.cache_mix.bucket_count)} buckets, ${numberText(brief.attribution.cache_mix.spike_bucket_count)} spikes, ${numberText(brief.attribution.cache_mix.cache_write_tokens)} write tokens, ${numberText(brief.attribution.cache_mix.cache_read_tokens)} read tokens, ${numberText(brief.attribution.cache_mix.cache_read_share)} read share, ${numberText(brief.attribution.cache_mix.turns)} turns`,
    "",
    "</details>",
  );

  return lines.join("\n");
}
