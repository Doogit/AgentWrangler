import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHeavyJobGate } from "../../src/daemon/heavy-job-gate.js";
import { createServer } from "../../src/daemon/http.js";
import { createRecsWorkerRunner } from "../../src/daemon/recs-worker-runner.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { migratedMemDb } from "../ingest/dbutil.js";

const spawned = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class FakeWorker {
    constructor() {
      spawned.count += 1;
    }
    on() {
      return this;
    }
    once() {
      return this;
    }
    terminate() {
      return Promise.resolve(0);
    }
  }
  return { ...actual, Worker: FakeWorker };
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(() => {
  spawned.count = 0;
});

describe("heavy job gate", () => {
  it("runs one job at a time, FIFO", async () => {
    const gate = createHeavyJobGate();
    const events: string[] = [];
    const a = deferred();
    const job = (name: string, hold?: Promise<void>) => async () => {
      events.push(`start ${name}`);
      await hold;
      events.push(`end ${name}`);
      return name;
    };
    const pa = gate.run("recs", job("a", a.promise));
    const pb = gate.run("history", job("b"));
    const pc = gate.run("diagnostics", job("c"));
    await tick();
    expect(events).toEqual(["start a"]);
    a.resolve();
    expect(await Promise.all([pa, pb, pc])).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("frees the slot when a job rejects or throws synchronously", async () => {
    const gate = createHeavyJobGate();
    const p1 = gate.run("recs", () => Promise.reject(new Error("boom")));
    const p2 = gate.run("history", () => {
      throw new Error("sync");
    });
    const p3 = gate.run("diagnostics", async () => "ok");
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).rejects.toThrow("sync");
    await expect(p3).resolves.toBe("ok");
  });

  it("does not deadlock when a non-gated caller awaits a gated job queued behind another", async () => {
    const gate = createHeavyJobGate();
    const hold = deferred();
    const history = gate.run("history", () => hold.promise);
    // Report bootstrap shape: not gated itself, awaits a gated recs job.
    const report = (async () => {
      const recs = await gate.run("recs", async () => "recs");
      return `report:${recs}`;
    })();
    await tick();
    hold.resolve();
    await history;
    expect(await report).toBe("report:recs");
  }, 2000);

  it("stop() rejects queued jobs and leaves the running one", async () => {
    const gate = createHeavyJobGate();
    const hold = deferred<string>();
    const running = gate.run("recs", () => hold.promise);
    const queued = gate.run("history", async () => "never");
    gate.stop();
    await expect(queued).rejects.toThrow(/stopped/);
    hold.resolve("done");
    await expect(running).resolves.toBe("done");
    await expect(gate.run("recs", async () => "late")).rejects.toThrow(/stopped/);
  });
});

describe("recs runner with a gate", () => {
  it("cancel() while queued means no worker is spawned and the run rejects", async () => {
    const gate = createHeavyJobGate();
    const hold = deferred();
    const holder = gate.run("history", () => hold.promise);
    const runner = createRecsWorkerRunner("unused.sqlite", gate);
    const queued = runner.run();
    const assertion = expect(queued).rejects.toThrow(/cancelled/);
    runner.cancel();
    hold.resolve();
    await holder;
    await assertion;
    expect(spawned.count).toBe(0);
  });

  it("a run queued after cancel() still spawns", async () => {
    const gate = createHeavyJobGate();
    const runner = createRecsWorkerRunner("unused.sqlite", gate);
    runner.cancel();
    void runner.run().catch(() => {});
    await tick();
    expect(spawned.count).toBe(1);
  });

  it("stop() while queued means no worker is spawned", async () => {
    const gate = createHeavyJobGate();
    const hold = deferred();
    const holder = gate.run("history", () => hold.promise);
    const runner = createRecsWorkerRunner("unused.sqlite", gate);
    const queued = runner.run();
    const assertion = expect(queued).rejects.toThrow(/stopped/);
    runner.stop();
    hold.resolve();
    await holder;
    await assertion;
    expect(spawned.count).toBe(0);
  });
});

describe("/api/status while the gate is held", () => {
  it("answers in under 1 s", async () => {
    const db = migratedMemDb();
    setQueryDb(db);
    const gate = createHeavyJobGate();
    const hold = deferred();
    const held = gate.run("recs", () => hold.promise);
    const queued = gate.run("history", async () => {});
    const server = createServer(db, 0, null);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const startedAt = Date.now();
      const status = await new Promise<number>((resolve, reject) => {
        http
          .get(
            {
              hostname: "127.0.0.1",
              port,
              path: "/api/status",
              headers: { host: `127.0.0.1:${port}` },
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode ?? 0));
            },
          )
          .on("error", reject);
      });
      expect(status).toBe(200);
      expect(Date.now() - startedAt).toBeLessThan(1000);
    } finally {
      hold.resolve();
      await Promise.all([held, queued]);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      resetQueryDb();
      db.close();
    }
  });
});
