/**
 * test/shared/overview-view-schema.test.ts — P1-U1 Overview section contract.
 *
 * Oracle: real daemon output on the shared seed (`scripts/build-shared-seed.ts`,
 * the DB verify:app uses), served through the HTTP handler (`createServer` →
 * `createHandler`) with the Overview's own requests, not hand-written fixtures.
 * Each section schema must accept what the legacy endpoint returns today,
 * reject a wrong type in a field the Overview reads, and tolerate unknown
 * extra fields.
 *
 * Synthetic fixture data only (SEC-101).
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { stopScanWorkers } from "../../src/daemon/scan-offload.js";
import { type Db, openDb } from "../../src/db/open.js";
import { getFlavorDecomposition } from "../../src/query/api/spend-flavor.js";
import { getCacheWriteTrend } from "../../src/query/api/trends.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import {
  type OverviewSectionName,
  overviewSectionSchemas,
} from "../../src/shared/schemas/overview-view.js";

function get(port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode !== 200) {
            reject(new Error(`${path} returned ${res.statusCode}: ${body}`));
            return;
          }
          resolve(JSON.parse(body));
        });
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/** `.data` of an ApiResponse envelope. */
async function data(port: number, path: string): Promise<Record<string, unknown>> {
  const body = (await get(port, path)) as { data: Record<string, unknown> };
  return body.data;
}

let scratchRoot: string;
let server: http.Server;
let db: Db;
const seed = {} as Record<OverviewSectionName, Record<string, unknown>>;

beforeAll(async () => {
  // The shared seed shifts its turns to ~1 day before now, so the Overview's
  // own 7d preset requests see the data.
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-overview-schema-"));
  const dbPath = path.join(scratchRoot, "shared-seed.sqlite");
  childProcess.execFileSync(
    process.execPath,
    ["--import", "tsx/esm", "scripts/build-shared-seed.ts", dbPath],
    { cwd: path.resolve(import.meta.dirname, "../.."), stdio: "pipe" },
  );
  db = openDb(dbPath);
  setQueryDb(db);
  server = createServer(db, 0, null);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const kpis = await data(port, "/api/overview?preset=7d");
  const trends = (await get(port, "/api/trends?preset=7d&bucket=day")) as {
    data: Record<string, unknown>;
    meta: { window: { from: string; to: string } };
  };
  // The prior window, derived exactly as OverviewPage does.
  const { from, to } = trends.meta.window;
  const priorFrom = new Date(Date.parse(from) - (Date.parse(to) - Date.parse(from)));
  const prior = new URLSearchParams({ from: priorFrom.toISOString(), to: from, bucket: "day" });
  const hot = (await get(port, "/api/hot-sessions?preset=7d")) as unknown[];
  const recs = await data(port, "/api/recommendations");
  seed.kpis = kpis;
  seed.workspaces = await data(port, "/api/workspaces?preset=7d");
  seed.trends = trends.data;
  seed.trends_prior = await data(port, `/api/trends?${prior.toString()}`);
  // The standalone routes were removed (PZ); call the query functions directly.
  seed.flavor = getFlavorDecomposition({ preset: "7d" }).data as unknown as Record<string, unknown>;
  seed.cache_write = getCacheWriteTrend({ preset: "7d" }, "day").data as unknown as Record<
    string,
    unknown
  >;
  seed.weekly_sessions = { rows: hot.slice(0, 5), cost_equiv_u: kpis.cost_equiv_u };
  seed.live = await data(port, "/api/live");
  seed.status = (await get(port, "/api/status")) as Record<string, unknown>;
  seed.top_recs = {
    active: recs.active,
    adopted: recs.adopted,
    active_groups: recs.active_groups,
  };
  seed.linkage = await data(port, "/api/outcomes/linkage");
  seed.hook_config = await data(port, "/api/hook-config");
}, 60_000);

afterAll(async () => {
  await stopScanWorkers(); // overview sections read on a scan worker that holds the DB file open
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  resetQueryDb();
  db.close();
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

const SECTIONS = Object.keys(overviewSectionSchemas) as OverviewSectionName[];

/** A wrong type in a field each section's render path reads. */
const MUTATIONS: Record<OverviewSectionName, (d: Record<string, unknown>) => unknown> = {
  kpis: (d) => ({ ...d, cost_equiv_u: "12" }),
  workspaces: (d) => ({ ...d, items: "not-an-array" }),
  trends: (d) => ({ ...d, buckets: [{ bucket: "2026-01-01", cost_equiv_u: null, turns: 1 }] }),
  trends_prior: (d) => ({ ...d, buckets: {} }),
  flavor: (d) => ({ ...d, flavors: [{ flavor: "cache_write_5m", weighted_share: "0.5" }] }),
  cache_write: (d) => ({ ...d, spike_buckets: [1] }),
  weekly_sessions: (d) => ({ ...d, rows: [{ session_id: 7 }] }),
  live: (d) => ({ ...d, items: [{ workspace_id: null }] }),
  status: (d) => ({ ...d, sessions: "3" }),
  top_recs: (d) => ({ ...d, active: "none" }),
  linkage: (d) => ({ ...d, linkage_rate: "high" }),
  hook_config: (d) => ({ ...d, installed: "yes" }),
};

describe("overview-view section schemas (P1-U1)", () => {
  it("covers every Overview section", () => {
    expect(SECTIONS.sort()).toEqual(Object.keys(MUTATIONS).sort());
  });

  // `live` items and adopted recs are empty on the seed; their row schemas are
  // exercised by the mutation cases only.
  it("the seed is not vacuous: spend, workspaces, buckets, sessions and recs", () => {
    expect((seed.top_recs.active as unknown[]).length).toBeGreaterThan(0);
    expect((seed.cache_write.buckets as unknown[]).length).toBeGreaterThan(0);
    expect(seed.kpis.cost_equiv_u).toBeGreaterThan(0);
    expect((seed.workspaces.items as unknown[]).length).toBeGreaterThan(0);
    expect((seed.trends.buckets as unknown[]).length).toBeGreaterThan(0);
    expect((seed.weekly_sessions.rows as unknown[]).length).toBeGreaterThan(0);
    expect((seed.flavor.flavors as unknown[]).length).toBeGreaterThan(0);
  });

  it.each(SECTIONS)("%s: real daemon output on the seed passes", (section) => {
    const result = overviewSectionSchemas[section].safeParse(seed[section]);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it.each(SECTIONS)("%s: a wrong type is rejected without throwing", (section) => {
    const mutated = MUTATIONS[section](seed[section]);
    const result = overviewSectionSchemas[section].safeParse(mutated);
    expect(result.success).toBe(false);
  });

  it.each(SECTIONS)("%s: an unknown extra field is accepted and kept", (section) => {
    const result = overviewSectionSchemas[section].safeParse({
      ...seed[section],
      future_field: { added: "later" },
    });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).future_field).toEqual({ added: "later" });
  });

  it("a missing required field is a section error", () => {
    const { cost_equiv_u: _dropped, ...rest } = seed.kpis;
    expect(overviewSectionSchemas.kpis.safeParse(rest).success).toBe(false);
  });
});
