import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { Ingestor } from "../../src/ingest/index.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, writeCorpus } from "./synth.js";

const SESSION = "synthetic-title-session";
const RECORD = assistant({
  id: "synthetic-message",
  session: SESSION,
  ts: "2026-01-01T10:00:00.000Z",
});
const ai = (aiTitle: string) => ({ type: "ai-title", aiTitle, sessionId: SESSION });
const custom = (customTitle: string) => ({ type: "custom-title", customTitle, sessionId: SESSION });

let db: Db;
let tmpDir: string;

beforeEach(() => {
  db = migratedMemDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-session-title-"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ingest(lines: Record<string, unknown>[]): string | null {
  writeCorpus(tmpDir, { "synthetic-project": { [`${SESSION}.jsonl`]: [RECORD, ...lines] } });
  new Ingestor(db, [tmpDir], { now: () => new Date("2026-08-01T00:00:00.000Z") }).runBackscan();
  const row = db.prepare("SELECT title FROM sessions WHERE session_id = ?").get(SESSION) as
    | { title: string | null }
    | undefined;
  expect(row).toBeDefined();
  return row?.title ?? null;
}

describe("session title ingestion", () => {
  it("stores the last AI title", () => {
    expect(ingest([ai("First label"), ai("Last label")])).toBe("Last label");
  });

  it("keeps a custom title when a later AI title arrives", () => {
    expect(ingest([ai("First label"), custom("Chosen label"), ai("Last label")])).toBe(
      "Chosen label",
    );
  });

  it("stores NULL when there is no title", () => {
    expect(ingest([])).toBeNull();
  });

  it("trims and caps a title at 200 characters", () => {
    expect(ingest([ai(`  ${"x".repeat(220)}  `)])).toBe("x".repeat(200));
  });

  it("updates the session when a title is appended after the first ingest", () => {
    expect(ingest([])).toBeNull();
    fs.appendFileSync(
      path.join(tmpDir, "synthetic-project", `${SESSION}.jsonl`),
      `${JSON.stringify(custom("Updated label"))}\n`,
    );
    new Ingestor(db, [tmpDir], { now: () => new Date("2026-08-01T00:00:00.000Z") }).runBackscan();
    expect(db.prepare("SELECT title FROM sessions WHERE session_id = ?").get(SESSION)).toEqual({
      title: "Updated label",
    });

    fs.appendFileSync(
      path.join(tmpDir, "synthetic-project", `${SESSION}.jsonl`),
      `${JSON.stringify(ai("Later AI label"))}\n`,
    );
    new Ingestor(db, [tmpDir], { now: () => new Date("2026-08-01T00:00:00.000Z") }).runBackscan();
    expect(db.prepare("SELECT title FROM sessions WHERE session_id = ?").get(SESSION)).toEqual({
      title: "Updated label",
    });
  });
});
