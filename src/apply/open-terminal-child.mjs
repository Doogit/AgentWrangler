// O11 Option-B terminal wrapper (spec-apply-console.md §5 Q4).
//
// The daemon launches the user's terminal to run:  node <this> <promptFile> <cwd>
// Only file PATHS ride the terminal's command line. This wrapper reads the
// prompt from the file and execs claude with the prompt as a single ARGV
// element, so prompt content never touches any shell/command-line parser.
//
// Runs inside the user's own terminal: claude inherits its TTY (stdio:inherit),
// so the session is fully interactive — native permissions, plan mode, diff
// review. The daemon does not run the edit; this hands off to the user.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

const promptFile = process.argv[2];
const cwd = process.argv[3];

// This wrapper is the only process in a freshly spawned terminal window: when it
// exits, the window closes. On any failure, hold the window open (only when a
// human is actually watching — a TTY) so the error is readable instead of a
// flash-close.
function holdOpenIfInteractive() {
  if (!process.stdout.isTTY) return;
  if (process.platform === "win32") {
    spawnSync("cmd", ["/c", "pause"], { stdio: "inherit" });
  } else {
    console.error("Press Enter to close…");
    spawnSync("sh", ["-c", "read -r _"], { stdio: "inherit" });
  }
}

function fail(message) {
  console.error(message);
  holdOpenIfInteractive();
  process.exit(1);
}

let prompt = "";
try {
  prompt = readFileSync(promptFile, "utf8");
} catch (e) {
  fail(`Could not read the seeded prompt (${String(e)}). Use Copy prompt instead.`);
}
// Transient by construction (SEC-101): remove the prompt file once read.
try {
  unlinkSync(promptFile);
} catch {
  // best-effort
}

// Resolve a REAL claude executable (never a .cmd/.bat shim: Node requires
// shell:true to spawn those, and a shell would re-parse the prompt argv). On
// this machine the native installer provides claude.exe; npm-only installs that
// have only claude.cmd fall through to the friendly Copy-prompt message.
function resolveClaude() {
  const isWin = process.platform === "win32";
  const names = isWin ? ["claude.exe", "claude"] : ["claude"];
  const binaryExts = isWin ? [".exe", ".com"] : [""];
  const dirs = (process.env.PATH ?? process.env.Path ?? "")
    .split(delimiter)
    .filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        const ext = extname(candidate).toLowerCase();
        // On Windows only .exe/.com are directly spawnable: this skips .cmd/.ps1
        // shims AND extensionless sh shims (npm installs put an extensionless
        // `claude` script on PATH that spawnSync cannot exec — PUB-6 flash-close).
        if (isWin && !binaryExts.includes(ext)) continue;
        return candidate;
      }
      if (isWin && extname(name) === "") {
        for (const ext of binaryExts) {
          const withExt = join(dir, name + ext);
          if (existsSync(withExt)) return withExt;
        }
      }
    }
  }
  return null;
}

const claude = resolveClaude();
if (claude === null) {
  fail(
    "Could not find a claude executable (.exe) on PATH. Open a terminal here and run `claude` yourself, or use Copy prompt.",
  );
}

const spawnCwd = typeof cwd === "string" && isAbsolute(cwd) ? cwd : process.cwd();
// Positional prompt = seed + auto-submit as the first interactive turn.
const result = spawnSync(claude, [prompt], { cwd: spawnCwd, stdio: "inherit" });
if (result.error !== undefined) {
  fail(`Failed to start claude (${claude}): ${String(result.error)}. Use Copy prompt instead.`);
}
process.exit(result.status ?? 0);
