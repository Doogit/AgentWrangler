import { describe, expect, it } from "vitest";
import { stageFromStatus, stageToStdout } from "../../src/hook/limit-burn-hook.mjs";

describe("stageFromStatus", () => {
  it("returns null when status is falsy", () => {
    expect(stageFromStatus(null)).toBeNull();
    expect(stageFromStatus(undefined)).toBeNull();
  });

  it("returns null when available is false", () => {
    expect(stageFromStatus({ available: false })).toBeNull();
  });

  it("returns null when both utilizations are below warn threshold", () => {
    expect(
      stageFromStatus({
        available: true,
        five_hour: { utilization: 0.1, resets_at: "2026-09-03T00:00:00Z" },
        seven_day: { utilization: 0.08, resets_at: "2026-09-09T00:00:00Z" },
      }),
    ).toBeNull();
  });

  it("returns soft when five_hour utilization is exactly at warn threshold", () => {
    expect(
      stageFromStatus({
        available: true,
        five_hour: { utilization: 0.15, resets_at: "2026-09-03T00:00:00Z" },
        seven_day: { utilization: 0.08, resets_at: "2026-09-09T00:00:00Z" },
      }),
    ).toBe("soft");
  });

  it("returns checkpoint when seven_day utilization exceeds checkpoint threshold", () => {
    expect(
      stageFromStatus({
        available: true,
        five_hour: { utilization: 0.1, resets_at: "2026-09-03T00:00:00Z" },
        seven_day: { utilization: 0.6, resets_at: "2026-09-09T00:00:00Z" },
      }),
    ).toBe("checkpoint");
  });

  it("returns checkpoint when five_hour utilization is exactly at checkpoint threshold", () => {
    expect(
      stageFromStatus({
        available: true,
        five_hour: { utilization: 0.5, resets_at: "2026-09-03T00:00:00Z" },
        seven_day: { utilization: 0.08, resets_at: "2026-09-09T00:00:00Z" },
      }),
    ).toBe("checkpoint");
  });
});

describe("stageToStdout", () => {
  it("returns empty string for null", () => {
    expect(stageToStdout(null)).toBe("");
  });

  it("soft: allows with a top-level additionalContext string", () => {
    const out = JSON.parse(stageToStdout("soft")) as Record<string, unknown>;
    const hookOutput = out.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecision).toBe("allow");
    expect(typeof out.additionalContext).toBe("string");
    expect((out.additionalContext as string).length).toBeGreaterThan(0);
  });

  it("checkpoint: allows (not deny) with a top-level additionalContext string", () => {
    const out = JSON.parse(stageToStdout("checkpoint")) as Record<string, unknown>;
    const hookOutput = out.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecision).toBe("allow");
    expect(typeof out.additionalContext).toBe("string");
    expect((out.additionalContext as string).length).toBeGreaterThan(0);
  });
});
