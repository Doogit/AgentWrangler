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

const daemon = spawn(process.execPath, [daemonPath, ...process.argv.slice(2)], {
  stdio: "inherit",
});

// A null code means the daemon was terminated by a signal — surface that as a
// non-zero exit so an abnormal end is visible to the calling shell / npx.
daemon.on("exit", (code) => process.exit(code ?? 1));
