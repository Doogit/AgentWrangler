import { parentPort, workerData } from "node:worker_threads";
/** Read-only recommendation snapshot build on a separate SQLite connection. */
import Database from "better-sqlite3";
import { applyReadPragmas } from "../db/open.js";
import {
  type CachedAggregate,
  seedLedgerAggregates,
  usedLedgerAggregates,
} from "../query/api/ledger-aggregate.js";
import { buildRecommendations, recommendationsStateKey } from "../query/api/recommendations.js";
import {
  type CallTarget,
  seedToolCallTargets,
  toolCallTargetEntries,
} from "../query/api/tool-calls.js";
import { setQueryDb } from "../query/db-context.js";

const port = parentPort;
if (port === null) throw new Error("recommendations worker needs a parent port");
const { dbPath, scope, nowIso, toolCallTargets, ledgerAggregates } = workerData as {
  dbPath: string;
  scope?: string;
  nowIso?: string;
  toolCallTargets?: Array<[string, CallTarget | null]>;
  ledgerAggregates?: Array<[string, CachedAggregate]>;
};
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  db.pragma("query_only = ON");
  applyReadPragmas(db);
  setQueryDb(db);
  seedToolCallTargets(toolCallTargets ?? []);
  seedLedgerAggregates(ledgerAggregates ?? []);
  const builtAtMs = Date.now();
  const stateKey = recommendationsStateKey();
  const result = buildRecommendations(scope, nowIso === undefined ? new Date() : new Date(nowIso));
  port.postMessage({
    type: "result",
    result,
    stateKey,
    builtAtMs,
    toolCallTargets: toolCallTargetEntries(),
    ledgerAggregates: usedLedgerAggregates(),
  });
} catch (error) {
  port.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  db.close();
}
