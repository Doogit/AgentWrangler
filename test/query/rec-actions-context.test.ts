import { mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import { contextHandler, displayPath } from "../../src/query/api/rec-actions/families/context.js";
import { assertCardActionsGuardrails } from "../../src/query/api/rec-actions/guardrails.js";
import { buildCardActions, buildTrigger } from "../../src/query/api/rec-actions/index.js";
import type {
  CardActionRecommendation,
  CardToolCall,
} from "../../src/query/api/rec-actions/types.js";

/** os.homedir() reads USERPROFILE (Windows) or HOME, so a test can point it at a temp folder. */
function withHome<T>(home: string, run: () => T): T {
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const memoryFile = path.join(os.tmpdir(), "aw-d1-source", "MEMORY.md");
const claudeFile = path.join(os.tmpdir(), "aw-d1-source", "CLAUDE.md");

const fixtures: Array<{
  rec: CardActionRecommendation;
  kind: string;
  fileRef: string | null;
  token: string;
}> = [
  {
    rec: {
      detector_id: "D1",
      lever: "trim",
      facts: {
        component: "MEMORY",
        source_file_ref: memoryFile,
        attribution_method: "CHARS4_ESTIMATE",
        source_tokens: 30000,
        source_target: 20000,
      },
    },
    kind: "EDIT",
    fileRef: memoryFile,
    token: "MEMORY",
  },
  {
    rec: {
      detector_id: "A1",
      lever: "spill",
      evidence: {
        metrics: { MAX_RESULT_BYTES: { value: 50000 } },
      },
    },
    kind: "HABIT",
    fileRef: null,
    token: "Cut large tool results",
  },
  {
    rec: { detector_id: "A2", lever: "compact", facts: { MAX_RESULT_BYTES: 12000 } },
    kind: "HABIT",
    fileRef: null,
    token: "12 KB",
  },
  {
    rec: {
      detector_id: "D6",
      lever: "range",
      facts: { tool_result_bytes: 250000, session_count: 3 },
    },
    kind: "HABIT",
    fileRef: null,
    token: "244 KiB",
  },
  {
    rec: { detector_id: "D10", lever: "catalog", facts: { catalog_tokens: 45000 } },
    kind: "INVESTIGATE",
    fileRef: null,
    token: "45K",
  },
  {
    rec: {
      detector_id: "D2",
      lever: "split",
      facts: { qualifying_session_count: 4, raw_context_average_tokens_per_turn: 200000 },
    },
    kind: "HABIT",
    fileRef: null,
    token: "200K",
  },
];

function directActions(rec: CardActionRecommendation) {
  const actions = contextHandler(rec, { trigger: { session_ids: [], window: null, facts: [] } });
  if (actions === null) throw new Error(`Expected context actions for ${rec.detector_id}`);
  return actions;
}

describe("context recommendation actions", () => {
  it.each(fixtures)("builds safe $rec.detector_id actions", ({ rec, kind, fileRef, token }) => {
    const direct = directActions(rec);
    expect(direct.primary.kind).toBe(kind);
    expect(direct.primary.file_ref).toBe(fileRef);
    expect(direct.primary.summary).toContain(token);
    expect(() => assertCardActionsGuardrails(direct, rec.detector_id)).not.toThrow();

    const built = buildCardActions(rec);
    expect(built.primary).toEqual(direct.primary);
    expect(built.alternatives).toEqual(direct.alternatives);
  });

  it("gives D10 a ready disable-list from per-item facts (U7)", () => {
    const rec: CardActionRecommendation = {
      detector_id: "D10",
      lever: "catalog",
      facts: {
        catalog_tokens: 4900,
        removable_tokens: 3120,
        disable_list: [
          "plugin big@market (~3000 tokens; no recorded use)",
          "skill solo (~120 tokens; last used 2025-12-20)",
        ],
        skill_use_untracked_count: 2,
        always_load_count: 0,
      },
    };
    const actions = withHome(path.join(os.tmpdir(), "aw-d10-empty-home"), () => directActions(rec));
    expect(actions.primary.summary).toContain("Disable 2 catalog item(s)");
    expect(actions.primary.copy_text).toContain(
      "  - plugin big@market (~3000 tokens; no recorded use)",
    );
    expect(actions.primary.copy_text).toContain('"enabledPlugins"');
    expect(actions.primary.copy_text).toContain("MCP server tool definitions are not sized");
    expect(actions.primary.copy_text).toContain("2 Skill call(s)");
    expect(() => assertCardActionsGuardrails(actions, "D10")).not.toThrow();
  });

  it("D2 writes the CLAUDE.md rule out, reuses an existing handoff skill and stays off D8's breaks", () => {
    const home = path.join(os.tmpdir(), "aw-d2-home");
    mkdirSync(path.join(home, ".claude", "skills", "handoff-global"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "skills", "handoff-global", "SKILL.md"), "---\n---\n");
    const actions = withHome(home, () =>
      directActions({
        detector_id: "D2",
        lever: "split",
        facts: { qualifying_session_count: 5, raw_context_average_tokens_per_turn: 252278 },
      }),
    );
    const text = actions.primary.copy_text;
    expect(text).toContain(
      "`When a task finishes, offer a handoff of at most 2K tokens and remind me to /clear.`",
    );
    expect(text).toContain("A break longer than the cache lifetime is a separate card");
    const alt = actions.alternatives[0];
    expect(alt?.summary).toContain("/handoff-global");
    expect(alt?.file_ref).toBe("~/.claude/skills/handoff-global/SKILL.md");
    expect(alt?.copy_text).toContain("instead of creating a second one");
    expect(alt?.copy_text).not.toContain("Create `~/.claude/skills/handoff/SKILL.md`");
  });

  it("D1 memory card names the longest index lines and points at the user's /memory-sweep skill", () => {
    const home = path.join(os.tmpdir(), "aw-d1-sweep-home");
    mkdirSync(path.join(home, ".claude", "skills", "memory-sweep"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "skills", "memory-sweep", "SKILL.md"), "---\n---\n");
    const file = path.join(os.tmpdir(), "aw-d1-sweep", "MEMORY.md");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `- [Short](a.md) — one\n- [Long entry](b.md) — ${"detail ".repeat(30)}\n- [Mid](c.md) — ${"x".repeat(60)}\n`,
    );
    const actions = withHome(home, () =>
      directActions({
        detector_id: "D1",
        lever: "trim",
        facts: {
          component: "MEMORY",
          source_file_ref: file,
          attribution_method: "CHARS4_ESTIMATE",
          source_tokens: 1500,
          source_target: 1000,
          turns_per_week: 5000,
          workspace_multiplier: 1,
        },
      }),
    );
    const text = actions.primary.copy_text;
    expect(text).toContain("Longest index lines");
    expect(text).toMatch(/"- \[Long entry\]\(b\.md\)[^\n]*…" \(~\d+ tokens\)/);
    expect(text.indexOf("[Long entry]")).toBeLessThan(text.indexOf("[Mid]"));
    expect(text).toContain("`/memory-sweep`");
    expect(actions.primary.detail.join(" ")).toContain("/memory-sweep");
  });

  it("D10 keeps skills the user's CLAUDE.md names off the disable list and writes the settings change", () => {
    const home = path.join(os.tmpdir(), "aw-d10-home");
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude", "CLAUDE.md"),
      "Before dispatching, load the `dispatch-brief` skill.\n",
    );
    const actions = withHome(home, () =>
      directActions({
        detector_id: "D10",
        lever: "catalog",
        facts: {
          catalog_tokens: 4900,
          removable_tokens: 3120,
          disable_list: [
            "plugin codex@openai-codex (~100 tokens; not seen in tracked skill calls)",
            "skill dispatch-brief (~108 tokens; not seen in tracked skill calls)",
            "skill memory-sweep (~106 tokens; not seen in tracked skill calls)",
          ],
          skill_use_untracked_count: 69,
          always_load_count: 0,
        },
      }),
    );
    const text = actions.primary.copy_text;
    expect(actions.primary.summary).toContain(
      "Disable 2 catalog item(s) not seen in tracked skill",
    );
    expect(actions.primary.summary).toContain("1 more is named in your CLAUDE.md");
    expect(text).toContain("  - skill memory-sweep");
    expect(text).toMatch(/Named in ~\/\.claude\/CLAUDE\.md[^\n]*\n {2}- skill dispatch-brief/);
    expect(text).toContain('{"enabledPlugins":{"codex@openai-codex":false}}');
    expect(text).not.toContain("no recorded use");
    expect(text).toContain("69 Skill call(s)");
  });

  it("names CLAUDE.md, not the CLAUDE_MD enum, for D1", () => {
    const actions = directActions({
      detector_id: "D1",
      lever: "trim",
      facts: {
        component: "CLAUDE_MD",
        source_file_ref: claudeFile,
        attribution_method: "MEASURED_CONTENT",
        source_tokens: 9000,
        source_target: 5000,
      },
    });
    expect(actions.primary.file_ref).toBe(claudeFile);
    // file_ref stays absolute for validation; the text shows the portable ~/… form.
    expect(actions.primary.summary).toBe(
      `Trim ${displayPath(claudeFile)} from 9,000 tokens to 5,000 or less.`,
    );
    expect(actions.primary.copy_text).toContain(displayPath(claudeFile));
  });

  it("gives D2 one change with a readable average context", () => {
    const actions = directActions({
      detector_id: "D2",
      lever: "split",
      facts: { qualifying_session_count: 3, raw_context_average_tokens_per_turn: 203104.13 },
    });
    expect(actions.primary.summary).toBe(
      "Start a fresh session at each task boundary: 3 long sessions averaged 203K tokens of context per model call.",
    );
    expect(actions.primary.target_metric).toBe("avg_context_per_turn");
    // Review 5 U4 (M3, OC1): a /handoff skill is the one alternative.
    expect(actions.alternatives.map((option) => option.option_id)).toEqual(["d2-handoff-skill"]);
  });

  it("keeps D1's cache-invalidation warning in detail and copy", () => {
    const d1 = fixtures[0];
    if (d1 === undefined) throw new Error("Missing D1 fixture");
    const actions = directActions(d1.rec);
    expect(actions.primary.detail.join(" ")).toMatch(/invalidates the cached prefix/i);
    expect(actions.primary.copy_text).toMatch(/full-price cache write/i);
  });

  describe("A1 card content", () => {
    const a1 = (events = 38): CardActionRecommendation => ({
      detector_id: "A1",
      lever: "spill",
      evidence: {
        session_ids: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"],
        window: { from: "2026-09-19T00:12:48.244Z", to: "2026-09-26T00:12:48.244Z" },
        metrics: {
          EVENT_COUNT: { value: events },
          RESULT_BYTES_TOTAL: { value: 1_468_006 },
          MAX_RESULT_BYTES: { value: 63_903 },
        },
      },
    });
    const built = (rec: CardActionRecommendation) => {
      const actions = contextHandler(rec, { trigger: buildTrigger(rec) });
      if (actions === null) throw new Error("expected A1 actions");
      return actions;
    };

    const skillFile: CardToolCall = {
      target: "~/.claude/skills/review/references/template.md",
      kind: "file",
      tool: "Read",
      calls: 21,
      session_ids: ["s1", "s2", "s3"],
      session_count: 6,
      total_bytes: 553_984,
      max_bytes: 26_624,
      whole_file: true,
    };
    const sharedFile: CardToolCall = {
      ...skillFile,
      target: "~/repo/src/big.ts",
      calls: 15,
      session_count: 13,
      total_bytes: 647_168,
      max_bytes: 57_344,
    };
    const withCalls = (rec: CardActionRecommendation): CardActionRecommendation => ({
      ...rec,
      tool_calls: [sharedFile, skillFile],
    });

    it("says plainly what happened and shows the size facts", () => {
      const trigger = buildTrigger(a1());
      expect(trigger.problem).toBe(
        // U7: subagent reads are priced along the subagent's own turns (was "count as zero").
        "38 successful tool calls returned more than 25 KB each, 1.4 MB in total (largest 62 KB). Each result stays in context and is re-sent on every later turn until /clear, compaction or Claude Code's tool-result clearing drops it. A read inside a subagent is re-sent on that subagent's later turns until it finishes. Asking for only the part you need keeps that cost out. The saving is worked out per result: bytes above 25 KB ÷ 2.7 bytes per token × 50% assumed avoidable × the price of one cache write plus a cache read on each later turn the result stays in context (at most 75). It covers all 38 results.",
      );
      expect(trigger.facts).toEqual([
        { label: "Total size", value: "1.4 MB in 38 results over 25 KB" },
        { label: "Largest result", value: "62 KB" },
      ]);
      expect(buildTrigger(a1(1)).problem).toMatch(/^1 successful tool call returned/);
      // The lead call group is named in the problem and passed through as the calls list.
      const listed = buildTrigger(withCalls(a1()));
      expect(listed.problem).toContain(
        "The one to fix first is `~/repo/src/big.ts`: read whole 15 times in 13 sessions, up to 56 KB each, 632 KB in total.",
      );
      expect(listed.calls).toEqual([sharedFile, skillFile]);
    });

    it("breaks the bytes down by tool, counting only targets repeated at least twice (R2.3)", () => {
      const bash: CardToolCall = {
        ...sharedFile,
        target: "git diff",
        kind: "command",
        tool: "Bash",
        calls: 4,
        total_bytes: 300_000,
      };
      const oneOff: CardToolCall = {
        ...sharedFile,
        target: "https://x.dev/a",
        kind: "url",
        tool: "WebFetch",
        calls: 1,
        total_bytes: 900_000,
      };
      const rec = { ...a1(), tool_calls: [sharedFile, skillFile, bash, oneOff] };
      const trigger = buildTrigger(rec);
      expect(trigger.facts).toContainEqual({
        label: "By tool, targets repeated 2+ times",
        value: "Read 1.1 MB and Bash 293 KB",
      });
      expect(trigger.problem).toContain(
        "By tool, counting targets repeated at least twice: Read 1.1 MB and Bash 293 KB. The one to fix first is `~/repo/src/big.ts`",
      );
      expect(trigger.problem).not.toContain("WebFetch");
      const prompt = built(rec).primary.copy_text;
      expect(prompt).toContain(
        "\n- By tool, counting targets repeated at least twice: Read 1.1 MB and Bash 293 KB\n- `~/repo/src/big.ts`",
      );
      expect(cardRuleViolations(built(rec), trigger)).toEqual([]);

      // Every repeated target counts, not only the eight the card lists.
      const many = Array.from({ length: 9 }, (_, i) => ({
        ...sharedFile,
        target: `~/repo/src/f${i}.ts`,
        total_bytes: 100_000,
      }));
      const wide = { ...a1(), tool_calls: [...many, bash] };
      expect(buildTrigger(wide).calls).toHaveLength(8);
      expect(buildTrigger(wide).facts).toContainEqual({
        label: "By tool, targets repeated 2+ times",
        value: "Read 879 KB and Bash 293 KB",
      });
      expect(built(wide).primary.detail[1]).toMatch(/^7 other large call groups are listed/);
    });

    it("U9: lists the sessions that ran the lead group, writes the rule, and says why a smaller group leads", () => {
      const lead: CardToolCall = {
        ...skillFile,
        target: "~/repo/docs/plans/api-plan.md",
        calls: 4,
        session_ids: ["a1", "a2", "a3"],
        session_count: 4,
        total_bytes: 146_000,
        max_bytes: 39_000,
        whole_file: false,
      };
      const rec = { ...a1(), tool_calls: [lead, sharedFile] };
      const trigger = buildTrigger(rec);
      expect(trigger.problem).toContain(
        "It comes first because the card ranks groups by what re-sending them costs, not by size; the largest group by total size is `~/repo/src/big.ts`",
      );
      // A home with no CLAUDE.md, so the user's own Read-range rule (U9 r4) does not change the text.
      const emptyHome = path.join(os.tmpdir(), "aw-a1-empty-home");
      mkdirSync(emptyHome, { recursive: true });
      const prompt = withHome(emptyHome, () => built(rec).primary.copy_text);
      expect(prompt).toContain(
        "- Sessions that ran the call group above (3 of 4 listed): a1, a2, a3",
      );
      expect(prompt).toContain(
        "Ready rule: `When reading api-plan.md or any file over 25 KB, Grep for the heading or symbol first, then Read with offset and limit of at most 300 lines. Read the whole file only when the task is to edit or review all of it.`",
      );
      // No explanation when the lead is already the biggest group.
      expect(buildTrigger({ ...a1(), tool_calls: [sharedFile, lead] }).problem).not.toContain(
        "It comes first because",
      );
    });

    it("recommends one change for the lead call; the others are only listed", () => {
      const { primary } = built(withCalls(a1()));
      expect(primary.target_metric).toBe("tool_result_bytes");
      // P3.1-T7 (A1b): a source file of your own read whole in many sessions is split.
      expect(primary.summary).toBe(
        "Split `big.ts` into smaller modules: read whole 15 times in 13 sessions, up to 56 KB each, 632 KB in total.",
      );
      expect(primary.detail).toEqual([
        expect.stringMatching(
          /^Split it into smaller modules: it is read whole in 13 different sessions/,
        ),
        '1 other large call group is listed as "also seen"; this change does not cover them.',
      ]);
      const prompt = primary.copy_text;
      expect(prompt).toMatch(/^# Split `big\.ts` into smaller modules$/m);
      expect(prompt).toContain(
        "found 38 successful tool calls between 2026-09-19 and 2026-09-26 that each returned more than 25 KB (1.4 MB in total). Nothing failed",
      );
      expect(prompt).toContain(
        "\n- By tool, counting targets repeated at least twice: Read 1.1 MB\n- `~/repo/src/big.ts`: read whole 15 times in 13 sessions, up to 56 KB each, 632 KB in total",
      );
      expect(prompt).toContain(
        "Also seen (not part of this fix):\n- `~/.claude/skills/review/references/template.md`: read whole 21 times in 6 sessions",
      );
      expect(prompt).toContain("These cover 36 of the 38 calls");
      // The fix covers the lead only.
      const fix = prompt.slice(prompt.indexOf("## Fix"), prompt.indexOf("## Steps"));
      expect(fix).toMatch(/`~\/repo\/src\/big\.ts`: Split it into smaller modules/);
      expect(fix).not.toMatch(/skill/);
      // Works from the listed calls, not transcript digging.
      expect(prompt).not.toMatch(/\.jsonl|tool_use/);
      expect(prompt).toMatch(/^1\. Check the size and structure of `~\/repo\/src\/big\.ts`/m);
      expect(prompt).toMatch(/ask me to confirm/i);
      expect(prompt).toMatch(/^7\. Verify: re-check the size of `~\/repo\/src\/big\.ts`/m);
      expect(prompt).not.toMatch(/\b[A-H]\d{1,2}\b|FILE_READ/);
    });

    it("tags an 'also seen' row that ran entirely inside a subagent (review 5 M19)", () => {
      // oversizedToolCalls sets `is_subagent` (review 5 residual M19).
      const subagentFile: CardToolCall = { ...skillFile, is_subagent: true };
      const rec = { ...a1(), tool_calls: [sharedFile, subagentFile] };
      const prompt = built(rec).primary.copy_text;
      expect(prompt).toContain(
        "Also seen (not part of this fix):\n" +
          "- `~/.claude/skills/review/references/template.md`: read whole 21 times in 6 sessions, up to 26 KB each, 541 KB in total (subagent)",
      );
      // The lead (not a subagent call) is untagged.
      expect(prompt).toContain(
        "- `~/repo/src/big.ts`: read whole 15 times in 13 sessions, up to 56 KB each, 632 KB in total\n",
      );
      expect(built(rec).primary.summary).not.toContain("offset");
      // U7: the false "count as zero" claim is gone; subagent reads are priced.
      expect(buildTrigger(rec).problem).not.toContain("count as zero");
      expect(buildTrigger(rec).problem).toContain(
        "A read inside a subagent is re-sent on that subagent's later turns until it finishes.",
      );
    });

    it("never leads with a scratch file when another call group exists", () => {
      const scratch: CardToolCall = { ...sharedFile, target: "~/AppData/Local/Temp/x/out.md" };
      const rec = { ...a1(), tool_calls: [scratch, skillFile] };
      expect(built(rec).primary.summary).toMatch(
        /^Stop reading all of `template\.md` on every run: read whole 21 times/,
      );
      expect(buildTrigger(rec).calls).toEqual([skillFile, scratch]);
    });

    it("falls back to the sessions when no call can be read back", () => {
      const prompt = built(a1()).primary.copy_text;
      expect(prompt).toContain(
        "could not read these calls back from the session transcripts. Sessions: s1, s2, s3, s4, s5.",
      );
      expect(prompt).toMatch(/offset and limit/);
    });

    it("fits the fix to the call's pattern", () => {
      const fix = (call: Partial<CardToolCall>) =>
        built({ ...a1(), tool_calls: [{ ...sharedFile, ...call }] }).primary.detail[0];
      expect(fix({ whole_file: false })).toMatch(/already read in parts/);
      expect(fix({ session_count: 1, calls: 4 })).toMatch(
        /read whole 4 times in one session\. Read it once/,
      );
      expect(fix({ session_count: 1, calls: 1 })).toMatch(/instead of loading all 56 KB/);
      expect(fix({ target: "~/AppData/Local/Temp/x/out.md" })).toMatch(/scratch or output file/);
      expect(fix({ kind: "command", tool: "Bash", target: "gh pr diff 136" })).toMatch(/--stat/);
      expect(fix({ kind: "command", tool: "Bash", target: "npm test" })).toMatch(
        /head, tail or grep/,
      );
      expect(fix({ kind: "url", tool: "WebFetch", target: "https://x.dev/a" })).toMatch(
        /fetched 15 times\. Save the facts/,
      );
      expect(fix({ tool: "Edit" })).toMatch(/the file itself is that large/);
    });

    it("A1 (review 4): advises an Artifact read by its saved file, never WebFetch", () => {
      const artifact = { kind: "url", tool: "Artifact", target: "https://claude.ai/artifact/x" };
      const { summary, detail } = built({
        ...a1(),
        tool_calls: [{ ...sharedFile, ...artifact } as CardToolCall],
      }).primary;
      expect(summary).toMatch(/^Read only the part you need from the saved copy of/);
      expect(detail[0]).toMatch(/saves the page to a local file/);
      expect(`${summary} ${detail[0]}`).not.toMatch(/WebFetch a specific question|notes file/);
    });

    // The card spans every tool (R2.3), so with no call read back the fix covers each kind of call.
    it("without a read-back call, gives one fix that covers every tool", () => {
      const [fix] = built(a1()).primary.detail;
      expect(fix).toMatch(/offset and limit/);
      expect(fix).toMatch(/grep, head or tail/);
      expect(fix).toMatch(/files_with_matches/);
      expect(fix).toMatch(/WebFetch a specific question/);
      expect(() => assertCardActionsGuardrails(built(a1()), "A1")).not.toThrow();
    });
  });

  it("offers A1 and D6 no hook, since AW ships no script to run", () => {
    for (const fixture of [fixtures[1], fixtures[3]]) {
      if (fixture === undefined) throw new Error("Missing A1/D6 fixture");
      const actions = directActions(fixture.rec);
      for (const action of [actions.primary, ...actions.alternatives]) {
        expect(action.hook).toBeUndefined();
        expect(action.copy_text).not.toContain('"hooks"');
      }
    }
  });

  it("R6-15: A1 names Claude Code's tool-result clearing; D6 no longer asserts it (U9 r3: nothing in its evidence shows it)", () => {
    const [, a1, , d6] = fixtures;
    if (a1 === undefined || d6 === undefined) throw new Error("Missing A1/D6 fixture");
    expect(directActions(a1.rec).primary.copy_text).toContain("tool-result clearing");
    expect(directActions(d6.rec).primary.copy_text).not.toContain("tool-result clearing");
  });
});
