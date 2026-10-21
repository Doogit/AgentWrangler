/**
 * test/daemon/boot-state.test.ts — P0-U13 S4: boot state survives restarts.
 *
 * A "reboot" closes the on-disk DB and reopens it with fresh runner/gate
 * instances, so nothing in memory carries over; only what the DB persisted does.
 *
 * Outcomes (a–c): the boot pass is skipped while the last COMPLETED pass is newer
 * than the poll interval; the lifecycle tick still fires; a failed or interrupted
 * pass leaves no completion marker; the new-mapping trigger (run()) is never gated.
 *
 * Detector (d–f): the boot walk is skipped when nothing the detectors read changed
 * since the last completed walk; new ingested rows, a mapping change, a new ISO
 * week, a detector code-version change or a work_items change each force one walk;
 * the marker is written only after a walk completes.
 *
 * Oracle: stub hook call counts (sync / walk calls) against inputs the test
 * injects with plain SQL and a fake clock — never the code's own counters.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDetectorBootGate } from "../../src/daemon/boot-state.js";
import {
  type DetectorPassRun,
  completeBackgroundDetectorPhase,
  createDetectorPassRunner,
} from "../../src/daemon/detector-pass.js";
import { createDaemonLifecycle } from "../../src/daemon/lifecycle.js";
import {
  OUTCOMES_POLL_INTERVAL_MS,
  type OutcomesPassDeps,
  createOutcomesPassRunner,
} from "../../src/daemon/outcomes-pass.js";
import { runMigrations } from "../../src/db/migrate.js";
import { type Db, openDb } from "../../src/db/open.js";
import type { BackgroundPipelineProgress } from "../../src/ingest/ingestor.js";
import type { GithubClient } from "../../src/outcomes/github/client.js";
import type { OutcomeStageSummary } from "../../src/outcomes/stage-summary.js";

const MIN = 60_000;
const T0 = new Date("2026-09-29T12:00:00.000Z"); // a Tuesday; ISO week 2026-W40

let dir: string;
let dbPath: string;
let db: Db;

function boot(): Db {
  db = openDb(dbPath);
  runMigrations(db);
  return db;
}

function reboot(): Db {
  db.close();
  return boot();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-boot-state-"));
  dbPath = path.join(dir, "db.sqlite");
  boot();
});

afterEach(() => {
  vi.useRealTimers();
  try {
    db.close();
  } catch {
    // already closed
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── outcomes ────────────────────────────────────────────────────────────────

const OK_SUMMARY: OutcomeStageSummary = {
  eligibleRepositories: 1,
  attemptedReads: 1,
  failedReads: 0,
  categories: {},
  repositories: [],
};

const stubClient = { enabled: true } as unknown as GithubClient;

function outcomesRunner(
  database: Db,
  counts: { sync: number },
  overrides: Partial<OutcomesPassDeps> = {},
) {
  return createOutcomesPassRunner({
    db: database,
    probe: () => {},
    readToken: async () => ({ ok: true, data: "fake-token" }),
    createClient: () => stubClient,
    sync: async () => {
      counts.sync++;
      return OK_SUMMARY;
    },
    link: async () => OK_SUMMARY,
    derive: () => {},
    findings: async () => OK_SUMMARY,
    ...overrides,
  });
}

describe("S4 outcomes boot pass", () => {
  it("(a) a reboot within the interval after a completed pass runs 0 boot passes; the tick still fires", async () => {
    vi.useFakeTimers({ now: T0 });
    const counts = { sync: 0 };
    await outcomesRunner(db, counts).runAtBoot();
    expect(counts.sync).toBe(1);

    vi.setSystemTime(T0.getTime() + 5 * MIN);
    const database = reboot();
    const runner = outcomesRunner(database, counts);
    const lifecycle = createDaemonLifecycle({
      bootScan: async () => {
        void runner.runAtBoot();
        return null;
      },
      calibrationTick: () => {},
      outcomesTick: () => {
        void runner.run();
      },
      reportsTick: () => {},
      closeServer: (onClosed) => onClosed(),
      closeDb: () => {},
      outcomesIntervalMs: OUTCOMES_POLL_INTERVAL_MS,
    });
    lifecycle.kickBootScan();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(counts.sync).toBe(1); // boot pass skipped

    await vi.advanceTimersByTimeAsync(OUTCOMES_POLL_INTERVAL_MS);
    expect(counts.sync).toBe(2); // the 10-min tick still runs on schedule
    lifecycle.shutdown();
  });

  it("(b) a reboot after the interval runs exactly 1 boot pass", async () => {
    vi.useFakeTimers({ now: T0 });
    const counts = { sync: 0 };
    await outcomesRunner(db, counts).runAtBoot();
    expect(counts.sync).toBe(1);

    vi.setSystemTime(T0.getTime() + OUTCOMES_POLL_INTERVAL_MS + MIN);
    await outcomesRunner(reboot(), counts).runAtBoot();
    expect(counts.sync).toBe(2);
  });

  it("(b) a FAILED last pass leaves no completion marker, so the next boot runs", async () => {
    vi.useFakeTimers({ now: T0 });
    const counts = { sync: 0 };
    const failing = outcomesRunner(db, counts, {
      sync: async () => {
        counts.sync++;
        throw new Error("boom");
      },
      link: async () => {
        throw new Error("boom");
      },
      findings: async () => {
        throw new Error("boom");
      },
    });
    await failing.runAtBoot();
    expect(failing.snapshot().state).toBe("failed");
    expect(counts.sync).toBe(1);

    vi.setSystemTime(T0.getTime() + MIN);
    await outcomesRunner(reboot(), counts).runAtBoot();
    expect(counts.sync).toBe(2);
  });

  it("(b) an interrupted last pass (process died mid-pass) leaves no marker, so the next boot runs", async () => {
    vi.useFakeTimers({ now: T0 });
    const counts = { sync: 0 };
    const hung = outcomesRunner(db, counts, {
      sync: () => {
        counts.sync++;
        return new Promise<OutcomeStageSummary>(() => {}); // never settles: the daemon dies here
      },
    });
    void hung.runAtBoot();
    await vi.advanceTimersByTimeAsync(10);
    expect(counts.sync).toBe(1);

    vi.setSystemTime(T0.getTime() + MIN);
    await outcomesRunner(reboot(), counts).runAtBoot();
    expect(counts.sync).toBe(2);
  });

  it("(c) the new-mapping trigger still runs a pass inside the skip window", async () => {
    vi.useFakeTimers({ now: T0 });
    const counts = { sync: 0 };
    await outcomesRunner(db, counts).runAtBoot();

    vi.setSystemTime(T0.getTime() + MIN);
    const runner = outcomesRunner(reboot(), counts);
    await runner.runAtBoot();
    expect(counts.sync).toBe(1); // boot skipped
    await runner.run(); // index.ts onNewMappings → runOutcomesPass()
    expect(counts.sync).toBe(2);
  });
});

// ── detector ────────────────────────────────────────────────────────────────

function seed(database: Db): void {
  database
    .prepare(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('w1', 'slug-1', ?)",
    )
    .run(T0.toISOString());
  database
    .prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count)
       VALUES ('s1', 'w1', 'f1.jsonl', ?, ?, 'LIVE', 1)`,
    )
    .run(T0.toISOString(), T0.toISOString());
  insertTurn(database, "m1");
  database
    .prepare(
      "INSERT INTO ingest_offsets (file_path, byte_offset, updated_at) VALUES ('f1.jsonl', 100, ?)",
    )
    .run(T0.toISOString());
}

function insertTurn(database: Db, id: string): void {
  database
    .prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version)
       VALUES (?, 's1', 'w1', ?, 'model-a', 'p1')`,
    )
    .run(id, T0.toISOString());
}

const PROGRESS: BackgroundPipelineProgress = {
  phase: "reading",
  files_total: 0,
  files_completed: 0,
  files_skipped: 0,
  files_with_new_data: 0,
  detector_runs: 0,
};

/** One daemon boot's detector wiring, as index.ts composes it. */
function detectorBoot(
  database: Db,
  walk: DetectorPassRun,
  opts: { now?: Date; codeVersion?: string } = {},
) {
  const now = () => opts.now ?? T0;
  const gate = createDetectorBootGate(database, {
    now,
    ...(opts.codeVersion !== undefined ? { codeVersion: opts.codeVersion } : {}),
  });
  const runner = createDetectorPassRunner({ db: database, now, run: gate.track(walk) });
  return {
    runner,
    bootPhase: () => completeBackgroundDetectorPhase(PROGRESS, gate.forBoot(runner), () => {}),
  };
}

function countingWalk(counter: { n: number }): DetectorPassRun {
  return async () => {
    counter.n++;
    return [];
  };
}

describe("S4 detector boot pass", () => {
  beforeEach(() => seed(db));

  it("(d) a reboot with no new data or mappings runs 0 detector walks", async () => {
    const walks = { n: 0 };
    await detectorBoot(db, countingWalk(walks)).bootPhase();
    expect(walks.n).toBe(1); // first boot: no marker yet

    await detectorBoot(reboot(), countingWalk(walks)).bootPhase();
    expect(walks.n).toBe(1);
  });

  it("(d) the boot phase still reports done when the walk is skipped", async () => {
    const walks = { n: 0 };
    await detectorBoot(db, countingWalk(walks)).bootPhase();
    const done = await detectorBoot(reboot(), countingWalk(walks)).bootPhase();
    expect(done.phase).toBe("done");
    expect(walks.n).toBe(1);
  });

  const forcing: Array<[string, (database: Db) => void, { now?: Date; codeVersion?: string }]> = [
    ["new ingested turn rows", (d) => insertTurn(d, "m2"), {}],
    [
      "a byte-offset advance (lines consumed without a new turn)",
      (d) => d.prepare("UPDATE ingest_offsets SET byte_offset = 250").run(),
      {},
    ],
    [
      "a session closing LIVE → RECONCILED",
      (d) => d.prepare("UPDATE sessions SET state = 'RECONCILED'").run(),
      {},
    ],
    [
      "a new workspace mapping",
      (d) => d.prepare("UPDATE workspaces SET repo_owner = 'o', repo_name = 'r'").run(),
      {},
    ],
    ["a new ISO week", () => {}, { now: new Date(T0.getTime() + 7 * 24 * 60 * MIN) }],
    ["a detector code-version change", () => {}, { codeVersion: "detectors-next" }],
    [
      "a work_items change from outcomes",
      (d) =>
        d
          .prepare(
            `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
             VALUES ('gh:o/r#1', 'w1', 1, 'MERGED', ?)`,
          )
          .run(T0.toISOString()),
      {},
    ],
  ];

  for (const [label, mutate, opts] of forcing) {
    it(`(e) ${label} forces exactly one walk`, async () => {
      const walks = { n: 0 };
      await detectorBoot(db, countingWalk(walks)).bootPhase();
      expect(walks.n).toBe(1);

      const second = reboot();
      mutate(second);
      await detectorBoot(second, countingWalk(walks), opts).bootPhase();
      expect(walks.n).toBe(2);

      // The forced walk recorded the new state: the next reboot skips again.
      await detectorBoot(reboot(), countingWalk(walks), opts).bootPhase();
      expect(walks.n).toBe(2);
    });
  }

  it("(e) data written while a walk runs is not hidden: the next boot walks again", async () => {
    const walks = { n: 0 };
    await detectorBoot(db, async (d) => {
      walks.n++;
      insertTurn(d, "m-during-walk");
      return [];
    }).bootPhase();
    expect(walks.n).toBe(1);

    await detectorBoot(reboot(), countingWalk(walks)).bootPhase();
    expect(walks.n).toBe(2);
  });

  it("(f) a walk that throws writes no marker: the next boot walks", async () => {
    const walks = { n: 0 };
    await expect(
      detectorBoot(db, async () => {
        walks.n++;
        throw new Error("walk failed");
      }).bootPhase(),
    ).rejects.toThrow("walk failed");

    await detectorBoot(reboot(), countingWalk(walks)).bootPhase();
    expect(walks.n).toBe(2);
  });

  it("(f) a crash mid-walk (never completes) writes no marker: the next boot walks", async () => {
    const walks = { n: 0 };
    await detectorBoot(db, countingWalk(walks)).bootPhase(); // marker for the current state
    insertTurn(db, "m2");
    void detectorBoot(db, () => {
      walks.n++;
      return new Promise(() => {}); // the daemon dies mid-walk
    }).bootPhase();
    await new Promise((resolve) => setImmediate(resolve));
    expect(walks.n).toBe(2);

    await detectorBoot(reboot(), countingWalk(walks)).bootPhase();
    expect(walks.n).toBe(3);
  });

  it("non-boot passes (post-ingest hook, 5-min idle floor) are never gated", async () => {
    const walks = { n: 0 };
    await detectorBoot(db, countingWalk(walks)).bootPhase();
    const { runner } = detectorBoot(reboot(), countingWalk(walks));
    await runner.runIfDue(true);
    expect(walks.n).toBe(2);
  }, 30_000);
});
