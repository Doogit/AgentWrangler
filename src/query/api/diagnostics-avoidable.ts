/**
 * src/query/api/diagnostics-avoidable.ts — the P3.L seam for Avoidable-spend figures (P4 plan KTD-4).
 *
 * The triage build calls the provider once per build. Until P3.L's ledger lands, every figure is
 * null ("not estimated"); U8 swaps `notEstimatedProvider` for a `ledger_daily` reader, and the
 * ranking, folding and banner switch on from these figures with no other change.
 */

export type CauseId = string;

export interface AvoidableCauseFigure {
  /** Allocated, turn-exclusive µ$ in the window; null = "not estimated". */
  avoidable_u: number | null;
  /** The same for the previous equal window (trend). */
  prev_avoidable_u: number | null;
  /** null ⇒ not estimated. */
  basis: "LEDGER" | null;
  /** PARTIAL: some of the cause's detectors have no producer (e.g. C11). */
  coverage: "ALL" | "PARTIAL";
  /** Six session-position buckets; absent until the ledger carries it (OD-1). */
  position_u?: [number, number, number, number, number, number];
  top_claim?: { session_id: string; message_id: string; value_u: number; ts: string };
  /** Exact, from claims. */
  sessions_affected?: number;
  /** Ledger sessions over the window, µ$ desc then id; `sessions_affected` is its length. */
  sessions?: Array<{ session_id: string; value_u: number }>;
}

export type AvoidableProvider = (
  windowDays: 7 | 14 | 30,
  asOf: Date,
) => {
  causes: ReadonlyMap<CauseId, AvoidableCauseFigure>;
  /** Σ causes (the ledger guarantees no overlap); null until P3.L. */
  tile_u: number | null;
  /** ISO of E, the UTC midnight the ledger window ends at; set only when every needed block is marked. */
  through?: string;
};

/** The P4 default: every figure is null. */
export const notEstimatedProvider: AvoidableProvider = () => ({ causes: new Map(), tile_u: null });
