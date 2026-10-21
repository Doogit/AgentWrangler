/**
 * test/ingest/idle-floor-gate.test.ts — P0-U14 part B: the 5-min detector
 * idle-floor pass is gated by S4's detector input marker, with a 60-min cap and
 * a local-day rollover override (max W0 staleness 1 h).
 *
 * Oracle: stub post-ingest hook call counts and inputs injected straight into
 * the DB / fake clock — never the ingestor's own counters. The hook stub wires
 * S4's gate.track exactly like the daemon does, so "last completed" is recorded
 * only when a pass resolves.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDetectorBootGate } from "../../src/daemon/boot-state.js";
import type { Db } from "../../src/db/open.js";
import { clearPostIngestHook, setPostIngestHook } from "../../src/ingest/detector-hook.js";
import { Ingestor } from "../../src/ingest/index.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, toJsonl } from "./synth.js";

const MIN = 60_000;
const SLUG = "proj-idle-gate";

let db: Db;
let tmp: string;
let filePath: string;
let handle: { stop(): void } | undefined;
let passes: number;
let failNext: boolean;
let gate: ReturnType<typeof createDetectorBootGate>;

function makeIngestor(overrides: Record<string, unknown> = {}): Ingestor {
  return new Ingestor(db, [tmp], {
    activityWindowSecs: 300,
    now: () => new Date(),
    detectorIdleGate: (at: Date) => gate.idleDue(at),
    ...overrides,
  } as ConstructorParameters<typeof Ingestor>[2]);
}

/** Start the tail after ingesting the seed file, so the first pass is the boot pass only. */
function startQuiet(ing: Ingestor): void {
  ing.ingestFile(filePath, SLUG);
  handle = ing.startTail();
}

function insertWorkItem(id: string): void {
  db.prepare(
    `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
     VALUES (?, (SELECT workspace_id FROM workspaces LIMIT 1), 1, 'MERGED', ?)`,
  ).run(id, new Date().toISOString());
}

function setStartLocal(y: number, mo: number, d: number, h: number, mi: number): void {
  vi.setSystemTime(new Date(y, mo, d, h, mi, 0)); // local wall clock: TZ-independent
}

beforeEach(() => {
  vi.useFakeTimers();
  setStartLocal(2026, 0, 7, 10, 0); // Wednesday 10:00 local
  db = migratedMemDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-idle-gate-"));
  fs.mkdirSync(path.join(tmp, SLUG), { recursive: true });
  filePath = path.join(tmp, SLUG, "s.jsonl");
  fs.writeFileSync(
    filePath,
    toJsonl([
      assistant({
        id: "ig-1",
        session: "ig-session",
        // Old enough that reconcile has already closed the session before the boot pass.
        ts: new Date(Date.now() - 2 * 24 * 60 * MIN).toISOString(),
        input: 100,
        output: 10,
      }),
    ]),
  );
  passes = 0;
  failNext = false;
  gate = createDetectorBootGate(db, { codeVersion: "test-v1", now: () => new Date() });
  const walk = gate.track(async () => {
    if (failNext) {
      failNext = false;
      throw new Error("walk crashed");
    }
    return [];
  });
  setPostIngestHook((_db, now) => {
    passes += 1;
    Promise.resolve(walk(db, now)).catch(() => {});
  });
});

afterEach(() => {
  handle?.stop();
  handle = undefined;
  clearPostIngestHook();
  vi.useRealTimers();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("P0-U14 idle-floor pass gated by the S4 marker", () => {
  it("(a) idle with an unchanged marker: 0 passes for 55 min, exactly 1 at the 60 min cap", async () => {
    startQuiet(makeIngestor());
    expect(passes).toBe(1); // boot pass

    await vi.advanceTimersByTimeAsync(55 * MIN);
    expect(passes).toBe(1);

    await vi.advanceTimersByTimeAsync(5 * MIN); // t = 60 min since the last completed pass
    expect(passes).toBe(2);

    await vi.advanceTimersByTimeAsync(50 * MIN); // the cap restarts from the new completed pass
    expect(passes).toBe(2);
  });

  it("(b) a work_items change makes the next idle-floor tick run a pass", async () => {
    startQuiet(makeIngestor());
    await vi.advanceTimersByTimeAsync(2 * MIN);
    insertWorkItem("wi-1");
    await vi.advanceTimersByTimeAsync(2 * MIN + 30_000);
    expect(passes).toBe(1); // before the 5 min floor
    await vi.advanceTimersByTimeAsync(30_000); // t = 5 min
    expect(passes).toBe(2);
    await vi.advanceTimersByTimeAsync(30 * MIN); // recorded: quiet again
    expect(passes).toBe(2);
  });

  it("(b) a workspace mapping change makes the next idle-floor tick run a pass", async () => {
    startQuiet(makeIngestor());
    await vi.advanceTimersByTimeAsync(2 * MIN);
    db.prepare("UPDATE workspaces SET repo_owner = 'o', repo_name = 'r'").run();
    await vi.advanceTimersByTimeAsync(3 * MIN); // t = 5 min
    expect(passes).toBe(2);
  });

  it("(b) new ingested rows run a pass on the non-idle path", async () => {
    startQuiet(makeIngestor());
    await vi.advanceTimersByTimeAsync(MIN);
    fs.appendFileSync(
      filePath,
      toJsonl([
        assistant({
          id: "ig-2",
          session: "ig-session",
          ts: new Date().toISOString(),
          input: 100,
          output: 10,
        }),
      ]),
    );
    await vi.advanceTimersByTimeAsync(4 * MIN); // t = 5 min
    expect(passes).toBe(2);
  });

  it("(c) a local-day rollover with an unchanged marker runs 1 pass at the first tick after midnight", async () => {
    setStartLocal(2026, 0, 7, 23, 30);
    startQuiet(makeIngestor());
    expect(passes).toBe(1);

    await vi.advanceTimersByTimeAsync(29 * MIN); // 23:59
    expect(passes).toBe(1);

    await vi.advanceTimersByTimeAsync(6 * MIN); // 00:05, first idle check after midnight
    expect(passes).toBe(2);

    await vi.advanceTimersByTimeAsync(30 * MIN); // same day again, marker unchanged
    expect(passes).toBe(2);
  }, 30_000); // 65 fake minutes of tail ticks with real I/O; times out at 5 s under full-suite load

  it("(d) a pass that fails does not record completion: the next tick runs again", async () => {
    startQuiet(makeIngestor());
    await vi.advanceTimersByTimeAsync(2 * MIN);
    insertWorkItem("wi-2");
    failNext = true;
    await vi.advanceTimersByTimeAsync(3 * MIN); // t = 5 min: pass runs and crashes
    expect(passes).toBe(2);

    await vi.advanceTimersByTimeAsync(5 * MIN); // t = 10 min: still dirty, runs again
    expect(passes).toBe(3);

    await vi.advanceTimersByTimeAsync(30 * MIN); // success recorded: quiet
    expect(passes).toBe(3);
  });

  it("(f) a gate that throws fails open: the idle-floor pass still runs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    startQuiet(
      makeIngestor({
        detectorIdleGate: () => {
          throw new Error("SQLITE_BUSY");
        },
      }),
    );
    expect(passes).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(passes).toBe(2);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("discovery tick failed"))).toBe(false);
    warn.mockRestore();
  });

  it("(g) the ingestor forces a pass 60 min after the last one even if the gate keeps saying skip", async () => {
    startQuiet(makeIngestor({ detectorIdleGate: () => false }));
    await vi.advanceTimersByTimeAsync(59 * MIN);
    expect(passes).toBe(1);
    await vi.advanceTimersByTimeAsync(MIN + 30_000);
    expect(passes).toBe(2);
  });

  it("(h) a wall clock set back before the last completed walk counts as due", () => {
    const walk = gate.track(async () => []);
    return Promise.resolve(walk(db, new Date())).then(() => {
      expect(gate.idleDue(new Date(Date.now() - 3 * 60 * MIN))).toBe(true);
    });
  });

  it("(e) post-ingest passes for new data are unchanged even when the gate says skip", async () => {
    startQuiet(makeIngestor({ detectorIdleGate: () => false }));
    await vi.advanceTimersByTimeAsync(MIN);
    fs.appendFileSync(
      filePath,
      toJsonl([
        assistant({
          id: "ig-3",
          session: "ig-session",
          ts: new Date().toISOString(),
          input: 100,
          output: 10,
        }),
      ]),
    );
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(passes).toBe(2);
    await vi.advanceTimersByTimeAsync(55 * MIN); // idle + gate says skip: nothing more
    expect(passes).toBe(2);
  });
});
