import { describe, expect, it } from "vitest";
import { createSnapshotService, freshnessOf } from "../../src/daemon/snapshot-service.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("snapshot service (P3-U4)", () => {
  it("coalesces builds per key and reports cold, building, then ready", async () => {
    const gate = deferred<string>();
    let builds = 0;
    const service = createSnapshotService<string, string>({
      build: () => {
        builds += 1;
        return gate.promise;
      },
    });
    expect(service.peek("a").state).toBe("cold");
    const one = service.start("a");
    const two = service.start("a");
    expect(one.task).toBe(two.task);
    expect(builds).toBe(1);
    expect(service.peek("a").state).toBe("building");
    gate.resolve("built");
    await one.task;
    const peeked = service.peek("a");
    expect(peeked.state).toBe("ready");
    if (peeked.state === "ready") {
      expect(peeked.snapshot.value).toBe("built");
      expect(peeked.stale).toBe(false);
      expect(peeked.recomputing).toBe(false);
    }
    service.stop();
  });

  it("OV-13: coldBuilds lists a build only while there is no snapshot to serve", async () => {
    const now = 1_000_000_000_000;
    let gate = deferred<string>();
    const service = createSnapshotService<string, string>({
      build: () => gate.promise,
      now: () => now,
    });
    expect(service.coldBuilds()).toEqual([]);
    const cold = service.start("a");
    expect(service.coldBuilds()).toEqual([{ key: "a", sinceMs: now }]);
    gate.resolve("v1");
    await cold.task;
    expect(service.coldBuilds()).toEqual([]);

    gate = deferred<string>();
    service.markStale();
    const refresh = service.start("a"); // a snapshot is served while this runs
    expect(service.peek("a").state).toBe("ready");
    expect(service.coldBuilds()).toEqual([]);

    service.invalidate(); // snapshot dropped: the running build now has nothing behind it
    expect(service.coldBuilds()).toEqual([{ key: "a", sinceMs: now }]);
    gate.resolve("v2");
    await refresh.task;
    expect(service.coldBuilds()).toEqual([]);
    service.stop();
  });

  it("invalidate drops the snapshot and discards a build that started before it (ADOPT-1)", async () => {
    const gate = deferred<string>();
    let builds = 0;
    const service = createSnapshotService<string, string>({
      build: async () => {
        builds += 1;
        return builds === 1 ? "first" : gate.promise;
      },
    });
    await service.start("a").task;
    const before = service.revision();
    const late = service.start("a"); // not pending any more: a second build
    service.invalidate();
    expect(service.revision()).toBe(before + 1);
    expect(service.peek("a").state).toBe("building");
    gate.resolve("pre-invalidate");
    await late.task;
    expect(late.revision).toBe(before);
    expect(service.peek("a").state).toBe("cold");
    service.stop();
  });

  it("marks a snapshot stale on markStale, an inputs-token change, or a new 10-minute bucket", async () => {
    let now = 1_000_000_000_000;
    let token = "t1";
    const service = createSnapshotService<string, string>({
      build: async () => "v",
      inputsToken: () => token,
      now: () => now,
    });
    await service.start("a").task;
    const stale = () => {
      const peeked = service.peek("a");
      return peeked.state === "ready" && peeked.stale;
    };
    expect(stale()).toBe(false);
    token = "t2";
    expect(stale()).toBe(true);
    await service.start("a").task;
    expect(stale()).toBe(false);
    service.markStale();
    expect(stale()).toBe(true);
    await service.start("a").task;
    expect(stale()).toBe(false);
    now += 600_000;
    expect(stale()).toBe(true);
    service.stop();
  });

  it("refresh rebuilds a stale snapshot once and reports recomputing behind it", async () => {
    let token = "t1";
    const gate = deferred<string>();
    let builds = 0;
    const service = createSnapshotService<string, string>({
      build: async () => {
        builds += 1;
        return builds === 1 ? "old" : gate.promise;
      },
      inputsToken: () => token,
      now: () => 1_000_000_000_000,
    });
    await service.start("a").task;
    token = "t2";
    service.refresh("a");
    service.refresh("a");
    expect(builds).toBe(2);
    const peeked = service.peek("a");
    expect(peeked.state === "ready" && peeked.recomputing).toBe(true);
    expect(peeked.state === "ready" && peeked.snapshot.value).toBe("old");
    expect(freshnessOf(peeked)?.status).toBe("recomputing");
    gate.resolve("new");
    await tick();
    const after = service.peek("a");
    expect(after.state === "ready" && after.snapshot.value).toBe("new");
    expect(freshnessOf(after)?.status).toBe("ready");
    service.stop();
  });

  it("records computed_at after inputs_as_of", async () => {
    let now = 1_000_000_000_000;
    const service = createSnapshotService<string, string>({
      build: async () => {
        now += 2_500;
        return "v";
      },
      now: () => now,
    });
    await service.start("a").task;
    expect(freshnessOf(service.peek("a"))).toEqual({
      status: "ready",
      inputs_as_of: new Date(1_000_000_000_000).toISOString(),
      computed_at: new Date(1_000_000_002_500).toISOString(),
    });
    service.stop();
  });

  it("a cold failure is reported; a failure behind a snapshot backs off 60 s", async () => {
    let now = 1_000_000_000_000;
    let fail = true;
    let builds = 0;
    const service = createSnapshotService<string, string>({
      build: async () => {
        builds += 1;
        if (fail) throw new Error("boom");
        return "v";
      },
      now: () => now,
    });
    await expect(service.start("a").task).rejects.toThrow("boom");
    const failed = service.peek("a");
    expect(failed.state === "failed" && failed.error.message).toBe("boom");
    service.clearFailure("a");
    expect(service.peek("a").state).toBe("cold");

    fail = false;
    await service.start("a").task;
    fail = true;
    service.markStale();
    service.refresh("a");
    await tick();
    expect(builds).toBe(3);
    expect(service.peek("a").state).toBe("ready");
    service.refresh("a");
    expect(builds).toBe(3);
    now += 60_000;
    service.refresh("a");
    expect(builds).toBe(4);
    await tick();
    service.stop();
  });

  it("F3: a failed rebuild's back-off ends early when the inputs token changes", async () => {
    const now = 1_000_000_000_000;
    let token = "t1";
    let fail = false;
    let builds = 0;
    const service = createSnapshotService<string, string>({
      build: async () => {
        builds += 1;
        if (fail) throw new Error("boom");
        return "v";
      },
      inputsToken: () => token,
      now: () => now,
    });
    await service.start("a").task;
    token = "t2";
    fail = true;
    service.refresh("a");
    await tick();
    expect(builds).toBe(2);
    service.refresh("a");
    expect(builds).toBe(2); // same token: still backing off
    token = "t3";
    fail = false;
    service.refresh("a");
    expect(builds).toBe(3); // inputs changed again: retry at once
    await tick();
    service.stop();
  });

  it("stop drops snapshots and ignores builds that finish later", async () => {
    const gate = deferred<string>();
    const service = createSnapshotService<string, string>({ build: () => gate.promise });
    const pending = service.start("a");
    service.stop();
    gate.resolve("late");
    await pending.task;
    expect(service.peek("a").state).toBe("cold");
  });
});
