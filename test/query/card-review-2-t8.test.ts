/**
 * P3.1-T8: review-2 detector findings that also change the card, one block per finding id
 * (register `docs/handoffs/2026-09-26-card-review/review-2-findings.md`).
 */
import { describe, expect, it } from "vitest";
import { NO_WHY, cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import {
  buildCardActions,
  buildTrigger,
  cardTitle,
} from "../../src/query/api/rec-actions/index.js";
import {
  belowFloor,
  guardVersions,
  openFalsePositives,
} from "../../src/query/api/rec-actions/trigger.js";
import type {
  CardActionRecommendation,
  CardToolCall,
  GuardShape,
} from "../../src/query/api/rec-actions/types.js";
import { validateAction } from "../../src/query/api/rec-actions/validate.js";
import {
  type RepoProbe,
  guardShape,
  notFoundCause,
  rmRisk,
} from "../../src/query/api/tool-calls.js";

const fs = { existsSync: () => true, statSync: () => ({ isFile: () => true }) };

function card(rec: CardActionRecommendation) {
  const trigger = buildTrigger(rec);
  const actions = buildCardActions(rec);
  return { trigger, actions, violations: cardRuleViolations(actions, trigger, cardTitle(rec)) };
}

describe("C2c + C2d: a file on another branch, or the right name in the wrong folder", () => {
  const repo = "c:/users/me/r";
  const probe = (existing: string[], tracked: string[]): RepoProbe => ({
    exists: (file) => existing.includes(file),
    checkouts: () => [repo, `${repo}/.worktrees/feat`],
    trackedFiles: () => tracked,
  });
  const missing = (file: string, cwd: string) => ({
    target: file,
    path: file,
    result: `File does not exist. Note: your current working directory is ${cwd}.`,
  });

  it("U9 r4: a main-checkout path that exists nowhere is a guess, not the wrong worktree", () => {
    const cwd = `${repo}/.worktrees/feat`;
    // Why: the model named a directory (`.audits-none`) that was never in any checkout.
    const never = missing(`${repo}/.audits-none`, cwd);
    expect(notFoundCause(never as never, "s1", probe([repo], []))).toBe("GUESSED_PATH");
    // A real main-checkout file read from a worktree is still the wrong worktree.
    const real = missing(`${repo}/docs/plan.md`, cwd);
    expect(notFoundCause(real as never, "s1", probe([repo, `${repo}/docs/plan.md`], []))).toBe(
      "WRONG_WORKTREE",
    );
    // U9 r8: a path that names a (since removed) worktree is its own cause.
    const gone = missing(`${repo}/.worktrees/old/docs/plan.md`, cwd);
    expect(notFoundCause(gone as never, "s1", probe([repo], []))).toBe("WORKTREE_GONE");
  });

  it("names a file present in another checkout as on another branch", () => {
    const call = missing(`${repo}/.worktrees/feat/src/ui/Table.tsx`, `${repo}/.worktrees/feat`);
    expect(notFoundCause(call as never, "s1", probe([`${repo}/src/ui/table.tsx`], []))).toBe(
      "NOT_ON_BRANCH",
    );
  });

  it("names a tracked file with the same name elsewhere as the wrong folder", () => {
    const call = missing(`${repo}/src/detector/d8_churn.ts`, repo);
    expect(
      notFoundCause(call as never, "s1", probe([repo], ["src/detector/detectors/d8_churn.ts"])),
    ).toBe("WRONG_FOLDER");
  });

  it("keeps a name found nowhere, or shared by several files, as a guess", () => {
    const call = missing(`${repo}/src/spend.ts`, repo);
    expect(notFoundCause(call as never, "s1", probe([repo], ["src/other.ts"]))).toBe(
      "GUESSED_PATH",
    );
    const shared = missing(`${repo}/src/ui/api/types.ts`, repo);
    expect(
      notFoundCause(shared as never, "s1", probe([repo], ["src/a/types.ts", "src/b/types.ts"])),
    ).toBe("GUESSED_PATH");
  });

  it("the wrong-folder card proposes a repo map", () => {
    const { actions, violations } = card({
      detector_id: "C2",
      lever: "x",
      evidence: {
        session_ids: ["s1", "s2", "s3"],
        metrics: { ERROR_COUNT: { value: 3 }, SESSION_COUNT: { value: 3 } },
      },
      tool_calls: [
        {
          target: "~/r/src/detector/d8_churn.ts",
          kind: "file",
          tool: "Read",
          calls: 3,
          session_ids: ["s1"],
          session_count: 3,
          total_bytes: 0,
          max_bytes: 0,
          whole_file: true,
          cause: "WRONG_FOLDER",
        },
      ],
    });
    expect(actions.primary.copy_text).toMatch(/repo map/);
    // Review 5: C2 has no "Why this matters" text yet (deferred item 11).
    expect(violations).toEqual([NO_WHY]);
  });
});

describe("D11c: offer to remove the PowerShell tool", () => {
  const d11 = (higher: string, preferred: string): CardActionRecommendation => ({
    detector_id: "D11",
    lever: "Route repository and file operations to the lower-error shell.",
    facts: {
      session_ids: ["s1", "s2"],
      preferred_tool: preferred,
      higher_error_tool: higher,
      powershell_error_count: 41,
      powershell_call_count: 970,
      powershell_error_ratio: 0.042,
      bash_error_count: 203,
      bash_call_count: 9585,
      bash_error_ratio: 0.021,
    },
  });

  it("adds a deny-PowerShell settings alternative that validates", () => {
    const { actions, violations } = card(d11("PowerShell", "Bash"));
    const deny = actions.alternatives.find((action) => action.kind === "CONFIG");
    expect(deny?.copy_text).toContain('"deny": ["PowerShell"]');
    // Review 5 OC2 default: the user's own settings, not the committed file.
    expect(deny?.file_ref).toBe(".claude/settings.local.json");
    expect(violations).toEqual([]);
    if (deny === undefined) throw new Error("expected the deny alternative");
    expect(
      validateAction({ ...deny, target_metric: "shell_error_rate" }, "shell_error_rate", [], {
        fs,
        baseDir: "/r",
      }),
    ).toMatchObject({ ok: true });
  });

  it("never offers to deny Bash", () => {
    expect(card(d11("Bash", "PowerShell")).actions.alternatives).toEqual([]);
  });

  it("says test, lint, typecheck and build failures are left out", () => {
    expect(card(d11("PowerShell", "Bash")).actions.primary.copy_text).toMatch(
      /test, lint, typecheck or build/,
    );
  });
});

describe("H1a: rate rm -rf risk by what it deletes, not by how often", () => {
  it("rates a relative path inside the project as low risk", () => {
    expect(rmRisk("rm -rf .claude/audits/certification/D14")).toBe("LOW");
    expect(rmRisk("npm test; rm -rf dist build && echo done")).toBe("LOW");
    expect(rmRisk("rm -rf node_modules/.cache 2>/dev/null")).toBe("LOW");
  });

  it("rates a variable, absolute, home, parent or whole-folder path as risky", () => {
    for (const command of [
      'rm -rf "$OUT"',
      'rm -rf "$(node -p 1)/x"',
      "rm -rf /c/work/repo",
      "rm -rf D:\\work\\repo",
      "rm -rf ~/work",
      "rm -rf ../other",
      "rm -rf .",
      "rm -rf *",
      "find . -name x | xargs rm -rf",
      // Card review F6 made `$TMP/…` a Temp folder (safe), so the unset variable here is `$BUILD`.
      "rm -rf dist; rm -rf $BUILD/x",
    ]) {
      expect(rmRisk(command), command).toBe("RISKY");
    }
  });

  it("ignores commands with no rm -rf", () => {
    expect(rmRisk("git status")).toBeNull();
    expect(rmRisk("rm file.txt")).toBeNull();
  });

  const call = (target: string, risk: "LOW" | "RISKY", calls = 1): CardToolCall => ({
    target,
    kind: "command",
    tool: "Bash",
    calls,
    session_ids: ["s1"],
    session_count: 1,
    total_bytes: 0,
    max_bytes: 0,
    whole_file: false,
    result: "",
    risk,
  });
  const h1 = (runs: number, calls: CardToolCall[]): CardActionRecommendation => ({
    detector_id: "H1",
    lever: "Add a confirmation guard (permissions.ask) for this destructive command class.",
    evidence: {
      session_ids: ["s1", "s2"],
      metrics: {
        DESTRUCTIVE_OPERATION: { kind: "ENUM", value: "RM_RF" },
        OPERATION_COUNT: { kind: "COUNT", value: runs },
      },
    },
    tool_calls: calls,
  });

  it("hides the card only when every run was read back and all are low risk", () => {
    const low = [call("rm -rf .claude/audits/certification/D4", "LOW", 3)];
    expect(belowFloor(h1(3, low))).toBe(true);
    expect(belowFloor(h1(4, low))).toBe(false);
    expect(belowFloor(h1(4, [...low, call('rm -rf "$OUT"', "RISKY")]))).toBe(false);
  });

  it("leads with a risky run and says how many runs were risky", () => {
    const { trigger, violations } = card(
      h1(4, [call("rm -rf dist", "LOW", 3), call('rm -rf "$OUT"', "RISKY")]),
    );
    expect(trigger.problem).toContain('`rm -rf "$OUT"`');
    expect(trigger.problem).toMatch(/1 of the 4 runs/);
    expect(trigger.facts).toContainEqual({ label: "Risky runs", value: "1 of 4" });
    expect(trigger.calls?.[0]?.risk).toBe("RISKY");
    // Review 5: H1 has no "Why this matters" text yet (deferred item 11).
    expect(violations).toEqual([NO_WHY]);
  });
});

describe("C9g2 + C9g3: classify guard blocks by shape and guard version", () => {
  it("names the shape a guard exists to stop before any false positive", () => {
    const shapes: Array<[string, GuardShape]> = [
      ["cd .worktrees/x && npm test", "CD_PREFIX"],
      ["git worktree add -b b .worktrees/b main && cd .worktrees/b && git status", "CD_PREFIX"],
      ["sed -i 's/a/b/' src/x.ts", "IN_PLACE_EDIT"],
      ["perl -pi -e 's/a/b/' x", "IN_PLACE_EDIT"],
      ["python -c \"open('x','w').write('y')\"", "IN_PLACE_EDIT"],
      ["cat >> test/x.test.ts <<'EOF'\nit('x')\nEOF", "HEREDOC_FILE"],
      ["echo hi > /tmp/x.txt", "TMP_WRITE"],
      ["git reset --hard HEAD~1", "DESTRUCTIVE_GIT"],
      ['curl -s $(python -c "import sqlite3;print(1)")', "PYTHON_READ"],
      ["git add -A && git commit -q -F - <<'EOF'\nfix: x\nEOF", "HEREDOC_STDIN"],
      ["python - <<'EOF'\nprint(open('a.md').read())\nEOF", "HEREDOC_STDIN"],
      ["git stash list", "GIT_STASH_READ"],
      ["npm run build", "OTHER"],
    ];
    for (const [command, shape] of shapes) expect(guardShape(command), command).toBe(shape);
  });

  const NOW =
    "Blocked command shape: cd&&-prefix / in-place edits (sed -i, python -c) / tmp writes";
  const OLD =
    "Blocked command shape: cd&&-prefix / in-place edits (sed -i, python -c) / heredoc edits";
  const block = (target: string, message: string, guard_shape: GuardShape): CardToolCall => ({
    target,
    kind: "command",
    tool: "Bash",
    calls: 1,
    session_ids: ["s1"],
    session_count: 1,
    total_bytes: 0,
    max_bytes: 0,
    whole_file: false,
    result: message,
    guard_shape,
  });
  const c9 = (calls: CardToolCall[]): CardActionRecommendation => ({
    detector_id: "C9",
    lever: "Review recurring blocked tool requests before repeating the same command shape.",
    evidence: {
      session_ids: ["s1", "s2"],
      metrics: {
        DENIAL_CLASS: { kind: "ENUM", value: "HOOK_BLOCK" },
        DENIAL_COUNT: { kind: "COUNT", value: calls.length },
      },
    },
    tool_calls: calls,
  });
  const correct = [
    block("cd a && b", NOW, "CD_PREFIX"),
    block("cd c && d", NOW, "CD_PREFIX"),
    block("sed -i s/a/b/ x", NOW, "IN_PLACE_EDIT"),
  ];
  // U9 r7: `git commit -F - <<'EOF'` is a correct block now, so the old-version false positive that
  // names the heredoc rule is a quoted `<<` (a grep pattern).
  const oldHeredoc = [
    block('grep -n "<<<<<<<" x', OLD, "QUOTED_HEREDOC"),
    block('grep -n "<<<<<<<" y', OLD, "QUOTED_HEREDOC"),
  ];

  it("says the guard works for correct blocks and names the current false positives", () => {
    const { trigger, actions, violations } = card(
      c9([...correct, block('python -c "print(1)"', NOW, "PYTHON_READ"), ...oldHeredoc]),
    );
    // Review 5 M6/M7: the split is stated once, flat (no shape names, zero parts left out).
    expect(trigger.problem).toContain(
      "Your guard blocked 6 calls: 1 harmless, 3 as intended, 2 from an earlier guard version.",
    );
    expect(trigger.facts).toContainEqual({ label: "Calls your guard blocked", value: "6" });
    expect(trigger.facts).toContainEqual({ label: "Harmless blocks to fix", value: "1" });
    expect(trigger.facts).toContainEqual({ label: "Blocked as intended", value: "3" });
    expect(trigger.calls?.[0]?.guard_shape).toBe("PYTHON_READ");
    expect(actions.primary.summary).toMatch(/python -c/);
    expect(actions.primary.copy_text).toMatch(/`python -c` that only reads: 1/);
    expect(actions.primary.copy_text).not.toContain("sed -i s/a/b/ x");
    expect(violations).toEqual([]);
  });

  it("hides the card when no false positive is left to fix", () => {
    const python = block('python -c "print(1)"', NOW, "PYTHON_READ");
    expect(belowFloor(c9([...correct, ...oldHeredoc]))).toBe(true);
    // Three open false positives in a week meet the floor (operator 2026-09-26, review 4).
    const pythons = [python, { ...python, target: "python -c 2" }, { ...python, target: "x 3" }];
    expect(belowFloor(c9([...correct, ...pythons, block("cd e && f", NOW, "CD_PREFIX")]))).toBe(
      false,
    );
    // An old false positive stays open while the current message still names its rule.
    const namesHeredoc = `${NOW} / heredoc edits`;
    const current = [block("cd a && b", namesHeredoc, "CD_PREFIX"), ...correct.slice(1)];
    expect(
      belowFloor(
        c9([...current, ...oldHeredoc, { ...oldHeredoc[0], target: "y" } as CardToolCall]),
      ),
    ).toBe(false);
  });

  const PS_NOW = "Blocked PowerShell shape: inline node -e";
  const psBlock = (target: string): CardToolCall => ({
    ...block(target, PS_NOW, "OTHER"),
    tool: "PowerShell",
  });

  it("review 4 C9: tracks each guard's current message on its own", () => {
    // Newest first: the PowerShell guard's block is newest, the Bash blocks all use Bash's current message.
    const calls = [
      psBlock("node -e 1"),
      ...correct,
      block('python -c "print(1)"', NOW, "PYTHON_READ"),
    ];
    const versions = guardVersions(calls);
    expect(versions.filter((version) => version.current).map((version) => version.tool)).toEqual([
      "Bash",
      "PowerShell",
    ]);
    expect(openFalsePositives(versions)).toEqual([["PYTHON_READ", 1]]);
    const { trigger } = card(c9(calls));
    expect(trigger.problem).not.toMatch(/earlier version/);
    expect(trigger.problem).not.toMatch(/does not know/);
  });

  it("review 4 C9: hides below three current false positives a week", () => {
    const python = (i: number) => block(`python -c "print(${i})"`, NOW, "PYTHON_READ");
    const twoWeeks = { from: "2026-01-01T00:00:00.000Z", to: "2026-01-15T00:00:00.000Z" };
    const withFps = (n: number) => ({
      ...c9([...correct, ...Array.from({ length: n }, (_, i) => python(i))]),
      window: twoWeeks,
    });
    expect(belowFloor(withFps(5))).toBe(true);
    expect(belowFloor(withFps(6))).toBe(false);
  });
});

describe("Floors: a card needs enough behind it to be worth showing", () => {
  const rec = (detector_id: string, metrics: Record<string, unknown> = {}) => ({
    detector_id,
    lever: "x",
    evidence: { metrics },
  });

  it("hides a C9 group with fewer than five denials", () => {
    const denials = (value: number) => ({
      DENIAL_CLASS: { kind: "ENUM", value: "USER_REJECTED" },
      DENIAL_COUNT: { kind: "COUNT", value },
    });
    expect(belowFloor(rec("C9", denials(4)))).toBe(true);
    expect(belowFloor(rec("C9", denials(5)))).toBe(false);
  });

  // U7: the C2 session-count floor hid the typical one-miss-per-session pattern; the detector now
  // applies a 0.1%-of-spend floor instead (c2-content-not-found.test.ts), so the card gate is gone.
  it("does not gate C2 on session counts", () => {
    expect(belowFloor(rec("C2"))).toBe(false);
  });
});
