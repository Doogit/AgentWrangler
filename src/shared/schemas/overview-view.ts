/**
 * src/shared/schemas/overview-view.ts — P1-U1 Overview section contract.
 *
 * One zod schema per Overview section, validating that section's `data` (today
 * the legacy endpoint's payload; P1-U2 serves the same values as
 * `sections.<name>.data`). Imported by the UI (`safeSection`) and by the daemon
 * contract test, which runs real seed output through every schema.
 *
 * Additive-tolerant: objects are loose (unknown fields pass through), fields a
 * newer daemon adds are optional, and a missing or wrongly typed field that the
 * Overview reads makes only that section an error. Open-ended enums are plain
 * strings so a new value never fails a section.
 *
 * `zod/mini`, not `zod`: full zod measured 28 KB gz for these schemas, over the
 * plan's M10 bar of +15 KB gz (P1-U1).
 */

import * as z from "zod/mini";

const num = z.number();
const nullableNum = z.nullable(z.number());
const nullableStr = z.nullable(z.string());
const rows = z.array(z.looseObject({}));

// ── kpis: GET /api/overview `data` ─────────────────────────────────────────

const subagentSpend = z.looseObject({
  total_cost_u: num,
  sidechain_cost_u: num,
  share: num,
  sessions_with_sidechain_spend: num,
  sessions_in_window: num,
  haiku_sidechain_turns: num,
  by_model_family: z.array(z.looseObject({ family: z.string(), cost_u: num })),
});

const kpis = z.looseObject({
  cost_equiv_u: num,
  turns: num,
  turns_total: num,
  unpriced_turns: num,
  live_sessions: num,
  forecast: z.looseObject({}),
  context_per_turn: z.array(
    z.looseObject({
      model: z.string(),
      n: num,
      avg_context_per_turn: num,
      avg_output_per_turn: num,
      usd_per_turn: nullableNum,
    }),
  ),
  model_mix: z.array(z.looseObject({ model: z.string(), turns: num })),
  subagent_spend: z.optional(subagentSpend),
});

// ── workspaces / live: PagedList rows ──────────────────────────────────────

const workspaceLabel = {
  workspace_id: z.string(),
  project_slug: z.string(),
  repo_path: nullableStr,
  repo_owner: nullableStr,
  repo_name: nullableStr,
};

const workspaces = z.looseObject({
  items: z.array(
    z.looseObject({
      ...workspaceLabel,
      cost_equiv_u: num,
      turns: num,
      cost_share: num,
      has_live: z.boolean(),
      usd_per_turn: nullableNum,
    }),
  ),
  next_cursor: nullableStr,
});

const live = z.looseObject({
  items: z.array(
    z.looseObject({
      ...workspaceLabel,
      session_id: z.string(),
      running_usd_u: num,
      current_context_tokens: num,
      model: z.string(),
      started_at: nullableStr,
    }),
  ),
  next_cursor: nullableStr,
});

// ── trends / trends_prior: GET /api/trends `data` ──────────────────────────

const trends = z.looseObject({
  bucket: z.string(),
  buckets: z.array(z.looseObject({ bucket: z.string(), cost_equiv_u: num, turns: num })),
  by_model: z.array(
    z.looseObject({ bucket: z.string(), model: z.string(), cost_equiv_u: num, turns: num }),
  ),
  by_workspace: z.array(
    z.looseObject({
      bucket: z.string(),
      workspace_id: z.string(),
      project_slug: z.string(),
      cost_equiv_u: num,
      turns: num,
    }),
  ),
  sessions: rows,
  cap_weighted: rows,
  cap_read_coeff: num,
  adoption_markers: rows,
});

// ── flavor: GET /api/overview/flavor `data` ────────────────────────────────

const flavor = z.looseObject({
  flavors: z.array(
    z.looseObject({
      flavor: z.string(),
      label: z.string(),
      weight: num,
      raw_tokens: num,
      weighted_tokens: num,
      weighted_share: num,
      raw_share: num,
    }),
  ),
  total_raw_tokens: num,
  total_weighted_tokens: num,
  cache_efficiency_ratio: nullableNum,
  cache_read_share: nullableNum,
  cache_read_tokens: num,
  cache_creation_tokens: num,
  reuse_band: z.string(),
  cap_weighted_tokens: num,
  coeff_used: num,
});

// ── cache_write: GET /api/trends/cache-write `data` ────────────────────────

const cacheWrite = z.looseObject({
  buckets: z.array(
    z.looseObject({
      bucket: z.string(),
      cache_creation_tokens: num,
      cache_read_tokens: num,
      efficiency_ratio: nullableNum,
      turns: num,
    }),
  ),
  spike_buckets: z.array(z.string()),
});

// ── weekly_sessions: top 5 of GET /api/hot-sessions?preset=7d + 7d cost ────

const weeklySessions = z.looseObject({
  rows: z.array(
    z.looseObject({
      session_id: z.string(),
      workspace_id: z.string(),
      title: z.optional(nullableStr),
      repo_owner: z.optional(nullableStr),
      repo_name: z.optional(nullableStr),
      turns: num,
      cost_equiv_u: num,
      avg_context_tokens: num,
      max_context_tokens: num,
      model: z.string(),
    }),
  ),
  cost_equiv_u: num,
});

// ── status: GET /api/status (not enveloped) ────────────────────────────────

const status = z.looseObject({
  sessions: num,
  files_seen: num,
  files_parsed: num,
  scan_state: z.optional(z.string()),
  lines_quarantined: z.optional(num),
  invalid_scan_root_count: z.optional(num),
  pipeline: z.optional(z.looseObject({ phase: z.string() })),
  loop_lag: z.optional(z.looseObject({ p50: num, p99: num, max: num })),
  // P2-U2 change counters (optional: an older daemon or fixture omits them).
  data_version: z.optional(num),
  data_scopes: z.optional(
    z.looseObject({ live: num, ingest: num, detectors: num, lifecycle: num, clock: z.string() }),
  ),
  // P2-U4 slice-loop coverage (optional: absent until the slice loop plans its slices).
  history_coverage: z.optional(
    z.looseObject({
      weeks_done: num,
      weeks_total: num,
      complete_through_ms: z.nullable(num),
      oldest_complete_day: z.nullable(z.string()),
      partial_week: z.boolean(),
    }),
  ),
});

// ── top_recs: the recs snapshot's active / adopted cards ───────────────────

const recCard = z.looseObject({
  rec_id: z.string(),
  detector_id: z.string(),
  category: z.string(),
  scope_workspace_id: nullableStr,
  lever: z.string(),
  state: z.string(),
  title: z.optional(z.string()),
  modeled_savings_u_per_wk: nullableNum,
  allocated_u_per_wk: z.optional(nullableNum),
  range_u_per_wk: z.optional(z.nullable(z.tuple([num, num]))),
});

const topRecs = z.looseObject({
  active: z.array(recCard),
  adopted: z.array(recCard),
  active_groups: z.optional(rows),
});

// ── linkage: GET /api/outcomes/linkage `data` ──────────────────────────────

const linkage = z.looseObject({
  linkage_rate: nullableNum,
  denominator_n: num,
  methodology_note: z.string(),
});

// ── hook_config: GET /api/hook-config `data` ───────────────────────────────

const hookConfig = z.looseObject({
  installed: z.boolean(),
  context_window: num,
  soft_pct: num,
  hard_pct: num,
  stale_s: num,
  d7_fail_count: num,
  d7_window_turns: num,
  d9_idle_seconds: num,
});

export const overviewSectionSchemas = {
  kpis,
  workspaces,
  trends,
  trends_prior: trends,
  flavor,
  cache_write: cacheWrite,
  weekly_sessions: weeklySessions,
  live,
  status,
  top_recs: topRecs,
  linkage,
  hook_config: hookConfig,
};

export type OverviewSectionName = keyof typeof overviewSectionSchemas;

export type OverviewSectionData<K extends OverviewSectionName> = z.output<
  (typeof overviewSectionSchemas)[K]
>;
