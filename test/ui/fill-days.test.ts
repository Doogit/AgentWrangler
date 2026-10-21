/**
 * OV-12 U3a: fillDailyBuckets — zero-fill missing calendar days in a rolling preset window,
 * matching /api/trends' day buckets (local YYYY-MM-DD, rolling 7d spans 8 calendar days).
 */
import { describe, expect, it } from "vitest";
import { fillDailyBuckets } from "../../src/ui/lib/fill-days.js";

type Row = { bucket: string; v: number };
const zero = (day: string): Row => ({ bucket: day, v: 0 });
const day = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** Local calendar days from `start` through `end`, inclusive. */
function days(start: Date, end: Date): string[] {
  const out: string[] = [];
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  while (day(d) <= day(end)) {
    out.push(day(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

describe("fillDailyBuckets", () => {
  it("30d with 3 missing days → 31 rows, the 3 gaps are zero, others unchanged", () => {
    const now = new Date(2026, 9, 3, 12, 0); // 2026-10-03 12:00 local
    const all = days(new Date(now.getTime() - 30 * 86_400_000), now);
    expect(all).toHaveLength(31);
    const missing = new Set(["2026-09-05", "2026-09-16", "2026-09-20"]);
    const rows = all.filter((d) => !missing.has(d)).map((d, i) => ({ bucket: d, v: i + 1 }));
    const out = fillDailyBuckets(rows, "30d", now, zero);
    expect(out.map((r) => r.bucket)).toEqual(all);
    for (const r of out) {
      if (missing.has(r.bucket)) expect(r.v).toBe(0);
      else expect(r).toBe(rows.find((x) => x.bucket === r.bucket));
    }
  });

  it("7d with no gaps → same rows (8 calendar days)", () => {
    const now = new Date(2026, 9, 3, 18, 26);
    const rows = days(new Date(now.getTime() - 7 * 86_400_000), now).map((d) => ({
      bucket: d,
      v: 1,
    }));
    expect(rows[0]?.bucket).toBe("2026-09-26");
    expect(fillDailyBuckets(rows, "7d", now, zero)).toEqual(rows);
  });

  it("empty input stays empty (keeps the empty state)", () => {
    expect(fillDailyBuckets([], "30d", new Date(2026, 9, 3), zero)).toEqual([]);
  });

  it("24h at 10:00 with only today's bucket → yesterday's zero row added", () => {
    const now = new Date(2026, 9, 3, 10, 0);
    const out = fillDailyBuckets([{ bucket: "2026-10-03", v: 5 }], "24h", now, zero);
    expect(out).toEqual([
      { bucket: "2026-10-02", v: 0 },
      { bucket: "2026-10-03", v: 5 },
    ]);
  });

  it("keeps a server bucket the client didn't expect", () => {
    const now = new Date(2026, 9, 3, 10, 0);
    const out = fillDailyBuckets(
      [
        { bucket: "2026-10-03", v: 5 },
        { bucket: "2026-10-04", v: 1 },
      ],
      "24h",
      now,
      zero,
    );
    expect(out.map((r) => r.bucket)).toEqual(["2026-10-02", "2026-10-03", "2026-10-04"]);
  });

  it("all starts at the earliest server bucket, not a fixed span", () => {
    const now = new Date(2026, 9, 3, 10, 0);
    const out = fillDailyBuckets(
      [
        { bucket: "2026-10-03", v: 5 },
        { bucket: "2026-09-29", v: 2 },
      ],
      "all",
      now,
      zero,
    );
    expect(out).toEqual([
      { bucket: "2026-09-29", v: 2 },
      { bucket: "2026-09-30", v: 0 },
      { bucket: "2026-10-01", v: 0 },
      { bucket: "2026-10-02", v: 0 },
      { bucket: "2026-10-03", v: 5 },
    ]);
  });

  it("DST-change week at 23:30 local → one row per calendar day", () => {
    // Covers both US (Nov 1) and EU (Oct 25) fall-back dates, whichever zone the runner uses.
    for (const now of [new Date(2026, 10, 3, 23, 30), new Date(2026, 9, 28, 23, 30)]) {
      const out = fillDailyBuckets([{ bucket: day(now), v: 1 }], "7d", now, zero);
      const buckets = out.map((r) => r.bucket);
      expect(buckets).toEqual(days(new Date(now.getTime() - 7 * 86_400_000), now));
      expect(new Set(buckets).size).toBe(buckets.length);
      // 168h back across a 25h fall-back day starts at 00:30, so 7 (not 8) calendar days — the
      // same window the server's ms subtraction gives; 7 or 8 depending on the runner's zone.
      expect(buckets.length).toBeGreaterThanOrEqual(7);
      expect(buckets.length).toBeLessThanOrEqual(8);
    }
  });
});
