import { describe, expect, it } from "vitest";
import {
  classifyDestructiveOp,
  isDisposablePath,
  shellSegments,
} from "../../src/ingest/destructive.js";

// Card review F6 (2026-10-04): 0 of 7 flagged runs were harmful. The command is parsed, not matched.
describe("classifyDestructiveOp — what counts as a run", () => {
  it.each([
    ["rm -rf dist", "rm-rf"],
    ["rm -fr build", "rm-rf"],
    ["rm -r -f out", "rm-rf"],
    ["rm -Rf out", "rm-rf"],
    ["rm --recursive --force out", "rm-rf"],
    ['rm -rf "$DIR"', "rm-rf"],
    ["rm -rf ~/projects/x", "rm-rf"],
    ["npm run build && rm -rf ../other", "rm-rf"],
    ["cd x; sudo rm -rf /var/lib/app", "rm-rf"],
    ["find . -name node_modules | xargs rm -rf", "rm-rf"],
    ["(cd sub && rm -rf gen)", "rm-rf"],
    ["bash -c 'rm -rf out'", "rm-rf"],
    ["rm -rf \\\n  out", "rm-rf"],
    ["git reset --hard HEAD~1", "git-reset-hard"],
    ["git -C repo reset --hard", "git-reset-hard"],
    ["git clean -fdx", "git-clean"],
    ['sqlite3 app.db "DROP TABLE users"', "sql-drop"],
  ])("%s → %s", (command, op) => {
    expect(classifyDestructiveOp(command)).toBe(op);
  });

  it.each([
    // A pattern inside a search or a quoted string is not a run.
    'grep -n "rm -rf\\|Null with no" src/query/api/tool-calls.ts',
    'grep -nE "rm -rf|git push" docs/plan.md | head -20',
    'git commit -m "stop rm -rf in scratch"',
    "echo 'rm -rf is dangerous'",
    'rg "DROP TABLE" src',
    // rm without both -r and -f.
    "rm -f notes.txt",
    "rm -r old",
    "rm file-rf.txt",
    "SP=/c/x; rm -f $SP/home/limits.json; for f in a b; do echo $f; done",
    // A dry run or a soft reset.
    "git clean -n",
    "git reset --soft HEAD~1",
    // A heredoc body and a comment are not commands.
    "cat > notes.md <<'EOF'\nrm -rf dist\nEOF",
    "ls # then rm -rf dist",
  ])("not a run: %s", (command) => {
    expect(classifyDestructiveOp(command)).toBeNull();
  });

  it.each([
    // Session scratchpads and Temp folders are disposable (the review's 4 scratch/Temp cleanups).
    "rm -rf C:/Users/dev/AppData/Local/Temp/claude/C--proj/0a1b/scratchpad/shots",
    'S="C:/Users/dev/AppData/Local/Temp/claude/C--proj/0a1b/scratchpad"; rm -rf "$S/fixture-scan"; mkdir -p "$S/fixture-scan"',
    "rm -rf /c/Users/dev/AppData/Local/Temp/aw-export-f2iIHl /c/Users/dev/AppData/Local/Temp/aw-export-iEZrPT",
    "rm -rf /tmp/build-cache",
    'rm -rf "$TMPDIR/x"',
    "rm -rf C:\\Users\\dev\\.claude\\jobs\\ab12\\tmp\\out",
  ])("scratch or Temp target is not a run: %s", (command) => {
    expect(classifyDestructiveOp(command)).toBeNull();
  });

  it("one risky target among scratch targets is still a run", () => {
    expect(classifyDestructiveOp("rm -rf /tmp/a src")).toBe("rm-rf");
  });
});

describe("isDisposablePath", () => {
  it.each([
    ["C:/Users/dev/AppData/Local/Temp/claude/p/s/scratchpad", true],
    ["/tmp/x", true],
    ["C:/Users/dev/AppData/Local/Temp", false],
    ["/tmp", false],
    ["/tmp/../home/dev", false],
    ["src", false],
    ["$HOME/x", false],
  ])("%s → %s", (path, disposable) => {
    expect(isDisposablePath(path)).toBe(disposable);
  });
});

describe("shellSegments", () => {
  it("splits on unquoted separators and keeps quoted text in one word", () => {
    expect(shellSegments(`a "b; c" && d 'e|f' | g`)).toEqual([["a", "b; c"], ["d", "e|f"], ["g"]]);
  });
});
