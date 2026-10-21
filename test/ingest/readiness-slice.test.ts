/**
 * Readiness slice. U2 capped it at 25 sessions / 24 MiB; P2-U4 (decision D4) made it
 * the W0 slice: every file modified in the last 7 days, with an elapsed-time guard
 * (test/ingest/slices.test.ts) instead of the caps. It stays offset-incremental like
 * every other pass.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Ingestor } from "../../src/ingest/index.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, toJsonl } from "./synth.js";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const OPTS = { now: () => NOW, activityWindowSecs: 300 };

function writeSession(root: string, name: string, id: string, mtimeIso: string): string {
  const dir = path.join(root, "proj-readiness");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    toJsonl([
      assistant({
        id,
        session: `session-${id}`,
        ts: "2026-07-30T00:00:00.000Z",
        input: 100,
        output: 10,
      }),
    ]),
  );
  const when = new Date(mtimeIso);
  fs.utimesSync(file, when, when);
  return file;
}

async function ingestW0(ing: Ingestor): Promise<void> {
  const w0 = ing.planSlices().find((s) => s.index === 0);
  if (w0 !== undefined) await ing.ingestSlice(w0);
}

describe("W0 readiness slice", () => {
  it("takes every recent session — no session or byte cap (D4)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-rs-all-"));
    const db = migratedMemDb();
    try {
      // U2's default cap was 25 sessions.
      for (let i = 0; i < 30; i++) {
        writeSession(
          root,
          `s${i}.jsonl`,
          `s${i}`,
          `2026-07-3${i % 2}T00:${String(i).padStart(2, "0")}:00.000Z`,
        );
      }
      const ing = new Ingestor(db, [root], OPTS);
      await ingestW0(ing);
      expect(ing.healthSnapshot().filesParsed).toBe(30);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes sessions older than the trailing window", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-rs-window-"));
    const db = migratedMemDb();
    try {
      // 7d window relative to NOW (2026-08-01): two recent, two old.
      writeSession(root, "recent-a.jsonl", "ra", "2026-07-31T00:00:00.000Z");
      writeSession(root, "recent-b.jsonl", "rb", "2026-07-30T00:00:00.000Z");
      writeSession(root, "old-a.jsonl", "oa", "2026-06-01T00:00:00.000Z");
      writeSession(root, "old-b.jsonl", "ob", "2026-05-01T00:00:00.000Z");
      const ing = new Ingestor(db, [root], OPTS);
      await ingestW0(ing);
      expect(ing.healthSnapshot().filesParsed).toBe(2);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("plans no slice on an empty corpus", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-rs-empty-"));
    const db = migratedMemDb();
    try {
      expect(new Ingestor(db, [root], OPTS).planSlices()).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("arms tail/discovery timers even when the initial back-scan throws (M1)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-rs-m1-"));
    const db = migratedMemDb();
    try {
      writeSession(root, "recent.jsonl", "recent", "2026-07-31T00:00:00.000Z");
      const ing = new Ingestor(db, [root], OPTS);
      // Force the batched back-scan to fail mid-backlog (e.g. a pathological line
      // deep in the corpus, or a transient DB write error).
      vi.spyOn(ing, "runBackgroundBackfill").mockRejectedValue(new Error("scan boom"));
      // Previously this rejected → the daemon's .catch only logged and the tail +
      // discovery timers never armed → NO live ingestion for the daemon lifetime
      // (readiness already fired on the slice, so the dashboard looked healthy).
      // Now it resolves to a real handle: reaching the return means startTailTimers()
      // ran and armed the intervals.
      const handle = await ing.startTailBatched();
      expect(handle).toBeDefined();
      expect(typeof handle.stop).toBe("function");
      expect(() => handle.stop()).not.toThrow();
      expect(() => handle.stop()).not.toThrow(); // idempotent double-stop
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stays offset-incremental — the background full scan re-parses zero sliced lines", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-rs-offset-"));
    const db = migratedMemDb();
    try {
      writeSession(root, "recent.jsonl", "recent", "2026-07-31T00:00:00.000Z");
      const cold = new Ingestor(db, [root], OPTS);
      await ingestW0(cold);
      expect(cold.healthSnapshot().turnsIngested).toBe(1);

      // The post-readiness background pass (startTailBatched) must not re-parse
      // the file already consumed by the slice.
      const bg = new Ingestor(db, [root], OPTS);
      const handle = await bg.startTailBatched(1);
      handle.stop();
      expect(bg.healthSnapshot()).toMatchObject({
        turnsIngested: 0,
        duplicateDrops: 0,
        filesParsed: 0,
      });
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
