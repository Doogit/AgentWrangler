/**
 * Cold-start boot scan ordering is orchestration only: per-file offset reads
 * remain forward and incremental.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ingestor } from "../../src/ingest/index.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, toJsonl } from "./synth.js";

const OPTS = {
  now: () => new Date("2026-08-01T00:00:00.000Z"),
  activityWindowSecs: 300,
};

function writeSession(root: string, name: string, id: string): string {
  const dir = path.join(root, "proj-order");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    toJsonl([
      assistant({
        id,
        session: `session-${id}`,
        ts: "2026-01-03T00:00:00.000Z",
        input: 100,
        output: 10,
      }),
    ]),
  );
  return file;
}

function setMtime(file: string, iso: string): void {
  const when = new Date(iso);
  fs.utimesSync(file, when, when);
}

function visitOrder(): { visited: string[]; restore(): void } {
  const visited: string[] = [];
  const original = Ingestor.prototype.ingestFileYielding;
  const spy = vi.spyOn(Ingestor.prototype, "ingestFileYielding").mockImplementation(async function (
    this: Ingestor,
    filePath,
    projectSlug,
    budgetBytes,
  ) {
    visited.push(path.basename(filePath));
    return original.call(this, filePath, projectSlug, budgetBytes);
  });
  return { visited, restore: () => spy.mockRestore() };
}

afterEach(() => vi.restoreAllMocks());

describe("batched boot-scan ordering", () => {
  it("visits mixed-mtime session files newest first", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-boot-order-"));
    const db = migratedMemDb();
    try {
      const oldest = writeSession(root, "oldest.jsonl", "oldest");
      const newest = writeSession(root, "newest.jsonl", "newest");
      const middle = writeSession(root, "middle.jsonl", "middle");
      setMtime(oldest, "2026-01-01T00:00:00.000Z");
      setMtime(middle, "2026-01-02T00:00:00.000Z");
      setMtime(newest, "2026-01-03T00:00:00.000Z");

      const order = visitOrder();
      await new Ingestor(db, [root], OPTS).runBackscanBatched(1);

      expect(order.visited).toEqual(["newest.jsonl", "middle.jsonl", "oldest.jsonl"]);
      order.restore();
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a stable path tiebreak when mtimes are identical", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-boot-tiebreak-"));
    const db = migratedMemDb();
    try {
      const files = [
        writeSession(root, "zeta.jsonl", "zeta"),
        writeSession(root, "alpha.jsonl", "alpha"),
        writeSession(root, "middle.jsonl", "middle"),
      ];
      for (const file of files) setMtime(file, "2026-01-03T00:00:00.000Z");

      const first = visitOrder();
      await new Ingestor(db, [root], OPTS).runBackscanBatched(1);
      first.restore();
      const second = visitOrder();
      await new Ingestor(db, [root], OPTS).runBackscanBatched(1);

      expect(first.visited).toEqual(["alpha.jsonl", "middle.jsonl", "zeta.jsonl"]);
      expect(second.visited).toEqual(first.visited);
      second.restore();
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles empty and single-file corpora without reordering", async () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-boot-empty-"));
    const singleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-boot-single-"));
    const db = migratedMemDb();
    try {
      await expect(
        new Ingestor(db, [emptyRoot], OPTS).runBackscanBatched(1),
      ).resolves.toBeDefined();

      writeSession(singleRoot, "only.jsonl", "only");
      const order = visitOrder();
      await expect(
        new Ingestor(db, [singleRoot], OPTS).runBackscanBatched(1),
      ).resolves.toBeDefined();
      expect(order.visited).toEqual(["only.jsonl"]);
      order.restore();
    } finally {
      db.close();
      fs.rmSync(emptyRoot, { recursive: true, force: true });
      fs.rmSync(singleRoot, { recursive: true, force: true });
    }
  });

  it("does not re-parse consumed lines after a warm restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-boot-offset-"));
    const db = migratedMemDb();
    try {
      const oldest = writeSession(root, "oldest.jsonl", "oldest");
      const newest = writeSession(root, "newest.jsonl", "newest");
      setMtime(oldest, "2026-01-01T00:00:00.000Z");
      setMtime(newest, "2026-01-03T00:00:00.000Z");

      const cold = new Ingestor(db, [root], OPTS);
      await cold.runBackscanBatched(1);
      expect(cold.healthSnapshot().turnsIngested).toBe(2);

      const warm = new Ingestor(db, [root], OPTS);
      await warm.runBackscanBatched(1);
      expect(warm.healthSnapshot()).toMatchObject({
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
