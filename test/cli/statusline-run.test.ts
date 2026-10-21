/** OV-7b: `agentwrangler statusline` robustness — --wrap, bad input, CRLF, never throws, real CLI entry. */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWrapArg, runStatusline } from "../../src/cli/statusline.js";

let tmp: string;
let n = 0;
const home = () => {
  const h = path.join(tmp, `h${n++}`);
  fs.mkdirSync(h, { recursive: true });
  return h;
};
const limitsFile = (h: string) => path.join(h, ".agentwrangler", "statusline-limits.json");
const nowMs = 1_800_000_000_000;
const nowSec = nowMs / 1000;
const payload = JSON.stringify({
  model: { display_name: "Opus 5.5 (1M context)" },
  cwd: "/nowhere/proj",
  rate_limits: {
    five_hour: { used_percentage: 20, resets_at: nowSec + 6510 },
    seven_day: { used_percentage: 40, resets_at: nowSec + 214200 },
  },
});
const fwd = (p: string) => p.replace(/\\/g, "/");
const NODE = `"${fwd(process.execPath)}"`;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-sl-run-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("runStatusline", () => {
  it("bad JSON, empty stdin and non-object JSON print nothing, write nothing, never throw", () => {
    for (const bad of ["", "not json", "[1,2]", "null", "{"]) {
      const h = home();
      expect(runStatusline({ stdin: bad, home: h, nowMs })).toBe("");
      expect(fs.existsSync(limitsFile(h))).toBe(false);
    }
  });

  it("handles a BOM and CRLF stdin", () => {
    const h = home();
    const out = runStatusline({ stdin: `﻿${payload.replace(/,/g, ",\r\n")}\r\n`, home: h, nowMs });
    expect(out).toContain("Opus 5.5");
    expect(fs.existsSync(limitsFile(h))).toBe(true);
  });

  it("limits write is atomic-ish: no temp file left behind, unwritable home does not throw", () => {
    const h = home();
    runStatusline({ stdin: payload, home: h, nowMs });
    expect(fs.readdirSync(path.join(h, ".agentwrangler"))).toEqual(["statusline-limits.json"]);
    const blocked = path.join(tmp, "blocked-file");
    fs.writeFileSync(blocked, "x");
    expect(() => runStatusline({ stdin: payload, home: blocked, nowMs })).not.toThrow();
  });

  it("--wrap: prints the wrapped command's stdout (fed the same stdin) and still writes limits", () => {
    const h = home();
    const echo = `${NODE} -e "process.stdin.pipe(process.stdout)"`;
    const out = runStatusline({ stdin: payload, home: h, nowMs, wrap: echo });
    expect(out).toBe(payload);
    expect(fs.existsSync(limitsFile(h))).toBe(true);
  });

  it("--wrap: a failing wrapped command falls back to our own line without throwing", () => {
    const h = home();
    const out = runStatusline({
      stdin: payload,
      home: h,
      nowMs,
      wrap: `${NODE} -e "process.exit(3)"`,
    });
    expect(out).toContain("Opus 5.5");
    const missing = runStatusline({
      stdin: payload,
      home: home(),
      nowMs,
      wrap: "no-such-command-aw-xyz",
    });
    expect(missing).toContain("Opus 5.5");
  });

  it("--wrap: a failing wrapped command that printed something keeps what it printed", () => {
    const out = runStatusline({
      stdin: payload,
      home: home(),
      nowMs,
      wrap: `${NODE} -e "process.stdout.write('partial'); process.exit(1)"`,
    });
    expect(out).toBe("partial");
  });
});

describe("parseWrapArg", () => {
  it("reads --wrap <cmd> and --wrap=<cmd>; absent -> undefined", () => {
    expect(parseWrapArg(["--wrap", "bash x.sh"])).toBe("bash x.sh");
    expect(parseWrapArg(["--wrap=bash y.sh"])).toBe("bash y.sh");
    expect(parseWrapArg([])).toBeUndefined();
    expect(parseWrapArg(["--wrap"])).toBeUndefined();
  });
});

describe("CLI entry (src/cli/agentwrangler.ts statusline)", () => {
  it("reads stdin, prints the line, writes the limits file, exits 0", () => {
    const h = home();
    const cli = path.join(__dirname, "..", "..", "src", "cli", "agentwrangler.ts");
    const now = Math.floor(Date.now() / 1000);
    const input = JSON.stringify({
      model: { display_name: "Opus 5.5 (1M context)" },
      cwd: "/nowhere/proj",
      rate_limits: {
        five_hour: { used_percentage: 20, resets_at: now + 6510 },
        seven_day: { used_percentage: 40, resets_at: now + 214200 },
      },
    });
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", cli, "statusline"], {
      input,
      encoding: "utf8",
      env: { ...process.env, HOME: h, USERPROFILE: h },
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    const plain = r.stdout.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
    expect(plain).toMatch(/^Opus 5\.5 \| proj \| 5h:20% 1h48m {2}7d:40% 2d11h$/);
    expect(
      JSON.parse(fs.readFileSync(limitsFile(h), "utf8")).rate_limits.five_hour.used_percentage,
    ).toBe(20);
  }, 60_000);
});
