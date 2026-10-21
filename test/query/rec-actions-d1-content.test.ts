import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contextHandler, displayPath } from "../../src/query/api/rec-actions/families/context.js";
import { buildCardActions, buildTrigger } from "../../src/query/api/rec-actions/index.js";
import type { CardActionRecommendation } from "../../src/query/api/rec-actions/types.js";

let root: string;
let claudeFile: string;
let memoryFile: string;

// Synthetic file: the "Workflow" section is 3x "Style" and 6x "Links".
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-d1-content-"));
  claudeFile = path.join(root, "CLAUDE.md");
  memoryFile = path.join(root, "MEMORY.md");
  fs.writeFileSync(
    claudeFile,
    [
      "# Global Preferences",
      "intro line",
      "## Workflow",
      "w".repeat(6000),
      "## Style",
      "s".repeat(2000),
      "## Links",
      "l".repeat(1000),
    ].join("\n"),
  );
  fs.writeFileSync(memoryFile, "- [a](a.md) — one\n- [b](b.md) — two\n");
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function d1(fileRef: string | null, component = "CLAUDE_MD"): CardActionRecommendation {
  return {
    detector_id: "D1",
    lever: "trim",
    facts: {
      component,
      scope: "global",
      source_file_ref: fileRef,
      attribution_method: "MEASURED_CONTENT",
      source_tokens: 4799,
      source_target: 2000,
      delta_context_tokens: 2799,
      turns_per_week: 15890,
      workspace_multiplier: 12,
    },
  };
}

function actions(rec: CardActionRecommendation) {
  const built = contextHandler(rec, { trigger: { session_ids: [], window: null, facts: [] } });
  if (built === null) throw new Error("expected D1 actions");
  return built;
}

describe("D1 card content", () => {
  it("names the largest sections, largest first, with token estimates", () => {
    const primary = actions(d1(claudeFile)).primary;
    const sections = primary.detail.find((line) => line.startsWith("Largest sections:"));
    expect(sections).toBeDefined();
    const order = ["Workflow", "Style", "Links"].map((name) => sections?.indexOf(name) ?? -1);
    expect(order.every((index) => index > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(sections).toMatch(/Workflow \(~3,\d{3} tokens\)/);
    expect(primary.copy_text).toContain("Workflow");
    expect(primary.copy_text).toContain("2,000");
    expect(primary.copy_text).toContain(displayPath(claudeFile));
  });

  it("offers two validatable alternatives with their own prompts", () => {
    const built = actions(d1(claudeFile));
    expect(built.alternatives).toHaveLength(2);
    for (const option of built.alternatives) {
      expect(option.kind).toBe("EDIT");
      expect(option.file_ref).toBe(claudeFile);
      expect(option.target_metric).toBe("avg_context_per_turn");
      expect(option.copy_text).toContain(displayPath(claudeFile));
      expect(option.copy_text).not.toBe(built.primary.copy_text);
    }
    const text = built.alternatives.map((option) => option.copy_text).join("\n");
    expect(text).toMatch(/skill/i);
    expect(text).toMatch(/repo/i);
    // Guardrails keep both alternatives (buildCardActions hides any that fail).
    expect(buildCardActions(d1(claudeFile)).alternatives).toHaveLength(2);
  });

  it("gives MEMORY its own alternatives", () => {
    const text = actions(d1(memoryFile, "MEMORY"))
      .alternatives.map((option) => option.copy_text)
      .join("\n");
    expect(text).toMatch(/topic file/i);
    expect(text).toMatch(/resolved|superseded/i);
  });

  it("makes every Copy prompt a complete, runnable Claude Code task", () => {
    const built = actions(d1(claudeFile));
    const prompts = [built.primary, ...built.alternatives].map((option) => option.copy_text);
    for (const prompt of prompts) {
      // Findings the pasted session cannot see on its own.
      expect(prompt).toContain(displayPath(claudeFile));
      expect(prompt).toContain("4,799");
      expect(prompt).toContain("2,000");
      expect(prompt).toContain("15,890");
      expect(prompt).toMatch(/Workflow \(~3,\d{3} tokens\)/);
      // Investigate → propose → confirm → apply → verify.
      expect(prompt).toMatch(/^1\. Read /m);
      expect(prompt).toMatch(/ask me to confirm/i);
      expect(prompt).toMatch(/Verify/);
      // R6-09: this fixture is MEASURED_CONTENT, so step 2 gives a character target at the
      // file's own ratio instead of the chars/4 estimate (that phrasing is for CHARS4_ESTIMATE,
      // covered separately below).
      expect(prompt).toMatch(/Measure its size in characters/i);
      expect(prompt).toMatch(/\/clear/);
    }
    // Each option carries its own solution, so the three prompts differ beyond the header.
    expect(new Set(prompts).size).toBe(3);
    expect(prompts[1]).toMatch(/skill/i);
    expect(prompts[2]).toMatch(/repo's CLAUDE\.md/i);
  });

  it("gives the pasted session the context it cannot see", () => {
    const rec = {
      ...d1(claudeFile),
      window: { from: "2026-09-18T00:00:00.000Z", to: "2026-09-25T00:00:00.000Z" },
    };
    const built = contextHandler(rec, { trigger: buildTrigger(rec) });
    if (built === null) throw new Error("expected D1 actions");
    const [primary, skills, repoRules] = [built.primary, ...built.alternatives].map(
      (option) => option.copy_text,
    );
    // What the file is, when Claude Code loads it, and how it was measured.
    expect(primary).toMatch(/user-level Claude Code instruction file/);
    expect(primary).toMatch(/every session in every workspace/);
    expect(primary).toMatch(/measured from the file's content/);
    expect(primary).toContain("2026-09-18 to 2026-09-25");
    expect(primary).toMatch(/about 44\.5M tokens per week/);
    expect(primary).toMatch(/any folder/);
    // Option-specific know-how.
    expect(skills).toMatch(/SKILL\.md.*name.*description/s);
    expect(repoRules).toMatch(/~\/\.claude\/projects/);

    const memory = actions(d1(memoryFile, "MEMORY")).primary.copy_text;
    expect(memory).toMatch(/auto-memory index/);
    const repoFile = d1(claudeFile);
    repoFile.facts = {
      ...repoFile.facts,
      scope: "workspace",
      attribution_method: "CHARS4_ESTIMATE",
    };
    expect(actions(repoFile).primary.copy_text).toMatch(
      /project CLAUDE\.md.*characters\/4 estimate/s,
    );
  });

  it("omits a one-section breakdown that says nothing", () => {
    const built = actions(d1(memoryFile, "MEMORY"));
    expect(built.primary.detail.some((line) => line.startsWith("Largest sections:"))).toBe(false);
    expect(built.primary.copy_text).not.toContain("Intro (~");
  });

  it("U9 r2: quoted index lines that mention a hook do not drop the card's actions", () => {
    const hookMemory = path.join(root, "HOOKMEMORY.md");
    fs.writeFileSync(
      hookMemory,
      `- [Context-budget hook](hook.md) — installed, 20/30%; ${"warn hooks need additionalContext ".repeat(4)}\n- [b](b.md) — two\n`,
    );
    const built = buildCardActions(d1(hookMemory, "MEMORY"));
    expect(built.primary.kind).toBe("EDIT");
    expect(built.primary.detail.join("\n")).toContain("Context-budget hook");
    expect(built.alternatives).toHaveLength(2);
  });

  it("still builds when the file cannot be read", () => {
    const built = actions(d1(path.join(root, "missing.md")));
    expect(built.primary.detail.some((line) => line.startsWith("Largest sections:"))).toBe(false);
    expect(built.alternatives).toHaveLength(2);
  });

  it("R6-09: for a measured file, states the trim target in characters at the file's own ratio", () => {
    const rec = d1(claudeFile);
    const prompt = actions(rec).primary.copy_text;
    const actualChars = fs.readFileSync(claudeFile, "utf8").length;
    const ratio = actualChars / 4799; // chars per token, from this file's own measured content
    const stepTwo = /^2\. .*?([\d,]+) characters/m.exec(prompt);
    expect(stepTwo).not.toBeNull();
    const charTarget = Number(stepTwo?.[1]?.replace(/,/g, ""));
    // The stated character target, converted back through the file's own ratio, lands within
    // 5% of the 2,000-token target — so step 7's character check actually proves the same thing
    // step 2 promised, instead of chars/4 drifting from the measured token count.
    expect(Math.abs(charTarget / ratio - 2000) / 2000).toBeLessThan(0.05);
    const stepSeven = /^7\. Verify:.*?(\d[\d,]*)-character target/m.exec(prompt);
    expect(stepSeven).not.toBeNull();
    expect(stepSeven?.[1]).toBe(stepTwo?.[1]);
    expect(prompt).not.toMatch(/7\. Verify:.*characters\/4 estimate/);
  });

  it("shows the measured D1 facts on the trigger", () => {
    expect(buildTrigger(d1(claudeFile)).facts).toEqual([
      { label: "File size", value: "4,799 tokens (target 2,000)" },
      { label: "Loaded on", value: "15,890 turns per week" },
      { label: "Workspaces", value: "12" },
      { label: "Extra tokens per week", value: "about 44.5M" },
    ]);
  });

  it("shows paths under the home folder as ~/…, with no username, on any OS", () => {
    const home = path.join(root, "home", "someone");
    const file = path.join(home, ".claude", "projects", "C--repo", "memory", "MEMORY.md");
    expect(displayPath(file, home)).toBe("~/.claude/projects/C--repo/memory/MEMORY.md");
    const outside = path.join(root, "elsewhere", "CLAUDE.md");
    expect(displayPath(outside, home)).toBe(outside);
    expect(displayPath(home, home)).toBe(home);

    const underHome = path.join(os.homedir(), ".claude", "CLAUDE.md");
    const prompt = actions(d1(underHome)).primary.copy_text;
    expect(prompt).toContain("~/.claude/CLAUDE.md");
    expect(prompt).not.toContain(os.homedir());
    expect(prompt).toMatch(/start at your home folder \(~\)/);
  });

  it("states what's wrong, linking the facts to the fix", () => {
    const rec = d1(path.join(root, "memory", "MEMORY.md"), "MEMORY");
    rec.facts = {
      ...rec.facts,
      attribution_method: "CHARS4_ESTIMATE",
      source_tokens: 1029,
      source_target: 1000,
      delta_context_tokens: 29,
      turns_per_week: 8384,
    };
    expect(buildTrigger(rec).problem).toBe(
      "MEMORY.md is 1,029 estimated tokens, 29 over its 1,000-token target (AgentWrangler's suggested default for this kind of file, not a Claude Code limit). Claude Code loads it on every turn (about 8,384 a week, counting main-conversation turns and forked-subagent turns), so the excess costs about 243K tokens a week. Trimming it to the target avoids part of that cost.",
    );
    // Small amounts keep their scale instead of rounding to "0.0M".
    rec.facts = { ...rec.facts, turns_per_week: 20 };
    const small = buildTrigger(rec);
    expect(small.problem).toContain("about 580 tokens a week");
    expect(small.facts).toContainEqual({ label: "Extra tokens per week", value: "about 580" });
    expect(buildTrigger({ detector_id: "D11", lever: "route", facts: {} }).problem).toBeUndefined();
  });

  it("shows the D11 error rates on the trigger", () => {
    const facts = buildTrigger({
      detector_id: "D11",
      lever: "route",
      facts: {
        higher_error_tool: "PowerShell",
        preferred_tool: "Bash",
        powershell_call_count: 847,
        powershell_error_count: 167,
        bash_call_count: 8742,
        bash_error_count: 682,
      },
    }).facts;
    expect(facts).toEqual([
      // Review 5: labelled shell-caused, so the rate is not read against C1's all-failure rate.
      { label: "Shell-caused failures in PowerShell", value: "167 of 847 calls (19.7%)" },
      { label: "Shell-caused failures in Bash", value: "682 of 8,742 calls (7.8%)" },
    ]);
  });
});
