import { describe, expect, it } from "vitest";
import { buildCardActions } from "../../src/query/api/rec-actions/index.js";
import {
  GUARD_FIX,
  NODE_FLAG_ERE,
  NODE_FLAG_JS,
  TMP_SCRUB_JS,
  buildTrigger,
} from "../../src/query/api/rec-actions/trigger.js";
import type {
  CardActionRecommendation,
  CardToolCall,
} from "../../src/query/api/rec-actions/types.js";
import { type RepoProbe, guardShape, notFoundCause } from "../../src/query/api/tool-calls.js";

const call = (over: Partial<CardToolCall>): CardToolCall => ({
  target: "~/x",
  kind: "file",
  tool: "Read",
  calls: 1,
  session_ids: [],
  session_count: 1,
  total_bytes: 0,
  max_bytes: 0,
  whole_file: false,
  ...over,
});

const rec = (
  detector_id: string,
  values: Record<string, number | string>,
  tool_calls?: CardToolCall[],
  session_ids = ["s1"],
): CardActionRecommendation => ({
  detector_id,
  lever: "lever",
  evidence: {
    session_ids,
    metrics: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }])),
  },
  ...(tool_calls === undefined ? {} : { tool_calls }),
});

/** The guard's current rule is a `/tmp/` substring; the fix runs it after cutting the job folder. */
const tmpBlocked = (command: string) => command.replace(TMP_SCRUB_JS, "$1/_/").includes("/tmp/");
const nodeBlocked = (command: string) => NODE_FLAG_JS.test(command);

describe("U9 round 7, tool lane: C9 patterns never block less than the current guard", () => {
  // Every row the current guard blocks (`node -e` prefix, `/tmp/` substring) except the harmless samples.
  const nodeBlock = [
    'node -e "1"',
    'node -e"1"',
    "node -e'1'",
    "node -e",
    "node -e1",
    "node -e(1)",
    "node\t-e 1",
    "node  -e x",
  ];
  const nodePass = [
    "Get-Process node -ErrorAction SilentlyContinue | Measure-Object",
    "node -ErrorAction Stop",
    "node scripts/x.js --foo",
  ];
  const tmpBlock = [
    "cat x > /tmp/out.txt",
    'cp a "/tmp/out.txt"',
    "echo hi >/tmp/out.txt",
    "cp f /var/tmp/x",
    "cp f /c/tmp/x",
    "cp f ./tmp/x",
    "cp f src/tmp/x",
    "cp f /jobs/../tmp/x",
    "cp /jobs/ab12/tmp/a /tmp/b",
    "cp f /jobs/ab12/tmp//tmp/x",
    "cp f /jobs/ab12/tmp/../../../tmp/x",
    "cp f /tmp/jobs/ab12/tmp/../x",
  ];
  const tmpPass = [
    "ls C:/work/.claude/jobs/abc123/tmp/u9/x.js",
    "ls jobs/ab12/tmp/f1",
    "ls $CLAUDE_JOB_DIR/tmp/x",
    "ls ${CLAUDE_JOB_DIR}/tmp/x",
  ];

  it("node -e: blocks every -e not followed by a letter, passes -ErrorAction", () => {
    for (const c of nodeBlock) expect(nodeBlocked(c), `must block: ${c}`).toBe(true);
    for (const c of nodePass) expect(nodeBlocked(c), `must pass: ${c}`).toBe(false);
    // Superset check against the current prefix rule: all it blocked beyond ours is -e<letter>.
    const old = /node\s+-e/i;
    for (const c of [...nodeBlock, ...nodePass]) {
      if (old.test(c) && !nodeBlocked(c)) expect(/node\s+-e[A-Za-z]/i.test(c), c).toBe(true);
    }
    expect(NODE_FLAG_ERE).toBe("node[[:space:]]+-e([^[:alpha:]]|$)");
  });

  it("/tmp: only the job scratch folder is cut out; every other /tmp/ stays blocked", () => {
    for (const c of tmpBlock) {
      expect(c.includes("/tmp/"), `the current guard blocks: ${c}`).toBe(true);
      expect(tmpBlocked(c), `must block: ${c}`).toBe(true);
    }
    for (const c of tmpPass) expect(tmpBlocked(c), `must pass: ${c}`).toBe(false);
  });

  it("a heredoc feeding a command is a correct block, not a false positive", () => {
    expect(guardShape("git commit -F - <<'EOF'\nmsg\nEOF")).toBe("HEREDOC_STDIN");
    const blocks = [
      call({
        tool: "Bash",
        kind: "command",
        target: "git commit -F - <<'EOF'",
        guard_shape: "HEREDOC_STDIN",
        result: "Blocked command shape (CLAUDE.md shell hygiene). Heredoc.",
        calls: 2,
      }),
      call({
        tool: "Bash",
        kind: "command",
        target: "ls jobs/ab12/tmp/f1",
        guard_shape: "SCRATCH_TMP",
        result: "Blocked command shape (CLAUDE.md shell hygiene). Heredoc.",
        calls: 3,
      }),
    ];
    const {
      summary,
      detail,
      copy_text: text,
    } = buildCardActions(
      rec("C9", { DENIAL_CLASS: "HOOK_BLOCK", DENIAL_COUNT: 5 }, blocks),
    ).primary;
    expect(summary).toContain("Stop 3 harmless calls");
    expect(summary).not.toMatch(/-F -/);
    expect(summary.split("change the guard").length).toBe(1);
    expect(detail.join("\n")).toContain("your rule forbids heredocs");
    expect(text).toContain("`/var/tmp/x`");
    expect(text).toContain('`node -e"1"`');
    expect(text).toContain("`git commit -F - <<'EOF'`");
  });

  it("a quoted << is fixed on the calling side, with no quote-blanking pattern", () => {
    expect(GUARD_FIX.QUOTED_HEREDOC).toBeUndefined();
    const quoted = call({
      tool: "Bash",
      kind: "command",
      target: 'grep -n "^<<<<<<<" x.ts',
      guard_shape: "QUOTED_HEREDOC",
      result: "Blocked command shape (CLAUDE.md shell hygiene). Heredoc.",
      calls: 4,
    });
    const text = buildCardActions(
      rec("C9", { DENIAL_CLASS: "HOOK_BLOCK", DENIAL_COUNT: 4 }, [quoted]),
    ).primary.copy_text;
    expect(text).toContain("^(<{7}|={7}|>{7})");
    expect(text).not.toMatch(/blank out/);
  });
});

describe("U9 round 7, tool lane: C2", () => {
  const repo = "c:/users/me/r";
  const probe = (existing: string[]): RepoProbe => ({
    exists: (file) => existing.includes(file),
    checkouts: () => [repo, `${repo}/.worktrees/demo`],
    trackedFiles: () => ["src/detector/detectors/d10_catalog_footprint.ts"],
  });
  const missing = (file: string) => ({
    target: file,
    path: file,
    result: `Path does not exist. Note: your current working directory is ${repo}.`,
  });

  it("a guessed file name in a worktree that is on disk is a guess, not the wrong worktree", () => {
    const guessed = missing(`${repo}/.worktrees/demo/src/detector/detectors/d10_catalog_bloat.ts`);
    expect(notFoundCause(guessed as never, "s1", probe([repo, `${repo}/.worktrees/demo`]))).toBe(
      "GUESSED_PATH",
    );
    // Same file name present in another checkout: the path named the wrong worktree.
    const elsewhere = [
      repo,
      `${repo}/.worktrees/demo`,
      `${repo}/src/detector/detectors/d10_catalog_bloat.ts`,
    ];
    expect(notFoundCause(guessed as never, "s1", probe(elsewhere))).toBe("WRONG_WORKTREE");
    // U9 r8: a worktree that is gone is its own cause (the file went with it or was never there).
    expect(notFoundCause(guessed as never, "s1", probe([repo]))).toBe("WORKTREE_GONE");
  });

  it("a tie is said as a tie, probes and unread lookups are left out, and no handoff cause is asserted", () => {
    const base = { result: "File does not exist." };
    const calls = [
      call({ ...base, target: "~/r/.worktrees/a/x.md", cause: "WRONG_WORKTREE", calls: 3 }),
      call({ ...base, target: "~/r/y.md", cause: "GUESSED_PATH", calls: 2 }),
      call({ ...base, target: "~/r/z.md", cause: "GUESSED_PATH", calls: 1 }),
      call({
        ...base,
        tool: "Grep",
        kind: "search",
        target: "D8 in ~/r/.audits-none",
        cause: "GUESSED_PATH",
        calls: 1,
      }),
    ];
    const r = rec("C2", { ERROR_COUNT: 14, SESSION_COUNT: 10 }, calls, ["s1", "s2"]);
    const { summary, copy_text: text } = buildCardActions(r).primary;
    expect(summary).toContain(
      "the commonest causes tie (guessed or moved and in the wrong worktree, 3 each of 6 lookups read back, not counting 1 deliberate probe)",
    );
    const problem =
      buildTrigger(r, { allocated_u_per_wk: null, reliability_u_per_wk: null }).problem ?? "";
    expect(problem).toContain("tie");
    expect(problem).not.toMatch(/A plan or handoff names the checkout/);
    expect(text).toContain("Glob for its file name");
  });
});

describe("U9 round 7, tool lane: C1 and C11", () => {
  it("C1 on a few failures offers four steps, no dangling script, and states the baseline basis", () => {
    const r = rec(
      "C1",
      {
        TOOL_ERROR_COUNT: 4,
        TOOL_CALL_COUNT: 36,
        TOOL_ERROR_RATE: 0.111,
        CORPUS_CALL_COUNT: 6533,
        CORPUS_ERROR_RATE: 0.003,
        OUTLIER_TOOLS: "mcp__claude-in-chrome__javascript_tool",
      },
      [
        call({
          tool: "mcp__claude-in-chrome__javascript_tool",
          kind: "other",
          target: "mcp__claude-in-chrome__javascript_tool {}",
          result: "JavaScript execution error: TypeError: Cannot read properties of null",
          session_ids: ["s1"],
        }),
      ],
    );
    const { summary, copy_text: text } = buildCardActions(r).primary;
    expect(summary).toMatch(/^Read the error of each failed call/);
    expect(text).not.toContain("that script");
    expect(text).not.toContain("Run this in a fresh session");
    expect(text).toContain("Say whether the same error shows up in more than one session");
    expect(text).toContain('Ready CLAUDE.md line: "Before a `javascript_tool` call');
    expect((text.match(/^\d+\. /gm) ?? []).length).toBe(4);
    const problem =
      buildTrigger(r, { allocated_u_per_wk: null, reliability_u_per_wk: null }).problem ?? "";
    expect(problem).toContain("main-conversation calls with a recorded outcome");
  });

  it("C11 gives a concrete limit and says one rule covers every session's card", () => {
    const r = rec("C11", { ERROR_COUNT: 0, READ_ERROR_COUNT: 1 }, [
      call({
        tool: "Read",
        target: "~/docs/plan.md",
        whole_file: false,
        result:
          "File content (28561 tokens) exceeds maximum allowed tokens (25000). Use offset and limit.",
      }),
    ]);
    const { copy_text: text, detail } = buildCardActions(r).primary;
    // U9 r9: no fixed limit (a fixed 200 can exceed the limit that already failed).
    expect(text).toContain("retry with half that limit, halving again until it fits");
    expect(text).not.toMatch(/limit 200|200 lines/);
    expect(text).not.toContain("Evidence:");
    expect(detail.join("\n")).toContain("the one rule for all of them");
    expect(text).not.toMatch(/head_limit|MCP/);
  });
});

describe("U9 round 7, tool lane: C3", () => {
  it("pastes the rule only, with no evidence paragraph or scratch path", () => {
    const text = buildCardActions(
      rec(
        "C3",
        { ERROR_COUNT: 36, SESSION_COUNT: 9, SUBAGENT_ERROR_COUNT: 26, WRITE_ERROR_COUNT: 10 },
        [call({ tool: "Write", target: "~/.claude/jobs/2e/msg.txt", calls: 3 })],
      ),
    ).primary.copy_text;
    expect(text).not.toMatch(/jobs|Where this came from|36/);
    expect(text.split("\n")).toHaveLength(3);
  });
});
