/**
 * P3.L L6 independent check (read-only): every rec card's headline `allocated_u_per_wk`
 * equals the ledger's spend-lane claims for that rec id over the card window (trailing 7d),
 * and efficiency headroom equals the whole spend lane for its window and never exceeds spend.
 * Written before the L6 implementation; it groups raw ledger claims itself rather than
 * reusing whatever aggregation the API path uses.
 *
 *   npx tsx scripts/parity/l6-card-check.ts --db <path> --now <ISO> [--from ISO --to ISO]
 */
import Database from "better-sqlite3";
import type { Db } from "../../src/db/open.js";
import { buildClaimLedger } from "../../src/detector/claim-ledger.js";
import { getEfficiencyHeadroom } from "../../src/query/api/efficiency-headroom.js";
import { buildRecommendations } from "../../src/query/api/recommendations.js";
import { setQueryDb } from "../../src/query/db-context.js";

// Spend-lane producers per design §6 (L2–L5). Every other detector has no spend producer,
// so its card must read "not estimated" (null), never $0.
const SPEND_PRODUCERS = new Set(["D1", "D10", "D2", "A1", "A2", "D7", "D8", "B1", "B3", "D4"]);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index] ?? "";
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    args.set(flag, value);
  }
  const dbPath = args.get("--db");
  const now = new Date(args.get("--now") ?? "");
  if (!dbPath || !Number.isFinite(now.getTime())) {
    throw new Error("Usage: l6-card-check.ts --db <path> --now ISO [--from ISO --to ISO]");
  }
  const to = args.get("--to") ?? now.toISOString();
  const from = args.get("--from") ?? new Date(Date.parse(to) - WEEK_MS).toISOString();
  return { dbPath, now, from, to };
}

function spendByRec(db: Db, fromIso: string, toIso: string) {
  const ledger = buildClaimLedger(db, { now: new Date(toIso), fromIso, toIso });
  const byRec = new Map<string, number>();
  let lane_u = 0;
  for (const claim of ledger.claims) {
    if (claim.lane !== "spend") continue;
    lane_u += claim.value_u;
    if (claim.recId) byRec.set(claim.recId, (byRec.get(claim.recId) ?? 0) + claim.value_u);
  }
  return { byRec, lane_u };
}

function main() {
  const { dbPath, now, from, to } = parseArgs(process.argv);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true }) as unknown as Db;
  const failures: string[] = [];
  try {
    setQueryDb(db);
    const view = buildRecommendations(undefined, now).data;
    if (view === null) throw new Error("buildRecommendations returned no data");
    const cardFrom = new Date(now.getTime() - WEEK_MS).toISOString();
    const cardLedger = spendByRec(db, cardFrom, now.toISOString());
    const cards = [
      ...view.active,
      ...view.limit_warnings,
      ...view.adopted,
      ...view.dismissed,
      ...view.history,
      ...(view.below_floor ?? []),
    ];
    const rows = [];
    const seen = new Set<string>();
    let cardSum_u = 0;
    for (const card of cards) {
      if (seen.has(card.rec_id)) continue;
      seen.add(card.rec_id);
      const allocated = (card as { allocated_u_per_wk?: number | null }).allocated_u_per_wk;
      const expected = SPEND_PRODUCERS.has(card.detector_id)
        ? Math.round(cardLedger.byRec.get(card.rec_id) ?? 0)
        : null;
      const ok =
        expected === null
          ? allocated === null
          : typeof allocated === "number" && Math.abs(allocated - expected) <= 1;
      if (!ok) failures.push(`card ${card.rec_id} (${card.detector_id}): ${allocated} != ${expected}`);
      if (typeof allocated === "number") cardSum_u += allocated;
      rows.push({
        rec: card.rec_id.slice(0, 12),
        det: card.detector_id,
        state: card.state,
        standalone: card.modeled_savings_u_per_wk,
        allocated,
        ledger: expected,
        ok,
      });
    }
    // Claims whose rec id no card shows would be silently dropped from every card.
    const orphan_u = [...cardLedger.byRec]
      .filter(([recId]) => !seen.has(recId))
      .reduce((total, [, value]) => total + value, 0);
    if (cardSum_u > Math.round(cardLedger.lane_u) + seen.size)
      failures.push(`Σ cards ${cardSum_u} > spend lane ${Math.round(cardLedger.lane_u)}`);

    const headroom = getEfficiencyHeadroom(db, { from, to }).data;
    if (headroom === null) throw new Error("getEfficiencyHeadroom returned no data");
    const lane = Math.round(spendByRec(db, from, to).lane_u);
    if (Math.abs(headroom.headroom_u_per_wk - lane) > 1)
      failures.push(`headroom ${headroom.headroom_u_per_wk} != spend lane ${lane}`);
    if (headroom.headroom_u_per_wk > headroom.actual_u_per_wk)
      failures.push(`headroom ${headroom.headroom_u_per_wk} > spend ${headroom.actual_u_per_wk}`);

    console.table(rows);
    console.log(
      JSON.stringify(
        {
          cardWindow: { from: cardFrom, to: now.toISOString() },
          cards: rows.length,
          cardSum_u,
          cardLane_u: Math.round(cardLedger.lane_u),
          orphanClaims_u: Math.round(orphan_u),
          headroom: {
            from,
            to,
            headroom_u_per_wk: headroom.headroom_u_per_wk,
            spendLane_u: lane,
            actual_u_per_wk: headroom.actual_u_per_wk,
            headroom_pct: headroom.headroom_pct,
            unclaimed_rec_count: headroom.unclaimed_rec_count,
          },
          failures,
        },
        null,
        2,
      ),
    );
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
}
