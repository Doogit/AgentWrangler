/**
 * test/daemon/data-scopes.test.ts — P2-U2 (poll-first, D6): `data_version` scopes on
 * `/api/status`, and `GET /api/version`.
 *
 * Every bump moves the global counter (the GET memo key). A scoped bump also moves one
 * per-scope counter, so a polling client refetches only what changed (review M4):
 *   live      ingest chunk commits and reconciles (live + status sections)
 *   ingest    a completed slice (heavy aggregates move only at slice boundaries)
 *   detectors a detector walk completion
 *   lifecycle a non-GET API write
 * `clock` is the local and UTC day, so a day boundary is visible to a poller.
 *
 * Synthetic content only (SEC-101).
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HARNESS_NOW_MS } from "../../scripts/benchmark/backfill-harness.mjs";
import {
  type DataScopes,
  bumpDataVersion,
  getDataScopes,
  getDataVersion,
} from "../../src/daemon/data-version.js";
import { createDetectorPassRunner } from "../../src/daemon/detector-pass.js";
import { createServer } from "../../src/daemon/http.js";
import { runMigrations } from "../../src/db/migrate.js";
import { Ingestor } from "../../src/ingest/index.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";
import { assistant, toJsonl } from "../ingest/synth.js";

const DAY = 86_400_000;
const NOW = HARNESS_NOW_MS;

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-p2u2-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

/** One session file under <root>/proj, turns at the given times, mtime = newest turn. */
function writeSession(root: string, name: string, turnTimes: number[]): string {
  const dir = path.join(root, "proj");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  const lines = turnTimes.map((t, i) =>
    assistant({
      id: `${name}-${i}`,
      session: name,
      ts: new Date(t).toISOString(),
      input: 10,
      output: 1,
    }),
  );
  fs.writeFileSync(file, toJsonl(lines), "utf8");
  const m = new Date(Math.max(...turnTimes));
  fs.utimesSync(file, m, m);
  return file;
}

/** Which counters moved between two reads. */
function moved(before: DataScopes, after: DataScopes): string[] {
  return (["live", "ingest", "detectors", "lifecycle"] as const).filter(
    (k) => after[k] !== before[k],
  );
}

describe("P2-U2 scoped bumps", () => {
  it("a scoped bump moves the global counter and only that scope", () => {
    const v = getDataVersion();
    const s = getDataScopes();
    bumpDataVersion("detectors");
    expect(getDataVersion()).toBe(v + 1);
    expect(moved(s, getDataScopes())).toEqual(["detectors"]);
  });

  it("an unscoped bump moves only the global counter", () => {
    const v = getDataVersion();
    const s = getDataScopes();
    bumpDataVersion();
    expect(getDataVersion()).toBe(v + 1);
    expect(moved(s, getDataScopes())).toEqual([]);
  });

  it("a tail-only ingest commit moves `live`, not `ingest`", () => {
    const root = path.join(tmp, "tail");
    const file = writeSession(root, "tail-a", [NOW - 120_000, NOW - 60_000]);
    const db = freshDb();
    try {
      const ingestor = new Ingestor(db, [root], { now: () => new Date(NOW) });
      const s = getDataScopes();
      ingestor.ingestFile(file, "proj");
      expect(moved(s, getDataScopes())).toEqual(["live"]);
    } finally {
      db.close();
    }
  });

  it("a reconcile moves `live`, not `ingest`", () => {
    const root = path.join(tmp, "reconcile");
    const file = writeSession(root, "rec-a", [NOW - 2 * DAY]);
    const db = freshDb();
    try {
      const ingestor = new Ingestor(db, [root], {
        now: () => new Date(NOW),
        activityWindowSecs: 300,
      });
      ingestor.ingestFile(file, "proj");
      const s = getDataScopes();
      (ingestor as unknown as { reconcileNow: () => void }).reconcileNow();
      expect(moved(s, getDataScopes())).toEqual(["live"]);
    } finally {
      db.close();
    }
  });

  it("a completed slice moves `ingest`", async () => {
    const root = path.join(tmp, "slice");
    writeSession(root, "slice-a", [NOW - DAY]);
    const db = freshDb();
    try {
      const ingestor = new Ingestor(db, [root], {
        now: () => new Date(NOW),
        activityWindowSecs: 300,
      });
      const [w0] = ingestor.planSlices();
      if (w0 === undefined) throw new Error("no slice planned");
      const s = getDataScopes();
      const result = await ingestor.ingestSlice(w0);
      expect(result.rest).toEqual([]);
      expect(moved(s, getDataScopes())).toContain("ingest");
    } finally {
      db.close();
    }
  });

  it("a detector walk completion moves `detectors`", async () => {
    const db = freshDb();
    try {
      const runner = createDetectorPassRunner({ db, run: async () => [] });
      const s = getDataScopes();
      expect((await runner.runIfDue(true)).ran).toBe(true);
      expect(moved(s, getDataScopes())).toContain("detectors");
    } finally {
      db.close();
    }
  });
});

// ── HTTP: /api/status fields, /api/version, lifecycle writes ──────────────────

function request(
  port: number,
  urlPath: string,
  method = "GET",
  host = `127.0.0.1:${port}`,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders =
      method === "GET"
        ? { Host: host }
        : { Host: host, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" };
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
            headers: res.headers,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(method === "GET" ? undefined : "{}");
  });
}

describe("P2-U2 HTTP", () => {
  let server: http.Server;
  let port: number;
  let db: Database.Database;

  beforeAll(async () => {
    db = createInMemoryFixtureDb();
    setQueryDb(db);
    server = createServer(db, 0, null);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    resetQueryDb();
    db.close();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("/api/status carries data_version and data_scopes", async () => {
    bumpDataVersion("live");
    const res = await request(port, "/api/status");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { data_version: number; data_scopes: DataScopes };
    expect(body.data_version).toBe(getDataVersion());
    expect(body.data_scopes).toEqual(getDataScopes());
    expect(Object.keys(body.data_scopes).sort()).toEqual(
      ["clock", "detectors", "ingest", "lifecycle", "live"].sort(),
    );
  });

  it("`clock` changes across midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T23:59:59.000Z"));
    const before = (
      JSON.parse((await request(port, "/api/status")).body) as {
        data_scopes: DataScopes;
      }
    ).data_scopes.clock;
    vi.setSystemTime(new Date("2026-10-06T00:00:01.000Z"));
    const after = (
      JSON.parse((await request(port, "/api/status")).body) as {
        data_scopes: DataScopes;
      }
    ).data_scopes.clock;
    expect(after).not.toBe(before);
  });

  it("a non-GET API write moves `lifecycle`", async () => {
    const s = getDataScopes();
    await request(port, "/api/no-such-write", "POST");
    expect(moved(s, getDataScopes())).toEqual(["lifecycle"]);
  });

  it("GET /api/version is < 200 B, only data_version, no ETag, and moves with a bump", async () => {
    const a = await request(port, "/api/version");
    expect(a.status).toBe(200);
    expect(Buffer.byteLength(a.body)).toBeLessThan(200);
    expect(a.headers.etag).toBeUndefined();
    const first = JSON.parse(a.body) as Record<string, unknown>;
    expect(Object.keys(first)).toEqual(["data_version"]);
    expect(first.data_version).toBe(getDataVersion());
    bumpDataVersion("live");
    const second = JSON.parse((await request(port, "/api/version")).body) as {
      data_version: number;
    };
    expect(second.data_version).toBe((first.data_version as number) + 1);
  });

  it("GET /api/version refuses a non-loopback Host (421)", async () => {
    const res = await request(port, "/api/version", "GET", "evil.example:80");
    expect(res.status).toBe(421);
  });
});
