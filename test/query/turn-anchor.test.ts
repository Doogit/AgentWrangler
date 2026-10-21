/**
 * test/query/turn-anchor.test.ts — P1-U6a test 3: `GET /api/sessions/:id/turns?anchor=` and
 * `?turn_index=` return one response holding every turn from the start through the end of
 * the page that holds the anchor.
 *
 * Oracle: the old client walk — follow `next_cursor` from the start until the page holding
 * the anchor — over the existing cursor route, on the shared seed (the DB verify:app uses).
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
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";

interface Page {
  items: Array<{ message_id: string }>;
  next_cursor: string | null;
}

function get(port: number, urlPath: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path: urlPath }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
          }),
        );
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

let scratchRoot: string;
let server: http.Server;
let port: number;
let db: Db;
let sessionId: string;
let allIds: string[];
const LIMIT = 1; // the seed's largest session has 4 turns: 4 pages

function turnsUrl(query: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/turns?${query}`;
}

/** The oracle: the old serial walk until the page holding `predicate` is reached. */
async function walkThrough(predicate: (ids: string[]) => boolean): Promise<Page> {
  const items: Page["items"] = [];
  let after: string | null = null;
  for (;;) {
    const q = new URLSearchParams({ limit: String(LIMIT) });
    if (after !== null) q.set("after", after);
    const reply = await get(port, turnsUrl(q.toString()));
    const page = (reply.body as { data: Page }).data;
    items.push(...page.items);
    after = page.next_cursor;
    if (predicate(items.map((i) => i.message_id)) || after === null) {
      return { items, next_cursor: after };
    }
  }
}

beforeAll(async () => {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-turn-anchor-"));
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
  port = (server.address() as { port: number }).port;
  // The seed session with the most turns, so the anchor sits several pages in.
  const top = db
    .prepare(
      "SELECT session_id FROM turns GROUP BY session_id ORDER BY COUNT(*) DESC, session_id LIMIT 1",
    )
    .get() as { session_id: string };
  sessionId = top.session_id;
  allIds = (
    db
      .prepare("SELECT message_id FROM turns WHERE session_id = ? ORDER BY ts, message_id")
      .all(sessionId) as Array<{ message_id: string }>
  ).map((r) => r.message_id);

  // A synthetic 2,100-turn session in the scratch copy (never the shared seed file).
  const src = db.prepare("SELECT * FROM turns WHERE session_id = ? LIMIT 1").get(sessionId) as {
    workspace_id: string;
    model: string;
    parser_version: string;
  };
  db.exec(`CREATE TEMP TABLE cap_s AS SELECT * FROM sessions WHERE session_id = '${sessionId}'`);
  db.exec("UPDATE cap_s SET session_id = 'sess-cap'");
  db.exec("INSERT INTO sessions SELECT * FROM cap_s");
  const ins = db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version) VALUES (?, 'sess-cap', ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (let i = 0; i < 2_100; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
      ins.run(capId(i), src.workspace_id, ts, src.model, src.parser_version);
    }
  })();
}, 60_000);

function capId(i: number): string {
  return `cap-${String(i).padStart(5, "0")}`;
}

afterAll(async () => {
  await stopScanWorkers(); // the turns route reads on a scan worker that holds the DB file open
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  resetQueryDb();
  db.close();
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

describe("turns anchor / turn_index (P1-U6a test 3)", () => {
  it("the seed session spans several pages (the test is meaningful)", () => {
    expect(allIds.length).toBeGreaterThan(LIMIT * 2);
  });

  it("?anchor=m equals the cursor walk through m's page, for every turn", async () => {
    for (const anchor of allIds) {
      const oracle = await walkThrough((ids) => ids.includes(anchor));
      const reply = await get(
        port,
        turnsUrl(new URLSearchParams({ anchor, limit: String(LIMIT) }).toString()),
      );
      expect(reply.status, anchor).toBe(200);
      const page = (reply.body as { data: Page }).data;
      expect(page.items, anchor).toEqual(oracle.items);
      // forward paging from the returned cursor is the walk's next page
      expect(page.next_cursor === null, anchor).toBe(oracle.next_cursor === null);
      if (page.next_cursor !== null) {
        const next = await get(
          port,
          turnsUrl(
            new URLSearchParams({ after: page.next_cursor, limit: String(LIMIT) }).toString(),
          ),
        );
        const nextIds = (next.body as { data: Page }).data.items.map((i) => i.message_id);
        expect(nextIds, anchor).toEqual(allIds.slice(page.items.length, page.items.length + LIMIT));
      }
    }
  });

  it("?turn_index=n equals the walk through the page holding index n; past the end → the full range", async () => {
    for (let n = 0; n < allIds.length; n++) {
      const oracle = await walkThrough((ids) => ids.length > n);
      const reply = await get(
        port,
        turnsUrl(new URLSearchParams({ turn_index: String(n), limit: String(LIMIT) }).toString()),
      );
      expect(reply.status, String(n)).toBe(200);
      expect((reply.body as { data: Page }).data.items, String(n)).toEqual(oracle.items);
    }
    const past = await get(port, turnsUrl(`turn_index=${allIds.length}&limit=${LIMIT}`));
    expect(past.status).toBe(200);
    const pastPage = (past.body as { data: Page }).data;
    expect(pastPage.items.map((i) => i.message_id)).toEqual(allIds);
    expect(pastPage.next_cursor).toBeNull();
  });

  it("contract errors: unknown anchor → 404; anchor/turn_index with after, both, or a bad index → 400", async () => {
    expect((await get(port, turnsUrl("anchor=not-a-turn"))).status).toBe(404);
    const after = Buffer.from("3", "utf-8").toString("base64");
    const a = allIds[0] as string;
    for (const q of [
      `anchor=${a}&after=${after}`,
      `turn_index=1&after=${after}`,
      `anchor=${a}&turn_index=1`,
      "turn_index=-1",
      "turn_index=1.5",
      "turn_index=x",
      "turn_index=",
    ]) {
      expect((await get(port, turnsUrl(q))).status, q).toBe(400);
    }
  });

  it("a large session: ?anchor= equals the walk at sampled anchors (limit 100)", async () => {
    for (const i of [0, 99, 100, 101, 777, 1_999]) {
      const anchor = capId(i);
      const reply = await get(port, `/api/sessions/sess-cap/turns?anchor=${anchor}&limit=100`);
      const ids = (reply.body as { data: Page }).data.items.map((r) => r.message_id);
      // walk oracle by arithmetic on the known ordering: pages of 100 through i's page
      const end = (Math.floor(i / 100) + 1) * 100;
      expect(ids, anchor).toEqual(Array.from({ length: end }, (_, k) => capId(k)));
    }
  });

  it("the full range is capped at 2,000 rows with next_cursor set to the row after the cap", async () => {
    const reply = await get(port, "/api/sessions/sess-cap/turns?anchor=cap-02050&limit=100");
    expect(reply.status).toBe(200);
    const page = (reply.body as { data: Page }).data;
    expect(page.items).toHaveLength(2_000);
    expect(page.items[0]?.message_id).toBe("cap-00000");
    const next = await get(
      port,
      `/api/sessions/sess-cap/turns?after=${encodeURIComponent(page.next_cursor ?? "")}&limit=100`,
    );
    expect((next.body as { data: Page }).data.items[0]?.message_id).toBe("cap-02000");
  });
});
