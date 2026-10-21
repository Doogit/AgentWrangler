import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { H1_HOOK_FN } from "../../src/query/api/rec-actions/families/permissions.js";
import { buildCardActions } from "../../src/query/api/rec-actions/index.js";
import {
  TMP_SCRUB_JS,
  TMP_SCRUB_SED,
  buildTrigger,
} from "../../src/query/api/rec-actions/trigger.js";
import type {
  CardActionRecommendation,
  CardToolCall,
} from "../../src/query/api/rec-actions/types.js";
import { guardShape } from "../../src/query/api/tool-calls.js";

// The shipped snippet, evaluated as-is (the card pastes this text into a Node hook).
const rmRfRisky = new Function(`${H1_HOOK_FN}\nreturn rmRfRisky;`)() as (c: string) => boolean;

describe("U9 round 8, tool lane: H1 hook snippet", () => {
  it("blocks the card's shapes, the per-segment, long-flag and multi-target bypasses", () => {
    for (const line of [
      'rm -rf "$DIR"',
      "rm -fr ~/x",
      "rm -rf ../x",
      "rm -rf *",
      "rm -r -f /home/me/x",
      "rm -f -r $HOME/x",
      "rm -Rf C:/data/x",
      "rm -rf .",
      "rm -rf ./*",
      "cd /repo && rm -rf $U/cards",
      "U=C:/x; curl -s a; rm -rf $U/cards; node b.cjs",
      // panel round 7 bypasses
      "rm -rf /tmp/a; rm -rf ~/y",
      "rm -rf /tmp/a && rm -rf /home/me",
      "rm -rf /tmp/a || rm -rf /home/me",
      "ls | rm -rf /x",
      "echo hi\nrm -rf /x",
      "rm --recursive --force /x",
      "rm -r --force /x",
      "rm --force --recursive ~/x",
      "rm -rf dist /x",
      "rm -rf dist ~/x",
      "rm -rf /tmp/a /home/me",
      "sudo rm -rf /x",
      "rm -rf %USERPROFILE%",
      "rm -rf `pwd`",
      "rm -rf /tmp",
      "rm -rf /tmp/",
      "rm -rf /tmp/*",
      "rm -rf /tmp/../home/me",
      "rm -rf -- /x",
      "(rm -rf /x)",
      "rm -rf C:\\data\\x",
      "rm -rf build/$X",
    ]) {
      expect(rmRfRisky(line), line).toBe(true);
    }
  });

  it("allows harmless scratch deletes and commands that only mention rm -rf", () => {
    for (const line of [
      "rm -rf dist",
      "rm -rf ./dist",
      "rm -rf .\\dist",
      "rm -rf .next .cache",
      "rm -rf /tmp/build",
      "rm -rf /var/tmp/build /tmp/x",
      "rm -rf /tmp/a; rm -rf dist",
      "rm -rf node_modules/.cache",
      "rm -r build",
      "rm -f /etc/foo.log",
      "rm /x",
      'grep "rm -rf" notes.md',
      "echo rm -rf is dangerous",
      "git rm -rf src/old",
      "ls && rm -f out.log",
      "rm -rf dist 2>&1",
    ]) {
      expect(rmRfRisky(line), line).toBe(false);
    }
  });
});

const call = (over: Partial<CardToolCall>): CardToolCall => ({
  target: "~/x",
  kind: "command",
  tool: "Bash",
  calls: 1,
  session_ids: [],
  session_count: 1,
  total_bytes: 0,
  max_bytes: 0,
  whole_file: false,
  ...over,
});

describe("U9 round 8, tool lane: C9 job-folder scrub", () => {
  // Blocked by a `/tmp/` test today and must stay blocked after the scrub.
  const stillBlocked = [
    "cp f /tmp/x",
    "cp f /var/tmp/x",
    "cp f /c/tmp/x",
    "cp f ./tmp/x",
    "cp f /home/me/proj/tmp/x",
    "cp f /jobs/../tmp/x",
    "cp f /tmp/jobs/ab12/tmp/../x",
    "cp f myjobs/ab12/tmp/x",
    "cp f $CLAUDE_JOB_DIR//tmp/x",
    "cp f jobs/ab12/tmp/../../../tmp/x",
  ];
  const nowPass = [
    "ls $CLAUDE_JOB_DIR/tmp/x",
    "ls ${CLAUDE_JOB_DIR}/tmp/x",
    "ls /c/work/.claude/jobs/ab12/tmp/x.js",
    "ls C:\\work\\.claude\\jobs\\ab12\\tmp\\x.js",
    "ls $env:CLAUDE_JOB_DIR\\tmp\\x",
    'git diff > "$CLAUDE_JOB_DIR/tmp/seed.patch"; git apply "$CLAUDE_JOB_DIR/tmp/seed.patch"',
  ];

  it("JavaScript scrub: only the job scratch folder passes, backslash form included", () => {
    const blocked = (c: string) => c.replace(TMP_SCRUB_JS, "$1/_/").includes("/tmp/");
    for (const c of stillBlocked) expect(blocked(c), `must block: ${c}`).toBe(true);
    for (const c of nowPass) expect(blocked(c), `must pass: ${c}`).toBe(false);
  });

  it("sed scrub gives the same answer (real sed)", () => {
    // The script goes in through a file: on Windows, MSYS rewrites path-like command-line arguments.
    const dir = mkdtempSync(path.join(os.tmpdir(), "aw-u9-r8-"));
    const file = path.join(dir, "scrub.sed");
    writeFileSync(file, `${/'(.*)'$/.exec(TMP_SCRUB_SED)?.[1] ?? ""}\n`);
    let sed: ((c: string) => string) | null = null;
    try {
      execFileSync("sed", ["--version"], { stdio: "pipe" });
      sed = (c) =>
        execFileSync("sed", ["-E", "-f", file], { input: `${c}\n`, stdio: "pipe" }).toString();
    } catch {
      return; // no sed on this machine; the JavaScript table above still runs
    }
    for (const c of stillBlocked) expect(sed(c).includes("/tmp/"), `must block: ${c}`).toBe(true);
    for (const c of nowPass.filter((x) => !x.includes("$env:"))) {
      expect(sed(c).includes("/tmp/"), `must pass: ${c}`).toBe(false);
    }
  });

  it("the classifier counts a PowerShell backslash job path as the job scratch folder", () => {
    expect(guardShape("Get-Content C:\\work\\.claude\\jobs\\ab12\\tmp\\x.txt", "PowerShell")).toBe(
      "PS_SCRATCH_TMP",
    );
    expect(guardShape("Get-Content C:\\work\\proj\\tmp\\x.txt", "PowerShell")).not.toBe(
      "PS_SCRATCH_TMP",
    );
  });

  it("the card says how the harmless blocks split and names the job folder as the only tmp it clears", () => {
    const rec: CardActionRecommendation = {
      detector_id: "C9",
      lever: "lever",
      evidence: {
        session_ids: ["s1"],
        metrics: {
          DENIAL_CLASS: { value: "HOOK_BLOCK" },
          DENIAL_COUNT: { value: 13 },
        },
      },
      tool_calls: [
        call({
          target: "ls $CLAUDE_JOB_DIR/tmp/x",
          guard_shape: "SCRATCH_TMP",
          result: "Blocked command shape (CLAUDE.md shell hygiene). Write under /tmp/.",
          calls: 5,
        }),
        call({
          target: 'grep -n "<<<<<<<" f',
          guard_shape: "QUOTED_HEREDOC",
          result: "Blocked command shape (CLAUDE.md shell hygiene). Write under /tmp/.",
          calls: 4,
        }),
        call({
          target: "Get-Process node -ErrorAction Stop",
          tool: "PowerShell",
          guard_shape: "PS_NODE_FLAG",
          result: "Blocked PowerShell shape (CLAUDE.md hygiene): node -e",
          calls: 4,
        }),
      ],
    };
    const { summary, detail, copy_text } = buildCardActions(rec).primary;
    expect(summary).toContain("Stop 13 harmless calls");
    const split = detail[0] ?? "";
    expect(split).toContain("9 of these need a change to the guard's patterns");
    expect(split).toContain("5 of them blocks on the job scratch folder");
    expect(split).toContain("4 are cleared by running the command another way");
    expect(copy_text).toContain("tested here against the shapes listed");
    expect(copy_text).toContain("A project's own `jobs/<id>/tmp/` folder would also pass");
    expect(copy_text).toContain("first open your guard");
  });
});

const rec = (
  detector_id: string,
  values: Record<string, number | string>,
  tool_calls: CardToolCall[],
  session_ids = ["s1"],
): CardActionRecommendation => ({
  detector_id,
  lever: "lever",
  evidence: {
    session_ids,
    metrics: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }])),
  },
  tool_calls,
});

describe("U9 round 8, tool lane: C2", () => {
  const lookup = (over: Partial<CardToolCall>): CardToolCall =>
    call({ tool: "Read", kind: "file", result: "File does not exist.", ...over });
  const vals = { ERROR_COUNT: 5, SESSION_COUNT: 4 };

  it("a path in a worktree folder that is gone is its own cause, with a fix for it", () => {
    const calls = [
      lookup({ target: "~/r/.worktrees/old/docs/h1.md", cause: "WORKTREE_GONE", calls: 3 }),
      lookup({ target: "~/r/docs/x.md", cause: "GUESSED_PATH", calls: 1 }),
    ];
    const { summary, copy_text } = buildCardActions(rec("C2", vals, calls)).primary;
    expect(summary).toContain("in a worktree that no longer exists");
    expect(summary).not.toContain("in the wrong worktree");
    expect(copy_text).toContain("git check-ignore -v <path>");
    expect(copy_text).toContain("never name a `.worktrees/<slug>/` path");
    expect(copy_text).not.toContain("a file that a worktree made lives under");
    const problem = buildTrigger(rec("C2", vals, calls)).problem ?? "";
    expect(problem).toContain("no longer on disk");
  });

  it("a deliberate probe is its own bucket and never counted as guessed", () => {
    const calls = [
      lookup({ target: "~/r/a.md", cause: "GUESSED_PATH", calls: 2 }),
      lookup({
        tool: "Grep",
        kind: "search",
        target: "D8 in ~/r/.audits-none",
        cause: "GUESSED_PATH",
        calls: 1,
      }),
    ];
    const { copy_text } = buildCardActions(
      rec("C2", { ERROR_COUNT: 3, SESSION_COUNT: 1 }, calls),
    ).primary;
    expect(copy_text).toContain("2 guessed or moved, 1 deliberate probe");
    expect(copy_text).toContain("Deliberate probes (not mistakes):");
    expect(copy_text).not.toContain("3 guessed or moved");
  });
});

describe("U9 round 8, tool lane: C3", () => {
  const files = [call({ tool: "Edit", target: "~/r/F5.md", calls: 6, subagent_calls: 5 })];
  const vals = {
    ERROR_COUNT: 36,
    SESSION_COUNT: 9,
    SUBAGENT_ERROR_COUNT: 26,
    WRITE_ERROR_COUNT: 10,
  };

  it("keeps the CLAUDE.md rule minimal and puts files and sessions in a prompt", () => {
    const actions = buildCardActions(rec("C3", vals, files, ["s1", "s2"]));
    expect(actions.primary.copy_text.split("\n")).toHaveLength(3);
    expect(actions.primary.copy_text).not.toContain("F5.md");
    const prompt = actions.alternatives[0]?.copy_text ?? "";
    expect(prompt).toContain("`~/r/F5.md`: 6 times, 5 of them in subagents");
    expect(prompt).toContain("s1, s2");
    expect(prompt).toContain("26 in subagents");
  });

  it("the headline basis (main-thread turns) and the rule's scope agree in one line", () => {
    const detail = buildCardActions(rec("C3", vals, files)).primary.detail.join("\n");
    expect(detail).toContain("The rule covers both threads");
    expect(detail).toContain("prices the 10 main-thread failures only");
    expect(detail).toContain("the 26 in subagents are counted, not priced");
    expect(detail).not.toContain("stops the subagent failures only");
  });
});

describe("U9 round 8, tool lane: C1", () => {
  const vals = {
    TOOL_ERROR_COUNT: 4,
    TOOL_CALL_COUNT: 36,
    CORPUS_ERROR_RATE: 22 / 6824,
    CORPUS_CALL_COUNT: 6824,
    CORPUS_ERROR_COUNT: 22,
    OUTLIER_TOOLS: "mcp__claude-in-chrome__javascript_tool",
  };
  const read = [
    call({ tool: "mcp__claude-in-chrome__javascript_tool", result: "TypeError: null", calls: 3 }),
  ];

  it("shows one expected figure, in the fact and in the problem", () => {
    const trigger = buildTrigger(rec("C1", vals, read));
    expect(trigger.facts).toContainEqual({
      label: "Expected at the all-tool rate",
      value: "about 0.1",
    });
    expect(trigger.problem).toContain("about 0.1 of these 36 calls");
  });

  it("says 1 of the 4 failing calls is unreadable and what the 6,824 counts", () => {
    const problem = buildTrigger(rec("C1", vals, read)).problem ?? "";
    expect(problem).toContain("3 of the 4 failed calls could be read back; 1 could not");
    expect(problem).toContain(
      "Those 6,824 calls are the ones in finished sessions in the week; 22 of them failed.",
    );
  });
});
