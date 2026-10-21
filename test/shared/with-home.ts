import * as os from "node:os";
import * as path from "node:path";

/**
 * Run `run` with os.homedir() pointing at an empty temp folder, so a card that looks at the
 * user's own ~/.claude (skills, CLAUDE.md) gives the same answer on every machine.
 */
export function withEmptyHome<T>(run: () => T): T {
  const home = path.join(os.tmpdir(), "aw-test-empty-home");
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
