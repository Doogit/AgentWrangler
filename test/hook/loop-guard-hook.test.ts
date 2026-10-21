import { describe, expect, it } from "vitest";
import { stageToStdout } from "../../src/hook/loop-guard-hook.mjs";

describe("loop-guard hook stage output", () => {
  it("is silent for ok", () => {
    expect(stageToStdout("ok", "below_threshold")).toBe("");
  });

  it("warns via hookSpecificOutput.additionalContext without deciding permission", () => {
    const out = JSON.parse(stageToStdout("warn", "near_repeated_identical_failures"));
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      additionalContext: expect.any(String),
    });
    expect(out).not.toHaveProperty("additionalContext");
  });

  it("denies for block without exposing raw tool text", () => {
    const rawToolText = "npm test --token=operator-owned-secret";
    const output = stageToStdout("block", rawToolText);
    expect(JSON.parse(output)).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(output).not.toContain(rawToolText);
    expect(output).not.toContain("transcript");
  });
});
