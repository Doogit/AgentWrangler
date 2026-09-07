/**
 * test/ingest/ef3-gaps.test.ts — EF3 per-session inter-user-turn gap aggregates.
 *
 * SEC-101: durations in seconds only; no content stored or asserted.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { Ingestor } from "../../src/ingest/index.js";
import { projectLine } from "../../src/ingest/parser.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, userPrompt, writeCorpus } from "./synth.js";

const INGEST_OPTS = { now: () => new Date("2026-08-01T00:00:00.000Z"), activityWindowSecs: 300 };

let db: Db;
let tmpDir: string;

beforeEach(() => {
  db = migratedMemDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-ef3-"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A. Exact aggregates
// ---------------------------------------------------------------------------

describe("EF3 — exact gap aggregates", () => {
  it("computes gap_n=3, gap_median_s=90, gap_p90_s=480, long_gap_count=1", () => {
    // User turns at 10:00:00, 10:00:30, 10:02:00, 10:10:00 → gaps [30, 90, 480]
    // Interleaved assistant turn proves assistant turns don't affect gap calculation.
    const lines = [
      userPrompt({ session: "sess-gaps", ts: "2026-01-01T10:00:00.000Z" }),
      assistant({
        id: "m1",
        session: "sess-gaps",
        ts: "2026-01-01T10:00:15.000Z",
        input: 10,
        output: 5,
      }),
      userPrompt({ session: "sess-gaps", ts: "2026-01-01T10:00:30.000Z" }),
      userPrompt({ session: "sess-gaps", ts: "2026-01-01T10:02:00.000Z" }),
      userPrompt({ session: "sess-gaps", ts: "2026-01-01T10:10:00.000Z" }),
    ];
    writeCorpus(tmpDir, { "proj-gaps": { "sess-gaps.jsonl": lines } });

    const ing = new Ingestor(db, [tmpDir], INGEST_OPTS);
    ing.runBackscan();

    const row = db
      .prepare(
        "SELECT gap_n, gap_median_s, gap_p90_s, long_gap_count FROM sessions WHERE session_id = ?",
      )
      .get("sess-gaps") as
      | { gap_n: number; gap_median_s: number; gap_p90_s: number; long_gap_count: number }
      | undefined;

    expect(row).toBeDefined();
    expect(row?.gap_n).toBe(3);
    expect(row?.gap_median_s).toBe(90);
    expect(row?.gap_p90_s).toBe(480);
    expect(row?.long_gap_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// B. <2 user turns → nulls
// ---------------------------------------------------------------------------

describe("EF3 — <2 user turns produce null aggregates", () => {
  it("session with exactly 1 user prompt → gap_n=0, nulls, long_gap_count=0", () => {
    const lines = [userPrompt({ session: "sess-one", ts: "2026-01-01T10:00:00.000Z" })];
    writeCorpus(tmpDir, { "proj-one": { "sess-one.jsonl": lines } });

    const ing = new Ingestor(db, [tmpDir], INGEST_OPTS);
    ing.runBackscan();

    const row = db
      .prepare(
        "SELECT gap_n, gap_median_s, gap_p90_s, long_gap_count FROM sessions WHERE session_id = ?",
      )
      .get("sess-one") as
      | {
          gap_n: number;
          gap_median_s: number | null;
          gap_p90_s: number | null;
          long_gap_count: number;
        }
      | undefined;

    expect(row).toBeDefined();
    expect(row?.gap_n).toBe(0);
    expect(row?.gap_median_s).toBeNull();
    expect(row?.gap_p90_s).toBeNull();
    expect(row?.long_gap_count).toBe(0);
  });

  it("session with 0 user prompts (assistant only) → gap_n=0, nulls, long_gap_count=0", () => {
    const lines = [
      assistant({
        id: "m2",
        session: "sess-zero",
        ts: "2026-01-01T10:00:00.000Z",
        input: 10,
        output: 5,
      }),
    ];
    writeCorpus(tmpDir, { "proj-zero": { "sess-zero.jsonl": lines } });

    const ing = new Ingestor(db, [tmpDir], INGEST_OPTS);
    ing.runBackscan();

    const row = db
      .prepare(
        "SELECT gap_n, gap_median_s, gap_p90_s, long_gap_count FROM sessions WHERE session_id = ?",
      )
      .get("sess-zero") as
      | {
          gap_n: number;
          gap_median_s: number | null;
          gap_p90_s: number | null;
          long_gap_count: number;
        }
      | undefined;

    expect(row).toBeDefined();
    expect(row?.gap_n).toBe(0);
    expect(row?.gap_median_s).toBeNull();
    expect(row?.gap_p90_s).toBeNull();
    expect(row?.long_gap_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C. SEC-101
// ---------------------------------------------------------------------------

describe("EF3 — SEC-101: no content in sessions row", () => {
  it("sessions row JSON does not contain the synth content sentinel", () => {
    const lines = [
      userPrompt({ session: "sess-sec", ts: "2026-01-01T10:00:00.000Z" }),
      userPrompt({ session: "sess-sec", ts: "2026-01-01T10:05:00.000Z" }),
    ];
    writeCorpus(tmpDir, { "proj-sec": { "sess-sec.jsonl": lines } });

    const ing = new Ingestor(db, [tmpDir], INGEST_OPTS);
    ing.runBackscan();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-sec") as
      | Record<string, unknown>
      | undefined;
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain("SYNTH_USER_CONTENT_DO_NOT_STORE");
  });
});

// ---------------------------------------------------------------------------
// D. Idempotent re-scan
// ---------------------------------------------------------------------------

describe("EF3 — idempotent re-scan", () => {
  it("re-scanning the same corpus with a second Ingestor yields unchanged aggregates", () => {
    const lines = [
      userPrompt({ session: "sess-idem", ts: "2026-01-01T10:00:00.000Z" }),
      userPrompt({ session: "sess-idem", ts: "2026-01-01T10:01:00.000Z" }),
      userPrompt({ session: "sess-idem", ts: "2026-01-01T10:10:00.000Z" }),
    ];
    writeCorpus(tmpDir, { "proj-idem": { "sess-idem.jsonl": lines } });

    // First ingestor.
    const ing1 = new Ingestor(db, [tmpDir], INGEST_OPTS);
    ing1.runBackscan();

    const snap = (sessionId: string) =>
      db
        .prepare(
          "SELECT gap_n, gap_median_s, gap_p90_s, long_gap_count FROM sessions WHERE session_id = ?",
        )
        .get(sessionId) as
        | {
            gap_n: number;
            gap_median_s: number | null;
            gap_p90_s: number | null;
            long_gap_count: number;
          }
        | undefined;

    const before = snap("sess-idem");
    expect(before).toBeDefined();

    // Second ingestor on the SAME db and SAME corpus.
    const ing2 = new Ingestor(db, [tmpDir], INGEST_OPTS);
    ing2.runBackscan();

    const after = snap("sess-idem");
    expect(after?.gap_n).toBe(before?.gap_n);
    expect(after?.gap_median_s).toBe(before?.gap_median_s);
    expect(after?.gap_p90_s).toBe(before?.gap_p90_s);
    expect(after?.long_gap_count).toBe(before?.long_gap_count);
  });
});

// ---------------------------------------------------------------------------
// F. Warm-restart write-guard: a fresh Ingestor (empty in-memory map) must not
//    clobber a richer persisted gap_n with a partial recompute.
// ---------------------------------------------------------------------------

describe("EF3 — persisted warm-restart gap aggregates", () => {
  it("a post-restart user turn extends the complete persisted gap history", () => {
    const filePath = path.join(tmpDir, "proj-warm", "sess-warm.jsonl");
    const lines = [
      userPrompt({ session: "sess-warm", ts: "2026-01-01T10:00:00.000Z" }),
      userPrompt({ session: "sess-warm", ts: "2026-01-01T10:00:30.000Z" }),
      userPrompt({ session: "sess-warm", ts: "2026-01-01T10:02:00.000Z" }),
      userPrompt({ session: "sess-warm", ts: "2026-01-01T10:10:00.000Z" }),
    ];
    writeCorpus(tmpDir, { "proj-warm": { "sess-warm.jsonl": lines } });

    const snap = (sessionId: string) =>
      db
        .prepare(
          "SELECT gap_n, gap_median_s, gap_p90_s, long_gap_count FROM sessions WHERE session_id = ?",
        )
        .get(sessionId) as
        | {
            gap_n: number;
            gap_median_s: number | null;
            gap_p90_s: number | null;
            long_gap_count: number;
          }
        | undefined;

    // Cold scan: 4 user turns → gaps [30, 90, 480] → gap_n=3.
    const ing1 = new Ingestor(db, [tmpDir], INGEST_OPTS);
    ing1.runBackscan();

    const cold = snap("sess-warm");
    expect(cold?.gap_n).toBe(3);
    expect(cold?.gap_median_s).toBe(90);
    expect(cold?.gap_p90_s).toBe(480);

    // Simulate a warm daemon restart and append one more user turn. Its 600s gap
    // is combined with the four timestamps already persisted by ing1.
    fs.appendFileSync(
      filePath,
      `${JSON.stringify(userPrompt({ session: "sess-warm", ts: "2026-01-01T10:20:00.000Z" }))}\n`,
      "utf8",
    );

    const ing2 = new Ingestor(db, [tmpDir], INGEST_OPTS);
    ing2.runBackscan();

    const warm = snap("sess-warm");
    expect(warm?.gap_n).toBe(4);
    expect(warm?.gap_median_s).toBe(285);
    expect(warm?.gap_p90_s).toBe(600);
    expect(warm?.long_gap_count).toBe((cold?.long_gap_count ?? 0) + 1);
  });

  it("a real new long gap after restart is surfaced, not frozen at the pre-restart value", () => {
    const filePath = path.join(tmpDir, "proj-warm2", "sess-warm2.jsonl");
    const lines = [
      userPrompt({ session: "sess-warm2", ts: "2026-01-01T10:00:00.000Z" }),
      userPrompt({ session: "sess-warm2", ts: "2026-01-01T10:00:30.000Z" }),
      userPrompt({ session: "sess-warm2", ts: "2026-01-01T10:02:00.000Z" }),
      userPrompt({ session: "sess-warm2", ts: "2026-01-01T10:10:00.000Z" }),
    ];
    writeCorpus(tmpDir, { "proj-warm2": { "sess-warm2.jsonl": lines } });

    const snap = (sessionId: string) =>
      db
        .prepare(
          "SELECT gap_n, gap_median_s, gap_p90_s, long_gap_count FROM sessions WHERE session_id = ?",
        )
        .get(sessionId) as
        | {
            gap_n: number;
            gap_median_s: number | null;
            gap_p90_s: number | null;
            long_gap_count: number;
          }
        | undefined;

    // Cold scan: 4 user turns → gap_n=3.
    const ing1 = new Ingestor(db, [tmpDir], INGEST_OPTS);
    ing1.runBackscan();
    expect(snap("sess-warm2")?.gap_n).toBe(3);

    // Warm restart: append 2 more user turns. Both extend the persisted history;
    // the 2nd is far over LONG_GAP_THRESHOLD_S (300s) from the 1st.
    fs.appendFileSync(
      filePath,
      `${JSON.stringify(userPrompt({ session: "sess-warm2", ts: "2026-01-01T10:20:00.000Z" }))}\n`,
      "utf8",
    );
    const ing2 = new Ingestor(db, [tmpDir], INGEST_OPTS);
    ing2.runBackscan();
    expect(snap("sess-warm2")?.gap_n).toBe(4);

    fs.appendFileSync(
      filePath,
      `${JSON.stringify(userPrompt({ session: "sess-warm2", ts: "2026-01-01T13:06:40.000Z" }))}\n`,
      "utf8",
    );
    ing2.runBackscan();

    // The full six-turn history now has five gaps, including the 10,000s gap.
    const after = snap("sess-warm2");
    expect(after?.gap_n).toBe(5);
    expect(after?.gap_median_s).toBe(480);
    expect(after?.gap_p90_s).toBe(10000);
    expect(after?.long_gap_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// E. Parser unit: projectLine surfaces ts and isUserTurn
// ---------------------------------------------------------------------------

describe("EF3 — parser unit: userPrompt projection", () => {
  it("projectLine of a userPrompt record → kind record, isUserTurn true, ts equals input", () => {
    const session = "sess-parser";
    const ts = "2026-01-01T10:00:00.000Z";
    const line = userPrompt({ session, ts });
    const r = projectLine(JSON.stringify(line), { defaultSessionId: session });
    expect(r.kind).toBe("record");
    if (r.kind !== "record") throw new Error("expected record");
    expect(r.isUserTurn).toBe(true);
    expect(r.ts).toBe(ts);
  });
});
