import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanDirectory } from "../../scripts/hooks/content-signatures.mjs";

// A planted "real transcript" line: transcript-shaped AND long (a captured turn).
const PLANTED = `${JSON.stringify({
  type: "assistant",
  sessionId: "real-session",
  message: {
    role: "assistant",
    usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 },
    content: [{ type: "text", text: `secret analysis ${"x".repeat(1200)}` }],
  },
})}\n`;

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const hooksSrc = path.join(repoRoot, "scripts", "hooks");

describe("SEC-101 pre-commit content gate blocks planted transcript content", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sec101-gate-"));
    execFileSync("git", ["init", "-q"], { cwd: tmp });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmp });
    execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
    // Copy the shipped hook scripts into the temp repo so the scanner runs as it would.
    fs.mkdirSync(path.join(tmp, "scripts", "hooks"), { recursive: true });
    for (const f of ["content-signatures.mjs", "leak-signatures.mjs", "precommit-scan.mjs"]) {
      fs.copyFileSync(path.join(hooksSrc, f), path.join(tmp, "scripts", "hooks", f));
    }
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const runScan = () =>
    spawnSync("node", [path.join(tmp, "scripts", "hooks", "precommit-scan.mjs")], {
      cwd: tmp,
      encoding: "utf8",
    });

  const stageScanUnstage = (rel: string, body: string) => {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    execFileSync("git", ["add", rel], { cwd: tmp });
    const r = runScan();
    execFileSync("git", ["rm", "-q", "--cached", rel], { cwd: tmp });
    fs.rmSync(abs);
    return r;
  };

  it("BLOCKS a staged file containing a long real transcript line", () => {
    const r = stageScanUnstage("leaked.jsonl", PLANTED);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/transcript-shaped JSON content line/);
  });

  it("BLOCKS a SHORT real transcript line outside a carve-out path", () => {
    const short = `${JSON.stringify({ role: "user", content: "fix my auth bug in x.ts" })}\n`;
    const r = stageScanUnstage("src/leaked.log", short);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/transcript-shaped JSON content line/);
  });

  it("PASSES a small synthetic transcript fixture under test/fixtures/", () => {
    const synthetic = `${JSON.stringify({
      type: "assistant",
      sessionId: "session-a",
      message: { role: "assistant", usage: { input_tokens: 1000 }, content: [] },
    })}\n`;
    const r = stageScanUnstage("test/fixtures/ingest/session-x.jsonl", synthetic);
    expect(r.status).toBe(0);
  });
});

// The export gate (scripts/launch/export.mjs rawContentGate) calls scanDirectory over the
// staged export set and die()s on any hit. Exercise that exact traversal here.
describe("SEC-101 export content gate (scanDirectory) blocks planted content", () => {
  let out: string;

  beforeAll(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), "sec101-out-"));
    fs.mkdirSync(path.join(out, "docs"), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(out, { recursive: true, force: true });
  });

  it("returns no hits for a clean export tree", () => {
    fs.writeFileSync(path.join(out, "README.md"), "# Project\n\nOrdinary docs.\n");
    fs.writeFileSync(path.join(out, "docs", "guide.md"), "Some guidance text.\n");
    expect(scanDirectory(out)).toEqual([]);
  });

  it("flags a planted transcript file in the export tree", () => {
    fs.writeFileSync(path.join(out, "leaked.txt"), PLANTED);
    const hits = scanDirectory(out);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.file === "leaked.txt")).toBe(true);
  });
});
