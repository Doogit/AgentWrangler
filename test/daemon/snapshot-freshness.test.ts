import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDiagnosticsSnapshotService } from "../../src/daemon/diagnostics-snapshot.js";
import { createServer } from "../../src/daemon/http.js";
import { createRecsSnapshotService } from "../../src/daemon/recs-snapshot.js";
import type { openDb } from "../../src/db/open.js";
import { composeSections, topRecsSection } from "../../src/query/api/overview-view.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createFixtureDb } from "../fixtures/seed.js";

let root: string;
let db: ReturnType<typeof openDb>;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-snapshot-freshness-"));
  db = createFixtureDb(path.join(root, "seed.sqlite"));
  setQueryDb(db);
}, 30_000);

afterAll(() => {
  resetQueryDb();
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function get(
  port: number,
  route: string,
): Promise<{ meta?: { freshness?: unknown }; data: unknown }> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path: route }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      })
      .on("error", reject);
  });
}

function expectFreshness(value: unknown, status: "ready" | "recomputing"): void {
  expect(value).toMatchObject({ status });
  const { computed_at, inputs_as_of } = value as { computed_at: string; inputs_as_of: string };
  expect(Date.parse(inputs_as_of)).toBeLessThanOrEqual(Date.parse(computed_at));
}

describe("A-17 freshness on snapshot responses (P3-U4)", () => {
  it("recs, diagnostics and the top_recs section say when their snapshot was computed", async () => {
    const recs = createRecsSnapshotService();
    const diagnostics = createDiagnosticsSnapshotService({ log: () => {} });
    const server = createServer(db, 0, null, null, null, null, recs, diagnostics);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expectFreshness((await get(port, "/api/recommendations")).meta?.freshness, "ready");

      const cold = await get(port, "/api/diagnostics");
      expect(cold.meta?.freshness).toBeUndefined(); // building: nothing computed yet
      await diagnostics.prewarm(7);
      expectFreshness((await get(port, "/api/diagnostics")).meta?.freshness, "ready");

      const section = await composeSections({ top_recs: () => topRecsSection(recs) });
      expectFreshness(section.sections.top_recs?.freshness, "ready");
    } finally {
      recs.stop();
      diagnostics.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("a write to a recs input serves the snapshot as recomputing; an unrelated write does not rebuild", async () => {
    let builds = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = createRecsSnapshotService();
    const recs = createRecsSnapshotService({
      builder: async (scope) => {
        builds += 1;
        if (builds === 2) await gate;
        return { result: await first.get(scope), builtAtMs: Date.now() };
      },
    });
    const server = createServer(db, 0, null, null, null, null, recs);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expectFreshness((await get(port, "/api/recommendations")).meta?.freshness, "ready");
      expectFreshness((await get(port, "/api/recommendations")).meta?.freshness, "ready");
      expect(builds).toBe(1);
      // Like the 60 s live reconcile: rows recs never read.
      db.prepare("CREATE TABLE IF NOT EXISTS freshness_probe (x)").run();
      db.prepare("INSERT INTO freshness_probe VALUES (1)").run();
      expectFreshness((await get(port, "/api/recommendations")).meta?.freshness, "ready");
      expect(builds).toBe(1);
      db.prepare(
        "INSERT INTO user_config (key, value, updated_at) VALUES ('freshness_probe', '1', ?)",
      ).run(new Date().toISOString());
      expectFreshness((await get(port, "/api/recommendations")).meta?.freshness, "recomputing");
      expect(builds).toBe(2);
    } finally {
      release();
      recs.stop();
      first.stop();
      db.prepare("DROP TABLE IF EXISTS freshness_probe").run();
      db.prepare("DELETE FROM user_config WHERE key = 'freshness_probe'").run();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
