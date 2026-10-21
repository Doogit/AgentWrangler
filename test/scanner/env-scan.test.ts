/**
 * test/scanner/env-scan.test.ts — environment scanner (JMS U2), temp-dir fixtures only.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { scanEnvironment } from "../../src/scanner/env-scan.js";

let root: string;
let claudeDir: string;
let db: Database.Database;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function scan() {
  return scanEnvironment(db, { claudeDir, claudeJsonPath: path.join(root, "claude.json") });
}

function addWorkspace(id: string, repoPath: string | null): void {
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, repo_path, registered_at) VALUES (?, ?, ?, ?)",
  ).run(id, `slug-${id}`, repoPath, "2026-01-01T00:00:00.000Z");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-env-scan-"));
  claudeDir = path.join(root, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  db = new Database(":memory:");
  runMigrations(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("scanEnvironment", () => {
  it("parses an allow-all Bash rule into a flag", () => {
    write(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Bash(*)", "Read"],
          deny: ["Bash(rm:*)"],
          defaultMode: "acceptEdits",
        },
      }),
    );
    const p = scan().settings.permissions;
    expect(p.status).toBe("ok");
    expect(p.data?.allowAllBash).toBe(true);
    expect(p.data?.deny).toEqual(["Bash(rm:*)"]);
    expect(p.data?.defaultMode).toBe("acceptEdits");
  });

  it("does not flag scoped Bash rules as allow-all", () => {
    write(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(git status)"] } }),
    );
    expect(scan().settings.permissions.data?.allowAllBash).toBe(false);
  });

  it("enumerates the hooks block", () => {
    write(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "a" }] }],
          Stop: [
            {
              hooks: [
                { type: "command", command: "b" },
                { type: "command", command: "c" },
              ],
            },
          ],
        },
      }),
    );
    const h = scan().settings.hooks;
    expect(h.status).toBe("ok");
    expect(h.data?.events).toEqual([
      { event: "PreToolUse", matcherCount: 1, commandCount: 1 },
      { event: "Stop", matcherCount: 1, commandCount: 2 },
    ]);
  });

  it("reports malformed settings JSON as unreadable without throwing", () => {
    write(path.join(claudeDir, "settings.json"), "{ not json");
    const s = scan().settings;
    expect(s.file).toBe("unreadable");
    expect(s.permissions.status).toBe("unreadable");
    expect(s.hooks.status).toBe("unreadable");
  });

  it("reports a missing workspace dir as NO_DATA", () => {
    addWorkspace("w1", path.join(root, "moved-away"));
    const proj = scan().projects[0];
    expect(proj?.state).toEqual({ kind: "NO_DATA", reason: "missing_dir" });
    expect(proj?.claudeMd.status).toBe("absent");
    expect(proj?.mcpJson.status).toBe("absent");
  });

  it("reports a null repo_path as the distinct unregistered NO_DATA state", () => {
    addWorkspace("w2", null);
    expect(scan().projects[0]?.state).toEqual({ kind: "NO_DATA", reason: "unregistered" });
  });

  it("finds and line-counts a per-project CLAUDE.md, .claude and .mcp.json", () => {
    const repo = path.join(root, "repo");
    write(path.join(repo, "CLAUDE.md"), "a\nb\nc");
    write(path.join(repo, ".claude", "settings.json"), JSON.stringify({ permissions: {} }));
    write(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { zed: {}, abe: {} } }));
    addWorkspace("w3", repo);
    const proj = scan().projects[0];
    expect(proj?.state).toEqual({ kind: "scanned" });
    expect(proj?.claudeMd).toEqual({ status: "ok", data: { lineCount: 3 } });
    expect(proj?.claudeDir.status).toBe("ok");
    expect(proj?.mcpJson.data?.names).toEqual(["abe", "zed"]);
  });

  it("reports permissions absent (not unreadable) when settings has no permissions key", () => {
    write(path.join(claudeDir, "settings.json"), JSON.stringify({ model: "x" }));
    const s = scan().settings;
    expect(s.file).toBe("ok");
    expect(s.permissions.status).toBe("absent");
    expect(s.hooks.status).toBe("absent");
  });

  it("reads global CLAUDE.md, skills, agents and MCP; missing ones are absent", () => {
    expect(scan().claudeMd.status).toBe("absent");
    expect(scan().skills.status).toBe("absent");
    write(path.join(claudeDir, "CLAUDE.md"), "x\ny\n");
    write(path.join(claudeDir, "skills", "s1", "SKILL.md"), "---\nname: alpha\n---\nbody");
    write(path.join(claudeDir, "agents", "bot.md"), "hi");
    write(path.join(root, "claude.json"), JSON.stringify({ mcpServers: { m1: {} } }));
    const r = scan();
    expect(r.claudeMd.data?.lineCount).toBe(3);
    expect(r.skills.data?.names).toEqual(["alpha"]);
    expect(r.agents.data?.names).toEqual(["bot"]);
    expect(r.mcp.data?.names).toEqual(["m1"]);
  });

  it("counts enabled plugins' MCP servers with the user-level ones", () => {
    const install = path.join(claudeDir, "plugins", "cache", "mkt", "toolbox", "1.0.0");
    write(
      path.join(claudeDir, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "toolbox@mkt": [{ scope: "user", installPath: install }] },
      }),
    );
    write(path.join(install, ".mcp.json"), JSON.stringify({ search: { command: "node" } }));
    // No ~/.claude.json: the plugin server alone makes the surface readable.
    expect(scan().mcp).toEqual({ status: "ok", data: { count: 1, names: ["toolbox:search"] } });
    write(path.join(root, "claude.json"), JSON.stringify({ mcpServers: { m1: {} } }));
    expect(scan().mcp.data).toEqual({ count: 2, names: ["m1", "toolbox:search"] });
    // A disabled plugin's servers do not load, so they do not count.
    write(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ enabledPlugins: { "toolbox@mkt": false } }),
    );
    expect(scan().mcp.data).toEqual({ count: 1, names: ["m1"] });
  });
});
