/**
 * Sample Claude Code statusline payloads for the OV-7b oracle test.
 *
 * Templates: {{REPO}} {{WT}} {{WT_BS}} {{SUB}} {{DET}} {{PLAIN}} expand to fixture directories (JSON-escaped);
 * "{{E+n}}" -> epoch seconds n s from now (number); {{I+n}} / {{IMS+n}} -> ISO 8601 (without / with
 * fractional seconds). Offsets sit 30 s inside a minute bucket so run-time drift cannot change the output.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface StatuslineCase {
  name: string;
  /** Send the payload with CRLF line endings. */
  crlf?: boolean;
  payload: string;
}

export const CASES: StatuslineCase[] = [
  {
    name: "full",
    payload: `{
  "model": { "display_name": "Opus 5.5 (1M context)" },
  "workspace": { "current_dir": "{{WT}}", "repo": { "name": "AgentWrangler" } },
  "cwd": "{{WT}}",
  "context_window": {
    "used_percentage": 42.4,
    "context_window_size": 200000,
    "current_usage": { "input_tokens": 1200, "cache_creation_input_tokens": 3000, "cache_read_input_tokens": 80800 }
  },
  "rate_limits": {
    "five_hour": { "used_percentage": 23.4, "resets_at": "{{E+6510}}" },
    "seven_day": { "used_percentage": 81, "resets_at": "{{E+214200}}" }
  },
  "cost": { "total_cost_usd": 3.2, "total_duration_ms": 4980000 }
}`,
  },
  {
    name: "minimal-plain-dir",
    payload: `{ "model": { "display_name": "Sonnet 5" }, "cwd": "{{PLAIN}}" }`,
  },
  {
    name: "all-null-fields",
    payload: `{
  "model": { "display_name": null },
  "workspace": { "current_dir": "{{PLAIN}}", "repo": null },
  "context_window": { "used_percentage": null, "current_usage": null },
  "rate_limits": null,
  "cost": { "total_cost_usd": null, "total_duration_ms": null }
}`,
  },
  {
    name: "worktree-backslash-iso",
    payload: `{
  "model": { "display_name": "Fable 5" },
  "workspace": { "current_dir": "{{WT_BS}}" },
  "context_window": { "used_percentage": 9, "current_usage": { "input_tokens": 500 } },
  "rate_limits": {
    "five_hour": { "used_percentage": 50, "resets_at": "{{IMS+1530}}" },
    "seven_day": { "used_percentage": 79.4, "resets_at": "{{I+90030}}" }
  },
  "cost": { "total_cost_usd": 0.07, "total_duration_ms": 45000 }
}`,
  },
  {
    name: "detached-hot-no-current-usage",
    payload: `{
  "model": { "display_name": "Opus 5.5" },
  "cwd": "{{DET}}",
  "context_window": { "used_percentage": 85.5, "context_window_size": 200000 },
  "rate_limits": {
    "five_hour": { "used_percentage": 99.5, "resets_at": {{E+5430}} },
    "seven_day": { "used_percentage": 12, "resets_at": {{E+259230}} }
  },
  "cost": { "total_cost_usd": 27.456, "total_duration_ms": 36000000 }
}`,
  },
  {
    name: "subdir-walks-up",
    payload: `{
  "model": { "display_name": "Haiku 5" },
  "workspace": { "current_dir": "{{SUB}}" },
  "context_window": { "used_percentage": 0, "current_usage": { "input_tokens": 0 } },
  "cost": { "total_duration_ms": 0, "total_cost_usd": 12.3 }
}`,
  },
  {
    name: "crlf-partial-limits",
    crlf: true,
    payload: `{
  "model": { "display_name": "Opus 5.5 (200k)" },
  "cwd": "{{REPO}}",
  "rate_limits": {
    "five_hour": { "used_percentage": 77, "resets_at": null },
    "seven_day": null
  },
  "cost": { "total_cost_usd": 5 }
}`,
  },
  {
    name: "limits-past-reset-and-bare-windows",
    payload: `{
  "model": { "display_name": "Sonnet 5" },
  "cwd": "{{REPO}}",
  "rate_limits": {
    "five_hour": { "used_percentage": 10, "resets_at": {{E+-600}} },
    "seven_day": { "used_percentage": 3 }
  }
}`,
  },
];

export interface Tree {
  root: string;
  tokens: Record<string, string>;
}

const fwd = (p: string) => p.replace(/\\/g, "/");
const esc = (s: string) => JSON.stringify(s).slice(1, -1);

/** Build the fixture repos under `root`: a main repo, a linked worktree, a detached repo and a plain dir. */
export function buildTree(root: string): Tree {
  const repo = path.join(root, "repos", "AgentWrangler");
  const wt = path.join(repo, ".worktrees", "statusline-limits");
  const det = path.join(root, "repos", "detached-repo");
  const plain = path.join(root, "plain", "scratch");
  const sub = path.join(repo, "src", "deep");
  const wtGit = path.join(repo, ".git", "worktrees", "statusline-limits");
  for (const d of [sub, wt, wtGit, path.join(det, ".git"), plain])
    fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${fwd(wtGit)}\n`);
  fs.writeFileSync(path.join(wtGit, "HEAD"), "ref: refs/heads/feat/statusline-limits\n");
  fs.writeFileSync(path.join(det, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  return {
    root,
    tokens: {
      REPO: esc(fwd(repo)),
      WT: esc(fwd(wt)),
      WT_BS: esc(wt.replace(/\//g, "\\")),
      SUB: esc(fwd(sub)),
      DET: esc(fwd(det)),
      PLAIN: esc(fwd(plain)),
    },
  };
}

/** Expand a template against a tree at `nowSec` (integer epoch seconds). */
export function expand(c: StatuslineCase, tree: Tree, nowSec: number): string {
  const iso = (n: number, ms: boolean) => {
    const s = new Date((nowSec + n) * 1000).toISOString();
    return ms ? s.replace(/\.000Z$/, ".123Z") : s.replace(/\.\d+Z$/, "Z");
  };
  let out = c.payload
    .replace(/"\{\{E\+(-?\d+)\}\}"/g, (_m, n) => String(nowSec + Number(n)))
    .replace(/\{\{E\+(-?\d+)\}\}/g, (_m, n) => String(nowSec + Number(n)))
    .replace(/\{\{IMS\+(-?\d+)\}\}/g, (_m, n) => iso(Number(n), true))
    .replace(/\{\{I\+(-?\d+)\}\}/g, (_m, n) => iso(Number(n), false));
  for (const [k, v] of Object.entries(tree.tokens)) out = out.split(`{{${k}}}`).join(v);
  return c.crlf ? out.replace(/\n/g, "\r\n") : out;
}
