import { afterEach, describe, expect, it, vi } from "vitest";
import { installHook, uninstallHook } from "../../src/ui/api/client";

afterEach(() => vi.unstubAllGlobals());

describe("hook installation status invalidation", () => {
  it.each([installHook, uninstallHook])(
    "notifies mounted views only after a successful mutation",
    async (mutate) => {
      const listener = vi.fn();
      window.addEventListener("agentwrangler:hooks-changed", listener);
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "synthetic-token" })))
        .mockResolvedValueOnce(new Response("conflict", { status: 409 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "fresh-token" })))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ changed: true, settingsPath: "/synthetic/settings.json" })),
        );
      vi.stubGlobal("fetch", fetchMock);
      try {
        await expect(mutate()).rejects.toThrow("conflict");
        expect(listener).not.toHaveBeenCalled();
        await expect(mutate()).resolves.toMatchObject({ changed: true });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenNthCalledWith(
          4,
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({ "X-AgentWrangler-Token": "fresh-token" }),
          }),
        );
      } finally {
        window.removeEventListener("agentwrangler:hooks-changed", listener);
      }
    },
  );
});
