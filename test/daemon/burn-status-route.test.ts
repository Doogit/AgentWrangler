/**
 * Tests for the GET /api/burn-status route and getBurnStatus handler.
 *
 * The router calls getBurnStatus() with no arg (default reader), so there is
 * no HTTP-level injection seam for the reader.  Shape assertions use the
 * exported function directly with stub readers; the HTTP suite verifies
 * route reachability and the response envelope.
 */
import * as http from "node:http";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import type { UsageReader } from "../../src/oauth/usage.js";
import { getBurnStatus } from "../../src/query/api/burn-status.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// ---------------------------------------------------------------------------
// Shared HTTP helpers (mirrors context-budget-route.test.ts)
// ---------------------------------------------------------------------------
function request(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

let db: Database.Database;
let server: http.Server;
let port: number;

beforeAll(async () => {
  db = createInMemoryFixtureDb();
  server = createServer(db, 0, null);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    }),
  );
});
beforeEach(() => setQueryDb(db));
afterEach(() => resetQueryDb());
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

// ---------------------------------------------------------------------------
// Route reachability (no credential → available:false, status 200)
// ---------------------------------------------------------------------------
describe("GET /api/burn-status route reachability", () => {
  it("returns 200 with a valid envelope regardless of credential state", async () => {
    const res = await request(port, "/api/burn-status");
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    // Envelope must have a data key.
    expect(parsed).toHaveProperty("data");
    const data = parsed.data as Record<string, unknown>;
    // available must be a boolean (true or false depending on credential state).
    expect(typeof data.available).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Shape assertions via direct injection of stub readers
// ---------------------------------------------------------------------------
describe("getBurnStatus with stub readers", () => {
  it("ok:false reader → data.available === false, status 200", async () => {
    const failReader: UsageReader = () => Promise.resolve({ ok: false, reason: "no credentials" });
    const envelope = await getBurnStatus(failReader);
    expect(envelope.data).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(envelope.data!.available).toBe(false);
  });

  it("ok:true reader → data.available === true with correct utilization fractions", async () => {
    // utilization is already fraction 0-1 at the UsageReader boundary (normalized in oauth/usage.ts).
    // No second /100 divide should occur; the values must pass through unchanged.
    const fiveHourUtilization = 0.25;
    const sevenDayUtilization = 0.4;
    const okReader: UsageReader = () =>
      Promise.resolve({
        ok: true,
        data: {
          five_hour: { utilization: fiveHourUtilization, resets_at: "2026-09-03T00:00:00Z" },
          seven_day: { utilization: sevenDayUtilization, resets_at: "2026-09-09T00:00:00Z" },
        },
      });
    const envelope = await getBurnStatus(okReader);
    expect(envelope.data).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const data = envelope.data!;
    expect(data.available).toBe(true);
    // Exact equality proves no extra /100 divide happens inside getBurnStatus.
    expect(data.five_hour?.utilization).toBe(fiveHourUtilization);
    expect(data.seven_day?.utilization).toBe(sevenDayUtilization);
  });
});

// ---------------------------------------------------------------------------
// Per-model surface + user_config snapshot persistence (RI2 async→sync bridge)
// ---------------------------------------------------------------------------
function readSnapshot(): string | null {
  const row = db.prepare("SELECT value FROM user_config WHERE key = 'per_model_snapshot'").get() as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

describe("getBurnStatus per-model snapshot persistence", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM user_config WHERE key = 'per_model_snapshot'").run();
  });

  it("surfaces per_model AND writes a per_model_snapshot when the reader has per-model data", async () => {
    const reader: UsageReader = () =>
      Promise.resolve({
        ok: true,
        data: {
          five_hour: { utilization: 0.3, resets_at: "2026-09-03T00:00:00Z" },
          seven_day: { utilization: 0.61, resets_at: "2026-09-09T00:00:00Z" },
          per_model: [
            { model: "sonnet", utilization: 0.82 },
            { model: "opus", utilization: 0.4 },
          ],
        },
      });
    const envelope = await getBurnStatus(reader);
    expect(envelope.data?.per_model).toEqual([
      { model: "sonnet", utilization: 0.82 },
      { model: "opus", utilization: 0.4 },
    ]);
    const raw = readSnapshot();
    expect(raw).not.toBeNull();
    const snap = JSON.parse(raw as string) as Record<string, unknown>;
    expect(snap.seven_day_util).toBe(0.61);
    expect(snap.five_hour_util).toBe(0.3);
    expect(snap.per_model).toEqual([
      { model: "sonnet", utilization: 0.82 },
      { model: "opus", utilization: 0.4 },
    ]);
    expect(typeof snap.captured_at).toBe("string");
  });

  it("omits per_model and leaves any existing snapshot untouched when the reader has none", async () => {
    db.prepare(
      "INSERT INTO user_config (key, value, updated_at) VALUES ('per_model_snapshot', 'PRIOR', ?)",
    ).run(new Date().toISOString());
    const reader: UsageReader = () =>
      Promise.resolve({
        ok: true,
        data: {
          five_hour: { utilization: 0.3, resets_at: "2026-09-03T00:00:00Z" },
          seven_day: { utilization: 0.4, resets_at: "2026-09-09T00:00:00Z" },
        },
      });
    const envelope = await getBurnStatus(reader);
    expect(envelope.data?.per_model).toBeUndefined();
    expect(readSnapshot()).toBe("PRIOR");
  });

  it("leaves any existing snapshot untouched when the reader fails", async () => {
    db.prepare(
      "INSERT INTO user_config (key, value, updated_at) VALUES ('per_model_snapshot', 'PRIOR', ?)",
    ).run(new Date().toISOString());
    const reader: UsageReader = () => Promise.resolve({ ok: false, reason: "no credentials" });
    const envelope = await getBurnStatus(reader);
    expect(envelope.data?.available).toBe(false);
    expect(readSnapshot()).toBe("PRIOR");
  });
});
