import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// PUB-6 regression coverage for src/apply/open-terminal-child.mjs — the wrapper
// that runs alone inside a freshly spawned terminal window. It is exercised as a
// real subprocess (piped stdio → isTTY false → the hold-open pause is skipped,
// so failures exit instead of hanging the suite).

const WRAPPER = path.resolve("src/apply/open-terminal-child.mjs");

let tmpRoot: string;

function runWrapper(env: NodeJS.ProcessEnv, promptFile: string, cwd: string) {
  return spawnSync(process.execPath, [WRAPPER, promptFile, cwd], {
    env: { ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
}

function writePrompt(): string {
  const p = path.join(tmpRoot, "prompt.txt");
  fs.writeFileSync(p, "seeded prompt", "utf8");
  return p;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-child-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("open-terminal-child wrapper", () => {
  it("exits 1 with a readable error when the prompt file is missing", () => {
    const res = runWrapper({ PATH: tmpRoot }, path.join(tmpRoot, "nope.txt"), tmpRoot);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Could not read the seeded prompt/);
  });

  it("exits 1 with a readable error when no claude executable is on PATH", () => {
    const emptyDir = path.join(tmpRoot, "empty");
    fs.mkdirSync(emptyDir);
    const res = runWrapper({ PATH: emptyDir }, writePrompt(), tmpRoot);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Could not find a claude executable/);
  });

  it.runIf(process.platform === "win32")(
    "PUB-6: skips an extensionless npm sh-shim and resolves the .exe later on PATH",
    () => {
      // Dir A (earlier on PATH): an extensionless sh shim named `claude` — the
      // exact shape npm puts in %APPDATA%\npm. Dir B (later): a dummy claude.exe.
      // Pre-fix the resolver returned the shim; post-fix it must reach the .exe
      // (observable via the failure message naming the resolved path, since the
      // dummy .exe is not a real binary).
      const dirA = path.join(tmpRoot, "npm-shims");
      const dirB = path.join(tmpRoot, "real-bin");
      fs.mkdirSync(dirA);
      fs.mkdirSync(dirB);
      fs.writeFileSync(path.join(dirA, "claude"), '#!/bin/sh\nexec node "$@"\n', "utf8");
      const exePath = path.join(dirB, "claude.exe");
      fs.writeFileSync(exePath, "not a real PE", "utf8");
      const res = runWrapper({ PATH: `${dirA};${dirB}` }, writePrompt(), tmpRoot);
      // Resolution picked the .exe (named in the spawn-failure message), never
      // the shim — and the failure is a visible non-zero exit, not a silent 0.
      expect(res.stderr).toContain(exePath);
      expect(res.stderr).toMatch(/Failed to start claude/);
      expect(res.status).toBe(1);
    },
  );

  it.runIf(process.platform === "win32")(
    "PUB-6: a shim-only PATH (no .exe anywhere) fails visibly instead of exiting 0",
    () => {
      const dirA = path.join(tmpRoot, "npm-shims");
      fs.mkdirSync(dirA);
      fs.writeFileSync(path.join(dirA, "claude"), "#!/bin/sh\n", "utf8");
      fs.writeFileSync(path.join(dirA, "claude.cmd"), "@echo off\r\n", "utf8");
      fs.writeFileSync(path.join(dirA, "claude.ps1"), "", "utf8");
      const res = runWrapper({ PATH: dirA }, writePrompt(), tmpRoot);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/Could not find a claude executable/);
    },
  );
});
