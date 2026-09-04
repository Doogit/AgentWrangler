import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GhSpawn, createGhRunner } from "../../src/outcomes/github/gh-cli-client.js";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly kill = vi.fn(() => true);
}

function fakeRunner(): { child: FakeChild; runner: ReturnType<typeof createGhRunner> } {
  const child = new FakeChild();
  const spawn = (() => child) as unknown as GhSpawn;
  return { child, runner: createGhRunner(spawn) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("gh child runner streaming limits", () => {
  it("accepts an exact UTF-8 byte bound", async () => {
    const { child, runner } = fakeRunner();
    const resultPromise = runner(["api", "fixture"], {
      token: "tok",
      maxStdoutBytes: 2,
    });

    child.stdout.write(Buffer.from("é", "utf8"));
    child.emit("close", 0);

    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      stdout: "é",
      code: 0,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("kills on a multibyte overflow without retaining the over-limit chunk and waits for close", async () => {
    const { child, runner } = fakeRunner();
    let settled = false;
    const resultPromise = runner(["api", "fixture"], {
      token: "tok",
      maxStdoutBytes: 1,
    });
    resultPromise.then(() => {
      settled = true;
    });

    child.stdout.write(Buffer.from("é", "utf8"));
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);

    child.emit("close", null);
    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      stdout: "",
      code: null,
      failure: "stdout-limit",
    });
  });
});

describe("gh child runner timeout lifecycle", () => {
  it("records and kills at timeout but leaves the promise pending until close", async () => {
    vi.useFakeTimers();
    const { child, runner } = fakeRunner();
    let settled = false;
    const resultPromise = runner(["api", "fixture"], { token: "tok", timeoutMs: 5 });
    resultPromise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(5);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);

    child.emit("close", null);
    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      code: null,
      failure: "timeout",
    });
  });
});
