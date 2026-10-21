/**
 * src/scanner/env-scan.ts — environment scanner for "Judge my setup".
 *
 * Reads the Claude Code config surfaces (settings permissions + hooks, CLAUDE.md, skills,
 * agents, auto-memory, MCP config, per-project config) into a typed scan result that
 * grading checks consume. Composes the read helpers exported from context-probe.
 *
 * Only derived facts (counts, names, flags) leave this module — never raw file content.
 * Never throws: unreadable/absent surfaces are reported via status.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Db } from "../db/open.js";
import {
  GLOBAL_WORKSPACE_ID,
  isRecord,
  mcpServerNames,
  parseFrontmatter,
  pluginMcpServers,
  readMemoryDir,
  resolveWithin,
  tryReadFile,
} from "../detector/context-probe.js";

export type SurfaceStatus = "ok" | "unreadable" | "absent";

export interface Surface<T> {
  status: SurfaceStatus;
  /** Present only when status is "ok". */
  data?: T;
}

export interface PermissionsInfo {
  allow: string[];
  deny: string[];
  ask: string[];
  defaultMode: string | null;
  /** An allow rule grants every Bash command (`Bash`, `Bash(*)`, `Bash(:*)`, `*`). */
  allowAllBash: boolean;
}

export interface HookEventInfo {
  event: string;
  matcherCount: number;
  commandCount: number;
}

export interface HooksInfo {
  events: HookEventInfo[];
}

export interface FileInfo {
  lineCount: number;
}

export interface NamedItems {
  count: number;
  names: string[];
}

export interface SettingsScan {
  /** Status of the settings.json file itself. */
  file: SurfaceStatus;
  permissions: Surface<PermissionsInfo>;
  hooks: Surface<HooksInfo>;
}

export type ProjectState =
  | { kind: "scanned" }
  | { kind: "NO_DATA"; reason: "unregistered" | "missing_dir" };

export interface ProjectScan {
  workspaceId: string;
  projectSlug: string;
  repoPath: string | null;
  state: ProjectState;
  claudeMd: Surface<FileInfo>;
  /** `<repo>/.claude/` directory: ok when present (with its settings.json facts). */
  claudeDir: Surface<SettingsScan>;
  mcpJson: Surface<NamedItems>;
  memory: Surface<FileInfo>;
}

export interface EnvScanResult {
  settings: SettingsScan;
  claudeMd: Surface<FileInfo>;
  skills: Surface<NamedItems>;
  agents: Surface<NamedItems>;
  mcp: Surface<NamedItems>;
  projects: ProjectScan[];
}

export interface EnvScanOptions {
  /** Defaults to `~/.claude`. */
  claudeDir?: string;
  /** Defaults to `~/.claude.json`. */
  claudeJsonPath?: string;
}

const ALLOW_ALL_BASH = /^(?:\*|Bash(?:\(\*{1,2}\)|\(:\*\))?)$/;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function countLines(content: string): number {
  return content.length === 0 ? 0 : content.split("\n").length;
}

function fileSurface(filePath: string): Surface<FileInfo> {
  if (!fs.existsSync(filePath)) return { status: "absent" };
  const content = tryReadFile(filePath);
  if (content === null) return { status: "unreadable" };
  return { status: "ok", data: { lineCount: countLines(content) } };
}

function parsePermissions(value: unknown): Surface<PermissionsInfo> {
  if (value === undefined) return { status: "absent" };
  if (!isRecord(value)) return { status: "unreadable" };
  const allow = strings(value.allow);
  return {
    status: "ok",
    data: {
      allow,
      deny: strings(value.deny),
      ask: strings(value.ask),
      defaultMode: typeof value.defaultMode === "string" ? value.defaultMode : null,
      allowAllBash: allow.some((rule) => ALLOW_ALL_BASH.test(rule.trim())),
    },
  };
}

function parseHooks(value: unknown): Surface<HooksInfo> {
  if (value === undefined) return { status: "absent" };
  if (!isRecord(value)) return { status: "unreadable" };
  const events: HookEventInfo[] = Object.entries(value)
    .map(([event, groups]) => {
      const list = Array.isArray(groups) ? groups : [];
      let commandCount = 0;
      for (const group of list) {
        if (isRecord(group) && Array.isArray(group.hooks)) commandCount += group.hooks.length;
      }
      return { event, matcherCount: list.length, commandCount };
    })
    .sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
  return { status: "ok", data: { events } };
}

/** Read a settings.json: malformed JSON is `unreadable`, never a throw. */
export function scanSettingsFile(settingsPath: string): SettingsScan {
  const raw = tryReadFile(settingsPath);
  if (raw === null) {
    const status: SurfaceStatus = fs.existsSync(settingsPath) ? "unreadable" : "absent";
    return {
      file: status,
      permissions: { status },
      hooks: { status },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      file: "unreadable",
      permissions: { status: "unreadable" },
      hooks: { status: "unreadable" },
    };
  }
  if (!isRecord(parsed)) {
    return {
      file: "unreadable",
      permissions: { status: "unreadable" },
      hooks: { status: "unreadable" },
    };
  }
  return {
    file: "ok",
    permissions: parsePermissions(parsed.permissions),
    hooks: parseHooks(parsed.hooks),
  };
}

function sorted(names: string[]): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function namedSurface(status: SurfaceStatus, names: string[]): Surface<NamedItems> {
  if (status !== "ok") return { status };
  const s = sorted(names);
  return { status: "ok", data: { count: s.length, names: s } };
}

/** Skill dir names (frontmatter `name` wins) under `<claudeDir>/skills/*\/SKILL.md`. */
function scanSkills(claudeDir: string): Surface<NamedItems> {
  const skillsDir = path.join(claudeDir, "skills");
  if (!fs.existsSync(skillsDir)) return { status: "absent" };
  try {
    const names: string[] = [];
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const resolved = resolveWithin(skillsDir, path.join(skillsDir, entry.name, "SKILL.md"));
      const content = resolved === null ? null : tryReadFile(resolved);
      if (content === null) continue;
      const fm = parseFrontmatter(content);
      names.push(fm !== null && typeof fm.name === "string" ? fm.name : entry.name);
    }
    return namedSurface("ok", names);
  } catch {
    return { status: "unreadable" };
  }
}

/** Agent names from `<claudeDir>/agents/*.md`. */
function scanAgents(claudeDir: string): Surface<NamedItems> {
  const agentsDir = path.join(claudeDir, "agents");
  if (!fs.existsSync(agentsDir)) return { status: "absent" };
  try {
    const names = fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name.slice(0, -3));
    return namedSurface("ok", names);
  } catch {
    return { status: "unreadable" };
  }
}

/** MCP servers from a `{ mcpServers }` JSON file (`~/.claude.json` or `.mcp.json`). */
function scanMcpFile(filePath: string): Surface<NamedItems> {
  const raw = tryReadFile(filePath);
  if (raw === null) return { status: fs.existsSync(filePath) ? "unreadable" : "absent" };
  try {
    JSON.parse(raw);
  } catch {
    return { status: "unreadable" };
  }
  return namedSurface("ok", mcpServerNames(raw, false));
}

/** User-level MCP servers plus enabled plugins' bundled servers ("<plugin>:<server>"). */
function scanUserMcp(claudeDir: string, claudeJsonPath: string): Surface<NamedItems> {
  const user = scanMcpFile(claudeJsonPath);
  if (user.status === "unreadable") return user;
  const plugin = pluginMcpServers(claudeDir, claudeJsonPath).map((s) => s.name);
  if (user.status === "absent" && plugin.length === 0) return user;
  return namedSurface("ok", [...(user.data?.names ?? []), ...plugin]);
}

function scanMemory(memoryDir: string): Surface<FileInfo> {
  if (!fs.existsSync(path.join(memoryDir, "MEMORY.md"))) return { status: "absent" };
  const content = readMemoryDir(memoryDir);
  if (content === null) return { status: "unreadable" };
  return { status: "ok", data: { lineCount: countLines(content) } };
}

function scanProject(
  claudeDir: string,
  ws: { workspace_id: string; project_slug: string; repo_path: string | null },
): ProjectScan {
  const memory = scanMemory(path.join(claudeDir, "projects", ws.project_slug, "memory"));
  const base = {
    workspaceId: ws.workspace_id,
    projectSlug: ws.project_slug,
    repoPath: ws.repo_path,
  };
  const noData = (reason: "unregistered" | "missing_dir"): ProjectScan => ({
    ...base,
    state: { kind: "NO_DATA", reason },
    claudeMd: { status: "absent" },
    claudeDir: { status: "absent" },
    mcpJson: { status: "absent" },
    memory,
  });
  if (!ws.repo_path) return noData("unregistered");
  let isDir = false;
  try {
    isDir = fs.statSync(ws.repo_path).isDirectory();
  } catch {
    // missing/moved
  }
  if (!isDir) return noData("missing_dir");

  const dotClaude = path.join(ws.repo_path, ".claude");
  return {
    ...base,
    state: { kind: "scanned" },
    claudeMd: fileSurface(path.join(ws.repo_path, "CLAUDE.md")),
    claudeDir: fs.existsSync(dotClaude)
      ? { status: "ok", data: scanSettingsFile(path.join(dotClaude, "settings.json")) }
      : { status: "absent" },
    mcpJson: scanMcpFile(path.join(ws.repo_path, ".mcp.json")),
    memory,
  };
}

/** Scan the user-level config plus every workspace's per-project config. */
export function scanEnvironment(db: Db, opts?: EnvScanOptions): EnvScanResult {
  const claudeDir = opts?.claudeDir ?? path.join(os.homedir(), ".claude");
  const claudeJsonPath = opts?.claudeJsonPath ?? path.join(os.homedir(), ".claude.json");

  let workspaces: { workspace_id: string; project_slug: string; repo_path: string | null }[] = [];
  try {
    workspaces = db
      .prepare(
        `SELECT workspace_id, project_slug, repo_path FROM workspaces
         WHERE workspace_id != ?
         ORDER BY workspace_id`,
      )
      .all(GLOBAL_WORKSPACE_ID) as typeof workspaces;
  } catch {
    // No workspaces table/rows: user-level scan still stands.
  }

  return {
    settings: scanSettingsFile(path.join(claudeDir, "settings.json")),
    claudeMd: fileSurface(path.join(claudeDir, "CLAUDE.md")),
    skills: scanSkills(claudeDir),
    agents: scanAgents(claudeDir),
    mcp: scanUserMcp(claudeDir, claudeJsonPath),
    projects: workspaces.map((ws) => scanProject(claudeDir, ws)),
  };
}
