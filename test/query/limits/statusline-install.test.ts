/** OV-7b: install/uninstall the `agentwrangler statusline` command in Claude Code's settings.json. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyStatusline,
  isStatuslineInstalled,
  planStatusline,
  statuslineCommand,
} from "../../../src/query/limits/statusline-install.js";

const CMD = `"/opt/node/node" "/opt/aw/dist/cli/agentwrangler.js" statusline`;
const OLD = "bash ~/.claude/statusline-command.sh";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-sl-inst-"));
  file = path.join(dir, "settings.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (text: string) => fs.writeFileSync(file, text);
const read = () => fs.readFileSync(file, "utf8");
const backups = () => fs.readdirSync(dir).filter((f) => f !== "settings.json");
const o = () => ({ settingsPath: file, command: CMD });

const NONE = `{\n  "$schema": "https://json.schemastore.org/claude-code-settings.json",\n  "env": {\n    "A": "1"\n  },\n  "permissions": {\n    "allow": ["Bash"]\n  }\n}\n`;
const WITH = `{\n  "env": {\n    "A": "1"\n  },\n  "statusLine": {\n    "type": "command",\n    "command": "${OLD}",\n    "padding": 1\n  },\n  "model": "opus"\n}\n`;

describe("planStatusline", () => {
  it("none -> plain command; previews before/after without touching the file", () => {
    write(NONE);
    const r = planStatusline("install", o());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.before).toBeNull();
    expect(JSON.parse(r.plan.after as string)).toEqual({ type: "command", command: CMD });
    expect(r.plan.changed).toBe(true);
    expect(read()).toBe(NONE);
    expect(backups()).toEqual([]);
  });

  it("existing statusLine -> wraps it with --wrap and keeps its other fields", () => {
    write(WITH);
    const r = planStatusline("install", o());
    if (!r.ok) throw new Error(r.error);
    expect(JSON.parse(r.plan.before as string)).toEqual({
      type: "command",
      command: OLD,
      padding: 1,
    });
    expect(JSON.parse(r.plan.after as string)).toEqual({
      type: "command",
      command: `${CMD} --wrap '${OLD}'`,
      padding: 1,
    });
  });

  it("unparseable settings.json is refused with the reason", () => {
    write(`{ "env": `);
    const r = planStatusline("install", o());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/settings\.json/);
    expect(r.error).toMatch(/JSON|parse|Unexpected/i);
    expect(read()).toBe(`{ "env": `);
  });

  it("a non-object root is refused", () => {
    write("[1]");
    expect(planStatusline("install", o()).ok).toBe(false);
  });

  it("already installed -> install is a no-op, uninstall offered", () => {
    write(NONE);
    applyStatusline("install", o());
    expect(isStatuslineInstalled(file)).toBe(true);
    const again = planStatusline("install", o());
    expect(again.ok && again.plan.changed).toBe(false);
    const un = planStatusline("uninstall", o());
    expect(un.ok && un.plan.changed).toBe(true);
  });

  it("uninstall when not installed is a no-op", () => {
    write(WITH);
    const r = planStatusline("uninstall", o());
    expect(r.ok && r.plan.changed).toBe(false);
  });
});

describe("applyStatusline", () => {
  it("install with none: adds statusLine, preserves everything else, backs up first", () => {
    write(NONE);
    const r = applyStatusline("install", o());
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(read());
    expect(parsed.statusLine).toEqual({ type: "command", command: CMD });
    expect(parsed.env).toEqual({ A: "1" });
    expect(parsed.permissions).toEqual({ allow: ["Bash"] });
    expect(read().startsWith(NONE.slice(0, NONE.lastIndexOf("}\n") - 1))).toBe(true);
    const b = backups();
    expect(b).toHaveLength(1);
    expect(b[0]).toMatch(/^settings\.json\..*backup/);
    expect(fs.readFileSync(path.join(dir, b[0] as string), "utf8")).toBe(NONE);
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("install with an existing statusLine wraps it; other keys and order untouched", () => {
    write(WITH);
    applyStatusline("install", o());
    const parsed = JSON.parse(read());
    expect(parsed.statusLine.command).toBe(`${CMD} --wrap '${OLD}'`);
    expect(parsed.statusLine.padding).toBe(1);
    expect(Object.keys(parsed)).toEqual(["env", "statusLine", "model"]);
    expect(read().endsWith('  "model": "opus"\n}\n')).toBe(true);
  });

  it("creates settings.json when there is none", () => {
    const r = applyStatusline("install", o());
    expect(r.ok).toBe(true);
    expect(JSON.parse(read())).toEqual({ statusLine: { type: "command", command: CMD } });
    expect(backups()).toEqual([]);
  });

  it("round trip returns the byte-identical original (none / existing / CRLF / empty object)", () => {
    for (const original of [
      NONE,
      WITH,
      NONE.replace(/\n/g, "\r\n"),
      WITH.replace(/\n/g, "\r\n"),
      "{}\n",
      "{}",
    ]) {
      write(original);
      expect(applyStatusline("install", o()).ok).toBe(true);
      expect(read()).not.toBe(original);
      expect(applyStatusline("uninstall", o()).ok).toBe(true);
      expect(read()).toBe(original);
    }
  });

  it("round trips a wrapped command containing single quotes", () => {
    const tricky = `bash -c 'echo "it's"' ~/x.sh`;
    const original = `{\n  "statusLine": {\n    "type": "command",\n    "command": ${JSON.stringify(tricky)}\n  }\n}\n`;
    write(original);
    applyStatusline("install", o());
    expect(JSON.parse(read()).statusLine.command).toContain("--wrap");
    applyStatusline("uninstall", o());
    expect(read()).toBe(original);
  });

  it("install twice does not double-wrap", () => {
    write(WITH);
    applyStatusline("install", o());
    const once = read();
    const r = applyStatusline("install", o());
    expect(r.ok && r.plan.changed).toBe(false);
    expect(read()).toBe(once);
  });

  it("refuses unparseable settings and writes nothing", () => {
    write("{ nope");
    const r = applyStatusline("install", o());
    expect(r.ok).toBe(false);
    expect(read()).toBe("{ nope");
    expect(backups()).toEqual([]);
  });

  it("refuses when the entry changed since the preview (expectBefore mismatch)", () => {
    write(WITH);
    const r = applyStatusline("install", {
      ...o(),
      expectBefore: JSON.stringify({ type: "command", command: "other" }),
    });
    expect(r.ok).toBe(false);
    expect(read()).toBe(WITH);
  });

  it("accepts the preview's own before text as expectBefore", () => {
    write(WITH);
    const p = planStatusline("install", o());
    if (!p.ok) throw new Error(p.error);
    expect(applyStatusline("install", { ...o(), expectBefore: p.plan.before }).ok).toBe(true);
  });
});

describe("statuslineCommand", () => {
  it("is an absolute node + cli path invocation ending in 'statusline', forward slashes, no backslashes", () => {
    const c = statuslineCommand();
    expect(c).toMatch(/^"[^"]+" "[^"]*agentwrangler\.js" statusline$/);
    expect(c).not.toContain("\\");
  });
});
