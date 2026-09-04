import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAnthropicApiKey } from "../../src/oauth/anthropic-api-key.js";

describe("readAnthropicApiKey", () => {
  const original = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "";
  });
  afterEach(() => {
    if (original === undefined) Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    else process.env.ANTHROPIC_API_KEY = original;
  });

  it("prefers the ANTHROPIC_API_KEY env var", async () => {
    process.env.ANTHROPIC_API_KEY = "  sk-ant-env  ";
    const raw = vi.fn();
    const result = await readAnthropicApiKey(raw);
    expect(result).toEqual({ ok: true, data: "sk-ant-env", source: "env" });
    expect(raw).not.toHaveBeenCalled();
  });

  it("reads the credential blob when no env var is set", async () => {
    const raw = vi.fn().mockResolvedValue("sk-ant-cred");
    const result = await readAnthropicApiKey(raw);
    expect(result).toEqual({ ok: true, data: "sk-ant-cred", source: "credential-manager" });
  });

  it("returns not-found when the credential blob is empty", async () => {
    const raw = vi.fn().mockResolvedValue("");
    const result = await readAnthropicApiKey(raw);
    expect(result).toEqual({ ok: false, reason: "anthropic-key-not-found" });
  });
});
