/**
 * test/query/trends.test.ts — spendByBucket reconciliation + API route test.
 *
 * Key assertion: bucket SUM reconciles with globalSpend for the same window.
 *
 * Fixture aggregates (from test/fixtures/seed.ts):
 *   global reconciled cost_equiv_u = 99_125 μUSD across 9 turns
 *   All turns fall on 2026-01-01 (ts offsets 0–305 minutes from BASE_TS)
 *   1 provisional turn (sess-b2) is excluded from reconciled totals.
 */

import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { getTrends } from "../../src/query/api/trends.js";
import { capWeightedTokens } from "../../src/query/cap-weighted.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { globalSpend } from "../../src/query/spend.js";
import {
  capWeightedByBucket,
  sessionCostSeries,
  spendByBucket,
  spendByBucketAndModel,
  spendByBucketAndWorkspace,
} from "../../src/query/trends.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const T_FROM = "2025-01-01T00:00:00.000Z";
const T_TO = "2027-01-01T00:00:00.000Z";

// ── Direct query tests ────────────────────────────────────────────────────────

describe("spendByBucket", () => {
  it("day bucket: all fixture turns fall in at most 2 local-day buckets (UTC offset boundary)", () => {
    // Turns span 2026-01-01T00:00Z–2026-01-01T05:05Z UTC.
    // With 'localtime', a UTC-behind timezone (e.g. UTC-5) may split them over
    // 2025-12-31 and 2026-01-01 local. UTC+ zones keep them on one day.
    // We assert the global sum, not the specific date label.
    const db = createInMemoryFixtureDb();
    const rows = spendByBucket(db, T_FROM, T_TO, "day");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBeLessThanOrEqual(2); // at most cross-midnight boundary
    const totalTurns = rows.reduce((s, r) => s + r.turns, 0);
    const totalCost = rows.reduce((s, r) => s + r.cost_equiv_u, 0);
    expect(totalTurns).toBe(9);
    expect(totalCost).toBe(99_125);
    db.close();
  });

  it("week bucket: single week covering all fixture turns", () => {
    const db = createInMemoryFixtureDb();
    const rows = spendByBucket(db, T_FROM, T_TO, "week");
    expect(rows.length).toBe(1);
    expect(rows[0]?.turns).toBe(9);
    expect(rows[0]?.cost_equiv_u).toBe(99_125);
    db.close();
  });

  it("month bucket: single month covering all fixture turns", () => {
    const db = createInMemoryFixtureDb();
    const rows = spendByBucket(db, T_FROM, T_TO, "month");
    expect(rows.length).toBe(1);
    expect(rows[0]?.bucket).toBe("2026-01");
    expect(rows[0]?.turns).toBe(9);
    expect(rows[0]?.cost_equiv_u).toBe(99_125);
    db.close();
  });

  it("RECONCILIATION: bucket SUM equals globalSpend for same window", () => {
    const db = createInMemoryFixtureDb();
    const globalRow = globalSpend(db, T_FROM, T_TO);
    const dayBuckets = spendByBucket(db, T_FROM, T_TO, "day");
    const bucketSum = dayBuckets.reduce((s, r) => s + r.cost_equiv_u, 0);
    expect(bucketSum).toBe(globalRow.cost_equiv_u);
    db.close();
  });

  it("workspace filter: scoped to ws-alpha returns only ws-alpha cost", () => {
    const db = createInMemoryFixtureDb();
    // ws-alpha: 7 turns, 49_775 μUSD (29_175 + 18_800 + 1_800)
    const rows = spendByBucket(db, T_FROM, T_TO, "day", "ws-alpha");
    expect(rows.length).toBe(1);
    expect(rows[0]?.turns).toBe(7);
    expect(rows[0]?.cost_equiv_u).toBe(49_775);
    db.close();
  });

  it("empty window: returns no rows", () => {
    const db = createInMemoryFixtureDb();
    const rows = spendByBucket(db, "2020-01-01T00:00:00.000Z", "2021-01-01T00:00:00.000Z", "day");
    expect(rows.length).toBe(0);
    db.close();
  });

  it("provisional turn excluded: turn count is 9, not 10 (10th is provisional)", () => {
    const db = createInMemoryFixtureDb();
    const rows = spendByBucket(db, T_FROM, T_TO, "day");
    const totalTurns = rows.reduce((s, r) => s + r.turns, 0);
    expect(totalTurns).toBe(9); // 10th turn (msg-b2-1) has provisional=1
    db.close();
  });
});

describe("spendByBucketAndModel", () => {
  it("returns one row per (bucket, model) with correct turn counts", () => {
    const db = createInMemoryFixtureDb();
    const rows = spendByBucketAndModel(db, T_FROM, T_TO, "day");
    // Fixture has 2 models: claude-sonnet (6 turns), claude-haiku (3 turns)
    expect(rows.length).toBe(2);
    const sonnet = rows.find((r) => r.model === "claude-sonnet");
    const haiku = rows.find((r) => r.model === "claude-haiku");
    expect(sonnet?.turns).toBe(6);
    expect(haiku?.turns).toBe(3);
    db.close();
  });

  it("model rows sum to same total as spendByBucket", () => {
    const db = createInMemoryFixtureDb();
    const buckets = spendByBucket(db, T_FROM, T_TO, "day");
    const modelRows = spendByBucketAndModel(db, T_FROM, T_TO, "day");
    const bucketSum = buckets.reduce((s, r) => s + r.cost_equiv_u, 0);
    const modelSum = modelRows.reduce((s, r) => s + r.cost_equiv_u, 0);
    expect(modelSum).toBe(bucketSum);
    db.close();
  });
});

describe("spendByBucketAndWorkspace", () => {
  it("returns one row per (bucket, workspace) with project_slug", () => {
    const db = createInMemoryFixtureDb();
    const rows = spendByBucketAndWorkspace(db, T_FROM, T_TO, "day");
    expect(rows.length).toBe(2);
    const alpha = rows.find((r) => r.workspace_id === "ws-alpha");
    const beta = rows.find((r) => r.workspace_id === "ws-beta");
    expect(alpha?.project_slug).toBe("project-alpha");
    expect(alpha?.cost_equiv_u).toBe(49_775);
    expect(beta?.cost_equiv_u).toBe(49_350);
    db.close();
  });
});

describe("sessionCostSeries", () => {
  it("returns only RECONCILED sessions within the window", () => {
    const db = createInMemoryFixtureDb();
    // 4 RECONCILED sessions: sess-a1, sess-a2, sess-a3, sess-b1
    // 1 LIVE session: sess-b2 (excluded)
    const rows = sessionCostSeries(db, T_FROM, T_TO);
    expect(rows.length).toBe(4);
    const ids = rows.map((r) => r.session_id);
    expect(ids).toContain("sess-a1");
    expect(ids).toContain("sess-b1");
    expect(ids).not.toContain("sess-b2");
    db.close();
  });

  it("includes project_slug and cost_equiv_u from sessions table", () => {
    const db = createInMemoryFixtureDb();
    const rows = sessionCostSeries(db, T_FROM, T_TO);
    const a1 = rows.find((r) => r.session_id === "sess-a1");
    expect(a1?.project_slug).toBe("project-alpha");
    expect(a1?.cost_equiv_u).toBe(29_175);
    db.close();
  });

  it("workspace filter returns only sessions for that workspace", () => {
    const db = createInMemoryFixtureDb();
    const rows = sessionCostSeries(db, T_FROM, T_TO, "ws-beta");
    // Only sess-b1 (RECONCILED); sess-b2 is LIVE
    expect(rows.length).toBe(1);
    expect(rows[0]?.session_id).toBe("sess-b1");
    db.close();
  });
});

// ── capWeightedByBucket ───────────────────────────────────────────────────────

describe("capWeightedByBucket", () => {
  it("RECONCILIATION: SUM of per-bucket cap_weighted_tokens equals capWeightedTokens for same window+coeff", () => {
    const db = createInMemoryFixtureDb();
    const coeff = 0.1;
    const buckets = capWeightedByBucket(db, T_FROM, T_TO, "day", coeff);
    const bucketSum = buckets.reduce((s, r) => s + r.cap_weighted_tokens, 0);
    const globalRows = capWeightedTokens(db, { fromIso: T_FROM, toIso: T_TO, coeff });
    const globalTotal = globalRows.reduce((s, r) => s + r.cap_weighted_tokens, 0);
    // Single-bucket fixture: exact equality; multi-bucket: |diff| <= bucketCount.
    expect(Math.abs(bucketSum - globalTotal)).toBeLessThanOrEqual(buckets.length);
    db.close();
  });

  it("excludes provisional turns (same guarantee as spendByBucket)", () => {
    const db = createInMemoryFixtureDb();
    const rows = capWeightedByBucket(db, T_FROM, T_TO, "day", 0.1);
    const totalTurns = rows.reduce((s, r) => s + r.turns, 0);
    expect(totalTurns).toBe(9); // 10th turn (msg-b2-1) has provisional=1
    db.close();
  });

  it("workspace filter scopes to ws-alpha only", () => {
    const db = createInMemoryFixtureDb();
    const alpha = capWeightedByBucket(db, T_FROM, T_TO, "day", 0.1, "ws-alpha");
    const alphaTurns = alpha.reduce((s, r) => s + r.turns, 0);
    expect(alphaTurns).toBe(7); // ws-alpha: 7 reconciled turns
    db.close();
  });

  it("empty window returns no rows", () => {
    const db = createInMemoryFixtureDb();
    const rows = capWeightedByBucket(
      db,
      "2020-01-01T00:00:00.000Z",
      "2021-01-01T00:00:00.000Z",
      "day",
      0.1,
    );
    expect(rows.length).toBe(0);
    db.close();
  });
});

// ── /api/trends HTTP route ───────────────────────────────────────────────────

describe("adoption markers", () => {
  function insertMarker(
    db: ReturnType<typeof createInMemoryFixtureDb>,
    recId: string,
    adoptedAt: string,
    state: string,
    workspaceId: string | null,
  ): void {
    db.prepare(
      `INSERT INTO recommendations
         (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
          modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
          state, created_at, adopted_at)
       VALUES (?, 'RULE', 'D4', 'MODEL', ?, ?, NULL, '{}', '{}',
               'model_mix_opus_fraction', ?, ?, ?)`,
    ).run(recId, workspaceId, `Lever ${recId}`, state, adoptedAt, adoptedAt);
  }

  it.each([
    ["day", "2026-01-15"],
    ["week", "2026-02"],
    ["month", "2026-01"],
  ] as const)(
    "normalizes %s marker coordinates with the chart bucket expression",
    (bucket, expected) => {
      const db = createInMemoryFixtureDb();
      setQueryDb(db);
      try {
        insertMarker(db, `marker-${bucket}`, "2026-01-15T12:00:00.000Z", "ADOPTED", "ws-alpha");

        const data = getTrends(
          { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" },
          bucket,
        ).data;

        expect(data?.adoption_markers).toEqual([
          expect.objectContaining({
            rec_id: `marker-${bucket}`,
            adopted_at: "2026-01-15T12:00:00.000Z",
            bucket: expected,
          }),
        ]);
      } finally {
        resetQueryDb();
        db.close();
      }
    },
  );

  it("uses half-open boundaries, lifecycle filtering, and exact workspace scope", () => {
    const db = createInMemoryFixtureDb();
    setQueryDb(db);
    try {
      insertMarker(db, "marker-from", "2026-01-01T00:00:00.000Z", "ADOPTED", "ws-alpha");
      insertMarker(
        db,
        "marker-measured",
        "2026-01-10T00:00:00.000Z",
        "MEASURED_EFFECTIVE",
        "ws-beta",
      );
      insertMarker(
        db,
        "marker-no-effect",
        "2026-01-15T00:00:00.000Z",
        "MEASURED_NO_EFFECT",
        "ws-beta",
      );
      insertMarker(db, "marker-global", "2026-01-20T00:00:00.000Z", "MEASURING", null);
      insertMarker(db, "marker-proposed", "2026-01-25T00:00:00.000Z", "PROPOSED", "ws-alpha");
      insertMarker(db, "marker-to", "2026-02-01T00:00:00.000Z", "ADOPTED", "ws-alpha");
      const filter = {
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-02-01T00:00:00.000Z",
      };

      const globalIds = getTrends(filter, "day").data?.adoption_markers.map((m) => m.rec_id);
      expect(globalIds).toEqual([
        "marker-from",
        "marker-measured",
        "marker-no-effect",
        "marker-global",
      ]);

      const workspaceIds = getTrends(filter, "day", "ws-alpha").data?.adoption_markers.map(
        (m) => m.rec_id,
      );
      expect(workspaceIds).toEqual(["marker-from"]);
    } finally {
      resetQueryDb();
      db.close();
    }
  });
});

function makeRequest(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET", headers: {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("/api/trends route", () => {
  let server: http.Server;
  let port: number;

  beforeAll(
    () =>
      new Promise<void>((resolve, reject) => {
        const db = createInMemoryFixtureDb();
        setQueryDb(db);
        server = createServer(db, 0, null);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as { port: number };
          port = addr.port;
          resolve();
        });
        server.on("error", reject);
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resetQueryDb();
          resolve();
        });
      }),
  );

  it("GET /api/trends returns 200 with correct shape", async () => {
    const r = await makeRequest(port, `/api/trends?from=${T_FROM}&to=${T_TO}&bucket=day`);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as {
      data: {
        bucket: string;
        buckets: Array<{ bucket: string; cost_equiv_u: number; turns: number }>;
        sessions: Array<{ session_id: string }>;
        by_model: Array<{ model: string }>;
        by_workspace: Array<{ workspace_id: string }>;
        cap_weighted: Array<{ bucket: string; cap_weighted_tokens: number; turns: number }>;
        cap_read_coeff: number;
      } | null;
      meta: { claim_kind: string; metric_definition_version: string };
    };
    expect(body.data).not.toBeNull();
    expect(body.meta.claim_kind).toBe("LIST_EQUIV");
    expect(body.meta.metric_definition_version).toBe("observe-1");
    expect(body.data?.bucket).toBe("day");
    expect(typeof body.data?.cap_read_coeff).toBe("number");
    expect(Array.isArray(body.data?.cap_weighted)).toBe(true);
  });

  it("GET /api/trends bucket sum reconciles with /api/overview", async () => {
    const [trendsResp, overviewResp] = await Promise.all([
      makeRequest(port, `/api/trends?from=${T_FROM}&to=${T_TO}&bucket=day`),
      makeRequest(port, `/api/overview?from=${T_FROM}&to=${T_TO}`),
    ]);
    const trendsBody = JSON.parse(trendsResp.body) as {
      data: { buckets: Array<{ cost_equiv_u: number }> } | null;
    };
    const overviewBody = JSON.parse(overviewResp.body) as {
      data: { cost_equiv_u: number } | null;
    };
    const bucketSum = (trendsBody.data?.buckets ?? []).reduce((s, r) => s + r.cost_equiv_u, 0);
    expect(bucketSum).toBe(overviewBody.data?.cost_equiv_u ?? -1);
    expect(bucketSum).toBe(99_125);
  });

  it("GET /api/trends?bucket=week returns week bucket key", async () => {
    const r = await makeRequest(port, `/api/trends?from=${T_FROM}&to=${T_TO}&bucket=week`);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { data: { bucket: string } | null };
    expect(body.data?.bucket).toBe("week");
  });

  it("GET /api/trends?bucket=month returns month bucket key", async () => {
    const r = await makeRequest(port, `/api/trends?from=${T_FROM}&to=${T_TO}&bucket=month`);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { data: { bucket: string } | null };
    expect(body.data?.bucket).toBe("month");
  });

  it("GET /api/trends with invalid bucket defaults to day", async () => {
    const r = await makeRequest(port, `/api/trends?from=${T_FROM}&to=${T_TO}&bucket=badvalue`);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { data: { bucket: string } | null };
    expect(body.data?.bucket).toBe("day");
  });

  it("GET /api/trends?workspace_id=ws-alpha scopes results", async () => {
    const r = await makeRequest(
      port,
      `/api/trends?from=${T_FROM}&to=${T_TO}&bucket=day&workspace_id=ws-alpha`,
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as {
      data: { buckets: Array<{ cost_equiv_u: number; turns: number }> } | null;
    };
    const buckets = body.data?.buckets ?? [];
    expect(buckets.length).toBe(1);
    expect(buckets[0]?.turns).toBe(7);
    expect(buckets[0]?.cost_equiv_u).toBe(49_775);
  });
});
