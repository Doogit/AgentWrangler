import { describe, expect, it } from "vitest";
import { NO_WHY, cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import { errorsHandler } from "../../src/query/api/rec-actions/families/errors.js";
import { assertCardActionsGuardrails } from "../../src/query/api/rec-actions/guardrails.js";
import { buildCardActions, buildTrigger } from "../../src/query/api/rec-actions/index.js";
import type {
  CardActionRecommendation,
  CardActions,
  CardToolCall,
} from "../../src/query/api/rec-actions/types.js";

const fixtures: Array<{
  rec: CardActionRecommendation;
  kind: "CONFIG" | "EDIT" | "INVESTIGATE";
  token: string;
  expectedAlternativeKinds: Array<"CONFIG" | "EDIT" | "INVESTIGATE">;
  /** Rewritten to the card rules (P3.1): a plain problem and a four-section prompt. */
  meetsCardRules?: boolean;
}> = [
  {
    rec: {
      detector_id: "C1",
      lever: "inspect failures",
      evidence: {
        metrics: {
          TOOL_ERROR_RATE: { value: 0.375 },
          TOOL_ERROR_COUNT: { value: 3 },
          TOOL_CALL_COUNT: { value: 8 },
          CORPUS_ERROR_RATE: { value: 0.05 },
          RATE_MULTIPLE: { value: 7.5 },
        },
        session_ids: ["c1-session"],
      },
    },
    kind: "INVESTIGATE",
    // Review 3 B7: no multiple of the all-tool rate; the tool was picked for a high rate.
    token: "3 of 8 calls to one tool (37.5%)",
    expectedAlternativeKinds: [],
    meetsCardRules: true,
  },
  {
    rec: {
      detector_id: "C2",
      lever: "confirm paths",
      evidence: {
        metrics: { ERROR_COUNT: { value: 4 }, SESSION_COUNT: { value: 2 } },
        session_ids: ["c2-a", "c2-b"],
      },
    },
    kind: "INVESTIGATE",
    token: "4 missing-path lookups across 2 sessions",
    expectedAlternativeKinds: [],
    meetsCardRules: true,
  },
  {
    rec: {
      detector_id: "C3",
      lever: "read first",
      evidence: { metrics: { ERROR_COUNT: { value: 3 } } },
    },
    kind: "EDIT",
    token: "3",
    // U9 r8: the card's files and sessions are in a prompt beside the minimal CLAUDE.md rule.
    expectedAlternativeKinds: ["INVESTIGATE"],
  },
  {
    rec: {
      detector_id: "C4",
      lever: "recover edits",
      evidence: { metrics: { FAILED_EDIT_COUNT: { value: 5 } }, session_ids: ["c4-session"] },
    },
    kind: "INVESTIGATE",
    token: "5",
    expectedAlternativeKinds: [],
  },
  {
    rec: {
      detector_id: "C5",
      lever: "break loop",
      evidence: { metrics: { REPEATED_ERROR_COUNT: { value: 7 } }, session_ids: ["c5-session"] },
    },
    kind: "INVESTIGATE",
    token: "7",
    expectedAlternativeKinds: [],
  },
  {
    rec: {
      detector_id: "C6",
      lever: "resolve flip flop",
      evidence: { metrics: { FLIP_FLOP_COUNT: { value: 2 } }, session_ids: ["c6-session"] },
    },
    kind: "INVESTIGATE",
    token: "2",
    expectedAlternativeKinds: [],
  },
  {
    rec: {
      detector_id: "C7",
      lever: "fix environment",
      evidence: {
        metrics: { BASH_COMMAND_FAMILY: { value: "BASH_NPM" }, BASH_FAILURE_COUNT: { value: 3 } },
      },
    },
    kind: "INVESTIGATE",
    token: "3 npm commands",
    // One change per card (P3.1): the settings env default moved into the prompt's Fix text.
    expectedAlternativeKinds: [],
    meetsCardRules: true,
  },
  {
    rec: {
      detector_id: "D7",
      lever: "break retries",
      facts: {
        session_ids: ["d7-session"],
        repeat_excess_event_count: 6,
        loop_flagged_turn_count: 12,
        loop_flagged_turn_share: 0.05,
      },
    },
    kind: "INVESTIGATE",
    // Review 5 M18: the summary names the two cases (same error, repeated read), not a count.
    token: "when a file is read again with no edit between",
    // The aw_loop_breaker retry-guard alternative was removed (rec-trust U0.3).
    expectedAlternativeKinds: [],
    meetsCardRules: true,
  },
  {
    rec: {
      detector_id: "D7",
      lever: "break retries",
      facts: {
        session_ids: ["d7-reread-session"],
        redundant_path_count: 4,
        total_redundant_read_count: 11,
      },
    },
    kind: "INVESTIGATE",
    token: "4 files re-read 11 times",
    // One change per card (P3.1): the compact-return CLAUDE.md note is no longer a second option.
    expectedAlternativeKinds: [],
    meetsCardRules: true,
  },
];

function direct(rec: CardActionRecommendation): CardActions {
  const result = errorsHandler(rec, { trigger: buildTrigger(rec) });
  if (result === null) throw new Error(`No error actions for ${rec.detector_id}`);
  return result;
}

describe("errors recommendation actions", () => {
  it.each(fixtures)(
    "builds safe $rec.detector_id actions",
    ({ rec, kind, token, expectedAlternativeKinds, meetsCardRules }) => {
      const handlerActions = direct(rec);
      const builtActions = buildCardActions(rec);

      expect(handlerActions.primary.kind).toBe(kind);
      expect(handlerActions.primary.summary).toContain(token);
      expect(handlerActions.primary.copy_text).not.toBe("");
      if (kind === "EDIT" || kind === "CONFIG")
        expect(handlerActions.primary.file_ref).not.toBeNull();
      expect(handlerActions.alternatives.map((action) => action.kind)).toEqual(
        expectedAlternativeKinds,
      );
      expect(() => assertCardActionsGuardrails(handlerActions, rec.detector_id)).not.toThrow();
      expect(builtActions.alternatives).toEqual(handlerActions.alternatives);
      // Review 5: C2 and C7 have no "Why this matters" text yet (deferred item 11).
      if (meetsCardRules)
        expect(cardRuleViolations(handlerActions, buildTrigger(rec))).toEqual(
          ["C2", "C7"].includes(rec.detector_id) ? [NO_WHY] : [],
        );
    },
  );

  it("C2: one card per workspace, counted by cause, fixing the lead cause (R2.1, R4.6)", () => {
    const call = (
      target: string,
      calls: number,
      cause: NonNullable<CardToolCall["cause"]>,
    ): CardToolCall => ({
      target,
      kind: "file",
      tool: "Read",
      calls,
      session_ids: ["c2-a"],
      session_count: 1,
      total_bytes: 0,
      max_bytes: 0,
      whole_file: true,
      result: "File does not exist.",
      cause,
    });
    const rec = (calls: CardToolCall[]): CardActionRecommendation => ({
      detector_id: "C2",
      lever: "confirm paths",
      evidence: {
        metrics: { ERROR_COUNT: { value: 12 }, SESSION_COUNT: { value: 9 } },
        session_ids: ["c2-a", "c2-b"],
      },
      tool_calls: calls,
    });

    const guessed = rec([
      call("~/repo/src/spend.ts", 3, "GUESSED_PATH"),
      call("~/repo/test/b1.test.ts", 1, "WRONG_WORKTREE"),
      call("~/repo/src/format.ts", 8, "GUESSED_PATH"),
    ]);
    const trigger = buildTrigger(guessed);
    expect(trigger.problem).toMatch(
      /^12 lookups of paths that did not exist across 9 sessions: 11 guessed or moved, 1 in the wrong worktree\./,
    );
    expect(trigger.facts).toEqual([
      { label: "Missing-path lookups", value: "12 in 9 sessions" },
      { label: "Guessed or moved paths", value: "11" },
      { label: "Paths in the wrong worktree", value: "1" },
    ]);
    const actions = direct(guessed);
    expect(actions.primary.summary).toContain("12 missing-path lookups across 9 sessions");
    expect(actions.primary.copy_text).toContain("locate an unfamiliar file with Glob");
    expect(actions.primary.copy_text).toContain(
      "- By cause: 11 guessed or moved, 1 in the wrong worktree",
    );
    // Review 5: C2 has no "Why this matters" text yet (deferred item 11).
    expect(cardRuleViolations(actions, trigger)).toEqual([NO_WHY]);

    // The fix follows the lead cause: one change per card.
    const scratch = rec([
      call("~/AppData/Local/Temp/claude/ws/abc/scratchpad/plan.md", 5, "OTHER_SCRATCHPAD"),
      call("~/repo/src/spend.ts", 2, "GUESSED_PATH"),
    ]);
    const scratchActions = direct(scratch);
    expect(buildTrigger(scratch).problem).toContain("another session's scratchpad");
    expect(scratchActions.primary.copy_text).toContain(
      "never point a handoff or plan at a scratchpad",
    );
    expect(scratchActions.primary.copy_text).not.toContain("locate an unfamiliar file with Glob");
    expect(cardRuleViolations(scratchActions, buildTrigger(scratch))).toEqual([NO_WHY]);

    const worktree = rec([call("~/repo/test/b1.test.ts", 4, "WRONG_WORKTREE")]);
    expect(direct(worktree).primary.copy_text).toContain("git rev-parse --show-toplevel");

    // The list shows every cause even when one cause has more than eight groups, and the
    // example is a file path rather than a search pattern.
    const pattern = { ...call("(?i)live in ~/repo/src/ui", 1, "GUESSED_PATH"), kind: "search" };
    const guesses = Array.from({ length: 9 }, (_, i) =>
      call(`~/repo/src/g${i}.ts`, 1, "GUESSED_PATH"),
    );
    const crowded = rec([
      pattern as CardToolCall,
      ...guesses,
      call("~/repo/test/b1.test.ts", 1, "WRONG_WORKTREE"),
    ]);
    const listed = buildTrigger(crowded).calls ?? [];
    expect(listed).toHaveLength(8);
    expect(listed.map((c) => c.cause)).toContain("WRONG_WORKTREE");
    expect(listed[0]?.kind).toBe("file");
    expect(buildTrigger(crowded).problem).toContain("such as `~/repo/src/g0.ts`");
  });

  it("R6-15: D7 re-reads context names /clear, compaction and tool-result clearing", () => {
    const fixture = fixtures.find(
      (fixture) => fixture.rec.facts?.redundant_path_count !== undefined,
    );
    if (fixture === undefined) throw new Error("D7 re-reads fixture is missing");
    const prompt = direct(fixture.rec).primary.copy_text;
    expect(prompt).toContain("tool-result clearing");
    expect(prompt).not.toContain("for the rest of the session");
  });

  it("rejects a C7 settings env block with a secret-looking variable", () => {
    const c7 = fixtures.find((fixture) => fixture.rec.detector_id === "C7");
    if (c7 === undefined) throw new Error("C7 fixture is missing");
    const invalid = direct(c7.rec);
    invalid.alternatives = [
      {
        option_id: "unsafe-secret-env",
        kind: "CONFIG",
        summary: "Store an environment variable.",
        detail: [],
        copy_text: '{ "env": { "API_TOKEN": "value" } }',
        file_ref: ".claude/settings.json",
      },
    ];
    expect(() => assertCardActionsGuardrails(invalid, "C7")).toThrow(/secrets/);
  });

  it("D7 cross-session re-reads: a partial-read top file gets a section pointer, named on the fact (review 5 M13/M14/M16)", () => {
    const topFile: CardToolCall = {
      target: "docs/plans/plan.md",
      kind: "file",
      tool: "Read",
      calls: 34,
      session_ids: ["s1"],
      session_count: 16,
      total_bytes: 34 * 2_000,
      max_bytes: 2_000,
      whole_file: false,
    };
    const rec: CardActionRecommendation = {
      detector_id: "D7",
      lever: "break retries",
      facts: {
        session_ids: ["s1", "s2"],
        redundant_path_count: 5,
        total_redundant_read_count: 40,
        total_redundant_result_bytes: 500_000,
      },
      tool_calls: [topFile],
    };
    const trigger = buildTrigger(rec);
    const actions = direct(rec);
    // M13: read in parts -> name the section, with labelled units (folded "count units" minor).
    expect(actions.primary.summary).toContain("Name the section");
    expect(actions.primary.summary).toContain("34 reads in 16 sessions");
    // M14: the fact names the file, not only its session count.
    expect(trigger.facts).toContainEqual({
      label: "Most-read look-up file",
      value: "`docs/plans/plan.md` (16 sessions)",
    });
    // M16: the other card named by its actual title (not a nickname). Residual M16: rows may be
    // whole reads, so the header no longer says "partial reads only".
    expect(actions.primary.copy_text).toContain(
      'whole or in parts, as each row says; results over 25 KB are on the "Shrink the large tool result that costs the most in re-sends" card',
    );
    // Folded minor: "the loop card" nickname is gone; the D7 loops card's own title is used.
    expect(trigger.problem).not.toContain("loop card");
    expect(trigger.problem).toContain(
      '"Stop repeated attempts and re-plan after a bounded retry threshold." card',
    );
  });

  it("D7 cross-session re-reads: a whole-read top file keeps the existing pointer wording", () => {
    const topFile: CardToolCall = {
      target: "docs/plans/plan.md",
      kind: "file",
      tool: "Read",
      calls: 20,
      session_ids: ["s1"],
      session_count: 12,
      total_bytes: 20 * 2_000,
      max_bytes: 2_000,
      whole_file: true,
    };
    const rec: CardActionRecommendation = {
      detector_id: "D7",
      lever: "break retries",
      facts: { session_ids: ["s1"], redundant_path_count: 3, total_redundant_read_count: 20 },
      tool_calls: [topFile],
    };
    expect(direct(rec).primary.summary).toBe(
      "Point Claude at the part of `docs/plans/plan.md` it needs, instead of the whole file (read in 12 sessions).",
    );
  });

  it("C3: states the counts and points at the subagent dispatch prompt, not a Glob rule", () => {
    const rec: CardActionRecommendation = {
      detector_id: "C3",
      lever: "read first",
      evidence: {
        metrics: {
          ERROR_COUNT: { value: 1 },
          SUBAGENT_ERROR_COUNT: { value: 1 },
          WRITE_ERROR_COUNT: { value: 0 },
          SESSION_COUNT: { value: 1 },
        },
      },
    };
    const action = direct(rec).primary;
    expect(action.summary).toContain("1 edit or write call was rejected");
    expect(action.summary).not.toContain("1 edits");
    expect(action.copy_text).toContain("subagent");
    expect(action.copy_text).not.toContain("Glob");
  });

  it("C4: names the dominant failure cause from the error text", () => {
    const rec = (text: string | undefined): CardActionRecommendation => ({
      detector_id: "C4",
      lever: "recover edits",
      evidence: {
        metrics: {
          FAILED_EDIT_COUNT: { value: 4 },
          ...(text === undefined ? {} : { TOP_FAILURE_ERROR_TEXT: { value: text } }),
        },
        session_ids: ["c4-session"],
      },
    });
    const modified = direct(
      rec("File has been modified since read, either by the user or by a linter."),
    );
    expect(modified.primary.summary).toContain("the file changed after it was read");
    expect(modified.primary.copy_text).toContain("formatter, a hook, another agent");
    // No stored text: the general advice, with no invented cause.
    expect(direct(rec(undefined)).primary.summary).not.toContain("commonest");
  });
});
