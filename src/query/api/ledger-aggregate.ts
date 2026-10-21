/**
 * Slim claim-ledger aggregate for the recs build (RB1-C).
 *
 * The recs readers (`RecEvidenceContext.claims`, `allocatedByRecId`, `reliabilityByRecId`) read only
 * eight fields of `ledger.claims`. A full ledger of a 7-day window is ~20-35 MB; this aggregate is
 * a few hundred tuples plus one float per claim. Closed-window aggregates are carried across builds (main process -> worker
 * `workerData` -> result message), keyed by the window and a fingerprint of every table the
 * ledger's producers read, so a late write into a closed window rebuilds only that window.
 */
import { createHash } from "node:crypto";
import type { Db } from "../../db/open.js";
import type { ClaimLedger, LedgerLane } from "../../detector/claim-ledger.js";
import { gridW1EndMs } from "../../detector/engine.js";
import { ENRICHMENT_EPOCH_KEY } from "../../ingest/enrichment-epoch.js";

const WEEK_MS = 7 * 86_400_000;

export interface LedgerTuple {
  detectorId: string;
  recId: string | undefined;
  workspaceId: string;
  sessionId: string;
  lane: LedgerLane;
  sidechain: boolean;
  unpriced: boolean;
}
export type LedgerAggregateClaim = LedgerTuple & { value_u: number };

/**
 * The ledger's claims in their original order, each reduced to a tuple index plus its `value_u`.
 * The values stay one per claim (a few hundred KB per window) because `value_u` is a float: summing
 * per tuple first would change the addition order and move a rounded headline by 1 µ$.
 */
export interface LedgerAggregate {
  tuples: LedgerTuple[];
  tupleOf: Int32Array;
  values: Float64Array;
}

export function aggregateLedger(ledger: ClaimLedger): LedgerAggregate {
  const index = new Map<string, number>();
  const tuples: LedgerTuple[] = [];
  const claims = ledger.claims;
  const tupleOf = new Int32Array(claims.length);
  const values = new Float64Array(claims.length);
  claims.forEach((claim, i) => {
    const sidechain = claim.sidechain === true;
    const key = JSON.stringify([
      claim.detectorId,
      claim.recId ?? null,
      claim.workspaceId,
      claim.sessionId,
      claim.lane,
      sidechain,
      claim.unpriced,
    ]);
    let at = index.get(key);
    if (at === undefined) {
      at = tuples.length;
      index.set(key, at);
      tuples.push({
        detectorId: claim.detectorId,
        recId: claim.recId,
        workspaceId: claim.workspaceId,
        sessionId: claim.sessionId,
        lane: claim.lane,
        sidechain,
        unpriced: claim.unpriced,
      });
    }
    tupleOf[i] = at;
    values[i] = claim.value_u;
  });
  return { tuples, tupleOf, values };
}

/** The aggregate's claims in the ledger's original order. */
export function* aggregateClaims(aggregate: LedgerAggregate): Generator<LedgerAggregateClaim> {
  for (let i = 0; i < aggregate.values.length; i++) {
    yield {
      ...(aggregate.tuples[aggregate.tupleOf[i] as number] as LedgerTuple),
      value_u: aggregate.values[i] as number,
    };
  }
}

/**
 * Closed = the window ends at or before the newest reset-grid point at or before `now`, the same
 * grid the detectors' history walk uses (`gridW1EndMs`, one week ahead of `now`). The current
 * grid week is never closed.
 */
export function isClosedWindow(db: Db, window: { to: string }, now: Date): boolean {
  const to = Date.parse(window.to);
  return Number.isFinite(to) && to <= gridW1EndMs(db, new Date(now.getTime() + WEEK_MS));
}

/** Tables read by `buildClaimLedger` and its producers, as a hash of cheap change signals. */
export function ledgerFingerprint(db: Db, window: { from: string; to: string }): string {
  const span = [window.from, window.to];
  const one = (sql: string, ...args: unknown[]): unknown =>
    Object.values(db.prepare(sql).get(...args) as object);
  const all = (sql: string, ...args: unknown[]): unknown => db.prepare(sql).all(...args);
  const signals = [
    // Windowed fact tables, read from covering indexes (~10 ms for all three on the live copy):
    // row count + newest rowid catch inserts, `provisional` the reconcile flip, a non-NULL count of
    // `agent_id` the agent-id backfill. Other in-place edits of closed rows (tool_events result
    // and error labels, ingest_metric_events labels, metadata, subagent_meta) cost 100-260 ms to
    // detect in SQL; the enrichment epoch in the user_config signal below covers them instead.
    one(
      `SELECT COUNT(*), MAX(rowid), SUM(provisional), SUM(agent_id IS NOT NULL)
         FROM turns WHERE ts >= ? AND ts < ?`,
      ...span,
    ),
    one("SELECT COUNT(*), MAX(rowid) FROM tool_events WHERE ts >= ? AND ts < ?", ...span),
    one(
      "SELECT COUNT(*), MAX(rowid) FROM ingest_metric_events WHERE event_ts >= ? AND event_ts < ?",
      ...span,
    ),
    // Sessions that overlap the window: a flip to RECONCILED changes what the producers join.
    one(
      `SELECT COUNT(*), MAX(rowid), SUM(state = 'RECONCILED')
         FROM sessions WHERE first_turn_at IS NULL OR (first_turn_at < ? AND last_turn_at >= ?)`,
      window.to,
      window.from,
    ),
    // Small current-state tables: content, not rowid or timestamps (the probe rewrites them).
    all("SELECT * FROM pricing_snapshots ORDER BY snapshot_id"),
    all("SELECT * FROM workspaces ORDER BY workspace_id"),
    all(
      "SELECT workspace_id, component, file_ref, file_hash, tokens, attribution_version FROM context_inventory ORDER BY probe_id",
    ),
    all(
      "SELECT workspace_id, component, file_ref, file_hash, tokens, attribution_version, observed_at FROM context_inventory_history ORDER BY id",
    ),
    // probed_at excluded: every probe rewrites it without a content change.
    all(
      `SELECT item_id, kind, name, plugin, usage_key, tokens, bytes, size_basis, source
         FROM catalog_items ORDER BY item_id`,
    ),
    all(
      `SELECT key, value FROM user_config
        WHERE key LIKE 'bytes_per_token%' OR key IN ('cap_read_coeff', 'scan_roots', ?)
        ORDER BY key`,
      ENRICHMENT_EPOCH_KEY,
    ),
  ];
  return createHash("sha1").update(JSON.stringify(signals)).digest("hex");
}

/** A cached aggregate older than this is rebuilt whatever the fingerprint says. */
const MAX_AGE_MS = 6 * 3_600_000;

export interface CachedAggregate {
  aggregate: LedgerAggregate;
  builtAtMs: number;
}

/** Cross-build cache of closed-window aggregates. Held by the runner, seeded into the worker. */
const seeded = new Map<string, CachedAggregate>();
const used = new Map<string, CachedAggregate>();

export function windowCacheKey(window: { from: string; to: string }, fingerprint: string): string {
  return `${window.from}\n${window.to}\n${fingerprint}`;
}

export function seedLedgerAggregates(entries: Array<[string, CachedAggregate]>): void {
  seeded.clear();
  used.clear();
  for (const [key, cached] of entries) seeded.set(key, cached);
}

/** The seeded aggregate for `key`, remembered as used so it survives into the next build. */
export function takeSeededAggregate(key: string): LedgerAggregate | undefined {
  const hit = seeded.get(key);
  if (!hit || Date.now() - hit.builtAtMs > MAX_AGE_MS) return undefined;
  used.set(key, hit);
  return hit.aggregate;
}

export function rememberAggregate(key: string, aggregate: LedgerAggregate): void {
  used.set(key, { aggregate, builtAtMs: Date.now() });
}

/** Exactly the closed-window aggregates this build used or built. */
export function usedLedgerAggregates(): Array<[string, CachedAggregate]> {
  return [...used];
}

/** Test hook. */
export function __resetLedgerAggregates(): void {
  seeded.clear();
  used.clear();
}
