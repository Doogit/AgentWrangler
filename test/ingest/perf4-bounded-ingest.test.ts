/**
 * test/ingest/perf4-bounded-ingest.test.ts — PERF4 chunk-bounded ingestion.
 *
 * Covers: multi-chunk vs one-shot equivalence, mid-transaction failure with
 * staged correlation-state rollback + same-process retry equality, event-loop
 * yielding during a single large file, the caught-up-only version skip,
 * resumable chunked legacy-prefix seeding, and durable quarantine identity
 * across restart and rotation. Synthetic content only (SEC-101).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { Ingestor } from "../../src/ingest/index.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, toJsonl, userPrompt, userToolResult, writeCorpus } from "./synth.js";

const NOW = () => new Date("2026-08-01T00:00:00.000Z");
const OPTS = { now: NOW, activityWindowSecs: 300 };
const SLUG = "proj-perf4";

let db: Db;
let tmp: string;
beforeEach(() => {
  db = migratedMemDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-perf4-"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

type ApplyLineFn = (
  raw: string,
  ctx: { defaultSessionId: string },
  workspaceId: string,
  filePath: string,
  lineNo: number,
  versionSalt: string,
) => void;

/** Shadow the private applyLine to throw once when a marker line arrives. */
function injectFailureOn(ingestor: Ingestor, marker: string): void {
  const target = ingestor as unknown as { applyLine: ApplyLineFn };
  const orig = target.applyLine.bind(ingestor);
  let fired = false;
  target.applyLine = (raw, ctx, ws, fp, lineNo, salt) => {
    orig(raw, ctx, ws, fp, lineNo, salt);
    if (!fired && raw.includes(marker)) {
      fired = true;
      throw new Error("injected mid-transaction failure");
    }
  };
}

/** A corpus exercising turns, tool correlation, friction, and quarantine. */
function correlationLines(session: string): Array<Record<string, unknown> | { raw: string }> {
  return [
    userPrompt({ session, ts: "2026-01-05T00:00:00.000Z" }),
    assistant({
      id: `${session}-m1`,
      session,
      ts: "2026-01-05T00:01:00.000Z",
      input: 100,
      output: 10,
      toolUses: [{ id: `${session}-t1`, name: "Bash", command: "echo synth" }],
    }),
    userToolResult({
      session,
      ts: "2026-01-05T00:02:00.000Z",
      results: [{ toolUseId: `${session}-t1`, text: "SYNTH_RESULT_0123456789" }],
    }),
    { raw: "this is not json {{{" },
    assistant({
      id: `${session}-m2`,
      session,
      ts: "2026-01-05T00:03:00.000Z",
      input: 50,
      output: 5,
      extra: { isCompactSummary: true },
    }),
    userPrompt({ session, ts: "2026-01-05T00:04:00.000Z" }),
    assistant({
      id: `${session}-m3`,
      session,
      ts: "2026-01-05T00:05:00.000Z",
      input: 25,
      output: 5,
    }),
  ];
}

function dump(d: Db): string {
  return JSON.stringify({
    turns: d
      .prepare(
        `SELECT message_id, session_id, workspace_id, ts, model, input_tokens,
                output_tokens, cache_read_tokens, tool_result_bytes, cost_equiv_u
         FROM turns ORDER BY message_id`,
      )
      .all(),
    sessions: d
      .prepare(
        `SELECT session_id, turn_count, user_turn_count, compaction_count,
                cost_equiv_u, first_turn_at, last_turn_at
         FROM sessions ORDER BY session_id`,
      )
      .all(),
    toolEvents: d
      .prepare(
        `SELECT event_id, session_id, tool_name, input_bytes, result_bytes, exit_class, commit_sha
         FROM tool_events ORDER BY event_id`,
      )
      .all(),
    metricEvents: d.prepare("SELECT COUNT(*) AS n FROM ingest_metric_events").get(),
    quarantine: d
      .prepare("SELECT file_path, line_no, error_class FROM ingest_quarantine ORDER BY q_id")
      .all(),
  });
}

function ingestOnce(target: Db, root: string, file: string): string {
  const clean = new Ingestor(target, [root], OPTS);
  clean.ingestFile(file, SLUG);
  return dump(target);
}

describe("multi-chunk equivalence", () => {
  it("tiny-budget chunked ingest matches one-shot final state exactly", async () => {
    writeCorpus(tmp, { [SLUG]: { "s.jsonl": correlationLines("perf4-eq") } });
    const file = path.join(tmp, SLUG, "s.jsonl");

    const chunked = new Ingestor(db, [tmp], OPTS);
    await chunked.ingestFileYielding(file, SLUG, 64); // many chunks, ~1 line each

    const ref = migratedMemDb();
    try {
      expect(dump(db)).toEqual(ingestOnce(ref, tmp, file));
    } finally {
      ref.close();
    }
  });
});

describe("failure between map mutation and commit", () => {
  it("single-chunk rollback discards staged correlation state; retry equals clean ingest", () => {
    // The failing line comes AFTER the tool_result, so countedResults and
    // resultBytesByMsg were mutated inside the doomed transaction.
    const session = "perf4-rollback";
    const lines = correlationLines(session);
    lines.push(
      assistant({ id: `${session}-inject-fail-here`, session, ts: "2026-01-05T00:06:00.000Z" }),
    );
    writeCorpus(tmp, { [SLUG]: { "s.jsonl": lines } });
    const file = path.join(tmp, SLUG, "s.jsonl");

    const ingestor = new Ingestor(db, [tmp], OPTS);
    injectFailureOn(ingestor, "inject-fail-here");
    expect(() => ingestor.ingestFile(file, SLUG)).toThrow("injected mid-transaction failure");

    // The whole (single) chunk rolled back: nothing committed, offset unadvanced.
    expect((db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n).toBe(0);
    expect(db.prepare("SELECT * FROM ingest_offsets").all()).toEqual([]);

    // Same-process retry (marker disarmed) must equal a clean ingest — if the
    // failed transaction's countedResults/resultBytesByMsg had leaked, the
    // retry would skip the tool_result accumulation and diverge.
    ingestor.ingestFile(file, SLUG);
    const ref = migratedMemDb();
    try {
      expect(dump(db)).toEqual(ingestOnce(ref, tmp, file));
    } finally {
      ref.close();
    }
  });

  it("multi-chunk failure keeps committed chunks, then retry completes (no stale version skip)", async () => {
    const session = "perf4-partial";
    const lines = correlationLines(session);
    lines.splice(
      5,
      0,
      assistant({ id: `${session}-inject-fail-here`, session, ts: "2026-01-05T00:02:30.000Z" }),
    );
    writeCorpus(tmp, { [SLUG]: { "s.jsonl": lines } });
    const file = path.join(tmp, SLUG, "s.jsonl");

    const ingestor = new Ingestor(db, [tmp], OPTS);
    injectFailureOn(ingestor, "inject-fail-here");
    await expect(ingestor.ingestFileYielding(file, SLUG, 64)).rejects.toThrow(
      "injected mid-transaction failure",
    );

    // Earlier chunks committed and their offset survived the failure.
    const partialTurns = (db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n;
    expect(partialTurns).toBeGreaterThan(0);
    const offsetRow = db.prepare("SELECT byte_offset FROM ingest_offsets").get() as {
      byte_offset: number;
    };
    expect(offsetRow.byte_offset).toBeGreaterThan(0);
    expect(offsetRow.byte_offset).toBeLessThan(fs.statSync(file).size);

    // Retry on the SAME unchanged file version must resume, not skip: the
    // caught-up marker is only recorded when no unread bytes remain.
    await ingestor.ingestFileYielding(file, SLUG, 64);
    const ref = migratedMemDb();
    try {
      expect(dump(db)).toEqual(ingestOnce(ref, tmp, file));
    } finally {
      ref.close();
    }
  });
});

describe("event-loop yielding", () => {
  it("yields between chunks while a single large file catches up", async () => {
    const session = "perf4-yield";
    const lines: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 200; i++) {
      lines.push(
        assistant({
          id: `${session}-m${i}`,
          session,
          ts: `2026-01-05T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
          input: 10,
        }),
      );
    }
    writeCorpus(tmp, { [SLUG]: { "big.jsonl": lines } });
    const file = path.join(tmp, SLUG, "big.jsonl");

    const ingestor = new Ingestor(db, [tmp], OPTS);
    let ticks = 0;
    let done = false;
    const pump = (async () => {
      while (!done) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        ticks++;
      }
    })();
    await ingestor.ingestFileYielding(file, SLUG, 512);
    done = true;
    await pump;

    expect(ticks).toBeGreaterThan(5); // the event loop turned during catch-up
    expect((db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n).toBe(200);
  });
});

describe("resumable legacy-prefix seeding", () => {
  // ~5 MiB fixture ingested three times synchronously — legitimately exceeds the 5 s
  // default; Vitest 4 enforces the timeout on sync tests where Vitest 2 could not.
  it(
    "re-seeds a large consumed prefix in bounded windows, resuming after an interrupt",
    { timeout: 60_000 },
    () => {
      // ~5 MiB file so seeding needs more than one 4 MiB window.
      const session = "perf4-seed";
      const pad = "p".repeat(1024);
      const rows: string[] = [];
      for (let i = 0; i < 4600; i++) {
        rows.push(
          JSON.stringify({
            ...userPrompt({
              session,
              ts: `2026-01-05T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0").slice(-3)}Z`,
            }),
            uuid: `seed-${i}`,
            pad,
          }),
        );
      }
      const dir = path.join(tmp, SLUG);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "legacy.jsonl");
      fs.writeFileSync(file, `${rows.join("\n")}\n`, "utf8");
      expect(fs.statSync(file).size).toBeGreaterThan(4 * 1024 * 1024);

      new Ingestor(db, [tmp], OPTS).ingestFile(file, SLUG);
      const eventCount = () =>
        (db.prepare("SELECT COUNT(*) AS n FROM ingest_metric_events").get() as { n: number }).n;
      const userTurns = () =>
        (
          db
            .prepare("SELECT user_turn_count AS n FROM sessions WHERE session_id = ?")
            .get(session) as { n: number }
        ).n;
      expect(eventCount()).toBe(4600);
      expect(userTurns()).toBe(4600);

      // Simulate a pre-ledger upgrade: offset kept, baseline + ledger dropped.
      db.prepare("DELETE FROM ingest_metric_baselines").run();
      db.prepare("DELETE FROM ingest_metric_events").run();

      // Interrupt seeding partway: the first window's progress must persist at a
      // line boundary strictly inside the prefix.
      const resumed = new Ingestor(db, [tmp], OPTS);
      type RecordFn = (raw: string, proj: unknown, applyAggregates: boolean) => void;
      const target = resumed as unknown as { recordMetricEvent: RecordFn };
      const orig = target.recordMetricEvent.bind(resumed);
      let calls = 0;
      let armed = true;
      target.recordMetricEvent = (raw, proj, applyAggregates) => {
        calls++;
        if (armed && calls > 3900) {
          armed = false;
          throw new Error("injected seeding interrupt");
        }
        orig(raw, proj, applyAggregates);
      };
      expect(() => resumed.ingestFile(file, SLUG)).toThrow("injected seeding interrupt");
      const baseline = db.prepare("SELECT seeded_offset FROM ingest_metric_baselines").get() as {
        seeded_offset: number;
      };
      const storedOffset = (
        db.prepare("SELECT byte_offset FROM ingest_offsets").get() as { byte_offset: number }
      ).byte_offset;
      expect(baseline.seeded_offset).toBeGreaterThan(0);
      expect(baseline.seeded_offset).toBeLessThan(storedOffset);

      // Resume to completion: every event registered exactly once, aggregates untouched.
      resumed.ingestFile(file, SLUG);
      expect(eventCount()).toBe(4600);
      expect(userTurns()).toBe(4600);
      const finalBaseline = db
        .prepare("SELECT seeded_offset FROM ingest_metric_baselines")
        .get() as {
        seeded_offset: number;
      };
      expect(finalBaseline.seeded_offset).toBe(storedOffset);
    },
  );
});

describe("durable quarantine identity", () => {
  const qRows = () =>
    db
      .prepare("SELECT q_id, line_no, error_class FROM ingest_quarantine ORDER BY line_no")
      .all() as Array<{ q_id: string; line_no: number; error_class: string }>;

  it("keeps line numbers durable across restart and dedupes same-version replay", () => {
    const session = "perf4-quar";
    writeCorpus(tmp, {
      [SLUG]: {
        "q.jsonl": [
          assistant({ id: `${session}-m1`, session, ts: "2026-01-05T00:00:00.000Z" }),
          { raw: "this is not json {{{" },
          assistant({ id: `${session}-m2`, session, ts: "2026-01-05T00:01:00.000Z" }),
        ],
      },
    });
    const file = path.join(tmp, SLUG, "q.jsonl");
    new Ingestor(db, [tmp], OPTS).ingestFile(file, SLUG);
    expect(qRows().map((r) => r.line_no)).toEqual([2]);

    // Cold restart (fresh process-local cursor), then more lines including a
    // second bad line: its line number must continue from the durable offset,
    // not restart at 1 (which would silently collide with the first bad line).
    fs.appendFileSync(
      file,
      toJsonl([
        { raw: "this is not json {{{" },
        assistant({ id: `${session}-m3`, session, ts: "2026-01-05T00:02:00.000Z" }),
      ]),
    );
    new Ingestor(db, [tmp], OPTS).ingestFile(file, SLUG);
    expect(qRows().map((r) => r.line_no)).toEqual([2, 4]);
    const [first, second] = qRows();
    expect(first?.q_id).not.toBe(second?.q_id);
    expect(first?.error_class).toBe(second?.error_class);

    // Same-version replay (timestamp-only change ⇒ reset + re-scan of the SAME
    // bytes) must dedupe to the same identities, not double the rows.
    const touched = new Date(fs.statSync(file).mtimeMs + 2000);
    fs.utimesSync(file, touched, touched);
    new Ingestor(db, [tmp], OPTS).ingestFile(file, SLUG);
    expect(qRows()).toHaveLength(2);
  });

  it("recovers the same line numbers across restart when the file contains blank lines", () => {
    // The in-process cursor counts only non-blank lines; the restart recovery
    // must match it or a later quarantine would drift to a different line_no.
    const session = "perf4-blank";
    writeCorpus(tmp, {
      [SLUG]: {
        "b.jsonl": [
          assistant({ id: `${session}-m1`, session, ts: "2026-01-05T00:00:00.000Z" }),
          { raw: "" },
          assistant({ id: `${session}-m2`, session, ts: "2026-01-05T00:01:00.000Z" }),
          { raw: "" },
        ],
      },
    });
    const file = path.join(tmp, SLUG, "b.jsonl");
    new Ingestor(db, [tmp], OPTS).ingestFile(file, SLUG);
    expect(qRows()).toHaveLength(0);

    fs.appendFileSync(file, toJsonl([{ raw: "this is not json {{{" }]));
    new Ingestor(db, [tmp], OPTS).ingestFile(file, SLUG); // fresh process-local cursor
    expect(qRows().map((r) => r.line_no)).toEqual([3]); // 3rd non-blank line

    // Single-process reference run agrees on the coordinate.
    const ref = migratedMemDb();
    try {
      new Ingestor(ref, [tmp], OPTS).ingestFile(file, SLUG);
      const refRow = ref.prepare("SELECT line_no FROM ingest_quarantine").get() as {
        line_no: number;
      };
      expect(refRow.line_no).toBe(3);
    } finally {
      ref.close();
    }
  });

  it("gives a rotated file's bad line a fresh identity even at the same line number", () => {
    const session = "perf4-rot";
    writeCorpus(tmp, {
      [SLUG]: {
        "r.jsonl": [
          assistant({ id: `${session}-m1`, session, ts: "2026-01-05T00:00:00.000Z" }),
          { raw: "this is not json {{{" },
        ],
      },
    });
    const file = path.join(tmp, SLUG, "r.jsonl");
    new Ingestor(db, [tmp], OPTS).ingestFile(file, SLUG);
    expect(qRows()).toHaveLength(1);

    // Rotate: different head content, but the bad line sits at the SAME line
    // number with the SAME error class. The head-hash salt must yield a new ID.
    fs.writeFileSync(
      file,
      toJsonl([
        assistant({ id: `${session}-m9-different-head`, session, ts: "2026-01-06T00:00:00.000Z" }),
        { raw: "this is not json {{{" },
      ]),
    );
    new Ingestor(db, [tmp], OPTS).ingestFile(file, SLUG);
    const rows = qRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.line_no).toBe(2);
    expect(rows[1]?.line_no).toBe(2);
    expect(rows[0]?.q_id).not.toBe(rows[1]?.q_id);
  });
});
