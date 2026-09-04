import { describe, expect, it } from "vitest";
import { stageToStdout } from "../../src/hook/loop-guard-hook.mjs";

describe("loop-guard hook stage output", () => {
  it("is silent for ok", () => {
    expect(stageToStdout("ok", "below_threshold")).toBe("");
  });

  it("allows with additional context for warn", () => {
    expect(JSON.parse(stageToStdout("warn", "near_repeated_identical_failures"))).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      additionalContext: expect.any(String),
    });
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
