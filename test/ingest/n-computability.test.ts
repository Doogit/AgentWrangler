import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { Ingestor } from "../../src/ingest/index.js";
import { computeN } from "../../src/ingest/n-computability.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, toJsonl, writeCorpus } from "./synth.js";

let db: Db;
let root: string;
const opts = { now: () => new Date("2026-08-01T00:00:00.000Z"), activityWindowSecs: 300 };
beforeEach(() => {
  db = migratedMemDb();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-u7-"));
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("U7 N computability", () => {
  it("persists all three structural marker generations as VERIFIED", () => {
    writeCorpus(root, {
      p: {
        "s.jsonl": [
          assistant({ id: "t0", session: "s", ts: "2026-01-01T00:00:00.000Z" }),
          {
            type: "assistant",
            timestamp: "2026-01-01T00:01:00.000Z",
            sessionId: "s",
            isCompactSummary: true,
            message: { content: [] },
          },
          {
            type: "assistant",
            subtype: "compact_boundary",
            timestamp: "2026-01-01T00:02:00.000Z",
            sessionId: "s",
            message: { content: [] },
          },
          {
            type: "summary",
            leafUuid: "leaf",
            timestamp: "2026-01-01T00:03:00.000Z",
            sessionId: "s",
            message: { content: [] },
          },
        ],
      },
    });
    new Ingestor(db, [root], opts).runBackscan();
    expect(
      db
        .prepare(
          "SELECT boundary_kind, boundary_verification FROM ingest_metric_events WHERE session_id='s' AND boundary_kind IS NOT NULL ORDER BY event_ts",
        )
        .all(),
    ).toEqual([
      { boundary_kind: "compact-summary", boundary_verification: "VERIFIED" },
      { boundary_kind: "compact-boundary", boundary_verification: "VERIFIED" },
      { boundary_kind: "legacy-summary", boundary_verification: "VERIFIED" },
    ]);
  });

  it("computes N to a structural boundary and uses an ADV-2 floor for cache collapse", () => {
    writeCorpus(root, {
      p: {
        "s.jsonl": [
          assistant({ id: "a", session: "s", ts: "2026-01-01T00:00:00.000Z", cacheRead: 8000 }),
          assistant({ id: "b", session: "s", ts: "2026-01-01T00:01:00.000Z", cacheRead: 100 }),
          {
            type: "assistant",
            subtype: "compact_boundary",
            timestamp: "2026-01-01T00:02:00.000Z",
            sessionId: "s",
            message: { content: [] },
          },
        ],
      },
    });
    new Ingestor(db, [root], opts).runBackscan();
    const inferred = db
      .prepare(
        "SELECT boundary_kind, boundary_verification FROM ingest_metric_events WHERE boundary_kind='cache-read-collapse'",
      )
      .get();
    expect(inferred).toEqual({
      boundary_kind: "cache-read-collapse",
      boundary_verification: "UNVERIFIED",
    });
    expect(computeN(db, "s", "2026-01-01T00:01:00.000Z")).toMatchObject({
      n: 0,
      observedTurnCount: 1,
      conservativeFloor: true,
      verification: "UNVERIFIED",
    });
    expect(computeN(db, "s", "2026-01-01T00:02:00.000Z")).toMatchObject({
      n: 0,
      conservativeFloor: false,
      verification: "VERIFIED",
    });
  });

  it("decouples the classifier version from the turns parser version (M3)", () => {
    writeCorpus(root, {
      p: {
        "s.jsonl": [
          assistant({
            id: "a",
            session: "s",
            ts: "2026-01-01T00:00:00.000Z",
            extra: { isCompactSummary: true },
          }),
        ],
      },
    });
    new Ingestor(db, [root], opts).runBackscan();
    // `turns` is byte-identical to ingest-3, so its parser_version must stay
    // ingest-3 -- bumping it would spuriously CONFOUND effect cycles that
    // straddle the upgrade. The classifier columns carry their own version tag.
    expect(db.prepare("SELECT DISTINCT parser_version FROM turns").all()).toEqual([
      { parser_version: "ingest-3" },
    ]);
    expect(
      db.prepare("SELECT DISTINCT classifier_version FROM ingest_metric_events").all(),
    ).toEqual([{ classifier_version: "classifier-2" }]);
  });

  it("floors N when a real (timestamp-less) legacy-summary boundary is present (M1)", () => {
    writeCorpus(root, {
      p: {
        "s.jsonl": [
          assistant({ id: "a", session: "s", ts: "2026-01-01T00:00:00.000Z" }),
          assistant({ id: "b", session: "s", ts: "2026-01-01T00:01:00.000Z" }),
          // A REAL legacy-summary record carries no `timestamp` field, so its
          // metric row gets event_ts=NULL and is invisible to the ts-ordered
          // boundary query. It must still floor N rather than let the window
          // span past it and overcount.
          { type: "summary", leafUuid: "leaf", sessionId: "s", message: { content: [] } },
          assistant({ id: "c", session: "s", ts: "2026-01-01T00:02:00.000Z" }),
        ],
      },
    });
    new Ingestor(db, [root], opts).runBackscan();
    expect(
      db
        .prepare(
          "SELECT event_ts, boundary_kind FROM ingest_metric_events WHERE boundary_kind='legacy-summary'",
        )
        .get(),
    ).toEqual({ event_ts: null, boundary_kind: "legacy-summary" });
    const res = computeN(db, "s", "2026-01-01T00:00:00.000Z");
    expect(res).toMatchObject({
      n: 0,
      conservativeFloor: true,
      boundaryKind: "legacy-summary",
      verification: "VERIFIED",
    });
    // The raw count would have overcounted (all three turns) without the floor.
    expect(res.observedTurnCount).toBe(3);
  });

  it("enriches the pre-upgrade prefix of a file that grew across the 022 upgrade (M2)", () => {
    const file = path.join(root, "p", "s.jsonl");
    writeCorpus(root, {
      p: {
        "s.jsonl": [
          assistant({
            id: "a",
            session: "s",
            ts: "2026-01-01T00:00:00.000Z",
            extra: { isCompactSummary: true },
          }),
        ],
      },
    });
    new Ingestor(db, [root], opts).runBackscan();
    // Simulate a file consumed BEFORE 022 landed: the metric row exists but the
    // classifier/boundary columns were never populated and no classifier
    // baseline was recorded.
    db.prepare(
      "UPDATE ingest_metric_events SET classifier_version=NULL, event_ts=NULL, event_position=NULL, boundary_kind=NULL, boundary_verification=NULL",
    ).run();
    db.prepare("DELETE FROM ingest_classifier_baselines").run();
    // The file keeps growing after the upgrade: append a record so the current
    // size exceeds the stored (pre-upgrade) offset and the file version no longer
    // matches -- the case the old sameFileVersion gate skipped, leaving the
    // prefix NULL forever.
    fs.appendFileSync(
      file,
      toJsonl([assistant({ id: "b", session: "s", ts: "2026-01-01T00:01:00.000Z" })]),
      "utf8",
    );
    new Ingestor(db, [root], opts).ingestFile(file, "p");
    expect(
      db
        .prepare(
          "SELECT classifier_version, boundary_kind FROM ingest_metric_events ORDER BY event_position",
        )
        .all(),
    ).toEqual([
      { classifier_version: "classifier-2", boundary_kind: "compact-summary" },
      { classifier_version: "classifier-2", boundary_kind: null },
    ]);
  });

  it("backfills U6 and U7 once and is idempotent", () => {
    const file = path.join(root, "p", "s.jsonl");
    writeCorpus(root, {
      p: {
        "s.jsonl": [
          assistant({
            id: "a",
            session: "s",
            ts: "2026-01-01T00:00:00.000Z",
            extra: { isCompactSummary: true },
          }),
        ],
      },
    });
    new Ingestor(db, [root], opts).runBackscan();
    db.prepare(
      "UPDATE ingest_metric_events SET classifier_version=NULL, event_ts=NULL, event_position=NULL, boundary_kind=NULL, boundary_verification=NULL",
    ).run();
    db.prepare("DELETE FROM ingest_classifier_baselines").run();
    const ingestor = new Ingestor(db, [root], opts);
    ingestor.ingestFile(file, "p");
    const first = db
      .prepare("SELECT classifier_version, event_position, boundary_kind FROM ingest_metric_events")
      .all();
    expect(first).toEqual([
      { classifier_version: "classifier-2", event_position: 1, boundary_kind: "compact-summary" },
    ]);
    new Ingestor(db, [root], opts).ingestFile(file, "p");
    expect(
      db
        .prepare(
          "SELECT classifier_version, event_position, boundary_kind FROM ingest_metric_events",
        )
        .all(),
    ).toEqual(first);
  });
});
