import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DiagnosticsBuilder,
  type HandoffCandidate,
  createDiagnosticsSnapshotService,
  createHandoffSource,
  joinHandoffs,
} from "../../src/daemon/diagnostics-snapshot.js";
import { createDiagnosticsWorkerRunner } from "../../src/daemon/diagnostics-worker-runner.js";
import { createHeavyJobGate } from "../../src/daemon/heavy-job-gate.js";
import { createServer } from "../../src/daemon/http.js";
import { getWorkerGauges, resetWorkerGauges } from "../../src/daemon/perf-monitor.js";
import {
  type RecsSnapshotService,
  createRecsSnapshotService,
} from "../../src/daemon/recs-snapshot.js";
import type { openDb } from "../../src/db/open.js";
import {
  recommendationTemplate,
  serializeModeledFormulaV1,
  serializeRecommendationPayloadV1,
} from "../../src/detector/privacy-contract.js";
import {
  type AvoidableRow,
  type DiagnosticsTriageView,
  type ReliabilityRow,
  type RiskRow,
  buildDiagnosticsTriage,
} from "../../src/query/api/diagnostics-triage.js";
import type { RecommendationsView } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { buildResponse } from "../../src/query/envelope.js";
import { createFixtureDb } from "../fixtures/seed.js";

const STAGES = ["census", "findings", "avoidable", "reliability"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function row<T>(cause_id: string, extra: Partial<T> = {}): T {
  return {
    cause_id,
    name: cause_id,
    explanation: "",
    rank: 1,
    featured: false,
    trend: "steady",
    trend_basis: "session_rate",
    handoff: null,
    patterns: [],
    sessions_affected: 1,
    sessions_affected_is_lower_bound: false,
    sessions: [],
    occurrences: 3,
    count_unit: "events",
    share: null,
    ...extra,
  } as T;
}

function view(window_days: 7 | 14 | 30 = 7): DiagnosticsTriageView {
  return {
    window_days,
    as_of: "2026-09-20T00:00:00.000Z",
    built_at: "2026-09-20T00:00:00.000Z",
    partial: false,
    tiles: {
      spend_u: 1,
      session_count: 4,
      avoidable_u: null,
      avoidable_share: null,
      friction_sessions: 1,
      friction_share: 0.25,
      fix_ready: { n: 0, m: 3 },
    },
    avoidable: {
      banner: null,
      causes: [
        row<AvoidableRow>("CONTEXT_TOO_LARGE", { rank: 1, featured: true }),
        row<AvoidableRow>("CACHE_REBUILT_MID_SESSION", { rank: 2, folded: true }),
      ],
    },
    reliability: {
      causes: [row<ReliabilityRow>("BLOCKED_BY_PERMISSIONS")],
      risk: row<RiskRow>("DESTRUCTIVE_COMMANDS_RAN", { rank: 0, risk: true, occurrences: 67 }),
    },
  };
}

function candidate(
  rec_id: string,
  detector_id: string,
  key: string | null,
  headline_u: number | null,
): HandoffCandidate {
  return { rec_id, detector_id, key, headline_u };
}

/** A recs service whose `get` returns these active cards (or throws, or never settles). */
function recsStub(
  active: () => Array<{ rec_id: string; detector_id: string }> | Error | "hang",
  history: Array<{ rec_id: string; detector_id: string }> = [],
  belowFloor: Array<{ rec_id: string; detector_id: string }> = [],
) {
  const toCard = (card: { rec_id: string; detector_id: string }) => ({
    ...card,
    modeled_savings_u_per_wk: 7,
    evidence: {},
  });
  const service: RecsSnapshotService = {
    get() {
      const cards = active();
      if (cards === "hang") return new Promise(() => {});
      if (cards instanceof Error) return Promise.reject(cards);
      return Promise.resolve(
        buildResponse(
          {
            active: cards.map(toCard),
            history: history.map(toCard),
            below_floor: belowFloor.map(toCard),
          } as unknown as RecommendationsView,
          { claim_kind: "OBS_PROXY" },
        ),
      );
    },
    peek: () => ({ state: "cold" }),
    peekCard: () => null,
    coldBuild: () => null,
    invalidate() {},
    revision: () => 0,
    markStale() {},
    stop() {},
  };
  return service;
}

/** A builder that reports four stages `stageMs` apart and counts its calls. */
function stagedBuilder(
  stageMs: number,
  calls: { n: number; windows?: number[] },
): DiagnosticsBuilder {
  return async (window, _asOf, onStage) => {
    calls.n += 1;
    calls.windows?.push(window);
    for (const stage of STAGES) {
      await sleep(stageMs);
      onStage(stage, stageMs);
    }
    return view(window);
  };
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeoutMs) throw new Error("timed out");
    await sleep(10);
  }
}

describe("joinHandoffs (KTD-7)", () => {
  it("picks the largest card per cause, nulls last, ties in list order, and counts fix_ready", () => {
    const joined = joinHandoffs(view(), [
      candidate("d2-null", "D2", "D2_LONG_FULL_CONTEXT", null),
      candidate("d2-small", "D2", "D2_LONG_FULL_CONTEXT", 5),
      candidate("d2-big-a", "D2", "D2_LONG_FULL_CONTEXT", 9),
      candidate("d2-big-b", "D2", "D2_LONG_FULL_CONTEXT", 9),
      candidate("b4-only-null", "B4", "B4_MID_SESSION_PREFIX_BREAK", null),
      candidate("c9", "C9", "C9_DENIAL_FRICTION", null),
      candidate("h1", "H1", "H1_DESTRUCTIVE_OPERATION_REPORT", null),
      candidate("unknown", "Z9", "Z9_NOPE", 100),
      candidate("no-key", "D2", null, 100),
    ]);
    const [context, cache] = joined.avoidable.causes;
    // Labels carry no arrow: the UI appends it (TriageRow), so it must not arrive doubled.
    expect(context?.handoff).toEqual({ rec_id: "d2-big-a", label: "Fix: compact earlier" });
    // A folded row still gets its hand-off; a null headline still beats no candidate.
    expect(cache?.handoff).toEqual({ rec_id: "b4-only-null", label: "Fix: keep the cache warm" });
    expect(joined.reliability.causes[0]?.handoff?.rec_id).toBe("c9");
    expect(joined.reliability.risk?.handoff).toEqual({
      rec_id: "h1",
      label: "Review 67 commands",
    });
    // n counts rows with a hand-off in both sections, excluding the risk row; m is unchanged.
    expect(joined.tiles.fix_ready).toEqual({ n: 3, m: 3 });
    expect(joined.partial).toBe(false);
  });

  it("marks the view partial with no hand-offs when there are no candidates to use", () => {
    const joined = joinHandoffs(view(), null);
    expect(joined.partial).toBe(true);
    expect(joined.avoidable.causes.every((cause) => cause.handoff === null)).toBe(true);
    expect(joined.tiles.fix_ready).toEqual({ n: 0, m: 3 });
    expect(joined).not.toHaveProperty("handoffs_pending");
  });

  it("flags handoffs_pending while recs are still building (F9)", () => {
    const joined = joinHandoffs(view(), "pending");
    expect(joined.handoffs_pending).toBe(true);
    expect(joined.partial).toBe(true);
    expect(joined.tiles.fix_ready).toEqual({ n: 0, m: 3 });
  });

  it("omits handoffs_pending once candidates are known, even when none match (F9)", () => {
    expect(joinHandoffs(view(), [])).not.toHaveProperty("handoffs_pending");
  });

  it("keeps a build-time partial after a successful join", () => {
    expect(joinHandoffs({ ...view(), partial: true }, []).partial).toBe(true);
  });

  it("RC-B: a quiet (history) card marks fix_quiet but never becomes the hand-off", () => {
    const quiet = (c: HandoffCandidate): HandoffCandidate => ({ ...c, quiet: true });
    const joined = joinHandoffs(view(), [
      quiet(candidate("d2-old", "D2", "D2_LONG_FULL_CONTEXT", 50)),
      quiet(candidate("c9-old", "C9", "C9_DENIAL_FRICTION", 50)),
      candidate("c9-live", "C9", "C9_DENIAL_FRICTION", 1),
      quiet(candidate("h1-old", "H1", "H1_DESTRUCTIVE_OPERATION_REPORT", null)),
      quiet(candidate("b4-no-key", "B4", null, 50)),
    ]);
    const [context, cache] = joined.avoidable.causes;
    expect(context).toMatchObject({ handoff: null, fix_quiet: true, quiet_rec_id: "d2-old" });
    expect(cache?.handoff).toBeNull();
    expect(cache).not.toHaveProperty("fix_quiet");
    expect(cache).not.toHaveProperty("quiet_rec_id");
    // An active card wins: the row has a hand-off and no quiet flag.
    expect(joined.reliability.causes[0]).toMatchObject({ handoff: { rec_id: "c9-live" } });
    expect(joined.reliability.causes[0]).not.toHaveProperty("fix_quiet");
    expect(joined.reliability.risk).toMatchObject({
      handoff: null,
      fix_quiet: true,
      quiet_rec_id: "h1-old",
    });
    expect(joined.tiles.fix_ready).toEqual({ n: 1, m: 3 });
  });

  it("RC-B: a below-floor card is a Small fix hand-off only when the cause has no active card", () => {
    const small = (c: HandoffCandidate): HandoffCandidate => ({ ...c, small: true });
    const quiet = (c: HandoffCandidate): HandoffCandidate => ({ ...c, quiet: true });
    const joined = joinHandoffs(view(), [
      // D2: small beats quiet; the larger small card wins.
      quiet(candidate("d2-old", "D2", "D2_LONG_FULL_CONTEXT", 50)),
      small(candidate("d2-tiny", "D2", "D2_LONG_FULL_CONTEXT", 1)),
      small(candidate("d2-less-tiny", "D2", "D2_LONG_FULL_CONTEXT", 2)),
      // C9: an active card beats a bigger small one.
      small(candidate("c9-small", "C9", "C9_DENIAL_FRICTION", 50)),
      candidate("c9-live", "C9", "C9_DENIAL_FRICTION", 1),
      // H1 (risk row): small only.
      small(candidate("h1-small", "H1", "H1_DESTRUCTIVE_OPERATION_REPORT", null)),
    ]);
    const [context, cache] = joined.avoidable.causes;
    expect(context).toMatchObject({
      handoff: { rec_id: "d2-less-tiny", label: "Small fix" },
      fix_small: true,
    });
    expect(context).not.toHaveProperty("fix_quiet");
    expect(cache?.handoff).toBeNull();
    expect(joined.reliability.causes[0]).toMatchObject({ handoff: { rec_id: "c9-live" } });
    expect(joined.reliability.causes[0]).not.toHaveProperty("fix_small");
    expect(joined.reliability.risk).toMatchObject({
      handoff: { rec_id: "h1-small", label: "Small fix" },
      fix_small: true,
    });
    // fix_ready counts active hand-offs only.
    expect(joined.tiles.fix_ready).toEqual({ n: 1, m: 3 });
  });

  it("RC-B: keeps the build's silent lists through the join", () => {
    const silent = [{ cause_id: "MODEL_BIGGER_THAN_NEEDED", name: "m" }];
    const base = view();
    const joined = joinHandoffs(
      {
        ...base,
        avoidable: { ...base.avoidable, silent },
        reliability: { ...base.reliability, silent },
      },
      [],
    );
    expect(joined.avoidable.silent).toEqual(silent);
    expect(joined.reliability.silent).toEqual(silent);
  });
});

describe("diagnostics snapshot service", () => {
  it("returns building at once for a cold window, with progress rising, then the view", async () => {
    const calls = { n: 0 };
    const service = createDiagnosticsSnapshotService({
      builder: stagedBuilder(120, calls),
      log: () => {},
    });
    try {
      const start = performance.now();
      const first = service.get(7);
      expect(performance.now() - start).toBeLessThan(100);
      expect(first.status).toBe("building");
      if (first.status !== "building") return;
      expect(first.progress).toMatchObject({
        step: 0,
        steps: 4,
        stage: "Counting failed and blocked commands",
        expected_ms: null,
      });
      const steps: number[] = [];
      let state = service.get(7);
      while (state.status === "building") {
        steps.push(state.progress.step);
        await sleep(30);
        state = service.get(7);
      }
      expect(state.status).toBe("ready");
      expect(Math.max(...steps)).toBeGreaterThan(0);
      expect(steps).toEqual([...steps].sort((a, b) => a - b));
      expect(calls.n).toBe(1);
    } finally {
      service.stop();
    }
  });

  it("builds the window that was asked for", async () => {
    const calls = { n: 0, windows: [] as number[] };
    const service = createDiagnosticsSnapshotService({
      builder: stagedBuilder(1, calls),
      log: () => {},
    });
    try {
      await service.prewarm(30);
      const state = service.get(30);
      expect(state.status === "ready" && state.view.window_days).toBe(30);
      expect(calls.windows).toEqual([30]);
    } finally {
      service.stop();
    }
  });

  it("reports the last logged build duration as expected_ms, across a restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-diag-durations-"));
    const durationsFile = path.join(dir, "diagnostics-build-ms.json");
    const logged: string[] = [];
    const calls = { n: 0 };
    const first = createDiagnosticsSnapshotService({
      builder: stagedBuilder(40, calls),
      log: (line) => logged.push(line),
      durationsFile,
    });
    try {
      await first.prewarm(14);
    } finally {
      first.stop();
    }
    const match = logged.join("\n").match(/14d build: (\d+) ms/);
    expect(match).not.toBeNull();
    const restarted = createDiagnosticsSnapshotService({
      builder: stagedBuilder(40, calls),
      log: () => {},
      durationsFile,
    });
    try {
      const building = restarted.get(14);
      expect(building.status === "building" && building.progress.expected_ms).toBe(
        Number(match?.[1]),
      );
      // A window never built → null.
      const other = restarted.get(30);
      expect(other.status === "building" && other.progress.expected_ms).toBeNull();
    } finally {
      restarted.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves the old snapshot with refreshing after markStale and rebuilds exactly once", async () => {
    const calls = { n: 0 };
    const service = createDiagnosticsSnapshotService({
      builder: stagedBuilder(30, calls),
      log: () => {},
    });
    try {
      await service.prewarm(7);
      expect(service.get(7)).toMatchObject({ status: "ready", refreshing: false });
      service.markStale();
      expect(service.get(7)).toMatchObject({ status: "ready", refreshing: true });
      service.get(7);
      service.get(7);
      expect(calls.n).toBe(2);
      await until(() => {
        const state = service.get(7);
        return state.status === "ready" && !state.refreshing;
      });
      expect(calls.n).toBe(2);
    } finally {
      service.stop();
    }
  });

  it("rebuilds again when markStale lands during a build", async () => {
    const calls = { n: 0 };
    const service = createDiagnosticsSnapshotService({
      builder: stagedBuilder(30, calls),
      log: () => {},
    });
    try {
      const building = service.prewarm(7);
      service.markStale();
      await building;
      expect(service.get(7)).toMatchObject({ status: "ready", refreshing: true });
      expect(calls.n).toBe(2);
    } finally {
      service.stop();
    }
  });

  it("rebuilds when the 10-minute bucket turns over", async () => {
    const calls = { n: 0 };
    let clock = Date.parse("2026-09-20T00:01:00.000Z");
    const service = createDiagnosticsSnapshotService({
      builder: stagedBuilder(1, calls),
      log: () => {},
      now: () => clock,
    });
    try {
      await service.prewarm(30);
      expect(service.get(30)).toMatchObject({ status: "ready", refreshing: false });
      clock += 10 * 60_000;
      expect(service.get(30)).toMatchObject({ status: "ready", refreshing: true });
      expect(calls.n).toBe(2);
    } finally {
      service.stop();
    }
  });

  it("reports a failed cold build once, then retries on the next GET", async () => {
    let fail = true;
    const service = createDiagnosticsSnapshotService({
      builder: async (window) => {
        if (fail) throw new Error("boom");
        return view(window);
      },
      log: () => {},
    });
    try {
      expect(service.get(7).status).toBe("building");
      await until(() => service.get(7).status === "failed");
      fail = false;
      expect(service.get(7).status).toBe("building");
      await until(() => service.get(7).status === "ready");
    } finally {
      service.stop();
    }
  });

  it("keeps serving the old snapshot after a failed rebuild and backs off for a minute", async () => {
    let clock = Date.parse("2026-09-20T00:01:00.000Z");
    let builds = 0;
    const service = createDiagnosticsSnapshotService({
      builder: async (window) => {
        builds += 1;
        if (builds > 1) throw new Error("boom");
        return view(window);
      },
      log: () => {},
      now: () => clock,
    });
    try {
      await service.prewarm(7);
      service.markStale();
      service.get(7);
      await until(() => {
        const state = service.get(7);
        return state.status === "ready" && !state.refreshing;
      });
      expect(builds).toBe(2);
      expect(service.get(7).status).toBe("ready");
      expect(builds).toBe(2);
      clock += 60_000;
      service.get(7);
      expect(builds).toBe(3);
    } finally {
      service.stop();
    }
  });

  it("drops a build that finishes after stop", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-diag-stop-"));
    const durationsFile = path.join(dir, "diagnostics-build-ms.json");
    const service = createDiagnosticsSnapshotService({
      builder: stagedBuilder(20, { n: 0 }),
      log: () => {},
      durationsFile,
    });
    const building = service.prewarm(7);
    service.stop();
    await building;
    await sleep(120);
    expect(fs.existsSync(durationsFile)).toBe(false);
    await service.prewarm(7);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("with the seed DB", () => {
  let root: string;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-diag-snapshot-"));
    dbPath = path.join(root, "seed.sqlite");
    db = createFixtureDb(dbPath);
    // A real V1 card: its template_id lives on the row, not in the card's evidence.
    const templateId = "D2_LONG_FULL_CONTEXT";
    const definition = recommendationTemplate(templateId);
    if (!definition) throw new Error("missing recommendation template");
    const payload = {
      version: 1 as const,
      template_id: templateId,
      facts: {
        session_ids: [],
        qualifying_session_count: 3,
        qualifying_turn_count: 620,
        raw_context_average_tokens_per_turn: 200_000,
        cap_weighted_burn_tokens_per_week: 1,
        cache_read_tokens_per_week: 1,
        cap_read_coefficient: 0.1,
      },
    };
    db.prepare(`INSERT INTO recommendations
      (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
       modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
       state, created_at, dismissed_until, contract_version, template_id, contract_status)
      VALUES (?, 'RULE', ?, ?, NULL, ?, 5000000, ?, ?, ?, 'PROPOSED', ?, NULL, 1, ?, 'V1_VALIDATED')`).run(
      "diag-handoff-d2",
      definition.detector_id,
      definition.category,
      definition.lever,
      serializeModeledFormulaV1(payload),
      serializeRecommendationPayloadV1(payload),
      definition.target_metric,
      new Date().toISOString(),
      templateId,
    );
    setQueryDb(db);
  }, 30_000);

  afterAll(() => {
    resetQueryDb();
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function serve(
    recs: RecsSnapshotService,
    diagnostics: ReturnType<typeof createDiagnosticsSnapshotService>,
  ) {
    const server = createServer(db, 0, null, null, null, null, recs, diagnostics);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const request = (route: string) =>
      new Promise<{
        status: number;
        body: { data: Record<string, unknown> } & Record<string, unknown>;
      }>((resolve, reject) => {
        http
          .get({ hostname: "127.0.0.1", port, path: route }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              }),
            );
          })
          .on("error", reject);
      });
    const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    return { request, close };
  }

  const handoffOf = (body: { data: Record<string, unknown> }) =>
    (body.data.avoidable as { causes: AvoidableRow[] }).causes[0]?.handoff ?? null;

  it("validates the window and accepts 7, 14 and 30", async () => {
    const service = createDiagnosticsSnapshotService({
      builder: stagedBuilder(1, { n: 0 }),
      log: () => {},
    });
    const { request, close } = await serve(
      recsStub(() => []),
      service,
    );
    try {
      for (const value of ["9", "5", "abc", ""]) {
        const response = await request(`/api/diagnostics?window=${value}`);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ code: "INVALID_QUERY" });
      }
      for (const [route, days] of [
        ["/api/diagnostics", 7],
        ["/api/diagnostics?window=7", 7],
        ["/api/diagnostics?window=14", 14],
        ["/api/diagnostics?window=30", 30],
      ] as const) {
        const response = await request(route);
        expect(response.status).toBe(200);
        expect(response.body.data).toMatchObject({ window_days: days });
      }
    } finally {
      service.stop();
      await close();
    }
  });

  it("joins a real V1 card's hand-off, then drops it on the next GET after it is adopted", async () => {
    const calls = { n: 0 };
    const recs = createRecsSnapshotService();
    const service = createDiagnosticsSnapshotService({
      builder: stagedBuilder(1, calls),
      log: () => {},
    });
    const { request, close } = await serve(recs, service);
    try {
      await service.prewarm(7);
      const before = await request("/api/diagnostics?window=7");
      expect(handoffOf(before.body)).toEqual({
        rec_id: "diag-handoff-d2",
        label: "Fix: compact earlier",
      });
      expect(before.body.data).toMatchObject({ tiles: { fix_ready: { n: 1, m: 3 } } });
      db.prepare(
        "UPDATE recommendations SET state = 'ADOPTED' WHERE rec_id = 'diag-handoff-d2'",
      ).run();
      recs.invalidate();
      const after = await request("/api/diagnostics?window=7");
      expect(handoffOf(after.body)).toBeNull();
      expect(calls.n).toBe(1);
    } finally {
      db.prepare(
        "UPDATE recommendations SET state = 'PROPOSED' WHERE rec_id = 'diag-handoff-d2'",
      ).run();
      recs.stop();
      service.stop();
      await close();
    }
  });

  it("does not wait on a recs rebuild: past the cap it uses the last cards seen, else partial", async () => {
    let mode: "ok" | "hang" = "ok";
    const source = createHandoffSource(
      recsStub(() =>
        mode === "hang" ? "hang" : [{ rec_id: "diag-handoff-d2", detector_id: "D2" }],
      ),
      db,
      100,
    );
    const fresh = await source.get();
    expect(fresh).toEqual([candidate("diag-handoff-d2", "D2", "D2_LONG_FULL_CONTEXT", 7)]);
    mode = "hang";
    const start = performance.now();
    expect(await source.get()).toEqual(fresh);
    expect(performance.now() - start).toBeLessThan(300);
    // While that slow fetch is still pending, later GETs don't wait at all.
    const again = performance.now();
    expect(await source.get()).toEqual(fresh);
    expect(performance.now() - again).toBeLessThan(50);
    const cold = createHandoffSource(
      recsStub(() => "hang"),
      db,
      100,
    );
    // F9: no cards yet and no failure seen means the first recs build is still running.
    expect(await cold.get()).toBe("pending");
  });

  it("RC-B: history cards come back quiet, keyed only while still PROPOSED", async () => {
    const source = createHandoffSource(
      recsStub(
        () => [],
        [
          { rec_id: "diag-handoff-d2", detector_id: "D2" },
          { rec_id: "not-a-row", detector_id: "D2" },
        ],
      ),
      db,
      100,
    );
    expect(await source.get()).toEqual([
      { ...candidate("diag-handoff-d2", "D2", "D2_LONG_FULL_CONTEXT", 7), quiet: true },
      { ...candidate("not-a-row", "D2", null, 7), quiet: true },
    ]);
  });

  it("RC-B: below-floor cards come back small, after active and before history", async () => {
    const source = createHandoffSource(
      recsStub(
        () => [],
        [{ rec_id: "not-a-row", detector_id: "D2" }],
        [{ rec_id: "diag-handoff-d2", detector_id: "D2" }],
      ),
      db,
      100,
    );
    expect(await source.get()).toEqual([
      { ...candidate("diag-handoff-d2", "D2", "D2_LONG_FULL_CONTEXT", 7), small: true },
      { ...candidate("not-a-row", "D2", null, 7), quiet: true },
    ]);
  });

  it("reports a recs failure as null, not pending, even when the retry is slow (F9)", async () => {
    let mode: "error" | "hang" = "error";
    const source = createHandoffSource(
      recsStub(() => (mode === "hang" ? "hang" : new Error("recs down"))),
      db,
      100,
    );
    expect(await source.get()).toBeNull();
    mode = "hang";
    expect(await source.get()).toBeNull();
  });

  it("answers a cold window at once, stays fast during a slow build, then serves the joined view", async () => {
    const calls = { n: 0 };
    const service = createDiagnosticsSnapshotService({
      builder: stagedBuilder(1_300, calls),
      log: () => {},
    });
    const { request, close } = await serve(
      recsStub(() => [{ rec_id: "diag-handoff-d2", detector_id: "D2" }]),
      service,
    );
    try {
      for (const [route, days] of [
        ["/api/diagnostics", 7],
        ["/api/diagnostics?window=30", 30],
      ] as const) {
        const start = performance.now();
        const cold = await request(route);
        expect(performance.now() - start).toBeLessThan(300);
        expect(cold.status).toBe(200);
        expect(cold.body.data).toMatchObject({ status: "building", window_days: days });
      }
      const statusStart = performance.now();
      expect((await request("/api/status")).status).toBe(200);
      expect(performance.now() - statusStart).toBeLessThan(500);
      await until(() => service.get(7).status === "ready", 10_000);
      const ready = await request("/api/diagnostics?window=7");
      expect(ready.body.data).toMatchObject({
        status: "ready",
        refreshing: false,
        window_days: 7,
        tiles: { fix_ready: { n: 1, m: 3 } },
      });
      expect(typeof ready.body.data.snapshot_at).toBe("string");
      // With a snapshot, a GET during a ≥5 s rebuild still answers well under 300 ms.
      service.markStale();
      const start = performance.now();
      const stale = await request("/api/diagnostics?window=7");
      expect(performance.now() - start).toBeLessThan(300);
      expect(stale.body.data).toMatchObject({ status: "ready", refreshing: true });
      expect(calls.n).toBe(3);
    } finally {
      service.stop();
      await close();
    }
  }, 20_000);

  it("serves a partial view, not a 500, when the recs snapshot fails", async () => {
    const service = createDiagnosticsSnapshotService({
      builder: stagedBuilder(1, { n: 0 }),
      log: () => {},
    });
    const { request, close } = await serve(
      recsStub(() => new Error("recs down")),
      service,
    );
    try {
      await service.prewarm(7);
      const response = await request("/api/diagnostics?window=7");
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ status: "ready", partial: true });
      // A failure is not "still checking": the UI shows "No fix yet" and stops polling (F9).
      expect(response.body.data).not.toHaveProperty("handoffs_pending");
    } finally {
      service.stop();
      await close();
    }
  });

  it("returns 500 once when a cold build fails, without the exception text", async () => {
    const service = createDiagnosticsSnapshotService({
      builder: async () => {
        throw new Error("secret detail");
      },
      log: () => {},
    });
    const { request, close } = await serve(
      recsStub(() => []),
      service,
    );
    try {
      expect((await request("/api/diagnostics?window=7")).body.data).toMatchObject({
        status: "building",
      });
      // The failure is reported once, to the first GET after the build ends.
      let response = { status: 200, body: {} as Record<string, unknown> };
      const start = performance.now();
      while (response.status === 200 && performance.now() - start < 5_000) {
        await sleep(20);
        response = await request("/api/diagnostics?window=7");
      }
      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).not.toContain("secret detail");
    } finally {
      service.stop();
      await close();
    }
  });

  it("the production service builds in a worker: a cold GET answers at once, then the view", async () => {
    const service = createDiagnosticsSnapshotService({ dbPath, log: () => {} });
    try {
      const start = performance.now();
      expect(service.get(7).status).toBe("building");
      expect(performance.now() - start).toBeLessThan(300);
      await until(() => service.get(7).status === "ready", 20_000);
    } finally {
      service.stop();
    }
  }, 30_000);

  it("real worker builds the same non-empty view as the in-process builder, twice", async () => {
    const asOf = "2026-01-02T00:00:00.000Z";
    const expected = buildDiagnosticsTriage(db, 7, new Date(asOf), { warn: () => {} });
    expect(expected.tiles.session_count).toBeGreaterThan(0);
    const runner = createDiagnosticsWorkerRunner(dbPath);
    try {
      for (let i = 0; i < 2; i += 1) {
        const stages: string[] = [];
        const actual = await runner.run(7, asOf, (stage) => stages.push(stage));
        expect({ ...actual, built_at: "" }).toEqual({ ...expected, built_at: "" });
        expect(stages).toEqual(STAGES);
      }
    } finally {
      runner.stop();
    }
  }, 30_000);

  it("build duration excludes the wait in a held heavy-job gate", async () => {
    const gate = createHeavyJobGate();
    let release = () => {};
    const held = gate.run(
      "recs",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const logged: string[] = [];
    const service = createDiagnosticsSnapshotService({ dbPath, gate, log: (l) => logged.push(l) });
    try {
      const done = service.prewarm(7);
      await sleep(1500);
      release();
      await held;
      await done;
      const match = logged.join("\n").match(/7d build: (\d+) ms/);
      expect(match).not.toBeNull();
      expect(Number(match?.[1])).toBeLessThan(1000);
    } finally {
      service.stop();
    }
  }, 30_000);

  it("records spawn/build-total timing under the 'diagnostics' worker kind (P0-U2b)", async () => {
    resetWorkerGauges();
    const runner = createDiagnosticsWorkerRunner(dbPath);
    try {
      await runner.run(7, "2026-01-02T00:00:00.000Z", () => {});
      // instrumentWorkerSpawn records on the worker's "exit" event, which fires
      // asynchronously just after the runner's own promise resolves (same
      // pattern as history-worker-runner.test.ts).
      await new Promise((resolve) => setTimeout(resolve, 50));
      const gauge = getWorkerGauges().diagnostics;
      expect(gauge).toBeDefined();
      expect(gauge?.count).toBeGreaterThanOrEqual(1);
    } finally {
      runner.stop();
      resetWorkerGauges();
    }
  }, 30_000);
});
