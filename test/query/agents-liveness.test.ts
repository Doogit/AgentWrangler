import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endSession } from "../../src/query/api/agents-liveness.js";

const children: ChildProcess[] = [];

function startChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1e9)"]);
  children.push(child);
  return child;
}

function childPid(child: ChildProcess): number {
  if (child.pid === undefined) throw new Error("child did not receive a pid");
  return child.pid;
}

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function waitForGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (isGone(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

afterEach(async () => {
  const spawned = children.splice(0);
  for (const child of spawned) {
    if (child.pid !== undefined && !isGone(child.pid)) child.kill("SIGKILL");
  }
  await Promise.all(
    spawned.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("exit", () => resolve());
        }),
    ),
  );
});

describe("endSession", () => {
  it("refuses to end a process without explicit confirmation", async () => {
    const pid = childPid(startChild());
    expect(await endSession(pid, undefined)).toEqual({
      ok: false,
      reason: "confirmation required",
      status: 400,
    });
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  it("ends a confirmed process", async () => {
    const pid = childPid(startChild());
    const result = await endSession(pid, true);
    expect(result).toEqual({ ok: true, ended: pid, status: 200 });
    expect(await waitForGone(pid)).toBe(true);
  });

  it("refuses a stale pid honestly", async () => {
    const child = startChild();
    const pid = childPid(child);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(await endSession(pid, true)).toEqual({
      ok: false,
      reason: "process not found",
      status: 404,
    });
  });

  it("rejects a non-integer pid", async () => {
    expect(await endSession(1.5, true)).toEqual({ ok: false, reason: "invalid pid", status: 400 });
  });

  it.runIf(process.platform !== "win32")(
    "D5: ends the whole process group, not just the leader",
    async () => {
      // Leader in its own group (detached) with a grandchild that ignores nothing.
      const leader = spawn(
        process.execPath,
        [
          "-e",
          "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{stdio:'ignore'});process.stdout.write(String(c.pid));setInterval(()=>{},1e9)",
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      children.push(leader);
      const grandchild = await new Promise<number>((resolve) =>
        leader.stdout?.once("data", (b: Buffer) => resolve(Number(b.toString()))),
      );
      const pid = childPid(leader);
      expect(await endSession(pid, true)).toEqual({ ok: true, ended: pid, status: 200 });
      expect(await waitForGone(grandchild)).toBe(true);
    },
  );
});

describe("endSession on macOS/Linux (D5, process.kill stubbed)", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const esrch = () => Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  let killSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
  });
  afterEach(() => {
    if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
    killSpy?.mockRestore();
  });

  function stubKill(impl: (pid: number, signal: string | number | undefined) => void) {
    const calls: Array<[number, string | number | undefined]> = [];
    killSpy = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: string | number,
    ) => {
      calls.push([pid, signal]);
      impl(pid, signal);
      return true;
    }) as typeof process.kill);
    return calls;
  }

  // 4242 leads its own group; the daemon is in group 1000.
  const leader = { pgidOf: async (p: number) => (p === 4242 ? 4242 : 1000) };

  it("signals the process group (negative pid) first", async () => {
    let termed = false;
    const calls = stubKill((pid, signal) => {
      if (signal === "SIGTERM") termed = true;
      if (signal === 0 && termed) throw esrch();
    });
    expect(await endSession(4242, true, leader)).toEqual({ ok: true, ended: 4242, status: 200 });
    expect(calls).toContainEqual([-4242, "SIGTERM"]);
    expect(calls).not.toContainEqual([4242, "SIGTERM"]);
  });

  it("falls back to the pid when the group signal fails", async () => {
    let termed = false;
    const calls = stubKill((pid, signal) => {
      if (pid < 0) throw esrch(); // no group with that id
      if (signal === "SIGTERM") termed = true;
      if (signal === 0 && termed) throw esrch();
    });
    expect(await endSession(4242, true, leader)).toEqual({ ok: true, ended: 4242, status: 200 });
    expect(calls).toContainEqual([-4242, "SIGTERM"]);
    expect(calls).toContainEqual([4242, "SIGTERM"]);
  });

  it("escalates to SIGKILL on the group when it outlives SIGTERM", async () => {
    const calls = stubKill(() => {});
    expect(await endSession(4242, true, { ...leader, graceMs: 300 })).toEqual({
      ok: true,
      ended: 4242,
      status: 200,
    });
    expect(calls).toContainEqual([-4242, "SIGKILL"]);
  });

  it("F2: gives SIGTERM a grace window before SIGKILL", async () => {
    let termedAt = 0;
    let killedAt = 0;
    stubKill((_pid, signal) => {
      if (signal === "SIGTERM") termedAt = Date.now();
      if (signal === "SIGKILL") killedAt = Date.now();
    });
    await endSession(4242, true, { ...leader, graceMs: 400 });
    expect(killedAt - termedAt).toBeGreaterThanOrEqual(380);
  });

  it("F2: no SIGKILL when the agent exits during the grace window", async () => {
    let termedAt = 0;
    const calls = stubKill((_pid, signal) => {
      if (signal === "SIGTERM") termedAt = Date.now();
      // Takes ~350 ms to shut down: longer than one poll, shorter than the grace.
      if (signal === 0 && termedAt > 0 && Date.now() - termedAt > 350) throw esrch();
    });
    expect(await endSession(4242, true, leader)).toEqual({ ok: true, ended: 4242, status: 200 });
    expect(calls.some(([, s]) => s === "SIGKILL")).toBe(false);
  });

  it("F2: default grace is about 3 s", async () => {
    let termedAt = 0;
    let killedAt = 0;
    stubKill((_pid, signal) => {
      if (signal === "SIGTERM") termedAt = Date.now();
      if (signal === "SIGKILL") killedAt = Date.now();
    });
    await endSession(4242, true, leader);
    expect(killedAt - termedAt).toBeGreaterThanOrEqual(2_900);
  }, 10_000);

  it("F3: signals only the pid when it does not lead its own group", async () => {
    let termed = false;
    const calls = stubKill((pid, signal) => {
      if (signal === "SIGTERM") termed = true;
      if (signal === 0 && termed) throw esrch();
    });
    const notLeader = { pgidOf: async (p: number) => (p === 4242 ? 777 : 1000), graceMs: 300 };
    expect(await endSession(4242, true, notLeader)).toEqual({ ok: true, ended: 4242, status: 200 });
    expect(calls).toContainEqual([4242, "SIGTERM"]);
    expect(calls.some(([p]) => p < 0)).toBe(false);
  });

  it("F3: never signals the group when the daemon is in it", async () => {
    const calls = stubKill(() => {});
    const sharedGroup = { pgidOf: async () => 4242, graceMs: 300 };
    expect(await endSession(4242, true, sharedGroup)).toEqual({
      ok: true,
      ended: 4242,
      status: 200,
    });
    expect(calls).toContainEqual([4242, "SIGTERM"]);
    expect(calls).toContainEqual([4242, "SIGKILL"]);
    expect(calls.some(([p]) => p < 0)).toBe(false);
  });

  it("F3: signals only the pid when the pgid lookup fails, without throwing", async () => {
    let termed = false;
    const calls = stubKill((pid, signal) => {
      if (signal === "SIGTERM") termed = true;
      if (signal === 0 && termed) throw esrch();
    });
    const broken = {
      pgidOf: async () => {
        throw new Error("ps missing");
      },
      graceMs: 300,
    };
    expect(await endSession(4242, true, broken)).toEqual({ ok: true, ended: 4242, status: 200 });
    expect(calls.some(([p]) => p < 0)).toBe(false);
  });

  it("waits without blocking the event loop", async () => {
    let termed = false;
    stubKill((_pid, signal) => {
      if (signal === "SIGTERM") termed = true;
      if (signal === 0 && termed) throw esrch();
    });
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 10);
    const pending = endSession(4242, true, leader);
    expect(pending).toBeInstanceOf(Promise);
    expect(ticked).toBe(false);
    await pending;
    // The 10 ms timer ran during the pause: Atomics.wait would have starved it until after.
    expect(ticked).toBe(true);
  });
});
