// Points git at the tracked hooks dir. Run by `npm run prepare`; a no-op outside
// a git checkout (e.g. a registry tarball install) so it never breaks consumers.
import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", "scripts/hooks"]);
  console.log("hooks: core.hooksPath -> scripts/hooks");
} catch {
  // Not a git checkout — nothing to install.
}
