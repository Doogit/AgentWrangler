import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { getWorkerGauges, resetWorkerGauges } from "../../src/daemon/perf-monitor.js";
import { createRecsSnapshotService } from "../../src/daemon/recs-snapshot.js";
import { createRecsWorkerRunner } from "../../src/daemon/recs-worker-runner.js";
import { openDb } from "../../src/db/open.js";
import {
  recommendationTemplate,
  serializeModeledFormulaV1,
  serializeRecommendationPayloadV1,
} from "../../src/detector/privacy-contract.js";
import {
  buildRecommendations,
  listRecommendations,
  recommendationsStateKey,
} from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createFixtureDb } from "../fixtures/seed.js";

let root: string;
let dbPath: string;
let db: ReturnType<typeof openDb>;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-recs-snapshot-"));
  dbPath = path.join(root, "seed.sqlite");
  db = createFixtureDb(dbPath);
  // Any proposed card will do; D5 limit warnings are hidden from the list (P3.1-T1).
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
    VALUES (?, 'RULE', ?, ?, NULL, ?, 0, ?, ?, ?, 'PROPOSED', ?, NULL, 1, ?, 'V1_VALIDATED')`).run(
    "snapshot-warning",
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

function currentBuild(scope?: string) {
  const builtAtMs = Date.now();
  const stateKey = recommendationsStateKey();
  return { result: buildRecommendations(scope), stateKey, builtAtMs };
}

function request(
  port: number,
  route: string,
  body?: unknown,
): Promise<{
  status: number;
  data: { data: { adopted: Array<{ rec_id: string }> } };
}> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method: payload ? "POST" : "GET",
        headers: payload ? { "Content-Type": "application/json" } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            data: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("recommendation snapshots", () => {
  it("keeps adopt and status responsive during a five-second build, then shows adoption", async () => {
    const rec = listRecommendations().data?.active.find(
      (card) => card.rec_id === "snapshot-warning",
    );
    expect(rec).toBeDefined();
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    let builds = 0;
    const service = createRecsSnapshotService({
      builder: async (scope) => {
        builds += 1;
        started();
        await new Promise((resolve) => setTimeout(resolve, 5_100));
        return currentBuild(scope);
      },
    });
    const server = createServer(db, 0, null, null, null, null, service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const cold = request(port, "/api/recommendations");
      await pending;
      const start = performance.now();
      const status = await request(port, "/api/status");
      expect(status.status).toBe(200);
      expect(performance.now() - start).toBeLessThan(1_000);
      const adoptStart = performance.now();
      const adopted = await request(port, "/api/recommendations/adopt", {
        rec_id: rec?.rec_id,
        completed_change: true,
      });
      expect(adopted.status).toBe(200);
      expect(performance.now() - adoptStart).toBeLessThan(2_000);
      expect(
        (await cold).data.data.adopted.some(
          (card: { rec_id: string }) => card.rec_id === rec?.rec_id,
        ),
      ).toBe(true);
      expect(
        (await request(port, "/api/recommendations")).data.data.adopted.some(
          (card: { rec_id: string }) => card.rec_id === rec?.rec_id,
        ),
      ).toBe(true);
      expect(builds).toBeGreaterThanOrEqual(1);
    } finally {
      service.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.prepare(
        "UPDATE recommendations SET state='PROPOSED', adopted_at=NULL WHERE rec_id='snapshot-warning'",
      ).run();
      // Adopting an actionable card opens an effect cycle; clear it so the next test can adopt.
      db.prepare("DELETE FROM effect_cycles WHERE rec_id='snapshot-warning'").run();
    }
  }, 20_000);

  it("revokes a built pre-adopt snapshot on the next GET", async () => {
    const service = createRecsSnapshotService();
    const server = createServer(db, 0, null, null, null, null, service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const before = await request(port, "/api/recommendations");
      expect(before.data.data.adopted.some((card) => card.rec_id === "snapshot-warning")).toBe(
        false,
      );
      const adopted = await request(port, "/api/recommendations/adopt", {
        rec_id: "snapshot-warning",
        completed_change: true,
      });
      expect(adopted.status).toBe(200);
      const after = await request(port, "/api/recommendations");
      expect(after.data.data.adopted.some((card) => card.rec_id === "snapshot-warning")).toBe(true);
    } finally {
      service.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.prepare(
        "UPDATE recommendations SET state='PROPOSED', adopted_at=NULL WHERE rec_id='snapshot-warning'",
      ).run();
      db.prepare("DELETE FROM effect_cycles WHERE rec_id='snapshot-warning'").run();
    }
  });

  it("coalesces cold requests and serves stale snapshots while rebuilding once", async () => {
    let builds = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createRecsSnapshotService({
      builder: async (scope) => {
        builds += 1;
        if (builds === 1) await gate;
        return currentBuild(scope);
      },
    });
    try {
      const one = service.get("ws-alpha");
      const two = service.get("ws-alpha");
      expect(builds).toBe(1);
      release();
      expect(await one).toEqual(await two);
      service.markStale();
      const stale = await service.get("ws-alpha");
      expect(stale.data).not.toBeNull();
      expect(builds).toBe(2);
      await service.get("ws-alpha");
      expect(builds).toBe(2);
    } finally {
      service.stop();
    }
  });

  it("serves the snapshot stale on external DB drift and rebuilds once; a lifecycle write still forces a fresh build", async () => {
    let builds = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createRecsSnapshotService({
      builder: async (scope) => {
        builds += 1;
        if (builds === 2) await gate;
        return currentBuild(scope);
      },
    });
    try {
      const first = await service.get("ws-drift");
      expect(builds).toBe(1);
      const beforeKey = recommendationsStateKey();
      db.prepare(
        "UPDATE recommendations SET modeled_savings_u_per_wk = modeled_savings_u_per_wk + 1 WHERE rec_id = 'snapshot-warning'",
      ).run();
      expect(recommendationsStateKey()).not.toBe(beforeKey);

      const stale = await Promise.race([
        service.get("ws-drift"),
        new Promise((resolve) => setTimeout(() => resolve("blocked on rebuild"), 1_000)),
      ]);
      expect(stale).toBe(first);
      expect(builds).toBe(2);

      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await service.get("ws-drift");
      expect(builds).toBe(2);

      service.invalidate();
      await service.get("ws-drift");
      expect(builds).toBe(3);
    } finally {
      release();
      service.stop();
      db.prepare(
        "UPDATE recommendations SET modeled_savings_u_per_wk = modeled_savings_u_per_wk - 1 WHERE rec_id = 'snapshot-warning'",
      ).run();
    }
  });

  it("real worker returns the same recommendation data as the in-process builder", async () => {
    const now = new Date();
    const comparisonDb = openDb(dbPath);
    setQueryDb(comparisonDb);
    let expected: ReturnType<typeof listRecommendations>["data"];
    try {
      expected = listRecommendations(undefined, now).data;
    } finally {
      setQueryDb(db);
      comparisonDb.close();
    }
    const runner = createRecsWorkerRunner(dbPath);
    try {
      const actual = await runner.run(undefined, now);
      expect(actual.stateKey).toBe(recommendationsStateKey());
      expect(actual.result.data).toEqual(expected);
    } finally {
      runner.stop();
    }
  }, 20_000);

  it("records spawn/build-total timing under the 'recs' worker kind (P0-U2b)", async () => {
    resetWorkerGauges();
    const runner = createRecsWorkerRunner(dbPath);
    try {
      await runner.run();
      // instrumentWorkerSpawn records on the worker's "exit" event, which fires
      // asynchronously just after the runner's own promise resolves (same
      // pattern as history-worker-runner.test.ts).
      await new Promise((resolve) => setTimeout(resolve, 50));
      const gauge = getWorkerGauges().recs;
      expect(gauge).toBeDefined();
      expect(gauge?.count).toBeGreaterThanOrEqual(1);
    } finally {
      runner.stop();
      resetWorkerGauges();
    }
  }, 20_000);
});
