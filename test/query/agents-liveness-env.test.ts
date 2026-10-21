import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// Never run the real `claude agents`: capture the spawn and answer with a failed exit.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

const { getAgentsLiveness } = await import("../../src/query/api/agents-liveness.js");

describe("claude agents spawn env (D2)", () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (previousKey === undefined) Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    else process.env.ANTHROPIC_API_KEY = previousKey;
  });

  it("never passes the daemon's ANTHROPIC_API_KEY to `claude agents`", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-daemon";
    let env: NodeJS.ProcessEnv | undefined;
    spawnMock.mockImplementation(
      (_cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        env = opts.env;
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          kill: () => true,
        });
        queueMicrotask(() => child.emit("close", 1));
        return child;
      },
    );
    const res = await getAgentsLiveness();
    expect(res.data?.available).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe("claude");
    expect(env).toBeDefined();
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env?.PATH ?? env?.Path).toBeDefined();
  });
});
