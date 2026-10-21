/**
 * src/detector/result-claims.ts — shared same-chain carry-claim model for the A1/A2/D7x
 * "result" ledger claim producers (P3.L L3).
 *
 * One oversized tool result is read back by later same-chain turns: the first later turn
 * WRITES it into the cache (split across cw5m/cw1h by that turn's own write mix), and every
 * later turn after that READS it back (cacheRead). "Same chain" = same session, same
 * is_sidechain, same agent_id (null-safe) as the event's owner turn, so parallel subagents
 * never mix. The detectors' own estimates walk the same chain through `createResultCarry` (U7).
 *
 * The later-turn walk reuses `carryTurns` from savings.ts (same stop conditions: verified
 * compaction, context collapse, or the 75-turn cap) so the producers stay in lockstep with
 * the detectors' own modeled estimate.
 */
import type { Db } from "../db/open.js";
import { LIST_PRICES, modelTier } from "../ingest/pricing.js";
import type { Claim, LedgerComponent } from "./claim-ledger.js";
import { type CarryTurn, carryTurns } from "./savings.js";
import { turnKey } from "./turn-claim.js";
import type { DetectorContext } from "./types.js";

export interface ResultClaimEvent {
  eventId: string;
  sessionId: string;
  ts: string;
  ownerMessageId: string | null;
}

export interface ResultClaimSpec {
  detectorId: string;
  event: ResultClaimEvent;
  /** Raw tokens for the write claim, and (if `includeCarry`) each carry claim. */
  raw: number;
  /** Whether later turns after the write turn get carry (cacheRead) claims too. */
  includeCarry: boolean;
  recId: string;
  fraction: number;
  fractionRange: readonly [number, number];
}

interface BilledTurn {
  workspaceId: string;
  cacheReadTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

interface OwnerTurn {
  ts: string;
  isSidechain: number;
  agentId: string | null;
  model: string | null;
  unitPricesJson: string | null;
}

/**
 * Turns the ledger bills, keyed by `turnKey` — same predicate as `buildClaimLedger`'s own
 * turn query (ts in window, provisional = 0).
 */
function loadBilledTurns(db: Db, fromIso: string, toIso: string): Map<string, BilledTurn> {
  const rows = db
    .prepare(
      `SELECT t.session_id, t.message_id, t.workspace_id,
              t.cache_read_tokens, t.cache_write_5m, t.cache_write_1h
         FROM turns t
        WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0`,
    )
    .all(fromIso, toIso) as Array<{
    session_id: string;
    message_id: string;
    workspace_id: string;
    cache_read_tokens: number;
    cache_write_5m: number;
    cache_write_1h: number;
  }>;
  const map = new Map<string, BilledTurn>();
  for (const row of rows) {
    map.set(turnKey(row.session_id, row.message_id), {
      workspaceId: row.workspace_id,
      cacheReadTokens: row.cache_read_tokens,
      cacheWrite5m: row.cache_write_5m,
      cacheWrite1h: row.cache_write_1h,
    });
  }
  return map;
}

function createOwnerLookup(
  db: Db,
): (sessionId: string, ownerMessageId: string | null) => OwnerTurn | undefined {
  const stmt = db.prepare(
    `SELECT t.ts, t.is_sidechain, t.agent_id, t.model, ps.unit_prices_json
       FROM turns t LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
      WHERE t.session_id = ? AND t.message_id = ?`,
  );
  // Many results share one owner turn: look each turn up once.
  const memo = new Map<string, OwnerTurn | undefined>();
  const lookup = (sessionId: string, ownerMessageId: string): OwnerTurn | undefined => {
    const row = stmt.get(sessionId, ownerMessageId) as
      | {
          ts: string;
          is_sidechain: number;
          agent_id: string | null;
          model: string | null;
          unit_prices_json: string | null;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      ts: row.ts,
      isSidechain: row.is_sidechain,
      agentId: row.agent_id,
      model: row.model,
      unitPricesJson: row.unit_prices_json,
    };
  };
  return (sessionId, ownerMessageId) => {
    if (ownerMessageId === null) return undefined;
    const key = `${sessionId}\0${ownerMessageId}`;
    if (!memo.has(key)) memo.set(key, lookup(sessionId, ownerMessageId));
    return memo.get(key);
  };
}

/** The owner turn's cache read, 5m- and 1h-write prices ($/MTok): its snapshot, else its list price. */
function ownerPrices(owner: OwnerTurn): { read: number; write: number; write1h: number } {
  let prices: number[] | undefined;
  if (owner.unitPricesJson !== null) {
    try {
      prices = JSON.parse(owner.unitPricesJson) as number[];
    } catch {
      // Fall through to the model's list price.
    }
  }
  const fallback = owner.model === null ? undefined : LIST_PRICES[modelTier(owner.model) ?? ""];
  return {
    read: prices?.[2] ?? fallback?.[2] ?? 0,
    write: prices?.[3] ?? fallback?.[3] ?? 0,
    write1h: prices?.[4] ?? fallback?.[4] ?? 0,
  };
}

/**
 * Later same-chain turns to claim against, in chain order: turn 1 is the write turn, the rest
 * (if any) carry. Walks the whole chain (same session, is_sidechain, agent_id as the owner
 * turn) and defers the stop condition (compaction / collapse / 75-turn cap) to `carryTurns`,
 * so the walk stays byte-identical to the detectors' own carry semantics.
 */
function createLaterTurnsResolver(
  db: Db,
): (sessionId: string, eventTs: string, owner: OwnerTurn) => string[] {
  const chainStmt = db.prepare(
    `SELECT message_id, ts, context_tokens FROM turns
      WHERE session_id = ? AND is_sidechain = ? AND agent_id IS ?
      ORDER BY ts ASC, message_id ASC`,
  );
  const compactStmt = db.prepare(
    `SELECT event_ts AS ts FROM ingest_metric_events
      WHERE session_id = ?
        AND boundary_kind = 'compact-boundary' AND boundary_verification = 'VERIFIED'
      ORDER BY event_ts ASC`,
  );
  // One read per session (not per result): the first verified compaction after an event.
  const compactions = new Map<string, string[]>();
  const nextCompaction = (sessionId: string, eventTs: string): string | null => {
    let all = compactions.get(sessionId);
    if (all === undefined) {
      all = (compactStmt.all(sessionId) as Array<{ ts: string }>).map((r) => r.ts);
      compactions.set(sessionId, all);
    }
    return all.find((ts) => ts > eventTs) ?? null;
  };
  // One chain read per (session, is_sidechain, agent_id): D6 walks every small result of a chain.
  const chains = new Map<
    string,
    Array<{ message_id: string; ts: string; context_tokens: number }>
  >();
  return (sessionId, eventTs, owner) => {
    const chainKey = JSON.stringify([sessionId, owner.isSidechain, owner.agentId]);
    let chain = chains.get(chainKey);
    if (chain === undefined) {
      chain = chainStmt.all(sessionId, owner.isSidechain, owner.agentId) as Array<{
        message_id: string;
        ts: string;
        context_tokens: number;
      }>;
      chains.set(chainKey, chain);
    }
    const compactTs = nextCompaction(sessionId, eventTs);
    const laterMeta: CarryTurn[] = [];
    const laterIds: string[] = [];
    let previousContext: number | undefined;
    for (const turn of chain) {
      const contextCollapsed =
        previousContext !== undefined &&
        previousContext > 50_000 &&
        turn.context_tokens < previousContext * 0.5;
      if (turn.ts > eventTs) {
        laterMeta.push({
          sessionId,
          compacted: compactTs !== null && turn.ts >= compactTs,
          contextCollapsed,
        });
        laterIds.push(turn.message_id);
      }
      previousContext = turn.context_tokens;
    }
    const count = carryTurns(sessionId, laterMeta);
    return laterIds.slice(0, count);
  };
}

/** How long one result stays in its owner chain's context, and at what prices. */
export interface ResultCarry {
  /** Later owner-chain turns that send the result: the first writes it, the rest read it. */
  carry: number;
  /** Owner turn's 5-minute cache-write price, $/MTok. */
  writePrice: number;
  /** Owner turn's cache-read price, $/MTok. */
  readPrice: number;
  /**
   * The write turn's 5m/1h write mix priced at the owner's rates, $/MTok — what the ledger's
   * write claim (split by that same mix) pays. `writePrice` when the write turn wrote nothing.
   */
  mixedWritePrice: number;
}

/**
 * Shared carry for result detectors (A1, A2, D6, D7 XREAD, D12): walks the result's owner chain —
 * main thread or the one subagent that read it (session, is_sidechain, agent_id) — through the
 * same stops as the ledger's claims (compaction, collapse, 75-turn cap). Undefined when the
 * owner turn is unknown, so nothing is priced.
 */
export function createResultCarry(
  db: Db,
): (sessionId: string, ts: string, ownerMessageId: string | null) => ResultCarry | undefined {
  // Prepared on first use: a result with no owner turn needs no turn queries.
  let findOwner: ReturnType<typeof createOwnerLookup> | undefined;
  let laterTurns: ReturnType<typeof createLaterTurnsResolver> | undefined;
  let writeMix: ((sessionId: string, messageId: string) => unknown) | undefined;
  return (sessionId, ts, ownerMessageId) => {
    if (ownerMessageId === null) return undefined;
    findOwner ??= createOwnerLookup(db);
    laterTurns ??= createLaterTurnsResolver(db);
    if (writeMix === undefined) {
      const stmt = db.prepare(
        "SELECT cache_write_5m AS w5, cache_write_1h AS w1h FROM turns WHERE session_id = ? AND message_id = ?",
      );
      writeMix = (session, message) => stmt.get(session, message);
    }
    const owner = findOwner(sessionId, ownerMessageId);
    if (owner === undefined) return undefined;
    const prices = ownerPrices(owner);
    const later = laterTurns(sessionId, ts, owner);
    const mix =
      later[0] === undefined
        ? undefined
        : (writeMix(sessionId, later[0]) as { w5: number; w1h: number } | undefined);
    const written = mix === undefined ? 0 : mix.w5 + mix.w1h;
    return {
      carry: later.length,
      writePrice: prices.write,
      readPrice: prices.read,
      mixedWritePrice:
        mix === undefined || written <= 0
          ? prices.write
          : (mix.w5 * prices.write + mix.w1h * prices.write1h) / written,
    };
  };
}

interface Runner {
  fromIso: string;
  toIso: string;
  billed: Map<string, BilledTurn>;
  laterTurns: ReturnType<typeof createLaterTurnsResolver>;
  findOwner: ReturnType<typeof createOwnerLookup>;
}

const runnerCache = new WeakMap<Db, Runner>();

/** Drops the shared per-build state; `buildClaimLedger` calls it so a rebuild sees fresh turns. */
export function resetResultClaimCache(db: Db): void {
  runnerCache.delete(db);
}

function resolveRunner(db: Db, fromIso: string, toIso: string): Runner {
  const cached = runnerCache.get(db);
  if (cached !== undefined && cached.fromIso === fromIso && cached.toIso === toIso) return cached;
  const runner: Runner = {
    fromIso,
    toIso,
    billed: loadBilledTurns(db, fromIso, toIso),
    laterTurns: createLaterTurnsResolver(db),
    findOwner: createOwnerLookup(db),
  };
  runnerCache.set(db, runner);
  return runner;
}

/** Per-producer, per-(turn, component) budget: raw tokens already emitted into that cell. */
export type ResultClaimBudget = Map<string, number>;

function clampRaw(
  budget: ResultClaimBudget,
  key: string,
  component: string,
  cellTokens: number,
  raw: number,
): number {
  const cellKey = `${key}\u0000${component}`;
  const used = budget.get(cellKey) ?? 0;
  const amount = Math.min(raw, cellTokens - used);
  if (amount <= 0) return 0;
  budget.set(cellKey, used + amount);
  return amount;
}

function makeClaim(
  spec: ResultClaimSpec,
  key: string,
  workspaceId: string,
  component: LedgerComponent,
  tokens: number,
): Claim {
  return {
    detectorId: spec.detectorId,
    workspaceId,
    sessionId: spec.event.sessionId,
    turnKey: key,
    component,
    slice: `result:${spec.event.eventId}`,
    tokens,
    fraction: spec.fraction,
    fractionRange: spec.fractionRange,
    assumed: true,
    recId: spec.recId,
  };
}

/**
 * Yields the write claim (and, if `spec.includeCarry`, the carry claims) for one result event.
 * Events must be fed to this in `(ts, event_id)` order across a producer's whole run, sharing
 * one `budget` Map, so the per-cell clamp (point 5 of the spec) sees a consistent history.
 */
export function* resultClaimsForEvent(
  db: Db,
  ctx: DetectorContext,
  spec: ResultClaimSpec,
  budget: ResultClaimBudget,
): Generator<Claim> {
  if (spec.raw <= 0) return;
  const runner = resolveRunner(db, ctx.fromIso, ctx.toIso);
  const owner = runner.findOwner(spec.event.sessionId, spec.event.ownerMessageId);
  if (owner === undefined) return;
  const included = runner.laterTurns(spec.event.sessionId, spec.event.ts, owner);
  if (included.length === 0) return;

  const writeMessageId = included[0] as string;
  const writeKey = turnKey(spec.event.sessionId, writeMessageId);
  const writeTurn = runner.billed.get(writeKey);
  if (writeTurn !== undefined) {
    const cw = writeTurn.cacheWrite5m + writeTurn.cacheWrite1h;
    const r5 = cw > 0 ? Math.round((spec.raw * writeTurn.cacheWrite5m) / cw) : spec.raw;
    const r1h = spec.raw - r5;
    if (r5 > 0) {
      const amount = clampRaw(budget, writeKey, "cw5m", writeTurn.cacheWrite5m, r5);
      if (amount > 0) yield makeClaim(spec, writeKey, writeTurn.workspaceId, "cw5m", amount);
    }
    if (r1h > 0) {
      const amount = clampRaw(budget, writeKey, "cw1h", writeTurn.cacheWrite1h, r1h);
      if (amount > 0) yield makeClaim(spec, writeKey, writeTurn.workspaceId, "cw1h", amount);
    }
  }

  if (!spec.includeCarry) return;
  for (let i = 1; i < included.length; i++) {
    const messageId = included[i] as string;
    const key = turnKey(spec.event.sessionId, messageId);
    const turn = runner.billed.get(key);
    if (turn === undefined) continue;
    const amount = clampRaw(budget, key, "cacheRead", turn.cacheReadTokens, spec.raw);
    if (amount > 0) yield makeClaim(spec, key, turn.workspaceId, "cacheRead", amount);
  }
}
