/** Bounded, query-time evidence for recommendation triggers. IDs and aggregates only. */
import type { Db } from "../../db/open.js";
import { type ClaimLedger, buildClaimLedger } from "../../detector/claim-ledger.js";
import { GLOBAL_WORKSPACE_ID } from "../../detector/context-probe.js";
import { d11Outcome } from "../../detector/turn-claim.js";
import {
  type LedgerAggregate,
  aggregateClaims,
  aggregateLedger,
  isClosedWindow,
  ledgerFingerprint,
  rememberAggregate,
  takeSeededAggregate,
  windowCacheKey,
} from "./ledger-aggregate.js";
import type { CardTrigger, CardTriggerEvidence } from "./rec-actions/types.js";
import type { RecommendationCard } from "./recommendations.js";

type Window = NonNullable<CardTrigger["window"]>;
type SessionRow = { session_id: string; turn_count: number };
type RankedSession = CardTriggerEvidence["sessions"][number];
/** What ranking a card's sessions needs, available before the card is built. */
type RankInput = Pick<
  RecommendationCard,
  "rec_id" | "detector_id" | "scope_workspace_id" | "evidence" | "last_seen_week_start"
> & { session_ids: string[] };

function anchorWindow(
  card: Pick<RecommendationCard, "evidence" | "last_seen_week_start">,
  fallback: Window | null,
): Window | null {
  const persisted = card.evidence.window;
  if (persisted && typeof persisted === "object" && !Array.isArray(persisted)) {
    const window = persisted as Record<string, unknown>;
    if (typeof window.from === "string" && typeof window.to === "string")
      return { from: window.from, to: window.to };
  }
  const week = card.last_seen_week_start;
  if (week) {
    const from = Date.parse(week);
    if (Number.isFinite(from))
      return { from: week, to: new Date(from + 7 * 86_400_000).toISOString() };
  }
  return fallback;
}

function validWindow(window: Window | null): window is Window {
  if (window === null) return false;
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  return Number.isFinite(from) && Number.isFinite(to) && from < to;
}

/** A request-local aggregate cache: each distinct evidence window is evaluated once. */
export class RecEvidenceContext {
  private readonly aggregates = new Map<string, LedgerAggregate>();
  private readonly cohorts = new Map<string, RankedSession[] | null>();

  /** `now` (a bulk build only) lets closed windows reuse aggregates from the previous build. */
  constructor(
    private readonly db: Db,
    private readonly now: Date | null = null,
  ) {}

  /** Builds the window's full ledger. Not retained: callers read `aggregate()`. */
  ledger(window: Window): ClaimLedger {
    return buildClaimLedger(this.db, {
      now: new Date(window.to),
      fromIso: window.from,
      toIso: window.to,
    });
  }

  /** The window's slim ledger aggregate; the full ledger is garbage as soon as it is reduced. */
  aggregate(window: Window): LedgerAggregate {
    const key = `${window.from}\n${window.to}`;
    let aggregate = this.aggregates.get(key);
    if (!aggregate) {
      const closed = this.now !== null && isClosedWindow(this.db, window, this.now);
      const cacheKey = closed ? windowCacheKey(window, ledgerFingerprint(this.db, window)) : null;
      aggregate = cacheKey === null ? undefined : takeSeededAggregate(cacheKey);
      if (!aggregate) {
        aggregate = aggregateLedger(this.ledger(window));
        if (cacheKey !== null) rememberAggregate(cacheKey, aggregate);
      }
      this.aggregates.set(key, aggregate);
    }
    return aggregate;
  }

  /**
   * The finding's whole cohort, most claimed spend first then most turns: D1 and D11 count every
   * eligible session in the window, C5 its one finding session. Null for other detectors.
   */
  private cohort(card: RankInput, window: Window): RankedSession[] | null {
    // The card's rank and its evidence both ask; the cohort is queried once.
    const key = `${card.rec_id}\n${window.from}\n${window.to}`;
    if (!this.cohorts.has(key)) this.cohorts.set(key, this.queryCohort(card, window));
    return this.cohorts.get(key) ?? null;
  }

  private queryCohort(card: RankInput, window: Window): RankedSession[] | null {
    let rows: SessionRow[] | null = null;
    if (card.detector_id === "D1") rows = this.d1Sessions(card, window);
    else if (card.detector_id === "D11") rows = this.d11Sessions(card, window);
    else if (card.detector_id === "C5") rows = this.c5Sessions(card, window);
    if (rows === null) return null;
    const claims = card.detector_id === "C5" ? null : this.claims(card, window);
    const sessions = rows.map((row) => ({
      session_id: row.session_id,
      claimed_u: claims?.get(row.session_id) ?? null,
      turn_count: row.turn_count,
    }));
    return sessions.sort(
      (a, b) =>
        (b.claimed_u ?? -1) - (a.claimed_u ?? -1) ||
        b.turn_count - a.turn_count ||
        a.session_id.localeCompare(b.session_id),
    );
  }

  /**
   * The finding's sessions by contribution (review 3 B8): the cohort's order where there is one,
   * else the stored sessions by claimed spend, ties in stored order.
   */
  sessionRank(card: RankInput, fallbackWindow: Window | null): string[] {
    const window = anchorWindow(card, fallbackWindow);
    if (!validWindow(window)) return card.session_ids;
    const cohort = this.cohort(card, window);
    if (cohort !== null) return cohort.map((session) => session.session_id);
    if (card.session_ids.length < 2) return card.session_ids;
    const claims = this.claims(card, window);
    return [...card.session_ids].sort((a, b) => (claims.get(b) ?? -1) - (claims.get(a) ?? -1));
  }

  enrich(card: RecommendationCard, fallbackWindow: Window | null): void {
    const window = anchorWindow(card, fallbackWindow);
    if (!card.trigger) return;
    card.trigger.window = window;
    if (!validWindow(window)) return;
    const cohort = this.cohort({ ...card, session_ids: card.trigger.session_ids }, window);
    if (cohort === null) return;
    // The card shows the trigger's own list, the one its prompt carries (review 3 B8); a listed
    // session outside the cohort (an evidence row read over another window) has no claim or turns.
    const byId = new Map(cohort.map((session) => [session.session_id, session]));
    card.trigger.evidence = {
      session_count: cohort.length,
      sessions: card.trigger.session_ids.map(
        (id) => byId.get(id) ?? { session_id: id, claimed_u: null, turn_count: 0 },
      ),
    };
  }

  private d1Sessions(card: RankInput, window: Window): SessionRow[] | null {
    const probeId = card.evidence.probe_id;
    const component = card.evidence.component;
    if (typeof probeId !== "string" || (component !== "MEMORY" && component !== "CLAUDE_MD"))
      return null;
    const source = this.db
      .prepare("SELECT workspace_id, component FROM context_inventory WHERE probe_id = ?")
      .get(probeId) as { workspace_id: string; component: string } | undefined;
    if (
      !source ||
      source.component !== component ||
      (card.scope_workspace_id === null
        ? source.workspace_id !== GLOBAL_WORKSPACE_ID
        : source.workspace_id !== card.scope_workspace_id)
    )
      return null;
    const workspaceFilter =
      card.scope_workspace_id === null ? "t.workspace_id != ?" : "t.workspace_id = ?";
    const eligible =
      component === "MEMORY"
        ? "(t.is_sidechain = 0 OR EXISTS (SELECT 1 FROM subagent_meta sm WHERE sm.agent_id = t.agent_id AND sm.agent_type = 'fork'))"
        : "(t.is_sidechain = 0 OR NOT EXISTS (SELECT 1 FROM subagent_meta sm WHERE sm.agent_id = t.agent_id AND sm.agent_type IN ('Explore', 'Plan')))";
    return this.db
      .prepare(`SELECT t.session_id, COUNT(*) AS turn_count FROM turns t
      WHERE ${workspaceFilter} AND t.ts >= ? AND t.ts < ? AND t.provisional = 0
        AND ${eligible} GROUP BY t.session_id`)
      .all(card.scope_workspace_id ?? GLOBAL_WORKSPACE_ID, window.from, window.to) as SessionRow[];
  }

  private d11Sessions(card: RankInput, window: Window): SessionRow[] | null {
    const tool = card.evidence.higher_error_tool;
    if (tool !== "Bash" && tool !== "PowerShell") return null;
    if (card.scope_workspace_id === null) return null;
    // Only calls the detector counts as a shell failure (`d11Outcome`) put a session in the cohort.
    const failed = (
      this.db
        .prepare(`SELECT e.session_id, e.exit_class,
        json_extract(c.content_json, '$.command') AS command_text,
        json_extract(c.content_json, '$.error') AS error_text
        FROM tool_events e
        JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
        LEFT JOIN tool_event_content c ON c.event_id = e.event_id
        WHERE s.workspace_id = ? AND e.ts >= ? AND e.ts < ?
          AND e.tool_name = ? AND e.exit_class = 'ERROR'`)
        .all(card.scope_workspace_id, window.from, window.to, tool) as {
        session_id: string;
        exit_class: string;
        command_text: string | null;
        error_text: string | null;
      }[]
    ).filter((row) => d11Outcome(row.exit_class, row.command_text, row.error_text) === "ERROR");
    const ids = [...new Set(failed.map((row) => row.session_id))];
    if (ids.length === 0) return [];
    const turns = this.db.prepare(`SELECT COUNT(*) AS n FROM turns
      WHERE session_id = ? AND ts >= ? AND ts < ? AND provisional = 0 AND is_sidechain = 0`);
    return ids.map((session_id) => ({
      session_id,
      turn_count: (turns.get(session_id, window.from, window.to) as { n: number }).n,
    }));
  }

  private c5Sessions(card: RankInput, window: Window): SessionRow[] | null {
    const ids = card.session_ids;
    if (ids.length !== 1 || card.scope_workspace_id === null) return null;
    const row = this.db
      .prepare(`SELECT s.session_id,
      COUNT(t.message_id) AS turn_count FROM sessions s
      JOIN turns t ON t.session_id = s.session_id AND t.ts >= ? AND t.ts < ?
        AND t.provisional = 0
      WHERE s.session_id = ? AND s.workspace_id = ? GROUP BY s.session_id`)
      .get(window.from, window.to, ids[0], card.scope_workspace_id) as SessionRow | undefined;
    return row ? [row] : null;
  }

  private claims(card: RankInput, window: Window): Map<string, number> {
    const claims = new Map<string, number>();
    for (const claim of aggregateClaims(this.aggregate(window))) {
      if (
        claim.detectorId !== card.detector_id ||
        claim.unpriced ||
        (card.detector_id === "D1" && claim.recId !== card.rec_id) ||
        (card.detector_id === "D11" && claim.workspaceId !== card.scope_workspace_id)
      )
        continue;
      claims.set(claim.sessionId, (claims.get(claim.sessionId) ?? 0) + claim.value_u);
    }
    return claims;
  }
}
