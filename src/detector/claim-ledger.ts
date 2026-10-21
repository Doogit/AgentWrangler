/** Exclusive ownership of billed turn tokens. Prices are micro-USD per token. */
import type { Db } from "../db/open.js";
import { a1ClaimProducer } from "./detectors/a1_tool_result_bloat.js";
import { a2ClaimProducer } from "./detectors/a2_task_output_bloat.js";
import { b1ClaimProducer } from "./detectors/b1_cache_read_collapse.js";
import { b3ClaimProducer } from "./detectors/b3_resume_cache_miss.js";
import { c6ClaimProducer } from "./detectors/c6_edit_flip_flop.js";
import { c11ClaimProducer } from "./detectors/c11_mcp_output_cap.js";
import { d1ClaimProducer } from "./detectors/d1_ctx_always_loaded.js";
import { d2ClaimProducer } from "./detectors/d2_session_long_full_context.js";
import { d4ClaimProducer } from "./detectors/d4_model_mismatch.js";
import { d6ClaimProducer } from "./detectors/d6_tool_result_bloat.js";
import { d7xClaimProducer } from "./detectors/d7_loop_retry_waste.js";
import { d8ClaimProducer } from "./detectors/d8_cache_write_churn.js";
import { d10ClaimProducer } from "./detectors/d10_catalog_footprint.js";
import { recId } from "./rec-id.js";
import { resetResultClaimCache } from "./result-claims.js";
import {
  D14_ESC_OWNER_SQL,
  type TurnKey,
  type WastedTurnFamily,
  turnKey,
  wastedTurnCensus,
} from "./turn-claim.js";
import type { DetectorContext } from "./types.js";

export type LedgerComponent = "input" | "output" | "cacheRead" | "cw5m" | "cw1h";
/** Lanes are allocated separately and never summed together (spec F2 v2). */
export type LedgerLane = "spend" | "reliability";

export interface Claim {
  detectorId: string;
  workspaceId: string;
  sessionId: string;
  turnKey: string;
  component: LedgerComponent;
  /** `<namespace>:<name>`; `<namespace>:*` covers its namespace, bare `*` the whole cell. */
  slice: string;
  tokens: number;
  derivedFrom?: string;
  assumed?: boolean;
  /** The finding's deterministic rec id. Required on spend-lane claims. */
  recId?: string;
  /** Absent = spend. */
  lane?: LedgerLane;
  /** Reliability lane only: set when the recovery turn is a subagent's (sidechain); absent = main chain. */
  sidechain?: true;
  /** Avoidable share of `tokens`, in (0, 1]; the ledger claims round(tokens × fraction). */
  fraction?: number;
  /** The ASSUMED fraction's plausible [min, max] (F1); needs `fraction` inside it. */
  fractionRange?: readonly [number, number];
  /** µ$/token these tokens should have cost (repricing). Absent = 0 (removal). */
  counterfactualPriceU?: number;
}

export interface ClaimProducer {
  detectorId: string;
  produce(db: Db, ctx: DetectorContext): Iterable<Claim>;
}

/**
 * Owner order when two producers claim one cell of the same lane. Basis-O detectors never
 * own claims: B2 labels the idle-expiry subset that D8 prices, B4 is folded into B1 (same
 * turn), C5 overlaps D7. B1 (gap ≤ thread TTL) and D8 (gap > thread TTL) price disjoint
 * turns by construction (cache-ttl.ts). Spend lane: specific before general, removal
 * before repricing, so D2 (`history:*`) and D4 (`model:*`) take only what is left.
 */
export const LEDGER_PRIORITY = [
  // Reliability lane.
  "C7",
  "C3",
  "C4",
  "C1",
  "C2",
  "C9",
  "D14",
  "D11",
  "C6",
  "C11",
  // Spend lane.
  "D1",
  "D10",
  "A1",
  "A2",
  "D7",
  "D12",
  // D6 is the most general result claim: it takes only what A2/D7/D12 leave on a shared cell.
  "D6",
  "D2",
  "D8",
  "B1",
  "B3",
  "D4",
  "D9",
] as const;

const COMPONENTS = ["input", "output", "cacheRead", "cw5m", "cw1h"] as const;
const TOKEN_COLUMNS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_5m",
  "cache_write_1h",
] as const;
const COMPONENT_COLUMNS = COMPONENTS.map((component, index) => ({
  component,
  column: TOKEN_COLUMNS[index],
}));

interface TurnBilling {
  workspace_id: string;
  session_id: string;
  message_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  unit_prices_json: string | null;
}

export interface LedgerEntry extends Claim {
  lane: LedgerLane;
  value_u: number;
  /** Tokens the producer asked for, before the fraction and the billed cap. */
  raw_tokens: number;
  /** round(raw_tokens × fraction): the tokens asked for before the billed cap clamped `tokens`. */
  requested_tokens: number;
  /** The turn has no usable pricing snapshot, so `value_u` is 0. */
  unpriced: boolean;
}

export interface ClaimLedger {
  claims: LedgerEntry[];
  subordinate: LedgerEntry[];
  rejected: Claim[];
  /** Billed tokens per cell. */
  billed: ReadonlyMap<string, number>;
  /** Billed µ$ per cell (tokens × unit price; 0 when unpriced). */
  billedValue: ReadonlyMap<string, number>;
}

function cellKey(claim: Pick<Claim, "turnKey" | "component">): string {
  return JSON.stringify([claim.turnKey, claim.component]);
}

function laneOf(claim: Pick<Claim, "lane">): LedgerLane {
  return claim.lane ?? "spend";
}

/** General claims that take what specific claims left (spec F2 v2 item 6). */
const RESIDUAL_SLICES = new Set(["history:*", "model:*"]);

/** Code-point order: locale-independent, so the frozen golden-ledger fixture is stable. */
function compare(a: string | undefined, b: string | undefined): number {
  const x = a ?? "";
  const y = b ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
}

function namespaceOf(slice: string): string {
  const colon = slice.indexOf(":");
  return colon < 0 ? "" : slice.slice(0, colon);
}

/** Same slice, bare `*`, or a `<namespace>:*` wildcard against its own namespace. */
function slicesConflict(a: string, b: string): boolean {
  if (a === b || a === "*" || b === "*") return true;
  return namespaceOf(a) === namespaceOf(b) && (a.endsWith(":*") || b.endsWith(":*"));
}

function validV2Fields(claim: Claim): boolean {
  const { fraction, fractionRange, counterfactualPriceU, lane, recId, derivedFrom } = claim;
  if (lane !== undefined && lane !== "spend" && lane !== "reliability") return false;
  if (recId !== undefined && recId.trim() === "") return false;
  if (derivedFrom !== undefined && derivedFrom.trim() === "") return false;
  if (fraction !== undefined && !(Number.isFinite(fraction) && fraction > 0 && fraction <= 1))
    return false;
  // F1: an ASSUMED fraction declares its plausible [min, max].
  if (claim.assumed && fraction !== undefined && fraction < 1 && fractionRange === undefined)
    return false;
  if (fractionRange !== undefined) {
    const [min, max] = fractionRange;
    if (fraction === undefined || !(min > 0 && min <= fraction && fraction <= max && max <= 1))
      return false;
  }
  return (
    counterfactualPriceU === undefined ||
    (Number.isFinite(counterfactualPriceU) && counterfactualPriceU >= 0)
  );
}

/**
 * `wastedTurnClaims` is expensive (D7 matcher + per-event queries), so the eight
 * family producers share one evaluation per `buildClaimLedger` call.
 */
type RecoveryTurn = TurnBilling & { recId?: string; sidechain?: true };
const adapterMemo = new WeakMap<Db, Map<WastedTurnFamily, RecoveryTurn[]>>();

const C9_LABELS: Record<string, string> = {
  "hook-block": "HOOK_BLOCK",
  "deny-rule": "DENY_RULE",
  "user-rejected": "USER_REJECTED",
};

/** The card a failure belongs to: the same scope key each detector's `evaluate()` emits. */
function reliabilityRecId(
  family: WastedTurnFamily,
  ws: string | null,
  sessionId: string,
  detail: string | null,
): string | undefined {
  // U9 r9: C1 fires one global card per outlier tool (`C1|<tool>`, see c1_tool_error_rate), so
  // its claims are keyed by the failing tool; a bare "C1" key matched no card and every C1
  // headline read $0.
  if (family === "C1") return detail === null ? undefined : recId("C1", null, `C1|${detail}`);
  if (ws === null) return undefined;
  switch (family) {
    case "C7":
      return recId("C7", ws, `C7|${ws}`);
    case "C2":
      return recId("C2", ws, `C2|${ws}`);
    case "C3":
      return recId("C3", ws, `C3|${ws}`);
    case "C4":
      return recId("C4", ws, `C4|${ws}|${sessionId}`);
    case "D11":
      return recId("D11", ws, `D11|tool-error-rate|${ws}`);
    case "C9":
      return detail === null ? undefined : recId("C9", ws, `C9|${ws}|${detail}`);
    case "D14":
      return detail === null ? undefined : recId("D14", ws, `D14|${ws}|${sessionId}|${detail}`);
    default:
      return undefined;
  }
}

/**
 * L8: a failure is priced at its recovery turn R(t), the first main-chain settled turn
 * after the issuing turn t (the call that reads the error and re-plans). Issuing turns are
 * the census turns that carry at least one event of the family; C9/D14 re-plan turns added
 * without an event are not issuing turns. Recovery turns outside the window are dropped.
 * A sidechain issuing turn is priced at the next settled turn of the same subagent; a subagent
 * that ended on the failure has no claim.
 */
function recoveryTurns(db: Db, ctx: DetectorContext): Map<WastedTurnFamily, RecoveryTurn[]> {
  const census = wastedTurnCensus(db, ctx);
  // Per event: its issuing turn and the facts that name its card (workspace, session, D14 kind).
  interface Issuer {
    key: TurnKey;
    sessionId: string;
    ws: string | null;
    detail: string | null;
    /** The failing tool (tool events only): names C1's per-tool card. */
    tool?: string | null;
  }
  const toolOwner = new Map<string, Issuer>();
  for (const row of db
    .prepare(
      `SELECT e.event_id, e.session_id, m.owner_message_id, s.workspace_id, e.interrupt_kind,
              e.tool_name
         FROM tool_events e JOIN tool_event_metadata m ON m.event_id = e.event_id
         LEFT JOIN sessions s ON s.session_id = e.session_id
        WHERE e.ts >= ? AND e.ts < ? AND m.owner_message_id IS NOT NULL`,
    )
    .all(ctx.fromIso, ctx.toIso) as Array<{
    event_id: string;
    session_id: string;
    owner_message_id: string;
    workspace_id: string | null;
    interrupt_kind: string | null;
    tool_name: string | null;
  }>)
    toolOwner.set(row.event_id, {
      key: turnKey(row.session_id, row.owner_message_id),
      sessionId: row.session_id,
      ws: row.workspace_id,
      detail: row.interrupt_kind,
      tool: row.tool_name,
    });
  // C9 events are denials in ingest_metric_events; the census' owner turn is the latest
  // main-chain turn at or before the denial.
  const denialOwner = new Map<string, Issuer>();
  const denials = db.prepare(
    `SELECT e.session_id, e.event_ts, e.classifier_label, s.workspace_id
       FROM ingest_metric_events e LEFT JOIN sessions s ON s.session_id = e.session_id
      WHERE e.event_id = ?`,
  );
  const ownerQ = db.prepare(
    `SELECT message_id FROM turns
      WHERE session_id = ? AND is_sidechain = 0 AND ts <= ?
      ORDER BY ts DESC LIMIT 1`,
  );
  for (const eventId of census.claimEventIds.get("C9") ?? []) {
    const denial = denials.get(eventId) as
      | {
          session_id: string;
          event_ts: string;
          classifier_label: string;
          workspace_id: string | null;
        }
      | undefined;
    if (denial === undefined) continue;
    const owner = ownerQ.get(denial.session_id, denial.event_ts) as
      | { message_id: string }
      | undefined;
    if (owner !== undefined)
      denialOwner.set(eventId, {
        key: turnKey(denial.session_id, owner.message_id),
        sessionId: denial.session_id,
        ws: denial.workspace_id,
        detail: C9_LABELS[denial.classifier_label] ?? null,
      });
  }
  // RC-D14: a D14 Esc event is a user record in ingest_metric_events, not a tool event. Its
  // issuing turn is the stopped response (D14_ESC_OWNER_SQL), as turn-claim claims it.
  const escOwnerQ = db.prepare(D14_ESC_OWNER_SQL);
  for (const eventId of census.claimEventIds.get("D14") ?? []) {
    if (toolOwner.has(eventId)) continue;
    const esc = denials.get(eventId) as
      | { session_id: string; event_ts: string; workspace_id: string | null }
      | undefined;
    if (esc === undefined) continue;
    const owner = escOwnerQ.get(esc.session_id, esc.event_ts, esc.event_ts) as
      | { message_id: string }
      | undefined;
    if (owner !== undefined)
      toolOwner.set(eventId, {
        key: turnKey(esc.session_id, owner.message_id),
        sessionId: esc.session_id,
        ws: esc.workspace_id,
        detail: "PURE_INTERRUPT",
      });
  }
  const recoveryQ = db.prepare(
    `SELECT r.message_id, r.session_id, r.workspace_id, r.ts,
            r.input_tokens, r.output_tokens, r.cache_read_tokens,
            r.cache_write_5m, r.cache_write_1h
       FROM turns t
       JOIN turns r ON r.session_id = t.session_id AND r.is_sidechain = 0
                   AND r.provisional = 0 AND r.ts > t.ts
      WHERE t.session_id = ? AND t.message_id = ?
      ORDER BY r.ts, r.message_id LIMIT 1`,
  );
  // Sidechain: R(t) stays inside the issuing turn's own subagent (session_id, agent_id).
  const sidechainRecoveryQ = db.prepare(
    `SELECT r.message_id, r.session_id, r.workspace_id, r.ts,
            r.input_tokens, r.output_tokens, r.cache_read_tokens,
            r.cache_write_5m, r.cache_write_1h
       FROM turns t
       JOIN turns r ON r.session_id = t.session_id AND r.agent_id = t.agent_id
                   AND r.is_sidechain = 1 AND r.provisional = 0 AND r.ts > t.ts
      WHERE t.session_id = ? AND t.message_id = ? AND t.is_sidechain = 1 AND t.agent_id IS NOT NULL
      ORDER BY r.ts, r.message_id LIMIT 1`,
  );
  const sidechainCensus = wastedTurnCensus(db, ctx, "sidechain");
  const memo = new Map<WastedTurnFamily, RecoveryTurn[]>();
  for (const [family, claimed] of census.claims) {
    // Recovery turn → its row and the issuing-event count per rec. One recovery turn has one
    // owner (the `turn:*` slice holds no second): the rec with most events, ties → lowest id.
    const priced = new Map<
      TurnKey,
      { row: TurnBilling; events: Map<string, number>; sidechain: boolean }
    >();
    const passes = [
      { census, claimed, query: recoveryQ, sidechain: false },
      {
        census: sidechainCensus,
        claimed: sidechainCensus.claims.get(family) ?? new Set<TurnKey>(),
        query: sidechainRecoveryQ,
        sidechain: true,
      },
    ];
    for (const pass of passes) {
      const recovery = new Map<TurnKey, (TurnBilling & { ts: string }) | undefined>();
      for (const eventId of pass.census.claimEventIds.get(family) ?? []) {
        const issuer = (family === "C9" ? denialOwner : toolOwner).get(eventId);
        if (issuer === undefined || !pass.claimed.has(issuer.key)) continue;
        if (!recovery.has(issuer.key)) {
          const bar = issuer.key.indexOf("|");
          recovery.set(
            issuer.key,
            pass.query.get(issuer.key.slice(0, bar), issuer.key.slice(bar + 1)) as
              | (TurnBilling & { ts: string })
              | undefined,
          );
        }
        const row = recovery.get(issuer.key);
        if (row === undefined || row.ts < ctx.fromIso || row.ts >= ctx.toIso) continue;
        const recoveryKey = turnKey(row.session_id, row.message_id);
        const entry = priced.get(recoveryKey) ?? {
          row,
          events: new Map<string, number>(),
          sidechain: pass.sidechain,
        };
        priced.set(recoveryKey, entry);
        const rec =
          reliabilityRecId(
            family,
            issuer.ws,
            issuer.sessionId,
            family === "C1" ? (issuer.tool ?? null) : issuer.detail,
          ) ?? "";
        entry.events.set(rec, (entry.events.get(rec) ?? 0) + 1);
      }
    }
    memo.set(
      family,
      [...priced.values()].map(({ row, events, sidechain }) => {
        const winner = [...events].sort(([a, x], [b, y]) => y - x || compare(a, b))[0]?.[0];
        return {
          ...row,
          ...(winner ? { recId: winner } : {}),
          ...(sidechain ? { sidechain: true as const } : {}),
        };
      }),
    );
  }
  return memo;
}

function prices(row: TurnBilling): number[] | null {
  if (row.unit_prices_json === null) return null;
  try {
    const value: unknown = JSON.parse(row.unit_prices_json);
    if (
      Array.isArray(value) &&
      value.length === COMPONENTS.length &&
      value.every((price) => typeof price === "number" && Number.isFinite(price) && price >= 0)
    )
      return value;
  } catch {
    /* Unpriceable turns carry no economic claim. */
  }
  return null;
}

/**
 * Claims each failure's recovery turn (L8 spec); an upper bound, so assumed. Reliability lane
 * (spec F2 v2 item 4): they never block or add to spend-lane claims.
 */
function wastedTurnProducer(detectorId: WastedTurnFamily): ClaimProducer {
  return {
    detectorId,
    produce(db, ctx) {
      let memo = adapterMemo.get(db);
      if (memo === undefined) {
        memo = recoveryTurns(db, ctx);
        adapterMemo.set(db, memo);
      }
      const result: Claim[] = [];
      for (const row of memo.get(detectorId) ?? []) {
        const key = turnKey(row.session_id, row.message_id);
        for (const { component, column } of COMPONENT_COLUMNS) {
          if (column === undefined) continue;
          const tokens = row[column];
          if (tokens <= 0) continue;
          result.push({
            detectorId,
            workspaceId: row.workspace_id,
            sessionId: row.session_id,
            turnKey: key,
            component,
            slice: "turn:*",
            tokens,
            assumed: true,
            lane: "reliability",
            ...(row.recId === undefined ? {} : { recId: row.recId }),
            ...(row.sidechain ? { sidechain: true as const } : {}),
          });
        }
      }
      return result;
    },
  };
}

/** Reliability-lane family ids produced by `wastedTurnProducer` (spec F2 v2 item 4). */
const RELIABILITY_LANE_FAMILY_IDS = ["C7", "C3", "C4", "C1", "C2", "C9", "D14", "D11"] as const;
/** RR U13: C6/C11 claim whole wasted turns of their own (not census recovery turns). */
const OWN_TURN_RELIABILITY_IDS = ["C6", "C11"] as const;
export const RELIABILITY_LANE_DETECTOR_IDS: ReadonlySet<string> = new Set([
  ...RELIABILITY_LANE_FAMILY_IDS,
  ...OWN_TURN_RELIABILITY_IDS,
]);

export const CLAIM_PRODUCERS: readonly ClaimProducer[] = [
  ...RELIABILITY_LANE_FAMILY_IDS.map(wastedTurnProducer),
  c6ClaimProducer,
  c11ClaimProducer,
  d1ClaimProducer,
  d10ClaimProducer,
  a1ClaimProducer,
  d6ClaimProducer,
  a2ClaimProducer,
  d7xClaimProducer,
  d2ClaimProducer,
  d8ClaimProducer,
  b1ClaimProducer,
  b3ClaimProducer,
  d4ClaimProducer,
];

/**
 * Detector ids with a spend-lane claim producer (P3.L L6): the only ids whose card headline
 * can show `allocated_u_per_wk` as a real (possibly $0) figure. Every other detector's headline
 * is null ("not estimated") — never $0, since there is nothing on the ledger to attribute.
 * Derived from `CLAIM_PRODUCERS` so a newly added spend producer is picked up automatically;
 * a newly added reliability producer must be added to `RELIABILITY_LANE_FAMILY_IDS` above.
 */
export const SPEND_LANE_DETECTOR_IDS: ReadonlySet<string> = new Set(
  CLAIM_PRODUCERS.map((producer) => producer.detectorId).filter(
    (id) => !RELIABILITY_LANE_DETECTOR_IDS.has(id),
  ),
);

export function buildClaimLedger(
  db: Db,
  ctx: DetectorContext,
  producers: readonly ClaimProducer[] = CLAIM_PRODUCERS,
): ClaimLedger {
  const rows = db
    .prepare(
      `SELECT t.message_id, t.session_id, t.workspace_id,
            t.input_tokens, t.output_tokens, t.cache_read_tokens,
            t.cache_write_5m, t.cache_write_1h, p.unit_prices_json
       FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
      WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0`,
    )
    .all(ctx.fromIso, ctx.toIso) as TurnBilling[];
  const turns = new Map(rows.map((row) => [turnKey(row.session_id, row.message_id), row]));
  const billed = new Map<string, number>();
  const billedValue = new Map<string, number>();
  for (const row of rows) {
    const unitPrices = prices(row);
    for (const [index, { component, column }] of COMPONENT_COLUMNS.entries()) {
      if (column === undefined) continue;
      const cell = JSON.stringify([turnKey(row.session_id, row.message_id), component]);
      billed.set(cell, row[column]);
      billedValue.set(cell, row[column] * (unitPrices?.[index] ?? 0));
    }
  }
  const priority = new Map<string, number>(LEDGER_PRIORITY.map((id, index) => [id, index]));
  adapterMemo.delete(db);
  resetResultClaimCache(db);
  let candidates: Claim[];
  try {
    candidates = producers.flatMap((producer) =>
      Array.from(producer.produce(db, ctx), (claim) => ({
        ...claim,
        detectorId: producer.detectorId,
      })),
    );
  } finally {
    adapterMemo.delete(db);
    resetResultClaimCache(db);
  }
  candidates.sort(
    (a, b) =>
      (priority.get(a.detectorId) ?? Number.POSITIVE_INFINITY) -
        (priority.get(b.detectorId) ?? Number.POSITIVE_INFINITY) ||
      compare(a.detectorId, b.detectorId) ||
      compare(a.turnKey, b.turnKey) ||
      compare(a.component, b.component) ||
      compare(a.slice, b.slice) ||
      compare(a.recId, b.recId) ||
      b.tokens - a.tokens,
  );
  const claims: LedgerEntry[] = [];
  const subordinate: LedgerEntry[] = [];
  const rejected: Claim[] = [];
  const owned = new Map<string, LedgerEntry[]>();
  for (const claim of candidates) {
    const row = turns.get(claim.turnKey);
    const index = COMPONENTS.indexOf(claim.component);
    const unitPrices = row && prices(row);
    const capacity = billed.get(cellKey(claim));
    const lane = laneOf(claim);
    if (
      row === undefined ||
      row.session_id !== claim.sessionId ||
      row.workspace_id !== claim.workspaceId ||
      index < 0 ||
      !Number.isSafeInteger(claim.tokens) ||
      claim.tokens <= 0 ||
      !claim.slice ||
      capacity === undefined ||
      !validV2Fields(claim) ||
      (lane === "spend" && claim.derivedFrom === undefined && !claim.recId)
    ) {
      rejected.push(claim);
      continue;
    }
    // The ledger applies the fraction: producers emit raw tokens plus `fraction`.
    const requested = Math.round(claim.tokens * (claim.fraction ?? 1));
    // An unpriced turn still owns its tokens; it just carries no value.
    const unpriced = unitPrices === null || unitPrices === undefined;
    const unitPrice = unpriced ? 0 : (unitPrices[index] ?? 0);
    const pricePerToken = Math.max(0, unitPrice - (claim.counterfactualPriceU ?? 0));
    // Nothing to claim, or a repricing worth $0 on a priced turn: owning tokens would only
    // starve lower priorities.
    if (
      requested <= 0 ||
      (!unpriced && claim.counterfactualPriceU !== undefined && pricePerToken === 0)
    ) {
      rejected.push(claim);
      continue;
    }
    const entry = (tokens: number): LedgerEntry => ({
      ...claim,
      lane,
      tokens,
      raw_tokens: claim.tokens,
      requested_tokens: requested,
      unpriced,
      value_u: tokens * pricePerToken,
    });
    if (claim.derivedFrom !== undefined) {
      subordinate.push(entry(Math.min(requested, capacity)));
      continue;
    }
    const cell = JSON.stringify([lane, claim.turnKey, claim.component]);
    const previous = owned.get(cell) ?? [];
    if (previous.some((owner) => slicesConflict(owner.slice, claim.slice))) {
      rejected.push(claim);
      continue;
    }
    // Totals use the clamped tokens; conservationReport checks requested_tokens.
    const remaining = capacity - previous.reduce((total, owner) => total + owner.tokens, 0);
    const owner = entry(Math.max(0, Math.min(requested, remaining)));
    claims.push(owner);
    previous.push(owner);
    owned.set(cell, previous);
  }
  return { claims, subordinate, rejected, billed, billedValue };
}

export interface OpenRec {
  rec_id: string;
  detector_id: string;
  scope_workspace_id: string | null;
}

/** Spend lane only: lanes overlap by design, so summing both could exceed spend. */
export function ledgerTotals(ledger: ClaimLedger, openRecs: readonly OpenRec[]) {
  const byRec = new Map<string, number>();
  const byDetector = new Map<string, number>();
  let sum_u = 0;
  for (const claim of ledger.claims) {
    if (claim.lane !== "spend") continue;
    const rec = openRecs.find(
      (item) =>
        item.detector_id === claim.detectorId &&
        (item.scope_workspace_id === claim.workspaceId || item.scope_workspace_id === null) &&
        (claim.recId === undefined || item.rec_id === claim.recId),
    );
    if (!rec) continue;
    byRec.set(rec.rec_id, (byRec.get(rec.rec_id) ?? 0) + claim.value_u);
    byDetector.set(claim.detectorId, (byDetector.get(claim.detectorId) ?? 0) + claim.value_u);
    sum_u += claim.value_u;
  }
  return { byRec, byDetector, sum_u };
}

/** `[lane, turnKey, component]`: conservation holds per lane. */
export function laneCellKey(claim: Pick<LedgerEntry, "lane" | "turnKey" | "component">): string {
  return JSON.stringify([claim.lane, claim.turnKey, claim.component]);
}

/** Checked per lane; reported cells are `laneCellKey`s. */
export function conservationReport(ledger: ClaimLedger) {
  const doubleOwned: string[] = [];
  const overbilled: string[] = [];
  const overvalued: string[] = [];
  const cells = new Map<string, LedgerEntry[]>();
  for (const claim of ledger.claims) {
    const laneCell = laneCellKey(claim);
    const owners = cells.get(laneCell) ?? [];
    if (owners.some((owner) => slicesConflict(owner.slice, claim.slice)))
      doubleOwned.push(laneCell);
    owners.push(claim);
    cells.set(laneCell, owners);
  }
  for (const [laneCell, owners] of cells) {
    const cell = cellKey(owners[0] as LedgerEntry);
    // Pre-clamp tokens: a producer over-claiming a cell is reported, not hidden. A residual
    // claim asks for the rest of the cell by design, so it is not counted.
    const specific = owners.filter((owner) => !RESIDUAL_SLICES.has(owner.slice));
    if (
      specific.reduce((sum, owner) => sum + owner.requested_tokens, 0) >
      (ledger.billed.get(cell) ?? 0)
    )
      overbilled.push(laneCell);
    // Float tolerance: values are tokens × fractional µ$ prices.
    if (
      owners.reduce((sum, owner) => sum + owner.value_u, 0) >
      (ledger.billedValue.get(cell) ?? 0) + 1e-6
    )
      overvalued.push(laneCell);
  }
  return { doubleOwned, overbilled, overvalued };
}
