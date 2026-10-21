import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecsSnapshotService } from "../../src/daemon/recs-snapshot.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// OV-13: the last recs build's duration feeds "usually ~N s" on the Summary page and status bar.
describe("recs build duration (OV-13)", () => {
  let dir: string;
  // Isolated migrated DB: the service's default token readers and dismissal expiry use the query DB.
  const db = createInMemoryFixtureDb();
  beforeEach(() => setQueryDb(db));
  afterEach(() => {
    resetQueryDb();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists the build time excluding the gate wait, and reads it back after a restart", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-recs-ms-"));
    const durationFile = path.join(dir, "recs-build-ms.json");
    let perf = 0;
    vi.spyOn(performance, "now").mockImplementation(() => perf);

    const first = createRecsSnapshotService({
      durationFile,
      builder: async (_scope, onStart) => {
        perf += 5_000; // queued behind another heavy job
        onStart?.();
        perf += 1_234; // the build itself
        return { result: { data: null } as never, builtAtMs: Date.now() };
      },
    });
    expect(first.coldBuild()).toBeNull();
    await first.get();
    first.stop();
    expect(JSON.parse(fs.readFileSync(durationFile, "utf8"))).toEqual({ ms: 1_234 });

    const second = createRecsSnapshotService({
      durationFile,
      builder: () => new Promise(() => {}),
    });
    void second.get();
    const peeked = second.peek();
    expect(peeked.state).toBe("building");
    expect(peeked.state === "building" && peeked.expectedMs).toBe(1_234);
    expect(second.coldBuild()).toEqual({ sinceMs: expect.any(Number), expectedMs: 1_234 });
    second.stop();
  });

  it("no duration file yet → expectedMs null", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-recs-ms-"));
    const service = createRecsSnapshotService({
      durationFile: path.join(dir, "missing.json"),
      builder: () => new Promise(() => {}),
    });
    void service.get();
    expect(service.coldBuild()).toEqual({ sinceMs: expect.any(Number), expectedMs: null });
    service.stop();
  });
});
