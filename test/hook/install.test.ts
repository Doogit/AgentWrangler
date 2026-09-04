import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installHook, isHookInstalled, uninstallHook } from "../../src/hook/install.js";

const directories: string[] = [];

function settingsPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentwrangler-hook-"));
  directories.push(directory);
  return path.join(directory, "settings.json");
}

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("context-budget hook installer", () => {
  it("installs and uninstalls idempotently while preserving other hooks", () => {
    const target = settingsPath();
    fs.writeFileSync(
      target,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-hook" }] }],
        },
      }),
    );

    expect(installHook(target)).toMatchObject({ changed: true, settingsPath: target });
    expect(installHook(target)).toMatchObject({ changed: false, settingsPath: target });
    const installed = JSON.parse(fs.readFileSync(target, "utf8")) as {
      hooks: { PreToolUse: { matcher: string }[] };
    };
    // Foreign Bash entry + AW "*" entry + AW Bash entry (danger-guard uses matcher "Bash").
    expect(installed.hooks.PreToolUse).toHaveLength(3);
    expect(JSON.stringify(installed)).toContain("context-budget-hook.mjs");
    expect(JSON.stringify(installed)).toContain("loop-guard-hook.mjs");
    expect(JSON.stringify(installed)).toContain("danger-guard-hook.mjs");
    expect(installed.hooks.PreToolUse.some((entry) => entry.matcher === "Bash")).toBe(true);
    expect(JSON.stringify(installed)).toContain("other-hook");

    expect(uninstallHook(target)).toMatchObject({ changed: true, settingsPath: target });
    expect(uninstallHook(target)).toMatchObject({ changed: false, settingsPath: target });
    const removed = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(JSON.stringify(removed)).toContain("other-hook");
    expect(JSON.stringify(removed)).not.toContain("context-budget-hook.mjs");
    expect(JSON.stringify(removed)).not.toContain("loop-guard-hook.mjs");
    expect(JSON.stringify(removed)).not.toContain("danger-guard-hook.mjs");
  });
});

describe("multi-event / multi-matcher registration", () => {
  it("registers hooks under their own event and matcher", () => {
    const target = settingsPath();
    installHook(target);
    const installed = JSON.parse(fs.readFileSync(target, "utf8")) as {
      hooks: { PreToolUse: { matcher: string }[]; PreCompact: { matcher: string }[] };
    };
    // PreCompact hook lands under hooks.PreCompact.
    expect(JSON.stringify(installed.hooks.PreCompact)).toContain("precompact-checkpoint-hook.mjs");
    // A Bash-matcher hook lands with that matcher under PreToolUse.
    const bashEntry = installed.hooks.PreToolUse.find((entry) => entry.matcher === "Bash");
    expect(JSON.stringify(bashEntry)).toContain("danger-guard-hook.mjs");
    // The "*"-matcher hooks group together, separate from the Bash entry.
    const starEntry = installed.hooks.PreToolUse.find((entry) => entry.matcher === "*");
    expect(JSON.stringify(starEntry)).toContain("context-budget-hook.mjs");
  });

  it("uninstall strips AW entries across every event and cleans empty events", () => {
    const target = settingsPath();
    installHook(target);
    uninstallHook(target);
    const removed = JSON.parse(fs.readFileSync(target, "utf8")) as { hooks?: unknown };
    // No AW hook of any event survives, and the empty hooks object is removed.
    expect(JSON.stringify(removed)).not.toContain("hook.mjs");
    expect(removed.hooks).toBeUndefined();
  });
});

describe("settings backup", () => {
  it("backs up pre-write content before mutating settings.json", () => {
    const target = settingsPath();
    const original = `${JSON.stringify({ model: "opus", hooks: {} }, null, 2)}\n`;
    fs.writeFileSync(target, original);

    installHook(target);

    const dir = path.dirname(target);
    const backups = fs.readdirSync(dir).filter((name) => name.includes(".aw-backup-"));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    // The most recent backup must byte-match the file as it was before this install.
    const newest = backups.sort().at(-1) as string;
    expect(fs.readFileSync(path.join(dir, newest), "utf8")).toBe(original);
  });

  it("retains only the newest few backups", () => {
    const target = settingsPath();
    fs.writeFileSync(target, JSON.stringify({ hooks: {} }));

    // Alternate install/uninstall to force many mutating writes.
    for (let i = 0; i < 8; i += 1) {
      installHook(target);
      uninstallHook(target);
    }

    const dir = path.dirname(target);
    const backups = fs.readdirSync(dir).filter((name) => name.includes(".aw-backup-"));
    expect(backups.length).toBeLessThanOrEqual(5);
  });
});

describe("isHookInstalled", () => {
  it("returns true when an AgentWrangler hook is installed", () => {
    const target = settingsPath();
    installHook(target);

    expect(isHookInstalled(target)).toBe(true);
  });

  it("returns false when no AgentWrangler hook is installed", () => {
    const target = settingsPath();
    fs.writeFileSync(
      target,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-hook" }] }],
        },
      }),
    );

    expect(isHookInstalled(target)).toBe(false);
  });

  it("returns false when settings.json is missing", () => {
    expect(isHookInstalled(settingsPath())).toBe(false);
  });
});
