/**
 * src/query/limits/weight-fit.ts — OV-12 U5 (D6): does the weekly limit count models by list price?
 *
 * Each reading k says: Σ_f m_f · spend_f,k ÷ used%_k = C (the same cap every week). Solve for one
 * multiplier m_f per family (least squares, Sonnet fixed at 1 as the reference) and the cap C.
 * m_f = 1 means list prices are right for that family. Diagnostic only: nothing else reads it.
 */

import { LIST_PRICES, REF_PRICE_U_PER_TOKEN } from "../../ingest/pricing.js";
import type { WeightFit, WeightFitFamily } from "./types.js";

export interface FitSample {
  week: string; // the reading's limit week (any stable key)
  usedPct: number;
  spendByFamilyU: Partial<Record<string, number>>;
}

const FAMILIES = ["Opus", "Sonnet", "Fable", "Haiku"] as const;
type Family = (typeof FAMILIES)[number];
const MIN_READINGS = 6;
const MIN_WEEKS = 3;
/** A family whose spend share moves this much between readings makes the mix "varied". */
const VARIED_SHARE = 0.15;
/** A family under this share of all spend is too small to fit. */
const MIN_SHARE = 0.05;

/** Input list price ÷ Sonnet 5 input, lowest–highest across the family's versions. */
function listWeight(f: Family): [number, number] {
  const w = Object.entries(LIST_PRICES)
    .filter(([k]) => k.startsWith(f.toLowerCase()))
    .map(([, p]) => p[0] / REF_PRICE_U_PER_TOKEN);
  return [Math.min(...w), Math.max(...w)];
}

/**
 * Solve the square system a·x = b (Gaussian elimination, partial pivot). Null when singular or
 * nearly so — each pivot must stay above a floor scaled to its own column, since columns differ
 * by ~1e14 (spend ÷ % vs the constant's 1s).
 */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] ?? 0]);
  const at = (r: number, c: number) => m[r]?.[c] ?? 0;
  const floor = Array.from(
    { length: n },
    (_, c) => Math.max(...a.map((row) => Math.abs(row[c] ?? 0))) * 1e-9,
  );
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(at(r, c)) > Math.abs(at(p, c))) p = r;
    if (!(Math.abs(at(p, c)) > (floor[c] ?? 0))) return null;
    [m[c], m[p]] = [m[p] ?? [], m[c] ?? []];
    const pivot = m[c] ?? [];
    for (let r = 0; r < n; r++) {
      const row = m[r];
      if (r === c || row === undefined) continue;
      const k = (row[c] ?? 0) / (pivot[c] ?? 1);
      for (let j = c; j <= n; j++) row[j] = (row[j] ?? 0) - k * (pivot[j] ?? 0);
    }
  }
  return m.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
}

/** Largest |x − mean| as a % of the mean. */
function spreadPct(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return mean > 0 ? (Math.max(...xs.map((x) => Math.abs(x - mean))) / mean) * 100 : null;
}

export function fitWeights(samples: FitSample[]): WeightFit {
  const spend = (s: FitSample, f: string) => s.spendByFamilyU[f] ?? 0;
  const total = (s: FitSample) =>
    Object.values(s.spendByFamilyU).reduce<number>((a, u) => a + (u ?? 0), 0);
  const weeks = new Set(samples.map((s) => s.week)).size;
  const grand = samples.reduce((a, s) => a + total(s), 0);
  const share = (f: Family) =>
    grand > 0 ? samples.reduce((a, s) => a + spend(s, f), 0) / grand : 0;
  const variedMix = FAMILIES.some((f) => {
    const shares = samples.map((s) => (total(s) > 0 ? spend(s, f) / total(s) : 0));
    return shares.length > 0 && Math.max(...shares) - Math.min(...shares) >= VARIED_SHARE;
  });
  const fitted = FAMILIES.filter((f) => f !== "Sonnet" && share(f) >= MIN_SHARE);
  const ready =
    samples.length >= MIN_READINGS &&
    weeks >= MIN_WEEKS &&
    variedMix &&
    share("Sonnet") >= MIN_SHARE;

  // Unknowns: m_f for each fitted family, then C. Row k: Σ m_f x_f,k − C = −(fixed spend)_k, x = spend ÷ %.
  let mult: Map<Family, number> | null = null;
  if (ready) {
    const rows = samples.map((s) => {
      const x = (u: number) => u / s.usedPct;
      const fixed = total(s) - fitted.reduce((a, f) => a + spend(s, f), 0);
      return { a: [...fitted.map((f) => x(spend(s, f))), -1], b: -x(fixed) };
    });
    const n = fitted.length + 1;
    const a = (r: { a: number[] }, i: number) => r.a[i] ?? 0;
    const ata = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => rows.reduce((s, r) => s + a(r, i) * a(r, j), 0)),
    );
    const atb = Array.from({ length: n }, (_, i) => rows.reduce((s, r) => s + a(r, i) * r.b, 0));
    const x = solve(ata, atb);
    if (x !== null) mult = new Map(fitted.map((f, i) => [f, x[i] as number]));
  }

  const capAt = (s: FitSample, m: (f: string) => number) =>
    Object.keys(s.spendByFamilyU).reduce((a, f) => a + m(f) * spend(s, f), 0) / s.usedPct;
  const families: WeightFitFamily[] = FAMILIES.map((f) => ({
    family: f,
    listWeight: listWeight(f),
    multiplier: f === "Sonnet" ? 1 : (mult?.get(f) ?? null),
    status: f === "Sonnet" ? "reference" : fitted.includes(f) ? "fitted" : "too-little-use",
  }));
  return {
    readings: samples.length,
    weeks,
    variedMix,
    ready: ready && mult !== null,
    families,
    spreadListPct: spreadPct(samples.map((s) => capAt(s, () => 1))),
    spreadFittedPct:
      mult === null
        ? null
        : spreadPct(samples.map((s) => capAt(s, (f) => mult?.get(f as Family) ?? 1))),
  };
}
