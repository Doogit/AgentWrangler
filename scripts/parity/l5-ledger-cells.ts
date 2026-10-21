/**
 * P3.L L5 helper: spend-lane tokens owned per cell by every producer EXCEPT D4, as the
 * `--others` input of `l5-d4-oracle.ts`. Output: { cells: { "[turnKey,component]": tokens } }.
 */
import * as fs from "node:fs";
import Database from "better-sqlite3";
import { buildClaimLedger, CLAIM_PRODUCERS } from "../../src/detector/claim-ledger.js";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i] ?? "", process.argv[i + 1] ?? "");
const dbPath = args.get("--db");
const out = args.get("--out");
if (!dbPath || !out)
  throw new Error("Usage: l5-ledger-cells.ts --db <path> --out <json> [--from ISO --to ISO]");
const to = new Date(args.get("--to") ?? Date.now());
const from = new Date(args.get("--from") ?? to.getTime() - 7 * 86_400_000);

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const ledger = buildClaimLedger(
  db,
  { fromIso: from.toISOString(), toIso: to.toISOString(), now: to },
  CLAIM_PRODUCERS.filter((p) => p.detectorId !== "D4"),
);
const cells: Record<string, number> = {};
for (const c of ledger.claims) {
  if (c.lane !== "spend") continue;
  const key = JSON.stringify([c.turnKey, c.component]);
  cells[key] = (cells[key] ?? 0) + c.tokens;
}
fs.writeFileSync(out, JSON.stringify({ cells }));
console.log(`${Object.keys(cells).length} spend cells → ${out}`);
