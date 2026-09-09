import { createHash } from "node:crypto";
import type { Db } from "../db/open.js";

export interface LegacyEffectCycle {
  cycleId: string;
  recId: string;
  contractVersion: "w4-legacy-1";
  state: "LEGACY_OPEN" | "LEGACY_FINALIZED";
  measuredAt: string;
  beforeFrom: string;
  beforeTo: string;
  afterFrom: string;
  afterTo: string;
  beforeValue: number | null;
  afterValue: number | null;
  beforeN: number | null;
  afterN: number | null;
  deltaPct: number | null;
  verdict: "EFFECTIVE" | "NO_EFFECT" | "INCONCLUSIVE" | null;
  comparisonStatus: null;
  guardrails: [];
  label: "Legacy target-metric result.";
}

export function synthesizeLegacyCycles(db: Db, recId?: string): LegacyEffectCycle[] {
  const sql = `SELECT rec_id,measured_at,before_from,before_to,after_from,after_to,
                      before_value,after_value,before_n,after_n,delta_pct,verdict
                 FROM recommendation_effects${recId === undefined ? "" : " WHERE rec_id = ?"}
                ORDER BY measured_at DESC,rec_id`;
  const rows = (recId === undefined ? db.prepare(sql).all() : db.prepare(sql).all(recId)) as Array<{
    rec_id: string;
    measured_at: string;
    before_from: string;
    before_to: string;
    after_from: string;
    after_to: string;
    before_value: number | null;
    after_value: number | null;
    before_n: number | null;
    after_n: number | null;
    delta_pct: number | null;
    verdict: LegacyEffectCycle["verdict"];
  }>;
  return rows.map((row) => ({
    cycleId: `legacy-${createHash("sha256").update(`${row.rec_id}\0${row.measured_at}`).digest("hex")}`,
    recId: row.rec_id,
    contractVersion: "w4-legacy-1",
    state: row.verdict === null ? "LEGACY_OPEN" : "LEGACY_FINALIZED",
    measuredAt: row.measured_at,
    beforeFrom: row.before_from,
    beforeTo: row.before_to,
    afterFrom: row.after_from,
    afterTo: row.after_to,
    beforeValue: row.before_value,
    afterValue: row.after_value,
    beforeN: row.before_n,
    afterN: row.after_n,
    deltaPct: row.delta_pct,
    verdict: row.verdict,
    comparisonStatus: null,
    guardrails: [],
    label: "Legacy target-metric result.",
  }));
}
