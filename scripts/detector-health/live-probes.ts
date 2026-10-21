/**
 * DH2 live probe loop, shared by probe-live.ts (CLI) and report.ts (DH4): each probe vs its detector at every
 * stored week end (detector_week_results week_start + 7d) plus the latest window. Aggregates only (SEC-101).
 *
 * Never pass the live DB: detectors run read/write against it.
 */

import type Database from "better-sqlite3";
import { buildContext } from "../../src/detector/engine.js";
import { DETECTORS } from "../../src/detector/registry.js";
import type { AnyDetector } from "../../src/detector/types.js";
import { PROBES } from "../../test/detector-health/probes/index.js";
import type { Probe } from "../../test/detector-health/probes/types.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type Outcome =
  | "agree-fires"
  | "agree-silent"
  | "silent-by-gate"
  | "miss"
  | "detector-only"
  | "red";

export interface LiveProbeRow {
  id: string;
  weekEnd: string;
  status: string;
  fired: number;
  stored: number;
  candidates: number;
  qualifying: number;
  outcome: Outcome;
  gates: unknown;
  probeNote: unknown;
}

export function outcome(
  status: string,
  fired: number,
  candidates: number,
  qualifying: number,
): Outcome {
  if (status === "BLOCKED" || status === "NOT_EVALUATED") return "red";
  if (fired > 0) return qualifying > 0 ? "agree-fires" : "detector-only";
  if (qualifying > 0) return "miss";
  return candidates > 0 ? "silent-by-gate" : "agree-silent";
}

/** Weekly steps from the first stored week to the latest, so weeks with no fired rows are still checked. */
export function liveWeekEnds(db: Database.Database): Date[] {
  const starts = (
    db
      .prepare("SELECT DISTINCT week_start FROM detector_week_results ORDER BY week_start")
      .all() as {
      week_start: string;
    }[]
  ).map((r) => Date.parse(r.week_start));
  if (starts.length === 0) throw new Error("detector_week_results is empty");
  const ends = new Set<number>();
  const latest = Math.max(...starts) + WEEK_MS;
  for (let e = (starts[0] ?? 0) + WEEK_MS; e <= latest; e += WEEK_MS) ends.add(e);
  ends.add(latest);
  return [...ends].sort((a, b) => a - b).map((ms) => new Date(ms));
}

export function runLiveProbes(
  db: Database.Database,
  ids: string[] = Object.keys(PROBES),
  weekEnds: Date[] = liveWeekEnds(db),
  detectors: readonly AnyDetector[] = DETECTORS,
  probes: Record<string, Probe> = PROBES,
): LiveProbeRow[] {
  const storedFired = db.prepare(
    "SELECT count(*) AS n FROM detector_week_results WHERE detector_id = ? AND week_start = ? AND fired = 1",
  );
  const rows: LiveProbeRow[] = [];
  for (const id of ids) {
    const probe = probes[id];
    const det = detectors.find((d) => d.id === id);
    if (!probe || !det) throw new Error(`no probe or detector for ${id}`);
    for (const end of weekEnds) {
      const weekStart = new Date(end.getTime() - WEEK_MS).toISOString();
      const out = det.evaluate(db, buildContext(end));
      const p = probe(db, end);
      const stored = (storedFired.get(id, weekStart) as { n: number }).n;
      rows.push({
        id,
        weekEnd: end.toISOString(),
        status: out.status,
        fired: out.fired.length,
        stored,
        candidates: p.candidates,
        qualifying: p.qualifying,
        outcome: outcome(out.status, out.fired.length, p.candidates, p.qualifying),
        gates: p.gates,
        probeNote: p.note,
      });
    }
  }
  return rows;
}
