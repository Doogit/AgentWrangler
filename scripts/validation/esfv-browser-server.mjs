/**
 * ESFV browser-acceptance server. Isolated fixed-clock ESF5 corpus replay plus
 * ESFV-specific seed extensions. No ingestion, operator files or provider actions.
 *
 * Extensions over esf5-browser-server.mjs:
 * - A second (open) measurement cycle on rec cycle-d2-02 so the ESFV-6 cycle
 *   timeline and the ESFV-1 "Measuring · day N of M" progress header render.
 * - Two USER-reported terminal work records in ws-shared so the ESFV-2 outcome
 *   bar renders non-zero terminal segments alongside the UNREPORTED ones.
 */
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createHandler } from "../../src/daemon/http.ts";
import { setReady } from "../../src/daemon/readiness.ts";
import { createEffectEngine } from "../../src/effects/index.ts";
import { setQueryDb } from "../../src/query/db-context.ts";
import { ESF5_AS_OF, ESF5_FROM, createEsf5Db } from "../../test/fixtures/esf5-corpus.ts";
import {
  createEsf5ObservationProvider,
  esf5EffectManifest,
  seedEsf5Effects,
} from "../../test/fixtures/esf5-effects.ts";

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

// ESFV-6: second cycle on the rolled-back rec. Cycle #1 (cycle-d2-02) is
// terminal (STOPPED via external rollback), so a retrack opens cycle #2.
const ESFV_RETRACK_APPLIED_AT = "2026-08-12T00:00:00.000Z";
const retrack = createEffectEngine(db, {
  observer: createEsf5ObservationProvider(),
  now: () => new Date(ESF5_AS_OF),
  idFactory: () => "cycle-d2-retrack",
});
retrack.track({
  recId: esf5EffectManifest.cycles.rollbackMid,
  detectorId: "D2",
  targetMetric: "d2-floor-context",
  scope: { workspaceId: "ws-esf5-d2" },
  cohort: { state: "RECONCILED" },
  trackingRequestedAt: ESFV_RETRACK_APPLIED_AT,
  appliedAt: ESFV_RETRACK_APPLIED_AT,
  applicationSource: "USER_ATTESTED",
  idempotencyKey: "esfv-retrack-cycle-d2-02",
});

// ESFV-2: reported terminal outcomes in ws-shared (revision 1 supersedes the
// corpus's ACTIVE/UNREPORTED revision 0 on two new records).
for (const [id, outcome] of [
  ["00000000-0000-4000-8000-00000000e5f1", "USEFUL"],
  ["00000000-0000-4000-8000-00000000e5f2", "UNSUCCESSFUL"],
]) {
  db.prepare(`INSERT INTO work_records (work_record_id, workspace_id, created_at, updated_at, current_revision_no)
    VALUES (?,?,?,?,0)`).run(id, "ws-shared", ESF5_FROM, ESF5_FROM);
  db.prepare(`INSERT INTO work_record_revisions (work_record_id, revision_no, task_intent, outcome_state, repair_band, effort_band, feedback_source, recorded_at, reported_at, mutation_id)
    VALUES (?,0,'IMPLEMENT',?,'UNREPORTED','UNREPORTED','USER_CLOSEOUT',?,?,?)`).run(
    id,
    outcome,
    ESF5_FROM,
    ESF5_FROM,
    `esfv-create-${id}`,
  );
}

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
  if (path === "/__esfv")
    return send(200, {
      corpus: "ESF5+ESFV",
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
  handler = createHandler(db, port, resolve("dist/ui"), "synthetic-esfv-browser-token");
  console.log(`ESFV_SYNTHETIC_URL=http://127.0.0.1:${port}`);
});
function stop() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
