/** Isolated fixed-clock corpus replay. No ingestion, operator files or provider actions. */
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createHandler } from "../../src/daemon/http.ts";
import { setReady } from "../../src/daemon/readiness.ts";
import { setQueryDb } from "../../src/query/db-context.ts";
import { ESF5_AS_OF, ESF5_FROM, createEsf5Db } from "../../test/fixtures/esf5-corpus.ts";
import { seedEsf5Effects } from "../../test/fixtures/esf5-effects.ts";

const NativeDate = Date;
globalThis.Date = class extends NativeDate {
  constructor(...args) {
    super(...(args.length ? args : [ESF5_AS_OF]));
  }
  static now() {
    return NativeDate.parse(ESF5_AS_OF);
  }
};
const db = createEsf5Db();
seedEsf5Effects(db);
setQueryDb(db);
setReady();
let handler;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const send = (status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (path === "/__esf5")
    return send(200, {
      corpus: "ESF5",
      from: ESF5_FROM,
      to: ESF5_AS_OF,
      mode: "synthetic-only",
      windowPolicy:
        "Resource requests use explicit fixed corpus bounds; preset selection is not evaluated by this harness.",
    });
  if (path === "/api/status")
    return send(200, {
      sessions: db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n,
      turns: db.prepare("SELECT COUNT(*) AS n FROM turns").get().n,
      files_seen: 0,
      files_parsed: 0,
      scan_state: "complete",
    });
  const safeRead =
    /^\/api\/(overview|workspaces|sessions|trends|cost-per-success|esf|work-records|recommendations|token|ready)(\/|$)/.test(
      path,
    );
  const safeWrite =
    path.startsWith("/api/work-records") ||
    /^\/api\/esf\/effects\/(stop|close|attest-rollback|track)$/.test(path);
  if (path.startsWith("/api/") && !(req.method === "GET" ? safeRead : safeWrite))
    return send(503, { error: "Unavailable in isolated synthetic replay" });
  // An explicit replay input, not a fake API response. Queries and UI consume
  // actual application routes. Record preset-label limitations independently.
  if (
    /^\/api\/(overview|workspaces|sessions|trends|cost-per-success)(\/|$)/.test(path) ||
    path === "/api/esf/observations"
  ) {
    url.searchParams.delete("preset");
    url.searchParams.set("from", ESF5_FROM);
    url.searchParams.set("to", ESF5_AS_OF);
    req.url = `${path}?${url.searchParams}`;
  }
  handler(req, res);
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  handler = createHandler(db, port, resolve("dist/ui"), "synthetic-esf5-browser-token");
  console.log(`ESF5_SYNTHETIC_URL=http://127.0.0.1:${port}`);
});
function stop() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
