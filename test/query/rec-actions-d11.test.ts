import path from "node:path";
import { describe, expect, it } from "vitest";
import { EFFECT_HANDLERS } from "../../src/effects/registry.js";
import { cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import { buildCardActions } from "../../src/query/api/rec-actions/index.js";
import { validateAction } from "../../src/query/api/rec-actions/validate.js";

const baseDir = path.resolve("synthetic-workspace");
const file = path.join(baseDir, "CLAUDE.md");
const options = {
  baseDir,
  fs: {
    existsSync: (name: string) => name === file,
    statSync: () => ({ isFile: () => true }),
  },
};
function action(preferred: string, higher: string) {
  return buildCardActions({
    detector_id: "D11",
    lever: "ROUTE_SHELL_TOOL_V1",
    facts: {
      preferred_tool: preferred,
      higher_error_tool: higher,
      bash_error_ratio: preferred === "Bash" ? 0.05 : 0.25,
      powershell_error_ratio: preferred === "PowerShell" ? 0.05 : 0.25,
    },
  }).primary;
}
describe("D11 shell routing action", () => {
  it.each([
    ["PowerShell", "Bash"],
    ["Bash", "PowerShell"],
  ])("routes to %s when %s has the higher error rate", (preferred, higher) => {
    const primary = action(preferred, higher);
    expect(primary).toMatchObject({
      kind: "EDIT",
      file_ref: "CLAUDE.md",
      target_metric: "shell_error_rate",
    });
    // The Copy prompt (P3.1) carries the exact block to add in its Fix section. Review 5 M11: with
    // PowerShell the higher-error shell, the block first stops the Unix pipes.
    const pipes =
      higher === "PowerShell"
        ? "Do not pipe to `grep`, `head` or `tail` in PowerShell; run those commands in Bash.\n"
        : "";
    expect(primary.copy_text).toContain(
      `## Fix\nAdd this block to CLAUDE.md:\n\n\`\`\`markdown\n## Shell Routing\n\n${pipes}Prefer ${preferred} for repository and file operations; use ${higher} only for platform-specific needs.\n\`\`\``,
    );
    expect(
      cardRuleViolations(
        { primary, alternatives: [] },
        {
          session_ids: [],
          window: null,
          facts: [{ label: "Errors", value: "25%" }],
          problem: "x",
          why: "It matters.",
        },
      ),
    ).toEqual([]);
    expect(primary.summary).toContain(`${higher} errors were 25% versus 5%`);
    expect(primary.detail).toContain(
      "Rollback: remove the Shell Routing block added by this action.",
    );
    expect(primary.permission_rule).toBeUndefined();
    expect(validateAction(primary, "shell_error_rate", EFFECT_HANDLERS, options)).toEqual({
      ok: true,
    });
  });
  it("keeps routing but marks it unmeasured when its effect handler is unavailable", () => {
    expect(validateAction(action("Bash", "PowerShell"), "shell_error_rate", [], options)).toEqual({
      ok: true,
      measured: false,
    });
  });
  it("still withholds an unmeasured action whose target file is missing", () => {
    expect(
      validateAction(action("Bash", "PowerShell"), "shell_error_rate", [], {
        ...options,
        fs: { ...options.fs, existsSync: () => false },
      }),
    ).toEqual({ ok: false, reason: "file_ref does not resolve to an existing file" });
  });
  it("withholds routing when workspace CLAUDE.md is missing", () => {
    expect(
      validateAction(action("Bash", "PowerShell"), "shell_error_rate", EFFECT_HANDLERS, {
        ...options,
        fs: { ...options.fs, existsSync: () => false },
      }),
    ).toEqual({ ok: false, reason: "file_ref does not resolve to an existing file" });
  });
});
