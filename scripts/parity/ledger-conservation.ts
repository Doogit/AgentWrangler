/** Read-only conservation report for the selected claim-ledger window. */
import Database from "better-sqlite3";
import { buildClaimLedger, conservationReport } from "../../src/detector/claim-ledger.js";

function parseArgs(argv: string[]) {
  let dbPath: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--db") dbPath = value;
    else if (arg === "--from") from = value;
    else if (arg === "--to") to = value;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!dbPath || (from === undefined) !== (to === undefined)) {
    throw new Error("Usage: ledger-conservation.ts --db <path> [--from ISO --to ISO]");
  }
  const end = to === undefined ? new Date() : new Date(to);
  const start =
    from === undefined ? new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000) : new Date(from);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new Error("Expected valid ISO dates with --from before --to");
  }
  return { dbPath, fromIso: start.toISOString(), toIso: end.toISOString(), now: end };
}

function main() {
  const { dbPath, ...ctx } = parseArgs(process.argv);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const ledger = buildClaimLedger(db, ctx);
    const report = conservationReport(ledger);
    const byDetector: Record<string, number> = {};
    const byRec: Record<string, number> = {};
    let sum_u = 0;
    for (const claim of ledger.claims) {
      sum_u += claim.value_u;
      byDetector[claim.detectorId] = (byDetector[claim.detectorId] ?? 0) + claim.value_u;
      if (claim.recId) byRec[claim.recId] = (byRec[claim.recId] ?? 0) + claim.value_u;
    }
    console.log(
      JSON.stringify(
        {
          window: { from: ctx.fromIso, to: ctx.toIso },
          doubleOwnedSlices: report.doubleOwned.length,
          cellsOverBilled: report.overbilled.length,
          cellsOverValued: report.overvalued.length,
          ownedClaimCount: ledger.claims.length,
          rejectedClaimCount: ledger.rejected.length,
          subordinateClaimCount: ledger.subordinate.length,
          unpricedClaimCount: ledger.claims.filter((claim) => claim.unpriced).length,
          sum_u: Math.round(sum_u),
          byDetector,
          byRec,
        },
        null,
        2,
      ),
    );
    if (
      report.doubleOwned.length > 0 ||
      report.overbilled.length > 0 ||
      report.overvalued.length > 0
    )
      process.exitCode = 1;
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
