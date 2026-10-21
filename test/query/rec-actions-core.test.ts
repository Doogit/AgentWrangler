import { describe, expect, it } from "vitest";
import {
  FAMILY_HANDLERS,
  assertCardActionsGuardrails,
  buildCardActions,
  buildTrigger,
  numberMetric,
  stringMetric,
} from "../../src/query/api/rec-actions/index.js";
import type { CardAction, CardActions } from "../../src/query/api/rec-actions/types.js";

const action = (overrides: Partial<CardAction> = {}): CardAction => ({
  kind: "CONFIG",
  summary: "Use a safe setting",
  detail: [],
  copy_text: "{}",
  file_ref: ".claude/settings.json",
  ...overrides,
});

const actions = (primary: CardAction): CardActions => ({
  primary: { ...primary, option_id: "primary" },
  alternatives: [],
});

describe("nested metric accessor", () => {
  it("reads V2 metric values before V1 flat facts", () => {
    expect(
      numberMetric(
        { evidence: { metrics: { COUNT: { value: 3 } } }, facts: { COUNT: 2 } },
        "COUNT",
      ),
    ).toBe(3);
    expect(stringMetric({ evidence: { metrics: { TOOL: { value: "Read" } } } }, "TOOL")).toBe(
      "Read",
    );
  });

  it("falls back to V1 flat facts", () => {
    expect(numberMetric({ facts: { COUNT: 2 } }, "COUNT")).toBe(2);
    expect(stringMetric({ facts: { TOOL: "Read" } }, "TOOL")).toBe("Read");
  });
});

describe("buildTrigger", () => {
  it("uses only raw session ids and ignores anchor hashes", () => {
    const trigger = buildTrigger({
      detector_id: "C1",
      lever: "inspect errors",
      evidence: {
        session_ids: ["session-a", "session-a", "session-b"],
        anchors: [{ session_id: "sid_hash" }],
      },
      facts: { session_ids: ["wrong-fallback"], anchors: [{ session_id: "sid_hash_two" }] },
    });
    expect(trigger.session_ids).toEqual(["session-a", "session-b"]);
  });
});

describe("card action guardrails", () => {
  it("rejects unsafe allow rules", () => {
    expect(() =>
      assertCardActionsGuardrails(
        actions(action({ permission_rule: { mode: "allow", pattern: "Bash(*)" } })),
        "C9",
      ),
    ).toThrow(/ask/);
  });

  it("requires a version gate for hooks", () => {
    expect(() =>
      assertCardActionsGuardrails(actions(action({ hook: { event: "PreToolUse" } })), "A1"),
    ).toThrow(/min_claude_code_version/);
  });

  it("rejects .claudeignore suggestions", () => {
    expect(() =>
      assertCardActionsGuardrails(actions(action({ summary: "Add .claudeignore" })), "A1"),
    ).toThrow(/claudeignore/);
  });

  it("rejects selective PreCompact hooks", () => {
    expect(() =>
      assertCardActionsGuardrails(
        actions(
          action({
            hook: { event: "PreCompact", selector: "large-files" },
            min_claude_code_version: "2.1.271",
          }),
        ),
        "D9",
      ),
    ).toThrow(/PreCompact/);
  });

  it("rejects secrets in settings env blocks", () => {
    expect(() =>
      assertCardActionsGuardrails(
        actions(action({ copy_text: '{ "env": { "API_KEY": "secret" } }' })),
        "C7",
      ),
    ).toThrow(/secrets/);
  });

  it("treats a *_TOKEN env var as a secret but a *_TOKENS size limit as not", () => {
    const envAction = (key: string) =>
      actions(
        action({
          kind: "CONFIG",
          copy_text: `{ "env": { "${key}": "1" } }`,
          file_ref: ".claude/settings.json",
        }),
      );
    expect(() => assertCardActionsGuardrails(envAction("GITHUB_TOKEN"), "C7")).toThrow(/secrets/);
    expect(() =>
      assertCardActionsGuardrails(envAction("MAX_MCP_OUTPUT_TOKENS"), "C11"),
    ).not.toThrow();
  });

  it("keeps B1 through B4 advise-only", () => {
    expect(() => assertCardActionsGuardrails(actions(action()), "B1")).toThrow(/advise-only/);
  });
});

describe("buildCardActions guardrail filtering", () => {
  const withHandler = (handler: () => CardActions, run: () => void) => {
    FAMILY_HANDLERS.set("TEST_FAMILY", handler);
    try {
      run();
    } finally {
      FAMILY_HANDLERS.delete("TEST_FAMILY");
    }
  };

  it("hides an alternative that fails a guardrail instead of throwing", () => {
    withHandler(
      () => ({
        primary: { ...action(), option_id: "safe" },
        alternatives: [
          {
            ...action({ permission_rule: { mode: "allow", pattern: "Bash(*)" } }),
            option_id: "unsafe",
          },
          { ...action({ summary: "Use ask for this tool" }), option_id: "ask" },
        ],
      }),
      () => {
        const result = buildCardActions({ detector_id: "TEST_FAMILY", lever: "test" });
        expect(result.primary.option_id).toBe("safe");
        expect(result.alternatives.map((a) => a.option_id)).toEqual(["ask"]);
      },
    );
  });

  it("still throws when the primary fails a guardrail", () => {
    withHandler(
      () => actions(action({ summary: "Add .claudeignore" })),
      () => {
        expect(() => buildCardActions({ detector_id: "TEST_FAMILY", lever: "test" })).toThrow(
          /claudeignore/,
        );
      },
    );
  });
});

describe("fallback action", () => {
  it("builds an investigate action with a session and specific question", () => {
    const result = buildCardActions({
      detector_id: "UNKNOWN",
      lever: "inspect the finding",
      facts: { session_ids: ["session-1"] },
      investigation_question: "Which failing command should be fixed before retrying?",
    });
    expect(result.primary.kind).toBe("INVESTIGATE");
    expect(result.primary.summary).toContain("session-1");
  });

  it("throws rather than emitting a bare investigation", () => {
    expect(() =>
      buildCardActions({ detector_id: "UNKNOWN", lever: "inspect the finding" }),
    ).toThrow(/session id and a specific question/);
  });
});
