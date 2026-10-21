import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { EFFECT_HANDLERS } from "../../src/effects/registry.js";
import { settingsKeyVerdict } from "../../src/query/api/rec-actions/settings-registry.js";
import type { CardAction } from "../../src/query/api/rec-actions/types.js";
import {
  resolveEffectivePermission,
  validateAction,
} from "../../src/query/api/rec-actions/validate.js";

const metric = "d1-source-tokens";
// Platform-native absolute paths: a hard-coded "C:\\..." is not absolute on POSIX.
const projectDir = path.join(os.tmpdir(), "aw-validate-project");
const sharedClaudeMd = path.join(os.tmpdir(), "aw-validate-shared", "CLAUDE.md");
const hooksDir = path.join(projectDir, "hooks");
const fileSystem = {
  existsSync: (name: string) =>
    [
      path.join(projectDir, ".claude", "settings.json"),
      path.join(hooksDir, "check.exe"),
      hooksDir,
      sharedClaudeMd,
    ].includes(name),
  statSync: (name: string) => ({ isFile: () => name !== hooksDir }),
};
const base = { fs: fileSystem, baseDir: projectDir, claudeCodeVersion: "2.1.271" };
const action = (overrides: Partial<CardAction> = {}): CardAction => ({
  kind: "CONFIG",
  summary: "Change a supported setting",
  detail: [],
  copy_text: '{"env":{"CLAUDE_CODE_PROMPT_CACHE_TTL":"1h"}}',
  file_ref: ".claude/settings.json",
  target_metric: metric,
  ...overrides,
});

describe("artifact validation", () => {
  it("withholds ENABLE_PROMPT_CACHING_1H when only a doc cites it", () => {
    expect(settingsKeyVerdict("ENABLE_PROMPT_CACHING_1H", "2.1.271")).toBe("UNKNOWN");
    expect(
      validateAction(
        action({ copy_text: '{"env":{"ENABLE_PROMPT_CACHING_1H":"1"}}' }),
        metric,
        EFFECT_HANDLERS,
        base,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("UNKNOWN") });
  });

  it("keeps omitClaudeMd UNKNOWN even at 2.1.280 without a version proof", () => {
    expect(settingsKeyVerdict("omitClaudeMd", "2.1.280")).toBe("UNKNOWN");
    expect(
      validateAction(
        action({
          kind: "EDIT",
          file_ref: sharedClaudeMd,
          copy_text: "omitClaudeMd: true",
        }),
        metric,
        EFFECT_HANDLERS,
        { ...base, claudeCodeVersion: "2.1.280" },
      ).ok,
    ).toBe(false);
  });

  it("allows a new subagent definition inside an existing workspace", () => {
    const agent = action({
      copy_text: "Add to a focused Explore agent definition:\nmodel: sonnet",
      file_ref: ".claude/agents/explore.md",
    });
    const withWorkspace = {
      ...base,
      fs: { ...fileSystem, existsSync: (name: string) => name === projectDir },
    };
    expect(validateAction(agent, metric, EFFECT_HANDLERS, withWorkspace)).toEqual({ ok: true });
    // Still withheld: missing workspace, a path outside it, a non-agent file, or an unproven key.
    expect(validateAction(agent, metric, EFFECT_HANDLERS, base).ok).toBe(false);
    expect(
      validateAction(
        { ...agent, file_ref: "../.claude/agents/explore.md" },
        metric,
        EFFECT_HANDLERS,
        withWorkspace,
      ).ok,
    ).toBe(false);
    expect(
      validateAction(
        { ...agent, file_ref: ".claude/other/explore.md" },
        metric,
        EFFECT_HANDLERS,
        withWorkspace,
      ).ok,
    ).toBe(false);
    expect(
      validateAction(
        { ...agent, copy_text: "omitClaudeMd: true" },
        metric,
        EFFECT_HANDLERS,
        withWorkspace,
      ),
    ).toEqual({ ok: false, reason: "settings key omitClaudeMd is UNKNOWN" });
  });

  it("accepts a permissions.deny or ask snippet but not allow", () => {
    for (const mode of ["deny", "ask"]) {
      const snippet = action({ copy_text: `{"permissions":{"${mode}":["Bash(rm -rf:*)"]}}` });
      expect(validateAction(snippet, metric, EFFECT_HANDLERS, base)).toEqual({ ok: true });
    }
    expect(
      validateAction(
        action({ copy_text: '{"permissions":{"allow":["Bash(ls:*)"]}}' }),
        metric,
        EFFECT_HANDLERS,
        base,
      ),
    ).toEqual({ ok: false, reason: "settings key permissions.allow is UNKNOWN" });
  });

  it("rejects unusable CONFIG JSON", () => {
    for (const copy_text of ["{}", "[]", "1", '"hello"']) {
      expect(validateAction(action({ copy_text }), metric, EFFECT_HANDLERS, base).ok).toBe(false);
    }
  });

  it("rejects an English sentence in place of an executable hook command", () => {
    const hook = action({
      copy_text: "Run a hook to inspect commands before they execute.",
      hook: { event: "PreToolUse" },
    });
    expect(validateAction(hook, metric, EFFECT_HANDLERS, base)).toMatchObject({ ok: false });
  });

  it("accepts a matching metric without an effect handler as unmeasured", () => {
    expect(
      validateAction(action({ target_metric: "missing" }), "missing", EFFECT_HANDLERS, base),
    ).toEqual({ ok: true, measured: false });
  });

  it("still withholds an unmeasured action on a metric mismatch or a guardrail failure", () => {
    expect(
      validateAction(action({ target_metric: "other" }), "missing", EFFECT_HANDLERS, base),
    ).toEqual({ ok: false, reason: "target metric mismatch or missing" });
    expect(
      validateAction(
        action({ target_metric: "missing", copy_text: "{not json" }),
        "missing",
        EFFECT_HANDLERS,
        base,
      ),
    ).toEqual({ ok: false, reason: "invalid settings or hook JSON" });
    expect(
      validateAction(
        action({ target_metric: "missing", copy_text: '{"env":{"inventedKey":true}}' }),
        "missing",
        EFFECT_HANDLERS,
        base,
      ),
    ).toEqual({ ok: false, reason: "settings key inventedKey is UNKNOWN" });
  });

  it("checks metric presence, file existence, version gates, and known settings", () => {
    expect(validateAction(action(), metric, EFFECT_HANDLERS, base)).toEqual({ ok: true });
    const { target_metric, ...withoutMetric } = action();
    expect(target_metric).toBe(metric);
    expect(validateAction(withoutMetric, metric, EFFECT_HANDLERS, base).ok).toBe(false);
    expect(
      validateAction(action(), metric, EFFECT_HANDLERS, { ...base, claudeCodeVersion: "2.1.241" })
        .ok,
    ).toBe(false);
    expect(
      validateAction(action({ file_ref: "../outside.json" }), metric, EFFECT_HANDLERS, base).ok,
    ).toBe(false);
    expect(
      validateAction(
        action({ copy_text: '{"env":{"inventedKey":true}}' }),
        metric,
        EFFECT_HANDLERS,
        base,
      ).ok,
    ).toBe(false);
  });

  it("allows an existing absolute global file and requires a target for CONFIG and EDIT", () => {
    expect(
      validateAction(
        action({
          kind: "EDIT",
          file_ref: sharedClaudeMd,
          copy_text: "Add a concise instruction.",
        }),
        metric,
        EFFECT_HANDLERS,
        base,
      ),
    ).toEqual({ ok: true });
    expect(validateAction(action({ file_ref: null }), metric, EFFECT_HANDLERS, base).ok).toBe(
      false,
    );
    expect(
      validateAction(
        action({ kind: "EDIT", file_ref: null, copy_text: "Add a rule." }),
        metric,
        EFFECT_HANDLERS,
        base,
      ).ok,
    ).toBe(false);
  });

  it("validates structured EDIT settings snippets and rejects unstructured settings edits", () => {
    const edit = action({
      kind: "EDIT",
      copy_text: 'Add to settings: {"env":{"CLAUDE_CODE_PROMPT_CACHE_TTL":"1h"}}',
    });
    expect(validateAction(edit, metric, EFFECT_HANDLERS, base)).toEqual({ ok: true });
    expect(
      validateAction(
        { ...edit, copy_text: 'Add to settings: {"env":{"madeUpSetting":true}}' },
        metric,
        EFFECT_HANDLERS,
        base,
      ).ok,
    ).toBe(false);
    expect(
      validateAction(
        { ...edit, copy_text: "Add an undocumented setting." },
        metric,
        EFFECT_HANDLERS,
        base,
      ).ok,
    ).toBe(false);
  });

  it("requires a hook executable path that exists", () => {
    const hook = action({
      copy_text: '{"hooks":{"PreToolUse":[{"command":"./hooks/check.exe --check"}]}}',
      hook: { event: "PreToolUse" },
      kind: "COMMAND",
    });
    expect(validateAction(hook, metric, EFFECT_HANDLERS, base)).toEqual({ ok: true });
    expect(
      validateAction(
        {
          ...hook,
          copy_text: '{"hooks":{"PreToolUse":[{"command":"./hooks/check.exe"},{"command":7}]}}',
        },
        metric,
        EFFECT_HANDLERS,
        base,
      ).ok,
    ).toBe(false);
    expect(
      validateAction(
        { ...hook, copy_text: '{"hooks":{"PreToolUse":[{"command":"./hooks"}]}}' },
        metric,
        EFFECT_HANDLERS,
        base,
      ).ok,
    ).toBe(false);
    expect(
      validateAction(
        { ...hook, copy_text: '{"hooks":{"PreToolUse":[{"command":"echo ok"}]}}' },
        metric,
        EFFECT_HANDLERS,
        base,
      ).ok,
    ).toBe(false);
  });

  it("uses deny then ask then allow across scopes and withholds overridden snippets", () => {
    const rules = {
      MANAGED: { deny: ["Read"], ask: [], allow: [] },
      CLI: { deny: [], ask: ["Grep"], allow: [] },
      PROJECT_LOCAL: { deny: [], ask: [], allow: ["Read", "Grep"] },
      PROJECT_SHARED: { deny: [], ask: [], allow: [] },
      USER: { deny: [], ask: [], allow: [] },
    };
    expect(resolveEffectivePermission(rules, "Read")).toEqual({ effect: "deny", scope: "MANAGED" });
    expect(resolveEffectivePermission(rules, "Grep")).toEqual({ effect: "ask", scope: "CLI" });
    expect(
      validateAction(
        action({ permission_rule: { mode: "allow", pattern: "Read" } }),
        metric,
        EFFECT_HANDLERS,
        { ...base, existingPermissions: rules },
      ).ok,
    ).toBe(false);
    expect(
      validateAction(
        action({ permission_rule: { mode: "allow", pattern: "Grep" } }),
        metric,
        EFFECT_HANDLERS,
        { ...base, existingPermissions: rules },
      ).ok,
    ).toBe(false);
  });
});
