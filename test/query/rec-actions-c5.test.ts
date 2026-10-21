import { describe, expect, it } from "vitest";
import { EFFECT_HANDLERS } from "../../src/effects/registry.js";
import { buildCardActions } from "../../src/query/api/rec-actions/index.js";
import { validateAction } from "../../src/query/api/rec-actions/validate.js";

const primary = buildCardActions({
  detector_id: "C5",
  lever: "break same error loop",
  evidence: {
    session_ids: ["synthetic-session"],
    metrics: { REPEATED_ERROR_COUNT: { value: 4 } },
  },
}).primary;
describe("C5 recovery action metric", () => {
  it("retains the recovery prompt and declares the detector metric", () => {
    expect(primary).toMatchObject({
      kind: "INVESTIGATE",
      file_ref: null,
      target_metric: "same_error_loop_count",
      option_id: "c5-break-same-error-loop",
    });
    expect(primary.copy_text).toContain("# Loop Recovery");
    expect(primary.copy_text).toContain("Do not repeat an unchanged failed call.");
    expect(validateAction(primary, "same_error_loop_count", EFFECT_HANDLERS)).toEqual({ ok: true });
  });
  it("carries the real error excerpt into a runnable Claude Code prompt", () => {
    // Free text a detector retained from tool_event_content (ADR-112 amendment).
    const excerpt = "error: husky pre-commit hook failed (exit 1)\n  at lint-staged";
    const built = buildCardActions({
      detector_id: "C5",
      lever: "break same error loop",
      evidence: {
        session_ids: ["synthetic-session"],
        window: { from: "2026-09-18T00:00:00.000Z", to: "2026-09-25T00:00:00.000Z" },
        metrics: {
          REPEATED_ERROR_COUNT: { value: 4 },
          TOP_LOOP_TOOL: { value: "Bash" },
          TOP_LOOP_ERROR_TEXT: { value: excerpt },
        },
      },
    }).primary;
    expect(built.summary).toContain("Bash");
    expect(built.copy_text).toContain("> error: husky pre-commit hook failed (exit 1)");
    expect(built.copy_text).toContain(">   at lint-staged");
    expect(built.copy_text).toContain("synthetic-session");
    expect(built.copy_text).toMatch(/~\/\.claude\/projects/);
    expect(built.copy_text).toContain("2026-09-18 to 2026-09-25");
    expect(built.copy_text).toMatch(/ask me to confirm/i);
    expect(validateAction(built, "same_error_loop_count", EFFECT_HANDLERS)).toEqual({ ok: true });
  });
  it("keeps the action but marks it unmeasured without a matching handler", () => {
    expect(validateAction(primary, "same_error_loop_count", [])).toEqual({
      ok: true,
      measured: false,
    });
  });
  it("rejects a metric that differs from the detector contract", () => {
    expect(validateAction(primary, "shell_error_rate", EFFECT_HANDLERS)).toEqual({
      ok: false,
      reason: "target metric mismatch or missing",
    });
  });
});
