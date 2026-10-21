#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  assertU12CommittedArtifact,
  isU12GuardedPath,
} from "../../src/evidence/precision-artifact-guard.js";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const paths = execFileSync(
  "git",
  [
    "ls-files",
    "-z",
    "--",
    "artifacts/evidence/precision-corpus/",
    "test/fixtures/evidence/precision-corpus/",
    "artifacts/evidence/precision-gate/",
    "test/fixtures/evidence/precision-gate/",
  ],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter((path) => path.length > 0);

const guardedPaths = paths.filter(isU12GuardedPath);
for (const path of guardedPaths) {
  const content = execFileSync("git", ["show", `HEAD:${path}`], { cwd: root, encoding: "utf8" });
  assertU12CommittedArtifact(path, content);
}

console.log(`U12 fixture privacy gate: ${guardedPaths.length} committed file(s) checked`);
