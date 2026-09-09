/**
 * test/ingest/perf5-idle-gating.test.ts — PERF5 idle gating of the per-tick
 * reconcile and the discovery-tick detector pass.
 *
 * Covers:
 *   - idle tail ticks (nothing parsed) skip reconcile until reconcileIdleFloorMs
 *   - a tick that parses new lines reconciles immediately, floor or not
 *   - idle discovery ticks skip the detector pass until detectorIdleFloorMs
 *   - new parsed lines since the last pass trigger detectors on the next
 *     discovery tick
 *   - floors of 0 restore the ungated per-tick behavior (benchmark "off" mode)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/open.js";
import { clearPostIngestHook, setPostIngestHook } from "../../src/ingest/detector-hook.js";
import { Ingestor } from "../../src/ingest/index.js";
import { reconcileSessions } from "../../src/ingest/reconcile.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, toJsonl } from "./synth.js";

vi.mock("../../src/ingest/reconcile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ingest/reconcile.js")>();
  return { ...actual, reconcileSessions: vi.fn(actual.reconcileSessions) };
});

const reconcileSpy = vi.mocked(reconcileSessions);

const TAIL_MS = 1_000;
const DISCOVERY_MS = 5_000;
const RECONCILE_FLOOR_MS = 10_000;
const DETECTOR_FLOOR_MS = 20_000;

let db: Db;
let tmp: string;
let slugDir: string;
let filePath: string;
let handle: { stop(): void } | undefined;
let detectorPasses: number;
let appended: number;

function makeIngestor(
  overrides: Partial<ConstructorParameters<typeof Ingestor>[2]> = {},
): Ingestor {
  return new Ingestor(db, [tmp], {
    activityWindowSecs: 300,
    tailIntervalMs: TAIL_MS,
    discoveryIntervalMs: DISCOVERY_MS,
    reconcileIdleFloorMs: RECONCILE_FLOOR_MS,
    detectorIdleFloorMs: DETECTOR_FLOOR_MS,
    now: () => new Date(), // mocked Date — tracks fake-timer time
    ...overrides,
  });
}

function appendTurn(): void {
  appended += 1;
  fs.appendFileSync(
    filePath,
    `${toJsonl([
      assistant({
        id: `gate-append-${appended}`,
        session: "gate-session",
        ts: "2026-01-03T00:01:00.000Z",
        input: 100,
        output: 10,
      }),
    ])}`,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-03T12:00:00.000Z"));
  db = migratedMemDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-idle-gating-"));
  slugDir = path.join(tmp, "proj-gate");
  fs.mkdirSync(slugDir, { recursive: true });
  filePath = path.join(slugDir, "s.jsonl");
  fs.writeFileSync(
    filePath,
    toJsonl([
      assistant({
        id: "gate-1",
        session: "gate-session",
        ts: "2026-01-03T00:00:00.000Z",
        input: 100,
        output: 10,
      }),
    ]),
  );
  appended = 0;
  detectorPasses = 0;
  setPostIngestHook(() => {
    detectorPasses += 1;
  });
  reconcileSpy.mockClear();
});

afterEach(() => {
  handle?.stop();
  handle = undefined;
  clearPostIngestHook();
  vi.useRealTimers();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("idle reconcile floor", () => {
  it("skips reconcile on idle ticks until the floor elapses", async () => {
    const ing = makeIngestor();
    handle = ing.startTail(); // boot: reconcile #1 at t=0
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RECONCILE_FLOOR_MS - TAIL_MS); // t=9s: idle ticks only
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TAIL_MS); // t=10s: floor due
    expect(reconcileSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(RECONCILE_FLOOR_MS - TAIL_MS); // t=19s
    expect(reconcileSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(TAIL_MS); // t=20s
    expect(reconcileSpy).toHaveBeenCalledTimes(3);
  });

  it("reconciles immediately on a tick that parsed new lines", async () => {
    const ing = makeIngestor();
    handle = ing.startTail();
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    appendTurn();
    await vi.advanceTimersByTimeAsync(TAIL_MS); // t=1s: parsed → reconcile despite floor
    expect(reconcileSpy).toHaveBeenCalledTimes(2);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM turns WHERE message_id='gate-append-1'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it("floors of 0 restore ungated per-tick reconcile", async () => {
    const ing = makeIngestor({ reconcileIdleFloorMs: 0, detectorIdleFloorMs: 0 });
    handle = ing.startTail();
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * TAIL_MS); // three idle ticks
    expect(reconcileSpy).toHaveBeenCalledTimes(4);
  });
});

describe("idle detector-pass floor", () => {
  it("skips the discovery-tick detector pass until the floor elapses", async () => {
    const ing = makeIngestor();
    handle = ing.startTail(); // boot pass #1 at t=0
    expect(detectorPasses).toBe(1);

    await vi.advanceTimersByTimeAsync(DETECTOR_FLOOR_MS - DISCOVERY_MS); // t=15s: idle discovery ticks
    expect(detectorPasses).toBe(1);

    await vi.advanceTimersByTimeAsync(DISCOVERY_MS); // t=20s: floor due
    expect(detectorPasses).toBe(2);
  });

  it("runs detectors on the next discovery tick after new lines were parsed", async () => {
    const ing = makeIngestor();
    handle = ing.startTail();
    expect(detectorPasses).toBe(1);

    appendTurn();
    await vi.advanceTimersByTimeAsync(TAIL_MS); // tail tick parses the append
    expect(detectorPasses).toBe(1); // detectors wait for the discovery cadence
    await vi.advanceTimersByTimeAsync(DISCOVERY_MS - TAIL_MS); // t=5s: discovery tick
    expect(detectorPasses).toBe(2);

    await vi.advanceTimersByTimeAsync(DISCOVERY_MS); // t=10s: idle again
    expect(detectorPasses).toBe(2);
  });

  it("floors of 0 restore the ungated per-discovery-tick pass", async () => {
    const ing = makeIngestor({ reconcileIdleFloorMs: 0, detectorIdleFloorMs: 0 });
    handle = ing.startTail();
    expect(detectorPasses).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * DISCOVERY_MS); // two idle discovery ticks
    expect(detectorPasses).toBe(3);
  });
});
