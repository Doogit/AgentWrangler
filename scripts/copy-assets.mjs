/**
 * scripts/copy-assets.mjs — copy non-TS runtime assets into dist/.
 *
 * `tsc` only emits .js from .ts sources; it does not copy the runtime assets the
 * daemon reads/spawns relative to its own module dir (import.meta.url):
 *   - src/db/migrations/*.sql   (migration runner reads these at boot)
 *   - src/hook/*.mjs + *.json    (installed hooks; danger-guard denylist)
 *   - src/apply/*.mjs            (open-terminal child wrapper)
 *
 * This mirrors every non-TS file under src/ (excluding src/ui, which vite owns,
 * and TS declaration files) into dist/ preserving its relative path, so the
 * compiled dist/<module>/asset sits beside its dist/<module>/*.js consumer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(repoRoot, "src");
const distRoot = path.join(repoRoot, "dist");

/** True for source files tsc handles or that have no runtime role. */
function isCompiledOrIgnorable(name) {
  return (
    name.endsWith(".ts") ||
    name.endsWith(".tsx") ||
    name.endsWith(".d.mts") ||
    name === ".gitkeep"
  );
}

let copied = 0;
for (const entry of fs.readdirSync(srcRoot, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const abs = path.join(entry.parentPath ?? entry.path, entry.name);
  const rel = path.relative(srcRoot, abs);
  // vite owns src/ui → dist/ui; skip it here.
  if (rel === "ui" || rel.startsWith(`ui${path.sep}`)) continue;
  if (isCompiledOrIgnorable(entry.name)) continue;

  const dest = path.join(distRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(abs, dest);
  copied++;
}

console.log(`copy-assets: copied ${copied} runtime asset(s) into dist/`);
