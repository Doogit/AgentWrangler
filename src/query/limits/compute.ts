/**
 * src/query/limits/compute.ts — pure per-row pace/burn/projection math.
 *
 * `computeRow` implements docs/design/overview/overview-v2.md §1 "Per row"
 * exactly. Pure and `now`-injectable so every state is deterministically
 * testable (see compute.test.ts).
 */

import type { LimitRow, PaceState } from "./types.js";

export function computeRow(
  i: {
    id: LimitRow["id"];
    label: string;
    windowHours: 5 | 168;
    usedPct: number;
    resetsAt: string;
  },
  now = new Date(),
): LimitRow {
  const hoursUntilReset = Math.max(0, (new Date(i.resetsAt).getTime() - now.getTime()) / 36e5);
  const elapsedHours = Math.max(0.01, i.windowHours - hoursUntilReset);
  const pacePct = Math.min(100, (100 * elapsedHours) / i.windowHours);
  const perHour = i.usedPct / elapsedHours;
  const isWeekly = i.windowHours === 168;
  const burnRate = isWeekly ? perHour * 24 : perHour;
  const budgetRate = isWeekly ? 100 / 7 : 100 / 5;
  const ratio = burnRate / budgetRate;
  // ratio > 1 ⇔ the projection hits the limit before reset, so "on" must stop at 1
  // (a 1.1 tolerance showed "On pace" beside "Limit in 6h at this rate" — OV-8).
  const paceState: PaceState = ratio <= 1 ? "on" : ratio <= 1.5 ? "ahead" : "over";
  const projection =
    perHour <= 100 / i.windowHours
      ? { kind: "ends-at" as const, pct: Math.min(100, i.usedPct + perHour * hoursUntilReset) }
      : { kind: "hits-limit-in" as const, hours: (100 - i.usedPct) / perHour };
  const row: LimitRow = {
    ...i,
    hoursUntilReset,
    elapsedHours,
    pacePct,
    burnRate,
    budgetRate,
    paceState,
    projection,
  };
  if (i.id.startsWith("weekly:") && i.usedPct > 0 && hoursUntilReset > 0) {
    const k = ((100 - i.usedPct) / i.usedPct) * (elapsedHours / hoursUntilReset);
    if (k >= 1.5) row.headroomMultiple = Math.round(k * 10) / 10;
  }
  return row;
}
