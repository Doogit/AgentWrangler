/**
 * test/daemon/boot-status.test.ts — BOOT-1 boot-progress contract.
 *
 * Covers:
 *   1. boot-progress module: counters, ring-buffer cap, files/s derivation.
 *   2. Privacy (SEC-101): a synthetic boot scan emits event text with
 *      workspace slugs and counts ONLY — no path separators, no local paths.
 *   3. Pre-ready /api/status carries the boot fields; after setReady() the
 *      steady-state response shape is byte-compatible with today (no boot keys).
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { setReady } from "../../src/daemon/readiness.js";
import {
  bootFileParsed,
  bootFilesTotal,
  bootSessionFound,
  bootTokensCounted,
  getBootProgress,
  pushBootEvent,
  resetBootProgress,
} from "../../src/ingest/boot-progress.js";
import { Ingestor } from "../../src/ingest/index.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { migratedMemDb } from "../ingest/dbutil.js";
import { assistant, userPrompt, writeCorpus } from "../ingest/synth.js";

function makeRequest(port: number, reqPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, headers: { host: `127.0.0.1:${port}` } },
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

beforeEach(() => {
  resetBootProgress();
});

// ── 1. boot-progress module ───────────────────────────────────────────────────

describe("boot-progress module", () => {
  it("accumulates counters and events with monotonic seq", () => {
    bootSessionFound();
    bootSessionFound();
    bootTokensCounted(1_000);
    bootTokensCounted(234);
    bootFilesTotal(3);
    pushBootEvent("root", "discovered 3 files across 2 workspaces", "2026-09-10T00:00:00Z");
    pushBootEvent("workspace", "scan slug-a → 2 files", "2026-09-10T00:00:01Z");
    const p = getBootProgress();
    expect(p.boot_sessions_found).toBe(2);
    expect(p.boot_tokens_counted).toBe(1_234);
    expect(p.boot_files_total).toBe(3);
    expect(p.boot_scan_events.map((e) => e.seq)).toEqual([1, 2]);
    expect(p.boot_scan_events[1]).toMatchObject({
      kind: "workspace",
      text: "scan slug-a → 2 files",
    });
  });

  it("caps the event ring buffer at 50, dropping oldest", () => {
    for (let i = 1; i <= 60; i++) pushBootEvent("stage", `event ${i}`);
    const events = getBootProgress().boot_scan_events;
    expect(events).toHaveLength(50);
    expect(events[0]?.text).toBe("event 11");
    expect(events[49]?.text).toBe("event 60");
    expect(events[49]?.seq).toBe(60);
  });

  it("derives files/s from parse ticks inside the 5s window", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) bootFileParsed(t0 + i * 100); // 10 files in 0.9s
    expect(getBootProgress(t0 + 1_000).boot_files_per_sec).toBe(2); // 10 / 5s window
    // Ticks age out of the window.
    expect(getBootProgress(t0 + 60_000).boot_files_per_sec).toBe(0);
  });

  it("ignores non-finite or negative token increments", () => {
    bootTokensCounted(Number.NaN);
    bootTokensCounted(-5);
    bootTokensCounted(7);
    expect(getBootProgress().boot_tokens_counted).toBe(7);
  });
});

// ── 2. Privacy: synthetic boot scan (SEC-101) ────────────────────────────────

describe("boot scan events privacy (SEC-101)", () => {
  it("emits workspace slugs and counts only — no path separators", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-boot-progress-"));
    try {
      writeCorpus(root, {
        "C--Users-synth-project-alpha": {
          "s1.jsonl": [
            userPrompt({ session: "s1", ts: "2026-09-10T00:00:00Z" }),
            assistant({
              id: "m1",
              session: "s1",
              ts: "2026-09-10T00:00:01Z",
              input: 10,
              output: 5,
            }),
          ],
        },
        "C--Users-synth-project-beta": {
          "s2.jsonl": [
            assistant({ id: "m2", session: "s2", ts: "2026-09-10T00:00:02Z", input: 3, output: 4 }),
          ],
        },
      });
      const db = migratedMemDb();
      const ingestor = new Ingestor(db, [root]);
      await ingestor.runBackscanBatched();
      db.close();

      const p = getBootProgress();
      expect(p.boot_sessions_found).toBe(2);
      expect(p.boot_tokens_counted).toBe(22);
      expect(p.boot_files_total).toBe(2);
      const texts = p.boot_scan_events.map((e) => e.text);
      expect(texts.some((t) => t.includes("C--Users-synth-project-alpha"))).toBe(true);
      expect(texts.some((t) => t.startsWith("discovered "))).toBe(true);
      for (const text of texts) {
        // Workspace-slug conventions only: no / or \ (i.e. no file paths).
        expect(text).not.toMatch(/[\\/]/);
        expect(text).not.toContain(root);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── 3. /api/status pre-ready contract ────────────────────────────────────────

describe("GET /api/status boot fields", () => {
  let server: http.Server;
  let port: number;
  let db: ReturnType<typeof migratedMemDb>;

  beforeAll(async () => {
    db = migratedMemDb();
    setQueryDb(db);
    await new Promise<void>((resolve, reject) => {
      server = createServer(db, 0, null);
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
      server.on("error", reject);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetQueryDb();
    db.close();
  });

  it("carries boot fields while not ready", async () => {
    bootSessionFound();
    bootTokensCounted(42);
    pushBootEvent("workspace", "scan slug-a → 1 files");
    const r = await makeRequest(port, "/api/status");
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body.boot_sessions_found).toBe(1);
    expect(body.boot_tokens_counted).toBe(42);
    expect(typeof body.boot_files_per_sec).toBe("number");
    expect(typeof body.boot_files_total).toBe("number");
    expect(body.boot_scan_events).toEqual([
      expect.objectContaining({ seq: 1, kind: "workspace", text: "scan slug-a → 1 files" }),
    ]);
  });

  // Keep LAST in the file: setReady() flips module-global state for good
  // (vitest isolates modules per test file, so other files are unaffected).
  it("drops boot fields after ready — steady-state shape unchanged", async () => {
    pushBootEvent("stage", "ready — opening dashboard");
    setReady();
    const r = await makeRequest(port, "/api/status");
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "files_parsed",
      "files_seen",
      "invalid_scan_root_count",
      "lines_quarantined",
      "scan_state",
      "sessions",
    ]);
  });
});
