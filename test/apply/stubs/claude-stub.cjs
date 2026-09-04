const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const mode = process.env.AGENTWRANGLER_STUB_MODE || "success";
const fileRef = process.env.AGENTWRANGLER_FILE_REF;
const permissionMode = args[args.indexOf("--permission-mode") + 1];
const settingsPath = args[args.indexOf("--settings") + 1];

if (settingsPath) {
  JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
}

function emit(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

if (mode === "sleep") {
  setInterval(() => {}, 1000);
} else if (mode === "big-output") {
  process.stdout.write("x".repeat(1024 * 1024));
  process.stdout.write("x".repeat(1024 * 1024));
  process.stdout.write("x".repeat(1024 * 1024));
} else if (permissionMode === "plan") {
  emit({ type: "system", subtype: "init" });
  emit({
    type: "result",
    subtype: "success",
    result: "Dry run: would trim CLAUDE.md\n--- a/.claude/CLAUDE.md\n+++ b/.claude/CLAUDE.md",
  });
} else {
  if (!fileRef) {
    emit({ type: "result", subtype: "error", result: "missing file ref" });
    process.exit(1);
  }

  fs.writeFileSync(fileRef, "trimmed\n", "utf-8");
  const reportedPath =
    mode === "out-of-scope" ? path.join(path.dirname(fileRef), "..", "outside.md") : fileRef;
  emit({ type: "tool_use", id: "tu1", name: "Edit", input: { file_path: reportedPath } });
  emit({ type: "tool_result", tool_use_id: "tu1", content: "ok" });
  emit({
    type: "result",
    subtype: "success",
    result: "Applied trim to CLAUDE.md\n--- a/.claude/CLAUDE.md\n+++ b/.claude/CLAUDE.md",
  });
}
