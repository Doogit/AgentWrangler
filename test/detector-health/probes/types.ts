/**
 * DH2 silence probes (spec-detector-health.md §3 DH2). A probe is a read-only recount of one
 * detector's trigger, written from its contract card in docs/plans/dh-contracts.md by an author
 * who has not read the detector code (§2). It reads base ingest columns or raw JSONL only.
 */

import type Database from "better-sqlite3";

export interface ProbeGate {
  /** Card constant or clause name, e.g. "B3_CACHE_CREATION_THRESHOLD". */
  name: string;
  /** The probe's own value for the best candidate (null = not computable). */
  value: number | null;
  threshold: number;
  op: ">" | ">=" | "<" | "<=";
  pass: boolean;
}

export interface ProbeResult {
  /** Relaxed candidates: scopes that show the pattern before materiality gates. */
  candidates: number;
  /** Scopes that pass every card clause and gate (the probe's own "would fire" count). */
  qualifying: number;
  /** Gate values for the candidate closest to firing (or the first qualifying one). */
  gates: ProbeGate[];
  /** Short plain-words note; aggregates only (SEC-101). */
  note: string;
}

/** `now` is the pinned clock; the window is [now - 7d, now). */
export type Probe = (db: Database.Database, now: Date) => ProbeResult;
