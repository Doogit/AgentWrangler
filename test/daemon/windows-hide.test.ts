import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// The daemon and its restart script run detached with no console. On Windows, a child started
// without `windowsHide` then gets a new console, which Windows Terminal (as default terminal)
// opens as a window that stays after the child exits. Every child_process call must hide it.
const ROOT = path.resolve(__dirname, "../..");
const SCAN = ["src", "scripts/daemon"];
// Run inside a terminal the user sees, by design.
const EXEMPT = new Set(["src/cli/agentwrangler.ts", "src/apply/open-terminal-child.mjs"]);
const CALL = /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|exec)\(/g;

function files(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return files(rel);
    return /\.(ts|tsx|mjs)$/.test(e.name) ? [rel] : [];
  });
}

function callArgs(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

describe("child processes hide their console window", () => {
  it("every child_process call passes windowsHide", () => {
    const missing: string[] = [];
    for (const file of SCAN.flatMap(files)) {
      if (EXEMPT.has(file)) continue;
      const text = readFileSync(path.join(ROOT, file), "utf8");
      if (!text.includes("child_process")) continue;
      // Options objects declared once and passed by name, e.g. `const opts = { windowsHide: true }`.
      const hidden = [...text.matchAll(/const (\w+) = \{[^}]*windowsHide/g)].map((d) => d[1]);
      for (const m of text.matchAll(CALL)) {
        const open = (m.index ?? 0) + m[0].length - 1;
        const args = callArgs(text, open);
        const usesHidden = hidden.some((name) => new RegExp(`\\b${name}\\b`).test(args));
        if (!args.includes("windowsHide") && !usesHidden) {
          missing.push(`${file}:${text.slice(0, m.index).split("\n").length} ${m[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
