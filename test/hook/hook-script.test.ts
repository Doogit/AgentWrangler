import { describe, expect, it } from "vitest";
import { stageToStdout } from "../../src/hook/context-budget-hook.mjs";

describe("context-budget hook stage output", () => {
  it("is silent for ok", () => {
    expect(stageToStdout("ok")).toBe("");
  });

  it("allows with a non-blocking message for soft", () => {
    expect(JSON.parse(stageToStdout("soft"))).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      additionalContext: expect.stringContaining("/clear"),
    });
  });

  it("warns but never blocks for hard (allow, never deny)", () => {
    const output = stageToStdout("hard");
    expect(JSON.parse(output)).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      additionalContext: expect.stringContaining("/clear"),
    });
    expect(output).not.toContain('"deny"');
    expect(output).not.toContain("transcript");
  });
});
