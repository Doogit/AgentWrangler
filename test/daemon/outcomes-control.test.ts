import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createOutcomesControlService } from "../../src/daemon/outcomes-control.js";
import { createOutcomesPassRunner } from "../../src/daemon/outcomes-pass.js";
import { GhCliClient } from "../../src/outcomes/github/gh-cli-client.js";

function setup() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE workspaces (workspace_id TEXT, repo_owner TEXT, repo_name TEXT)");
  const runner = createOutcomesPassRunner({
    db,
    probe: () => {},
    readToken: async () => ({ ok: true, data: "fake" }),
    createClient: () => ({ enabled: true }) as never,
    sync: async () => {},
    link: async () => {},
    derive: () => {},
    findings: async () => {},
    deadlineMs: 100,
  });
  return { db, runner };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("outcomes control service", () => {
  it("keeps separate snapshots, tests one known repo, coalesces and cools down", async () => {
    const { db, runner } = setup();
    db.prepare("INSERT INTO workspaces VALUES ('w', 'owner', 'repo')").run();
    let calls = 0;
    let release: (() => void) | undefined;
    let now = 1000;
    const service = createOutcomesControlService(
      db,
      runner,
      async () => ({ ok: true, data: "fake" }),
      (token) =>
        new GhCliClient(token, async () => {
          calls++;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { ok: true, stdout: "[]", stderr: "", code: 0 };
        }),
      () => now,
    );
    expect(service.snapshot().connection.state).toBe("never-run");
    const first = service.startConnection();
    expect(first.status).toBe(202);
    expect(service.startConnection()).toMatchObject({ status: 409, attemptId: first.attemptId });
    await tick();
    expect(calls).toBe(1);
    release?.();
    await tick();
    expect(service.snapshot()).toMatchObject({
      sync: { state: "never-run" },
      connection: { state: "success", repositoryAccess: "tested" },
    });
    expect(service.startConnection()).toMatchObject({ status: 429, retryAfterMs: 30000 });
    now += 30000;
    expect(service.startSync().status).toBe(202);
    await tick();
    expect(service.snapshot().sync.state).toBe("disabled"); // no producer summary / eligible repo evidence
    db.close();
  });

  it("retains historical connection success across failed and timed-out retries until invalidation", async () => {
    vi.useFakeTimers();
    const { db, runner } = setup();
    db.prepare("INSERT INTO workspaces VALUES ('w', 'owner', 'repo')").run();
    let mode = "success";
    let release: (() => void) | undefined;
    const service = createOutcomesControlService(
      db,
      runner,
      async () => ({ ok: true, data: "fake" }),
      () =>
        ({
          enabled: true,
          testRepositoryAccess: async () => {
            if (mode === "timeout")
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            return mode === "failed"
              ? { ok: false, reason: "unauthorized" }
              : { ok: true, data: [] };
          },
        }) as unknown as GhCliClient,
    );
    try {
      expect(service.startConnection().status).toBe(202);
      await vi.advanceTimersByTimeAsync(0);
      const success = service.snapshot().connection.lastSuccess;
      expect(success).not.toBeNull();
      await vi.advanceTimersByTimeAsync(30_000);
      mode = "failed";
      expect(service.startConnection().status).toBe(202);
      await vi.advanceTimersByTimeAsync(0);
      expect(service.snapshot().connection).toMatchObject({
        state: "failed",
        lastSuccess: success,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      mode = "timeout";
      expect(service.startConnection().status).toBe(202);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.snapshot().connection).toMatchObject({
        state: "timed-out",
        lastSuccess: success,
      });
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      service.invalidateConnection();
      expect(service.snapshot().connection.lastSuccess).toBeNull();
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it("invalidates connection evidence and fences a stale completion by credential epoch", async () => {
    const { db, runner } = setup();
    db.prepare("INSERT INTO workspaces VALUES ('w', 'owner', 'repo')").run();
    let release: (() => void) | undefined;
    const service = createOutcomesControlService(
      db,
      runner,
      async () => ({ ok: true, data: "fake" }),
      (token) =>
        new GhCliClient(token, async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { ok: true, stdout: "[]", stderr: "", code: 0 };
        }),
    );
    service.startConnection();
    await tick();
    service.invalidateConnection();
    expect(service.snapshot().connection).toMatchObject({ state: "never-run", credentialEpoch: 1 });
    expect(service.startConnection().status).toBe(409);
    release?.();
    await tick();
    expect(service.snapshot().connection.state).toBe("never-run");
    db.close();
  });

  it("reports no mapped repository as untested without calling gh", async () => {
    const { db, runner } = setup();
    let calls = 0;
    const service = createOutcomesControlService(
      db,
      runner,
      async () => ({ ok: true, data: "fake" }),
      (token) =>
        new GhCliClient(token, async () => {
          calls++;
          return { ok: true, stdout: "[]", stderr: "", code: 0 };
        }),
    );
    expect(service.startConnection().status).toBe(202);
    await tick();
    expect(service.snapshot().connection).toMatchObject({
      state: "disabled",
      repositoryAccess: "untested",
      attemptedReads: 0,
    });
    expect(calls).toBe(0);
    db.close();
  });

  it("holds the connection slot while a 30-second timeout drains and fences late success", async () => {
    vi.useFakeTimers();
    const { db, runner } = setup();
    db.prepare("INSERT INTO workspaces VALUES ('w', 'owner', 'repo')").run();
    let release: (() => void) | undefined;
    const service = createOutcomesControlService(
      db,
      runner,
      async () => ({ ok: true, data: "fake" }),
      (token) =>
        new GhCliClient(token, async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { ok: true, stdout: "[]", stderr: "", code: 0 };
        }),
    );
    try {
      const first = service.startConnection();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(release).toBeTypeOf("function");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.snapshot().connection).toMatchObject({ state: "timed-out", draining: true });
      expect(service.startConnection()).toMatchObject({ status: 409, attemptId: first.attemptId });
      release?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(service.snapshot().connection).toMatchObject({ state: "timed-out", draining: false });
      expect(service.startConnection().status).toBe(202); // cooldown elapsed while draining
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });
});
