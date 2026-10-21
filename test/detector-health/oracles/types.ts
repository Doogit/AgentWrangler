/**
 * DH3 quantity oracles (spec-detector-health.md §3 DH3). An oracle recomputes one detector's headline
 * quantity from base ingest columns / raw JSONL, written from its dh-contracts.md card by an author who has
 * not read src/**. Window convention matches the probes: [now - 7d, now).
 */

import type Database from "better-sqlite3";

export interface OracleScope {
  workspace_id: string | null;
  /** Card scope, e.g. "E1|<ws>". */
  key: string;
}

export interface OracleQuantity {
  name: string;
  unit: "events" | "turns" | "tokens" | "bytes" | "sessions" | "count";
  value: number;
}

/** An ASSUMED multiplier taken from the card (not measured). */
export interface OracleAssumption {
  name: string;
  value: number;
  source: string;
}

export interface OracleFinding {
  scope: OracleScope;
  /** Measured quantities (exact events/turns; tokens). */
  quantities: OracleQuantity[];
  /** Priced measured cost (µ$, via priceTurns) before assumptions; null for count-only cards. */
  measured_u: number | null;
  /** Empty = no modelled multiplier. */
  assumptions: OracleAssumption[];
  /** The card-comparable $/wk figure (measured_u x assumptions); null for count-only cards. */
  modeled_u: number | null;
  /** Count-only cards: the headline count. */
  count?: number;
}

export interface OracleResult {
  findings: OracleFinding[];
  /** message_ids whose raw fields the oracle relied on (input to the raw-JSONL check). */
  turns_checked: string[];
  /** Short plain-words note; aggregates only (SEC-101). */
  note: string;
}

export type Oracle = (db: Database.Database, now: Date) => OracleResult;

/** Which card figure the oracle is graded against. */
/** "headline" = the card's net $ (for cards with no modeled figure, e.g. D4). */
/** "presence" = one per workspace on each side (no card shows the oracle's count); secondary metrics still checked. */
export type OracleFigure = "modeled" | "reliability" | "count" | "headline" | "presence";
