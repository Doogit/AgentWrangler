/** Pack the built checkout and exercise its exact tarball through npm exec (npx).
 * Uses a fresh profile/cache and --smoke: no collectors, credentials, hooks or server.
 * Run npm run build first. Never publishes. Requires registry access for runtime deps.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aw-package-smoke-"));
const env = {};
for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "LANG"]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
Object.assign(env, {
  HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
  XDG_CONFIG_HOME: root, TMP: root, TEMP: root, TMPDIR: root,
  npm_config_cache: path.join(root, "cache"),
  npm_config_userconfig: path.join(root, "npmrc"),
  npm_config_globalconfig: path.join(root, "global-npmrc"),
  npm_config_registry: "https://registry.npmjs.org/",
  npm_config_audit: "false", npm_config_fund: "false",
  AW_NO_OPEN: "1", AW_DB_PATH: path.join(root, "smoke.sqlite"),
  AW_SCAN_ROOT: path.join(root, "empty-scan"), AW_PORT: "0",
});
await fs.mkdir(env.AW_SCAN_ROOT);
await fs.writeFile(env.npm_config_userconfig, "");
await fs.writeFile(env.npm_config_globalconfig, "");

function npm(args, cwd) {
  const win = process.platform === "win32";
  const command = win ? process.execPath : "npm";
  const argv = win
    ? [path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), ...args]
    : args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => { stdout += b; });
    child.stderr.on("data", (b) => { stderr += b; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`npm ${args[0]} exited ${code}: ${stderr.slice(-3000)}${stdout.slice(-1000)}`));
    });
  });
}

try {
  await fs.access(path.join(repo, "dist/ui/index.html"));
  // Older npm versions still run prepare despite ignore-scripts. Keep lifecycle
  // output captured so stdout remains the pack JSON on every supported runner.
  const [pack] = JSON.parse(await npm(["pack", "--ignore-scripts", "--foreground-scripts=false", "--json", "--pack-destination", root], repo));
  const files = new Set(pack.files.map((file) => file.path));
  for (const required of ["dist/cli/agentwrangler.js", "dist/daemon/index.js", "dist/ui/index.html", "README.md", "LICENSE"]) {
    assert(files.has(required), `tarball missing ${required}`);
  }
  assert([...files].some((file) => file.startsWith("dist/db/migrations/")), "migrations missing");
  assert([...files].some((file) => file.startsWith("dist/ui/assets/") && file.endsWith(".js")), "UI chunks missing");
  assert([...files].every((file) => file === "package.json" || file === "README.md" || file === "LICENSE" || file.startsWith("dist/")), "unexpected package content");
  const tarball = path.join(root, pack.filename);
  assert(path.dirname(tarball) === root, "pack filename escaped temporary root");
  const sha256 = createHash("sha256").update(await fs.readFile(tarball)).digest("hex");
  const output = await npm(["exec", "--yes", "--package", tarball, "--", "agentwrangler", "--smoke", "--no-open"], root);
  const tables = /smoke: (\d+)\/(\d+) v2 tables present .* OK/.exec(output);
  assert(tables && Number(tables[1]) > 0 && tables[1] === tables[2], "daemon did not verify every required table");
  await fs.access(env.AW_DB_PATH);
  console.log(JSON.stringify({
    platform: process.platform, node: process.version, package: pack.name, version: pack.version,
    sha256, packagedFiles: files.size, invocation: "npm exec --package <exact-local-tarball> -- agentwrangler --smoke --no-open",
    smoke: `${tables[1]}/${tables[2]} tables`, profile: "fresh home, npm config, cache and database",
    limits: "schema/CLI/package-content smoke only; no HTTP, native UI, credentials or collectors",
  }, null, 2));
} finally {
  // Only remove this exact mkdtemp directory after every npm child has exited.
  const resolved = path.resolve(root);
  assert(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith("aw-package-smoke-"));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
