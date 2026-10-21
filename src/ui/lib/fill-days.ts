/**
 * src/ui/lib/fill-days.ts — zero-fill missing days in a daily-bucket series (OV-12 Q7).
 *
 * /api/trends returns only days that have turns, so a quiet day would vanish from the chart.
 * The fill lives in the UI (plan E1) so the trends contract and its other consumers are unchanged.
 */

type Preset = "24h" | "7d" | "30d" | "all";

export const PRESET_DAYS: Record<Exclude<Preset, "all">, number> = { "24h": 1, "7d": 7, "30d": 30 };

/** Local YYYY-MM-DD, matching SQLite date(ts,'localtime') (daemon and browser share a machine). */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Every calendar day from the window start (now − days, same ms subtraction as the server;
 * "all" starts at the earliest bucket) through today, plus any server bucket outside that
 * range, sorted; a missing day → zero(day). Empty input stays empty so callers keep their
 * "no spend" state.
 */
export function fillDailyBuckets<T extends { bucket: string }>(
  rows: T[],
  preset: Preset,
  now: Date,
  zero: (day: string) => T,
): T[] {
  if (rows.length === 0) return [];
  const byDay = new Map(rows.map((r) => [r.bucket, r]));
  const first = [...byDay.keys()].sort()[0] as string;
  const start =
    preset === "all"
      ? new Date(
          Number(first.slice(0, 4)),
          Number(first.slice(5, 7)) - 1,
          Number(first.slice(8, 10)),
        )
      : new Date(now.getTime() - PRESET_DAYS[preset] * 86_400_000);
  const today = localDay(now);
  // Step by calendar date (not +24h) so a DST change never skips or repeats a day.
  for (
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    localDay(d) <= today;
    d.setDate(d.getDate() + 1)
  ) {
    const key = localDay(d);
    if (!byDay.has(key)) byDay.set(key, zero(key));
  }
  return [...byDay.keys()].sort().map((k) => byDay.get(k) as T);
}
