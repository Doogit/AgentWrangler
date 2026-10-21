/** Read-only aggregate timing probe; prints counts and timings, never row data. */
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { loadConfig } from "../src/daemon/config.js";
import { sessionDiagnosticCategories } from "../src/query/api/diagnostics.js";
import { getHotSessionsPage } from "../src/query/api/hot-sessions.js";
import { listWorkspaces } from "../src/query/api/overview.js";
import { sessionTopDrivers } from "../src/query/api/session-drivers.js";
import { setQueryDb } from "../src/query/db-context.js";
import { hotSessionsByCost } from "../src/query/spend.js";

const db = new Database(loadConfig().dbPath, { readonly: true, fileMustExist: true });
setQueryDb(db);
const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
console.log(
  JSON.stringify({
    corpus: {
      sessions: count("sessions"),
      turns: count("turns"),
      recommendations: count("recommendations"),
    },
  }),
);
const sevenDays = new Date(Date.now() - 7 * 86_400_000).toISOString();
const thirtyDays = new Date(Date.now() - 30 * 86_400_000).toISOString();
function probe(label: string, run: () => unknown) {
  const start = performance.now();
  const result = run();
  console.log(
    JSON.stringify({
      label,
      ms: Math.round(performance.now() - start),
      bytes: Buffer.byteLength(JSON.stringify(result)),
      rows: Array.isArray((result as { rows?: unknown[] }).rows)
        ? (result as { rows: unknown[] }).rows.length
        : ((result as { data?: { items?: unknown[] } }).data?.items?.length ?? 0),
    }),
  );
}
for (const [label, window] of [
  ["7d", { from: sevenDays, to: "9999-12-31T23:59:59.999Z" }],
  ["30d", { from: thirtyDays, to: "9999-12-31T23:59:59.999Z" }],
] as const) {
  probe(`sessions-${label}-10`, () => getHotSessionsPage({ window, limit: 10 }));
  probe(`sessions-${label}-50`, () => getHotSessionsPage({ window, limit: 50 }));
}
probe("sessions-all-50", () => getHotSessionsPage({ limit: 50 }));
probe("sessions-all-200", () => getHotSessionsPage({ limit: 200 }));
probe("session-sql-all-201", () => ({ rows: hotSessionsByCost(db, 201) }));
probe("session-categories", () => ({ rows: [...sessionDiagnosticCategories(db)] }));
const firstRows = hotSessionsByCost(db, 50, undefined, {
  activeWindow: { from: sevenDays, to: "9999-12-31T23:59:59.999Z" },
});
probe("session-sql-7d-50", () => ({
  rows: hotSessionsByCost(db, 50, undefined, {
    activeWindow: { from: sevenDays, to: "9999-12-31T23:59:59.999Z" },
  }),
}));
probe("session-drivers-50", () => ({ rows: [...sessionTopDrivers(db, firstRows)] }));
probe("workspaces-7d", () => listWorkspaces({ preset: "7d" }));
probe("workspaces-all", () => listWorkspaces({ from: "1970-01-01T00:00:00.000Z" }));
db.close();
