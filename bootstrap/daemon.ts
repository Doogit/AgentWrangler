/**
 * bootstrap/daemon.ts — throwaway proof of stack (S0 exit criterion only).
 * Replaced by real code at Phase 1 gate. Do NOT import from src/.
 *
 * Proves:
 *   1. better-sqlite3 native module installs and opens an in-memory DB.
 *   2. WAL + FK pragmas apply without error.
 *   3. Node http server binds to 127.0.0.1 and serves a hello page.
 *   4. Non-loopback Host headers are refused (loopback-only policy).
 */

import * as http from "node:http";
import * as process from "node:process";
import Database from "better-sqlite3";

const VERSION = "0.0.1";
const PORT = 47821;
const HOST = "127.0.0.1";

// ── 1. SQLite in-memory proof ─────────────────────────────────────────────────
const db = new Database(":memory:");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Note: WAL is not supported on in-memory DBs; pragma silently stays 'memory'.
// WAL IS the target for on-disk DBs (Phase 1). We verify the pragma API works
// and FK enforcement is on — the only things provable in-memory.
const jm = (db.pragma("journal_mode") as Array<{ journal_mode: string }>)[0]?.journal_mode;
const fk = (db.pragma("foreign_keys") as Array<{ foreign_keys: number }>)[0]?.foreign_keys;

console.log(`AgentWrangler daemon v${VERSION}`);
console.log(`Node ${process.version}`);
console.log(
  `SQLite in-memory: journal_mode=${jm} (WAL not supported in-memory), foreign_keys=${fk}`,
);

if (fk !== 1) {
  console.error("FATAL: foreign_keys pragma failed");
  process.exit(1);
}

// ── 2. Smoke-mode: exit after DB proof (used by CI + npm run smoke) ──────────
const isSmoke = process.argv.includes("--smoke");
if (isSmoke) {
  console.log("smoke: DB ok — exiting");
  db.close();
  process.exit(0);
}

// ── 3. HTTP server on loopback ────────────────────────────────────────────────
const ALLOWED_HOSTS = new Set([HOST, `${HOST}:${PORT}`, "localhost", `localhost:${PORT}`]);

const server = http.createServer((req, res) => {
  const host = req.headers.host ?? "";
  // Refuse non-loopback Host headers
  if (!ALLOWED_HOSTS.has(host)) {
    res.writeHead(421, { "Content-Type": "text/plain" });
    res.end("Misdirected Request — loopback only");
    return;
  }

  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>AgentWrangler</title></head>
<body>
  <h1>AgentWrangler daemon v${VERSION}</h1>
  <p>Node ${process.version} · SQLite journal_mode=${jm} · foreign_keys=${fk}</p>
  <p>Stack proof OK. UI build not yet served — run <code>npm run build:ui</code> first.</p>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
});

server.listen(PORT, HOST, () => {
  console.log(`Listening on http://${HOST}:${PORT}`);
});

process.on("SIGINT", () => {
  server.close();
  db.close();
  process.exit(0);
});
