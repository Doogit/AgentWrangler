/**
 * DH3 grader: compares an oracle's per-workspace figure with the live cards' figure for the same detector,
 * plus the price and raw-JSONL legs. Tolerance ±3% on $ (tokens ±2% + price ±1%), exact on counts.
 * Net-$ cards: `net` (the card headline) is the ledger's overlap-removed share and is graded by ledger-sql,
 * not here; the report only shows net/modeled.
 */

import type Database from "better-sqlite3";
import type { PipelineTrace } from "../pipeline.js";
import { priceCrossCheck } from "./price.js";
import { rawCheck } from "./raw-check.js";
import type { OracleFigure, OracleResult } from "./types.js";

export const DOLLAR_TOLERANCE = 0.03;
export const PRICE_TOLERANCE = 0.01;
export const RAW_SAMPLE = 50;

export interface WsGrade {
  /** null = global. Callers scrub before printing. */
  workspace_id: string | null;
  /** Rec scope key when the row is a per-scope grade of global findings (e.g. C1 per tool); else null. */
  scope: string | null;
  oracle: number | null;
  card: number | null;
  /** (card - oracle) / oracle; null when a side is absent or the oracle is 0. */
  signed_err: number | null;
  /** Card headline / card modeled for net-$ cards (the ledger's overlap-removed share). */
  net_over_modeled: number | null;
  verdict: "ok" | "miss" | "extra" | "off";
}

export interface OracleGrade {
  verdict: string;
  /** Mean signed error over workspaces present on both sides; null when none. */
  mean_signed_err: number | null;
  per_ws: WsGrade[];
  price: { n: number; max_rel_diff: number; mean_signed_rel_diff: number };
  raw: { sampled: number; matched: number; available: number };
  assumption_bound: boolean;
}

function sumBy(entries: Array<[string | null, number | null]>): Map<string | null, number> {
  const m = new Map<string | null, number>();
  for (const [k, v] of entries) if (v !== null) m.set(k, (m.get(k) ?? 0) + v);
  return m;
}

const pct = (x: number, d = 1): string => `${(x * 100).toFixed(d)}%`;

/** Oracle quantity name → card evidence metric; exact. B2 and B4 expose these beside their headline. */
const SECONDARY_EXACT: Array<[string, string]> = [
  ["previous_cache_read_tokens", "PREVIOUS_CACHE_READ_TOKENS"],
  ["current_cache_read_tokens", "CURRENT_CACHE_READ_TOKENS"],
  ["current_cache_creation_tokens", "CURRENT_CACHE_CREATION_TOKENS"],
  ["break_creation_tokens", "CURRENT_CACHE_CREATION_TOKENS"],
  ["longest_gap_ms", "GAP_DURATION_MS"],
  ["longest_gap_ttl_ms", "CONSERVATIVE_TTL_DURATION_MS"],
];
/** Oracle `measured_u` ↔ card metric, ±DOLLAR_TOLERANCE (B4's rewrite cost). */
const SECONDARY_COST = "REWRITE_COST_U";

/** Secondary checks per workspace, only where both the oracle finding and the card carry the field. */
function secondaryFails(result: OracleResult, trace: PipelineTrace, per_ws: WsGrade[]): string[] {
  const out: string[] = [];
  for (const f of result.findings) {
    const ws = f.scope.workspace_id;
    const rows = trace.money.filter((m) => (m.scope_workspace_id ?? null) === ws && m.metrics);
    const n = per_ws.findIndex((w) => w.workspace_id === ws) + 1;
    const cardSum = (metric: string): number | null => {
      const vals = rows.flatMap((m) =>
        m.metrics?.[metric] === undefined ? [] : [m.metrics[metric]],
      );
      return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
    };
    for (const [q, metric] of SECONDARY_EXACT) {
      const o = f.quantities.find((x) => x.name === q)?.value;
      const c = cardSum(metric);
      if (o !== undefined && c !== null && o !== c)
        out.push(`workspace #${n} ${metric} oracle ${o} card ${c} (exact)`);
    }
    const cost = cardSum(SECONDARY_COST);
    if (f.measured_u !== null && f.measured_u !== 0 && cost !== null) {
      const err = (cost - f.measured_u) / f.measured_u;
      if (Math.abs(err) > DOLLAR_TOLERANCE)
        out.push(
          `workspace #${n} ${SECONDARY_COST} err ${pct(err)} outside ±${pct(DOLLAR_TOLERANCE, 0)}`,
        );
    }
  }
  return out;
}

export function gradeOracle(
  result: OracleResult,
  trace: PipelineTrace,
  figure: OracleFigure,
  db: Database.Database,
): OracleGrade {
  const assumption_bound = result.findings.some((f) => f.assumptions.length > 0);
  const price = priceCrossCheck(db, result.turns_checked);
  const available = new Set(result.turns_checked).size;
  let raw = rawCheck(db, result.turns_checked, RAW_SAMPLE);
  // A deleted transcript file is a data gap, not a mismatch: widen the sample once to reach 50 found turns.
  if (raw.sampled < RAW_SAMPLE && raw.missing_file + raw.missing_line > 0)
    raw = rawCheck(
      db,
      result.turns_checked,
      Math.min(available, RAW_SAMPLE + 2 * (raw.missing_file + raw.missing_line)),
    );
  const fails: string[] = [];

  // Global findings (workspace null) that carry per-rec scope keys (C1: one rec per tool) are
  // graded per scope key (only when every oracle key is a card's key, as D1/D5 keys differ); otherwise per workspace.
  const cardKeys = new Set(trace.money.map((m) => m.scope_key));
  const byScope =
    result.findings.length > 0 &&
    result.findings.every((f) => f.scope.workspace_id === null && cardKeys.has(f.scope.key)) &&
    trace.money.every((m) => m.scope_key != null);
  const oKey = (f: OracleResult["findings"][number]): string | null =>
    byScope ? f.scope.key : f.scope.workspace_id;
  const cKey = (m: PipelineTrace["money"][number]): string | null =>
    byScope ? (m.scope_key ?? null) : (m.scope_workspace_id ?? null);
  const exactFigure = figure === "count" || figure === "presence";

  // Oracle side, per key.
  const oracleBy = sumBy(
    result.findings.map((f) => [
      oKey(f),
      figure === "count" ? (f.count ?? null) : figure === "presence" ? 1 : f.modeled_u,
    ]),
  );
  // Card side, per key.
  const cardBy = sumBy(
    trace.money.map((m) => [
      cKey(m),
      figure === "count"
        ? (m.count ?? 1)
        : figure === "presence"
          ? 1
          : figure === "reliability"
            ? m.reliability
            : figure === "headline"
              ? m.headline
              : m.modeled,
    ]),
  );
  const countFallback = figure === "count" && trace.money.some((m) => m.count == null);
  const netBy = sumBy(trace.money.map((m) => [cKey(m), m.headline]));
  const modeledBy = sumBy(trace.money.map((m) => [cKey(m), m.modeled]));

  const per_ws: WsGrade[] = [];
  const keys = new Set<string | null>([...oracleBy.keys(), ...cardBy.keys()]);
  for (const ws of keys) {
    const o = oracleBy.get(ws) ?? null;
    const c = cardBy.get(ws) ?? null;
    const net = netBy.get(ws);
    const modeledSum = modeledBy.get(ws);
    const net_over_modeled =
      figure === "modeled" && net !== undefined && modeledSum ? net / modeledSum : null;
    let verdict: WsGrade["verdict"] = "ok";
    let signed_err: number | null = null;
    if ((o ?? 0) === 0 && (c ?? 0) === 0) {
      verdict = "ok";
    } else if (o === null || o === 0) {
      verdict = "extra";
    } else if (c === null) {
      verdict = "miss";
    } else {
      signed_err = (c - o) / o;
      const tol = exactFigure ? 0 : DOLLAR_TOLERANCE;
      verdict = Math.abs(signed_err) <= tol ? "ok" : "off";
    }
    per_ws.push({
      workspace_id: byScope ? null : ws,
      scope: byScope ? ws : null,
      oracle: o,
      card: c,
      signed_err,
      net_over_modeled,
      verdict,
    });
  }
  const sortKey = (w: WsGrade): string => w.workspace_id ?? w.scope ?? "";
  per_ws.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  const bad = per_ws.filter((w) => w.verdict !== "ok");
  const compared = per_ws.filter((w) => w.signed_err !== null);
  const mean_signed_err =
    compared.length > 0
      ? compared.reduce((s, w) => s + (w.signed_err as number), 0) / compared.length
      : null;

  const inactive = trace.status !== "ACTIVE";
  const silent = result.findings.length === 0 && per_ws.every((w) => (w.oracle ?? 0) === 0);
  if (inactive && silent) {
    return {
      verdict: "PASS (silent, 0 findings)",
      mean_signed_err: null,
      per_ws,
      price,
      raw: { sampled: raw.sampled, matched: raw.matched, available },
      assumption_bound,
    };
  }

  const tolText = exactFigure ? "exact" : `±${pct(DOLLAR_TOLERANCE, 0)}`;
  if (!byScope) fails.push(...secondaryFails(result, trace, per_ws));
  for (const w of bad) {
    const n = per_ws.indexOf(w) + 1;
    if (w.verdict === "miss") fails.push(`miss: oracle has workspace #${n}, no card`);
    else if (w.verdict === "extra") fails.push(`extra: card has workspace #${n}, oracle 0/none`);
    else
      fails.push(
        `workspace #${n} err ${(w.signed_err as number) >= 0 ? "+" : "-"}${pct(Math.abs(w.signed_err as number))} outside ${tolText}`,
      );
  }
  if (price.max_rel_diff > PRICE_TOLERANCE)
    fails.push(`price leg Δ ${pct(price.max_rel_diff, 2)} > ${pct(PRICE_TOLERANCE, 0)}`);
  if (raw.mismatches.length > 0)
    fails.push(`raw mismatch ${raw.mismatches.map((m) => `${m.field}×${m.count}`).join(", ")}`);
  if (available >= RAW_SAMPLE && raw.sampled < RAW_SAMPLE)
    fails.push(
      `raw sampled ${raw.sampled}/${RAW_SAMPLE} (${raw.missing_file} missing file, ${raw.missing_line} missing line)`,
    );
  if (fails.length > 0) {
    return {
      verdict: `FAIL (${fails.join("; ")})`,
      mean_signed_err,
      per_ws,
      price,
      raw: { sampled: raw.sampled, matched: raw.matched, available },
      assumption_bound,
    };
  }
  const rawText =
    available >= RAW_SAMPLE ? `raw ${raw.matched}/${raw.sampled}` : `raw n=${raw.sampled}`;
  const parts = [
    `${per_ws.length} ws`,
    `mean err ${mean_signed_err === null ? "n/a" : `${mean_signed_err >= 0 ? "+" : "-"}${pct(Math.abs(mean_signed_err))}`}`,
    rawText,
    `price Δ≤${pct(price.max_rel_diff, 2)}`,
  ];
  if (figure === "presence") parts.push("pair count not graded: stored evidence lacks it");
  if (countFallback) parts.push("count vs visible cards per ws");
  if (raw.missing_file > 0) parts.push(`${raw.missing_file} raw file(s) missing`);
  if (assumption_bound) parts.push("assumption-bound");
  return {
    verdict: `PASS (${parts.join(", ")})`,
    mean_signed_err,
    per_ws,
    price,
    raw: { sampled: raw.sampled, matched: raw.matched, available },
    assumption_bound,
  };
}
