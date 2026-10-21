#!/usr/bin/env node

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// This CLI ships compiled to dist/cli/agentwrangler.js and spawns the compiled
// daemon at dist/daemon/index.js — no tsx at runtime. The prebuilt UI ships in
// dist/ui, so there is no build-UI-if-missing step (that only applied to the
// tsx clone path, which now builds dist via the package `prepare` script).
// Browser auto-open, --smoke, --no-open and the hook commands are all handled
// by the daemon itself.
const cliDir = path.dirname(fileURLToPath(import.meta.url));
const daemonPath = path.resolve(cliDir, "..", "daemon", "index.js");

if (process.argv[2] === "statusline") {
  // `agentwrangler statusline` runs on every Claude Code statusline refresh: handle it in this process
  // (no daemon spawn) and load only its own module. It never throws and always exits 0.
  import("./statusline.js")
    .then((m) => m.runStatuslineCli(process.argv.slice(3)))
    .catch(() => undefined);
} else if (process.argv[2] === "audit") {
  // `agentwrangler audit` runs in-process on a copy of the DB; it never starts or talks to the daemon.
  import("./audit/index.js")
    .then((m) => m.runAuditCli(process.argv.slice(3)))
    .then((code) => process.exit(code));
} else {
  const daemon = spawn(process.execPath, [daemonPath, ...process.argv.slice(2)], {
    stdio: "inherit",
  });

  // A null code means the daemon was terminated by a signal — surface that as a
  // non-zero exit so an abnormal end is visible to the calling shell / npx.
  daemon.on("exit", (code) => process.exit(code ?? 1));
}
