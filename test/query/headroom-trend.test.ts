import * as http from "node:http";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { type HeadroomTrendData, getHeadroomTrend } from "../../src/query/api/headroom-trend.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import type { ApiResponse } from "../../src/query/envelope.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const FROM = "2026-02-16T00:00:00.000Z";
const TO = "2026-02-19T00:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

function setLimit(value: string | null): void {
  db.prepare(
    `INSERT INTO user_config (key, value, updated_at) VALUES ('limit_tokens', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(value, "2026-02-16T00:00:00.000Z");
}

function insertTurn(
  messageId: string,
  ts: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): void {
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        cost_equiv_u, provisional, parser_version)
     VALUES (?, 'sess-a1', 'ws-alpha', ?, 'headroom-test', ?, ?, ?, 0, 0, 0, 0, 0, 'headroom-test')`,
  ).run(messageId, ts, inputTokens, outputTokens, cacheReadTokens);
}

function okData(
  response: ApiResponse<HeadroomTrendData>,
): Extract<HeadroomTrendData, { state: "OK" }> {
  if (response.data === null || response.data.state !== "OK") {
    throw new Error("expected an OK headroom response");
  }
  return response.data;
}

describe("getHeadroomTrend", () => {
  it.each([
    ["day", "2026-02-16"],
    // week uses strftime('%Y-%W') → "2026-07" is ISO week 07 of 2026 (not month 07), same
    // format as the existing trend series; kept identical so buckets align across charts.
    ["week", "2026-07"],
    ["month", "2026-02"],
  ] as const)("uses the existing %s bucket key", (bucket, expectedBucket) => {
    setLimit("1000");
    insertTurn(`bucket-${bucket}`, "2026-02-16T12:00:00.000Z", 100, 100, 0);

    const data = okData(getHeadroomTrend({ from: FROM, to: "2026-02-17T00:00:00.000Z" }, bucket));

    expect(data.bucket).toBe(bucket);
    expect(data.points.map((point) => point.bucket)).toEqual([expectedBucket]);
  });

  it("returns NO_LIMIT when limit_tokens is null", () => {
    setLimit(null);

    const response = getHeadroomTrend({ from: FROM, to: TO });

    expect(response.data).toEqual({ state: "NO_LIMIT" });
    expect(response.meta.n).toBe(0);
  });

  it("computes aligned headline and upper-bound headroom without clamping", () => {
    setLimit("1000");
    insertTurn("math-1", "2026-02-16T12:00:00.000Z", 100, 50, 500);
    insertTurn("math-2", "2026-02-17T12:00:00.000Z", 200, 100, 100);
    insertTurn("math-3", "2026-02-18T12:00:00.000Z", 2000, 0, 0);

    const data = okData(getHeadroomTrend({ from: FROM, to: TO }));

    expect(data.cap_read_coeff_headline).toBe(0.1);
    expect(data.cap_read_coeff_upper).toBe(1.0);
    expect(data.coefficient_unverified).toBe(true);
    expect(data.points).toEqual([
      {
        bucket: "2026-02-16",
        headroom_headline: 0.8,
        headroom_upper: 0.35,
        cap_weighted_headline: 200,
        cap_weighted_upper: 650,
      },
      {
        bucket: "2026-02-17",
        headroom_headline: 0.69,
        headroom_upper: 0.6,
        cap_weighted_headline: 310,
        cap_weighted_upper: 400,
      },
      {
        bucket: "2026-02-18",
        headroom_headline: -1,
        headroom_upper: -1,
        cap_weighted_headline: 2000,
        cap_weighted_upper: 2000,
      },
    ]);
    for (const point of data.points) {
      expect(point.headroom_headline).toBe((1000 - point.cap_weighted_headline) / 1000);
      expect(point.headroom_upper).toBe((1000 - point.cap_weighted_upper) / 1000);
    }
    expect(data.points[0]?.headroom_headline).not.toBe(data.points[0]?.headroom_upper);
  });

  it("GET /api/trends/headroom returns 200", async () => {
    setLimit("1000");
    insertTurn("route-1", "2026-02-16T12:00:00.000Z", 100, 100, 0);
    const server = createServer(db, 0, null);

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("server did not bind");
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = http.request(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: `/api/trends/headroom?from=${FROM}&to=2026-02-17T00:00:00.000Z&bucket=day`,
            method: "GET",
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
            res.on("error", reject);
          },
        );
        request.on("error", reject);
        request.end();
      });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual(
        expect.objectContaining({ data: expect.any(Object) }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
