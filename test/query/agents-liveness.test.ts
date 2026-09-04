import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
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
  it("refuses to end a process without explicit confirmation", () => {
    const pid = childPid(startChild());
    expect(endSession(pid, undefined)).toEqual({
      ok: false,
      reason: "confirmation required",
      status: 400,
    });
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  it("ends a confirmed process", async () => {
    const pid = childPid(startChild());
    const result = endSession(pid, true);
    expect(result).toEqual({ ok: true, ended: pid, status: 200 });
    expect(await waitForGone(pid)).toBe(true);
  });

  it("refuses a stale pid honestly", async () => {
    const child = startChild();
    const pid = childPid(child);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(endSession(pid, true)).toEqual({
      ok: false,
      reason: "process not found",
      status: 404,
    });
  });

  it("rejects a non-integer pid", () => {
    expect(endSession(1.5, true)).toEqual({ ok: false, reason: "invalid pid", status: 400 });
  });
});
