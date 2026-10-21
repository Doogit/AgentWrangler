import { describe, expect, it } from "vitest";
import { withoutAnthropicApiKey } from "../../src/shared/claude-child-env.js";

describe("withoutAnthropicApiKey (D2)", () => {
  it("drops ANTHROPIC_API_KEY, keeps every other var, and leaves the input untouched", () => {
    const input = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-daemon", HOME: "/home/u" };
    const out = withoutAnthropicApiKey(input);
    expect(out).toEqual({ PATH: "/bin", HOME: "/home/u" });
    expect(input.ANTHROPIC_API_KEY).toBe("sk-ant-daemon");
  });

  it("is a plain copy when the key is absent", () => {
    expect(withoutAnthropicApiKey({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
});
