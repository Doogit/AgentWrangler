import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NO_WHY, cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import { routingHandler } from "../../src/query/api/rec-actions/families/routing.js";
import {
  assertCardActionsGuardrails,
  isActionAllowed,
} from "../../src/query/api/rec-actions/guardrails.js";
import { buildCardActions, buildTrigger } from "../../src/query/api/rec-actions/index.js";
import type {
  CardActionRecommendation,
  CardActions,
} from "../../src/query/api/rec-actions/types.js";

const fixtures: Array<{
  rec: CardActionRecommendation;
  kind: "CONFIG" | "INVESTIGATE" | "HABIT";
  fileRef: string | null;
  token: string;
  alternativeKinds: Array<"CONFIG" | "HABIT">;
  /** Rewritten to the card rules (P3.1): a plain problem and a four-section prompt. */
  meetsCardRules?: boolean;
}> = [
  {
    rec: {
      detector_id: "D4",
      lever: "model routing",
      facts: {
        workspace_id: "workspace-d4",
        session_ids: ["d4-session"],
        total_opus_turns_per_week: 20,
        mismatch_turns_per_week: 8,
        opus_subagent_count: 6,
        lookup_subagent_count: 3,
        mismatch_fraction: 0.4,
        avg_input_tokens: 80_000,
        avg_output_tokens: 120,
      },
    },
    // U9 r4: a habit with a ready dispatch rule, not an INVESTIGATE terminal.
    kind: "HABIT",
    fileRef: null,
    token:
      "Pass model: sonnet on Agent calls that only read or search: 3 Opus subagents that looked like lookup work ran 8 turns a week (40% of Opus subagent turns)",
    alternativeKinds: [],
    meetsCardRules: true,
  },
  {
    rec: {
      detector_id: "D9",
      lever: "fork routing",
      facts: { workspace_id: "workspace-d9", fork_count: 4, session_ids: ["d9-session"] },
    },
    kind: "CONFIG",
    fileRef: ".claude/settings.json",
    token: "4 detected forks",
    alternativeKinds: ["CONFIG", "HABIT"],
  },
  {
    rec: {
      detector_id: "D12",
      lever: "subagent returns",
      facts: {
        workspace_id: "workspace-d12",
        sidechain_result_bytes: 250_000,
        sidechain_turn_count: 12,
        sidechain_session_count: 3,
        session_ids: ["d12-session"],
      },
    },
    // One INVESTIGATE prompt per card (P3.1): the wave-size env option is no longer offered.
    kind: "INVESTIGATE",
    fileRef: null,
    token: "244 KB returned in 3 sessions",
    alternativeKinds: [],
    meetsCardRules: true,
  },
  {
    rec: {
      detector_id: "G11",
      lever: "failed work item",
      evidence: {
        session_ids: ["g11-session"],
        metrics: {
          WORK_ITEM_ID: { value: "work-item-hash" },
          INPUT_CACHE_TOKENS: { value: 72_000 },
          WORKSPACE_P90_INPUT_CACHE_TOKENS: { value: 48_000 },
          COMPARISON_WORK_ITEM_COUNT: { value: 20 },
        },
      },
    },
    kind: "INVESTIGATE",
    fileRef: null,
    token: "72,000-token",
    alternativeKinds: [],
  },
  {
    rec: {
      detector_id: "C11",
      lever: "MCP output cap",
      evidence: { session_ids: ["c11-session"], metrics: { ERROR_COUNT: { value: 3 } } },
    },
    kind: "CONFIG",
    fileRef: ".claude/settings.json",
    token: "3 MCP output-cap errors",
    alternativeKinds: ["HABIT"],
  },
  {
    // U7: Read over-cap errors only. The MCP cap setting does not apply to them.
    rec: {
      detector_id: "C11",
      lever: "MCP output cap",
      evidence: {
        session_ids: ["c11-session"],
        metrics: { ERROR_COUNT: { value: 0 }, READ_ERROR_COUNT: { value: 4 } },
      },
    },
    kind: "HABIT",
    fileRef: null,
    token: "4 whole-file Reads hit the output cap",
    alternativeKinds: [],
  },
];

function direct(rec: CardActionRecommendation): CardActions {
  const actions = routingHandler(rec, { trigger: buildTrigger(rec) });
  if (actions === null) throw new Error(`No routing actions for ${rec.detector_id}`);
  return actions;
}

describe("routing recommendation actions", () => {
  it.each(fixtures)("builds safe $rec.detector_id actions", (fixture) => {
    const handlerActions = direct(fixture.rec);
    const builtActions = buildCardActions(fixture.rec);

    expect(handlerActions.primary.kind).toBe(fixture.kind);
    expect(handlerActions.primary.file_ref).toBe(fixture.fileRef);
    expect(handlerActions.primary.summary).toContain(fixture.token);
    expect(handlerActions.primary.copy_text).not.toBe("");
    expect(handlerActions.alternatives.map((action) => action.kind)).toEqual(
      fixture.alternativeKinds,
    );
    expect(isActionAllowed(handlerActions.primary, fixture.rec.detector_id)).toBe(true);
    for (const action of [handlerActions.primary, ...handlerActions.alternatives]) {
      if (action.kind === "CONFIG" || action.kind === "EDIT")
        expect(action.file_ref).not.toBeNull();
    }
    expect(() =>
      assertCardActionsGuardrails(handlerActions, fixture.rec.detector_id),
    ).not.toThrow();
    expect(builtActions.alternatives).toEqual(handlerActions.alternatives);
    // Review 5: no routing card has a "Why this matters" text yet (deferred item 11).
    if (fixture.meetsCardRules)
      expect(cardRuleViolations(handlerActions, buildTrigger(fixture.rec))).toEqual([NO_WHY]);
  });

  it("U9: D4 names the agent types, fixes each by type and states the rule actually used", () => {
    const rec: CardActionRecommendation = {
      detector_id: "D4",
      lever: "model routing",
      facts: {
        session_ids: ["d4-session"],
        total_opus_turns_per_week: 705,
        mismatch_turns_per_week: 562,
        opus_subagent_count: 30,
        lookup_subagent_count: 15,
        mismatch_fraction: 0.7972,
        avg_output_tokens: 38,
        top_agent_types: ["general-purpose", "workflow-subagent"],
      },
    };
    // Point home at an empty folder so the user's own CLAUDE.md model rule is not read (U9 r5).
    const savedHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    const emptyHome = mkdtempSync(path.join(os.tmpdir(), "aw-d4-home-"));
    process.env.USERPROFILE = emptyHome;
    process.env.HOME = emptyHome;
    let text: string;
    try {
      text = direct(rec).primary.copy_text;
    } finally {
      for (const [key, value] of Object.entries(savedHome)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(emptyHome, { recursive: true, force: true });
    }
    expect(text).toContain(
      "Most common subagent types among them, by turns: general-purpose, workflow-subagent",
    );
    expect(text).toContain("pass model: sonnet (haiku for pure grep)");
    expect(text).toContain("agent() call");
    expect(text).toContain("at least 80% of their turns");
    expect(text).not.toContain("every turn");
    const problem = buildTrigger(rec).problem ?? "";
    expect(problem).toContain("at least 80% of each one's turns");
    expect(problem).not.toContain("did only lookup work");
    expect(problem).toContain("Most common types: general-purpose, workflow-subagent.");
  });

  it("G11 names the failed work item's spend, the baseline and the sessions, without claiming a cause", () => {
    const g11 = fixtures.find((fixture) => fixture.rec.detector_id === "G11");
    if (g11 === undefined) throw new Error("Missing G11 fixture");
    const primary = direct(g11.rec).primary;
    expect(primary.summary).toContain("72,000-token");
    expect(primary.summary).toContain("48,000");
    expect(primary.copy_text).toContain(
      "- Tokens used by the failed work item's linked sessions: 72,000",
    );
    expect(primary.copy_text).toContain("(20 comparison entries)");
    expect(primary.copy_text).toContain("g11-session");
    expect(primary.copy_text).toContain("does not show that the spend caused the failure");
    expect(primary.detail.join(" ")).toContain("does not show the spend caused the failure");
  });

  it("keeps the D4 Sonnet-cap caveat and D9 version gate scoped to their primary actions", () => {
    const d4Fixture = fixtures[0];
    const d9Fixture = fixtures[1];
    if (d4Fixture === undefined || d9Fixture === undefined)
      throw new Error("Missing routing fixtures");
    const d4 = direct(d4Fixture.rec);
    const d9 = direct(d9Fixture.rec);
    expect(d4.primary.detail.join(" ")).toMatch(/Sonnet weekly cap is the binding constraint/i);
    expect(d9.primary.detail.join(" ")).toContain("v2.1.271+");
    const nonFork = d9.alternatives.find((action) => action.option_id === "d9-non-fork-agent");
    expect(nonFork?.detail.join(" ")).toMatch(/omitClaudeMd.*v2\.1\.271\+/);
    const explicitType = d9.alternatives.find(
      (action) => action.option_id === "d9-explicit-subagent-type",
    );
    expect(explicitType?.detail.join(" ")).not.toContain("v2.1.271+");
  });

  it("uses singular fork copy for one D9 fork", () => {
    const actions = direct({
      detector_id: "D9",
      lever: "fork routing",
      facts: { workspace_id: "workspace-d9", fork_count: 1, session_ids: ["d9-session"] },
    });
    for (const action of [actions.primary, ...actions.alternatives]) {
      expect(action.summary).toContain("1 detected fork.");
      expect(action.summary).not.toContain("forks");
    }
  });

  it("rejects a selective PreCompact routing alternative", () => {
    const d9Fixture = fixtures[1];
    if (d9Fixture === undefined) throw new Error("Missing D9 fixture");
    const actions = direct(d9Fixture.rec);
    const alternative = actions.alternatives[0];
    if (alternative === undefined) throw new Error("Missing D9 alternative");
    actions.alternatives[0] = {
      ...alternative,
      hook: { event: "PreCompact", selector: "Agent" },
      min_claude_code_version: "2.1.271",
    };
    expect(() => assertCardActionsGuardrails(actions, "D9")).toThrow(/selective PreCompact/);
  });
});
