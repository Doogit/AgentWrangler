/**
 * OAUTH-1 — AgentWrangler never sends the user's Claude Code OAuth token (Anthropic's terms bar
 * third-party reuse: .claude/audits/2026-10-13-jms-p2-terms.md). Usage comes from the statusline.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStatuslineUsage } from "../../src/query/limits/statusline.js";

function srcFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return srcFiles(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

describe("no OAuth token egress", () => {
  it("no src file sends the OAuth beta header or a bearer access token", () => {
    const offenders = srcFiles(path.resolve(__dirname, "../../src")).filter((f) => {
      const text = fs.readFileSync(f, "utf8");
      return text.includes("oauth-2025-04-20") || /Bearer \$\{[^}]*accessToken/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

describe("USAGE-CLI egress (spec criterion 7)", () => {
  it.each(["cli-usage.ts", "usage-sources.ts"])(
    "src/query/limits/%s never imports oauth/credentials or mentions credentials.json",
    (name) => {
      const text = fs.readFileSync(path.resolve(__dirname, "../../src/query/limits", name), "utf8");
      expect(text).not.toMatch(/oauth\/credentials/);
      expect(text).not.toMatch(/credentials\.json/i);
    },
  );
});

describe("readStatuslineUsage", () => {
  const T0 = new Date("2026-10-13T12:00:00.000Z");
  const H = 36e5;
  let dir: string;
  let file: string;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-oauth1-"));
    file = path.join(dir, "statusline-limits.json");
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the fresh statusline percentages as fractions", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        at: T0.toISOString(),
        rate_limits: {
          five_hour: { used_percentage: 41, resets_at: Math.floor((T0.getTime() + 2 * H) / 1000) },
          seven_day: { used_percentage: 63, resets_at: Math.floor((T0.getTime() + 60 * H) / 1000) },
        },
      }),
    );
    const r = await readStatuslineUsage(file);
    expect(r).toEqual({
      ok: true,
      data: {
        five_hour: { utilization: 0.41, resets_at: new Date(T0.getTime() + 2 * H).toISOString() },
        seven_day: { utilization: 0.63, resets_at: new Date(T0.getTime() + 60 * H).toISOString() },
      },
    });
  });

  it("fails with a setup hint when the file is missing", async () => {
    const r = await readStatuslineUsage(file);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("Settings");
  });

  it("never reads the real home file under vitest", async () => {
    const r = await readStatuslineUsage();
    expect(r.ok).toBe(false);
  });
});
