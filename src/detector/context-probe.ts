/**
 * src/detector/context-probe.ts — ContextInventoryProbe.
 *
 * Reads the always-loaded prefix sources, sizes each in tokens via a measured Claude count
 * when one exists for the loaded content (attribution_version = "measured-pair-v1:<version>/
 * <model>"), else Math.ceil(utf8_bytes / 4) (attribution_version = "chars4-v1"), and writes
 * per-source rows to context_inventory.  Never persists file content — only
 * path + sha1 hash + token count (SEC-101).
 *
 * Sources probed:
 *   GLOBAL — keyed to the '__global__' sentinel workspace (INSERT OR IGNORE):
 *     - ~/.claude/CLAUDE.md            (component: CLAUDE_MD)
 *     - Plugin/skill catalog (ESTIMATE) derived from
 *         ~/.claude/plugins/installed_plugins.json +
 *         enabled plugin cache skills +
 *         ~/.claude/skills/ * /SKILL.md frontmatter name+description
 *                                      (component: MCP_SCHEMAS — skill/plugin text only;
 *                                       no MCP server schema is measured)
 *     - Per-item catalog rows (skill | plugin | mcp_server) → catalog_items. MCP servers
 *       are listed by name with size_basis 'unmeasured' (schemas come from the server).
 *     - Tool-Search config state from ~/.claude/settings.json (component:
 *       SETTINGS_SYSTEM; state metadata only, never settings content)
 *   PER-WORKSPACE (real workspace_id):
 *     - ~/.claude/projects/<slug>/memory/MEMORY.md (component: MEMORY; capped prefix)
 *     - <repo_path>/CLAUDE.md          (component: CLAUDE_MD; when set)
 *
 * probe_id = "probe-" + sha1(workspace_id|component|file_ref).slice(0, 16)
 * INSERT OR REPLACE keeps the table bounded (re-probe overwrites the row).
 *
 * Injected `now: Date` for probed_at — never call new Date() in this module.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Db } from "../db/open.js";

const ATTRIBUTION_VERSION = "chars4-v1";
const TOOL_SEARCH_STATE_VERSION = "tool-search-state-v1";
const MAX_ALWAYS_LOAD_FLAGS = 256;
const MAX_CATALOG_ITEMS = 10_000;

/** Sentinel workspace_id and slug for all global sources. */
export const GLOBAL_WORKSPACE_ID = "__global__";
export const GLOBAL_PROJECT_SLUG = "__global__";

type Component = "CLAUDE_MD" | "RULES" | "MCP_SCHEMAS" | "SETTINGS_SYSTEM" | "MEMORY" | "OTHER";

/** The configured Tool-Search behavior, before server-level alwaysLoad overrides. */
export type ToolSearchMode = "deferred" | "threshold" | "upfront" | "disabled" | "unknown";

/** The effective state represented by the catalog estimate. */
export type CatalogLoadState = "deferred" | "threshold" | "upfront" | "alwaysLoad" | "unknown";

/** A server-level alwaysLoad flag with the server identifier privacy-preserved. */
export interface AlwaysLoadFlag {
  server_id_hash: string;
  always_load: boolean;
}

/** Bounded state facts persisted in the SETTINGS_SYSTEM inventory row. */
export interface ToolSearchState {
  tool_search_mode: ToolSearchMode;
  effective_catalog_state: CatalogLoadState;
  configured_value: string | null;
  always_load_flags: AlwaysLoadFlag[];
  always_load_count: number;
  always_load_flags_truncated: boolean;
  catalog_item_count: number;
  catalog_item_count_truncated: boolean;
  catalog_hash: string | null;
}

/** tokens = ceil(utf8_bytes / 4) — standard cheap heuristic. */
function countTokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content, "utf8") / 4);
}

/**
 * Claude token counts measured by `scripts/parity/measure-sources.ts` (controlled pairs; C1
 * decision A), keyed by SHA-1 of the loaded content. Scoped to one Claude Code version and
 * model, recorded in the attribution version. A source with no entry stays `chars4-v1`.
 */
interface MeasuredCounts {
  attribution: string;
  counts: Map<string, number>;
}

function readMeasuredCounts(file: string): MeasuredCounts | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      claudeVersion: string;
      models: string[];
      deltas: { mode: string; contentSha1: string; observed: number[] }[];
    };
    const counts = new Map<string, number>();
    for (const delta of parsed.deltas) {
      const [first, ...rest] = delta.observed;
      // Only stable repeated counts are usable; anything else stays a chars4 estimate.
      if (delta.mode === "M" && first !== undefined && rest.every((value) => value === first)) {
        counts.set(delta.contentSha1, first);
      }
    }
    return {
      attribution: `measured-pair-v1:${parsed.claudeVersion}/${parsed.models.join("+")}`,
      counts,
    };
  } catch {
    return null;
  }
}

/** SHA-1 hex of UTF-8 content. */
function sha1Hex(content: string): string {
  return crypto.createHash("sha1").update(content, "utf8").digest("hex");
}

/** Serialize config facts without retaining settings or catalog content. */
export function encodeToolSearchState(state: ToolSearchState): string {
  return `${TOOL_SEARCH_STATE_VERSION}:${JSON.stringify(state)}`;
}

/** Parse the probe's bounded Tool-Search state metadata. */
export function parseToolSearchState(raw: string): ToolSearchState | null {
  if (!raw.startsWith(`${TOOL_SEARCH_STATE_VERSION}:`)) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(TOOL_SEARCH_STATE_VERSION.length + 1));
    if (!isRecord(parsed)) return null;
    const mode = parsed.tool_search_mode;
    const effective = parsed.effective_catalog_state;
    if (
      mode !== "deferred" &&
      mode !== "threshold" &&
      mode !== "upfront" &&
      mode !== "disabled" &&
      mode !== "unknown"
    ) {
      return null;
    }
    if (
      effective !== "deferred" &&
      effective !== "threshold" &&
      effective !== "upfront" &&
      effective !== "alwaysLoad" &&
      effective !== "unknown"
    ) {
      return null;
    }
    if (!Array.isArray(parsed.always_load_flags)) return null;
    const flags = parsed.always_load_flags.filter(
      (flag): flag is AlwaysLoadFlag =>
        isRecord(flag) &&
        typeof flag.server_id_hash === "string" &&
        /^[0-9a-f]{16}$/.test(flag.server_id_hash) &&
        typeof flag.always_load === "boolean",
    );
    if (typeof parsed.configured_value !== "string" && parsed.configured_value !== null) {
      return null;
    }
    if (
      typeof parsed.always_load_count !== "number" ||
      typeof parsed.always_load_flags_truncated !== "boolean" ||
      typeof parsed.catalog_item_count !== "number" ||
      typeof parsed.catalog_item_count_truncated !== "boolean" ||
      (typeof parsed.catalog_hash !== "string" && parsed.catalog_hash !== null)
    ) {
      return null;
    }
    return {
      tool_search_mode: mode,
      effective_catalog_state: effective,
      configured_value: parsed.configured_value,
      always_load_flags: flags.slice(0, MAX_ALWAYS_LOAD_FLAGS),
      always_load_count: parsed.always_load_count,
      always_load_flags_truncated: parsed.always_load_flags_truncated,
      catalog_item_count: parsed.catalog_item_count,
      catalog_item_count_truncated: parsed.catalog_item_count_truncated,
      catalog_hash: parsed.catalog_hash,
    };
  } catch {
    return null;
  }
}

/** Deterministic probe_id: "probe-" + sha1(workspace_id|component|file_ref).slice(0,16). */
export function makeProbeId(workspaceId: string, component: Component, fileRef: string): string {
  const hash = crypto
    .createHash("sha1")
    .update(`${workspaceId}|${component}|${fileRef}`)
    .digest("hex")
    .slice(0, 16);
  return `probe-${hash}`;
}

/** Read a file, returning its UTF-8 text, or null if missing/unreadable. */
export function tryReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Read only MEMORY.md, capped at 200 lines and then 25,600 UTF-8 bytes. */
export function readMemoryDir(dir: string): string | null {
  const content = tryReadFile(path.join(dir, "MEMORY.md"));
  if (content === null) return null;

  const firstLines = content.split("\n").slice(0, 200).join("\n");
  const maxBytes = 25_600;
  if (Buffer.byteLength(firstLines, "utf8") <= maxBytes) return firstLines;

  let bytes = 0;
  let end = 0;
  for (const character of firstLines) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return firstLines.slice(0, end);
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns a flat key→value map, or null if no frontmatter block is present.
 * Values `true`/`false` are returned as booleans; everything else as strings.
 */
export function parseFrontmatter(content: string): Record<string, string | boolean> | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("---", 3);
  if (end === -1) return null;
  const block = content.slice(3, end).trim();
  const result: Record<string, string | boolean> = {};
  for (const line of block.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (val === "true") result[key] = true;
    else if (val === "false") result[key] = false;
    else result[key] = val;
  }
  return result;
}

/**
 * Load the `enabledPlugins` map from ~/.claude/settings.json.
 * Returns a map of plugin-key → boolean (true = enabled, false = disabled).
 * Returns an empty map if settings.json is absent, unreadable, or has no enabledPlugins key.
 */
function loadEnabledPlugins(claudeDir: string): Map<string, boolean> {
  const settingsPath = path.join(claudeDir, "settings.json");
  const raw = tryReadFile(settingsPath);
  if (raw === null) return new Map();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return new Map();
    const ep = (parsed as Record<string, unknown>).enabledPlugins;
    if (!ep || typeof ep !== "object" || Array.isArray(ep)) return new Map();
    const result = new Map<string, boolean>();
    for (const [k, v] of Object.entries(ep as Record<string, unknown>)) {
      if (typeof v === "boolean") result.set(k, v);
    }
    return result;
  } catch {
    return new Map();
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface SettingsSnapshot {
  exists: boolean;
  value: Record<string, unknown>;
}

function readSettings(claudeDir: string): SettingsSnapshot {
  const raw = tryReadFile(path.join(claudeDir, "settings.json"));
  if (raw === null) return { exists: false, value: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    return { exists: true, value: isRecord(parsed) ? parsed : {} };
  } catch {
    return { exists: true, value: {} };
  }
}

function normalizeToolSearchSetting(value: unknown): {
  mode: ToolSearchMode;
  configuredValue: string | null;
} {
  if (value === undefined) return { mode: "deferred", configuredValue: null };
  const configuredValue =
    typeof value === "boolean"
      ? String(value)
      : typeof value === "string"
        ? value.trim().toLowerCase().slice(0, 32)
        : null;
  if (configuredValue === "true") return { mode: "deferred", configuredValue };
  if (configuredValue === "false") return { mode: "disabled", configuredValue };
  if (configuredValue === "auto" || /^auto:(?:[0-9]|[1-9][0-9]|100)$/.test(configuredValue ?? "")) {
    return { mode: "threshold", configuredValue };
  }
  return { mode: "unknown", configuredValue };
}

/** Collect only server-level flags; server names are hashed before persistence. */
function readAlwaysLoadFlags(settings: Record<string, unknown>): {
  flags: AlwaysLoadFlag[];
  truncated: boolean;
  alwaysLoadCount: number;
} {
  const flags = new Map<string, boolean>();
  const servers = settings.mcpServers;
  if (isRecord(servers)) {
    for (const [serverName, config] of Object.entries(servers)) {
      if (isRecord(config) && typeof config.alwaysLoad === "boolean") {
        flags.set(serverName, config.alwaysLoad);
      }
    }
  }

  // Accept a compact top-level map as well. This keeps the probe tolerant of
  // settings snapshots that flatten MCP server flags for diagnostics.
  const flattened = settings.alwaysLoad;
  if (isRecord(flattened)) {
    for (const [serverName, value] of Object.entries(flattened)) {
      if (typeof value === "boolean" && !flags.has(serverName)) flags.set(serverName, value);
    }
  }

  const entries = [...flags.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const truncated = entries.length > MAX_ALWAYS_LOAD_FLAGS;
  // Count over the full set, not the persisted 256-cap slice: effectiveCatalogState
  // must stay "alwaysLoad" even when every always-load server sorts past the cap.
  const alwaysLoadCount = entries.reduce((n, [, alwaysLoad]) => n + (alwaysLoad ? 1 : 0), 0);
  return {
    flags: entries.slice(0, MAX_ALWAYS_LOAD_FLAGS).map(([serverName, alwaysLoad]) => ({
      server_id_hash: sha1Hex(serverName).slice(0, 16),
      always_load: alwaysLoad,
    })),
    truncated,
    alwaysLoadCount,
  };
}

interface CatalogBuildResult {
  content: string;
  itemCount: number;
  itemCountTruncated: boolean;
  /** Per-item rows for catalog_items (skills, plugins, MCP servers). */
  items: CatalogItem[];
}

interface ToolSearchStateRecord {
  state: ToolSearchState;
  encoded: string;
  hash: string;
  settingsExists: boolean;
}

function buildToolSearchState(
  claudeDir: string,
  catalog: CatalogBuildResult,
): ToolSearchStateRecord | null {
  const settings = readSettings(claudeDir);
  if (!settings.exists && catalog.content.length === 0) return null;

  const env = isRecord(settings.value.env) ? settings.value.env : {};
  const configured =
    env.ENABLE_TOOL_SEARCH ?? settings.value.ENABLE_TOOL_SEARCH ?? settings.value.enableToolSearch;
  const normalized = normalizeToolSearchSetting(configured);
  const permissions = isRecord(settings.value.permissions) ? settings.value.permissions : {};
  const denied =
    Array.isArray(permissions.deny) && permissions.deny.some((entry) => entry === "ToolSearch");
  const toolSearchMode: ToolSearchMode = denied ? "disabled" : normalized.mode;
  const alwaysLoadResult = readAlwaysLoadFlags(settings.value);
  const alwaysLoadFlags = alwaysLoadResult.flags;
  const alwaysLoadCount = alwaysLoadResult.alwaysLoadCount;
  const effectiveCatalogState: CatalogLoadState =
    alwaysLoadCount > 0 ? "alwaysLoad" : toolSearchMode === "disabled" ? "upfront" : toolSearchMode;
  const catalogHash = catalog.content.length > 0 ? sha1Hex(catalog.content) : null;
  const state: ToolSearchState = {
    tool_search_mode: toolSearchMode,
    effective_catalog_state: effectiveCatalogState,
    configured_value: denied ? "denied" : normalized.configuredValue,
    always_load_flags: alwaysLoadFlags,
    always_load_count: alwaysLoadCount,
    always_load_flags_truncated: alwaysLoadResult.truncated,
    catalog_item_count: catalog.itemCount,
    catalog_item_count_truncated: catalog.itemCountTruncated,
    catalog_hash: catalogHash,
  };
  const encoded = encodeToolSearchState(state);
  return {
    state,
    encoded,
    hash: sha1Hex(encoded),
    settingsExists: settings.exists,
  };
}

/** Resolve an existing path only when its real path stays within `root`. */
export function resolveWithin(root: string, candidate: string): string | null {
  try {
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    const relative = path.relative(realRoot, realCandidate);
    if (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    ) {
      return realCandidate;
    }
  } catch {
    // Missing/unreadable roots and candidates are not catalogued.
  }
  return null;
}

/** One catalog entry recorded per item in catalog_items (U7 D10). */
export interface CatalogItem {
  kind: "skill" | "plugin" | "mcp_server";
  name: string;
  /** Owning plugin key (name@marketplace); null for user-level items. */
  plugin: string | null;
  /** Skill tool `skill` input, or the mcp__ tool-name prefix; null for plugins. */
  usageKey: string | null;
  /** Resident text sized with chars4; null when the size cannot be measured locally. */
  text: string | null;
  source: string;
  /** Plugin MCP servers only: the raw server config (in memory only; never written to the DB). */
  config?: Record<string, unknown>;
}

/** Plugin name as it prefixes its skills and MCP tools: the key before "@marketplace". */
function pluginShortName(pluginKey: string): string {
  const at = pluginKey.indexOf("@");
  return at > 0 ? pluginKey.slice(0, at) : pluginKey;
}

/** Add direct child skills from a skills directory in deterministic order. */
function appendSkills(
  parts: string[],
  skillsDir: string,
  boundaryRoot: string | null,
  seenSkillFiles: Set<string>,
  items: CatalogItem[],
  pluginKey: string,
): void {
  try {
    const entries = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
      const resolvedSkill = resolveWithin(boundaryRoot ?? skillsDir, skillMd);
      if (resolvedSkill === null || seenSkillFiles.has(resolvedSkill)) continue;
      const skillContent = tryReadFile(resolvedSkill);
      if (skillContent === null) continue;
      seenSkillFiles.add(resolvedSkill);
      const fm = parseFrontmatter(skillContent);
      if (fm !== null && fm.enabled === false) continue;
      const name = fm !== null && typeof fm.name === "string" ? fm.name : entry.name;
      const desc = fm !== null && typeof fm.description === "string" ? fm.description : "";
      const line = `skill:${name}${desc ? ` ${desc}` : ""}`;
      parts.push(line);
      // Plugin skills are invoked as "<plugin>:<skill>" (e.g. codex:rescue).
      const qualified = `${pluginShortName(pluginKey)}:${name}`;
      items.push({
        kind: "skill",
        name: qualified,
        plugin: pluginKey,
        usageKey: qualified,
        text: line,
        source: "plugin skill name+description (SKILL.md frontmatter)",
      });
    }
  } catch {
    // Missing/unreadable skills directories are skipped.
  }
}

/** MCP server configs (name-sorted) from a `{ mcpServers: {...} }` file or a bare server map. */
function mcpServerConfigs(
  raw: string | null,
  bareMapAllowed: boolean,
): [string, Record<string, unknown>][] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return [];
    const servers = isRecord(parsed.mcpServers)
      ? parsed.mcpServers
      : bareMapAllowed
        ? parsed
        : null;
    if (servers === null) return [];
    return Object.entries(servers)
      .filter((e): e is [string, Record<string, unknown>] => isRecord(e[1]))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [];
  }
}

/** MCP server names from a `{ mcpServers: {...} }` file or a bare server map. */
export function mcpServerNames(raw: string | null, bareMapAllowed: boolean): string[] {
  return mcpServerConfigs(raw, bareMapAllowed).map(([name]) => name);
}

const MCP_UNMEASURED_SOURCE =
  "tool schemas come from the running server and are not measurable from local files";

/**
 * Build the plugin/skill catalog text (ESTIMATE).
 *
 * Concatenates name+description from:
 *   - ~/.claude/plugins/installed_plugins.json (plugin list)
 *   - enabled plugin cache installPath/skills/ * /SKILL.md entries
 *   - ~/.claude/skills/ * /SKILL.md frontmatter (skill catalog)
 *
 * Plugins whose key appears in ~/.claude/settings.json `enabledPlugins` with value false
 * are excluded. Frontmatter `enabled: false` skill entries are also skipped.
 * The resulting string is sized in tokens; its content is never stored.
 */
function buildPluginCatalog(claudeDir: string, claudeJsonPath: string): CatalogBuildResult {
  const parts: string[] = [];
  const items: CatalogItem[] = [];
  const enabledPlugins = loadEnabledPlugins(claudeDir);
  // Installed is not enabled. Once settings.json switches any plugin on, a plugin it does not
  // list is off too (U9 D10: an installed-but-unlisted plugin was counted as loaded). With no
  // plugin switched on at all the map says nothing, so only an explicit false excludes.
  const anyEnabled = [...enabledPlugins.values()].some((on) => on);
  const pluginEnabled = (name: string): boolean => {
    const state = enabledPlugins.get(name);
    return state === undefined ? !anyEnabled : state;
  };
  const pluginCacheRoot = path.join(claudeDir, "plugins", "cache");
  // installPath -> plugin key (first key wins for a shared install path).
  const pluginInstallPaths = new Map<string, string>();
  const seenSkillFiles = new Set<string>();
  const pluginItem = (name: string, line: string): void => {
    parts.push(line);
    items.push({
      kind: "plugin",
      name,
      plugin: name,
      usageKey: null,
      text: line,
      source: "installed_plugins.json entry (+ its skills; enabledPlugins in settings.json)",
    });
  };

  // Plugins from installed_plugins.json
  const pluginsPath = path.join(claudeDir, "plugins", "installed_plugins.json");
  const pluginsRaw = tryReadFile(pluginsPath);
  if (pluginsRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(pluginsRaw);
      if (Array.isArray(parsed)) {
        for (const p of parsed) {
          if (isRecord(p)) {
            const name = p.name;
            const desc = p.description;
            if (typeof name === "string") {
              // Exclude plugins explicitly disabled in settings.json enabledPlugins
              if (!pluginEnabled(name)) continue;
              pluginItem(name, `plugin:${name}${typeof desc === "string" ? ` ${desc}` : ""}`);
            }
          }
        }
      } else if (
        isRecord(parsed) &&
        typeof parsed.version === "number" &&
        isRecord(parsed.plugins)
      ) {
        // Current Claude Code format: plugin key -> installation records.
        for (const [name, installs] of Object.entries(parsed.plugins).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        )) {
          if (!pluginEnabled(name)) continue;
          pluginItem(name, `plugin:${name}`);
          if (!Array.isArray(installs)) continue;
          for (const install of installs) {
            if (!isRecord(install) || typeof install.installPath !== "string") continue;
            const resolvedInstall = resolveWithin(pluginCacheRoot, install.installPath);
            if (resolvedInstall !== null && !pluginInstallPaths.has(resolvedInstall)) {
              pluginInstallPaths.set(resolvedInstall, name);
            }
          }
        }
      } else if (isRecord(parsed)) {
        for (const [name, info] of Object.entries(parsed).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        )) {
          // Exclude plugins explicitly disabled in settings.json enabledPlugins
          if (!pluginEnabled(name)) continue;
          const desc = isRecord(info) ? info.description : undefined;
          pluginItem(name, `plugin:${name}${typeof desc === "string" ? ` ${desc}` : ""}`);
        }
      }
    } catch {
      // Malformed JSON: include the raw bytes in the token estimate
      parts.push(pluginsRaw);
    }
  }

  // Plugin skills: traverse only cache installs named by installed_plugins.json.
  // Canonical-file deduplication prevents repeated installation records from counting the same skill.
  for (const installPath of [...pluginInstallPaths.keys()].sort()) {
    const pluginKey = pluginInstallPaths.get(installPath) as string;
    appendSkills(
      parts,
      path.join(installPath, "skills"),
      installPath,
      seenSkillFiles,
      items,
      pluginKey,
    );
    // Plugin-bundled MCP servers: tools are named mcp__plugin_<plugin>_<server>__*.
    const pluginMcp = resolveWithin(installPath, path.join(installPath, ".mcp.json"));
    const pluginServers = mcpServerConfigs(
      pluginMcp === null ? null : tryReadFile(pluginMcp),
      true,
    );
    for (const [server, config] of pluginServers) {
      const short = pluginShortName(pluginKey);
      items.push({
        kind: "mcp_server",
        name: `${short}:${server}`,
        plugin: pluginKey,
        usageKey: `mcp__plugin_${short}_${server}__`,
        text: null,
        source: `plugin .mcp.json; ${MCP_UNMEASURED_SOURCE}`,
        config,
      });
    }
  }

  // Standalone skills from ~/.claude/skills/*/SKILL.md frontmatter.
  const skillsDir = path.join(claudeDir, "skills");
  try {
    // Sort by name so the catalog string (and thus file_hash) is deterministic across
    // machines/re-probes — readdirSync order is filesystem-dependent.
    const entries = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
      const skillContent = tryReadFile(skillMd);
      if (skillContent === null) continue;
      const fm = parseFrontmatter(skillContent);
      // Skip explicitly disabled skills
      if (fm !== null && fm.enabled === false) continue;
      const name = fm !== null && typeof fm.name === "string" ? fm.name : entry.name;
      const desc = fm !== null && typeof fm.description === "string" ? fm.description : "";
      const line = `skill:${name}${desc ? ` ${desc}` : ""}`;
      parts.push(line);
      items.push({
        kind: "skill",
        name,
        plugin: null,
        usageKey: name,
        text: line,
        source: "~/.claude/skills SKILL.md frontmatter name+description",
      });
    }
  } catch {
    // skills directory missing or unreadable — skip
  }

  // User-level MCP servers (names only — never config content). Not part of the
  // catalog text: their schema size is not measurable from local files.
  const userServers = new Set([
    ...mcpServerNames(tryReadFile(path.join(claudeDir, "settings.json")), false),
    ...mcpServerNames(tryReadFile(claudeJsonPath), false),
  ]);
  for (const server of [...userServers].sort()) {
    items.push({
      kind: "mcp_server",
      name: server,
      plugin: null,
      usageKey: `mcp__${server}__`,
      text: null,
      source: `user mcpServers config; ${MCP_UNMEASURED_SOURCE}`,
    });
  }

  // Canonical-file and repeated-install deduplication happen above. Preserve distinct
  // catalog entries even when two skill files render the same name/description.
  const itemCountTruncated = parts.length > MAX_CATALOG_ITEMS;
  return {
    content: parts.sort().join("\n"),
    itemCount: Math.min(parts.length, MAX_CATALOG_ITEMS),
    itemCountTruncated,
    items: items.slice(0, MAX_CATALOG_ITEMS),
  };
}

/** Enabled plugins' bundled MCP servers ("<plugin>:<server>") with their raw config. */
export function pluginMcpServers(
  claudeDir: string,
  claudeJsonPath: string,
): { name: string; config: Record<string, unknown> }[] {
  return buildPluginCatalog(claudeDir, claudeJsonPath).items.flatMap((i) =>
    i.kind === "mcp_server" && i.config !== undefined ? [{ name: i.name, config: i.config }] : [],
  );
}

/**
 * Rewrite catalog_items with the current catalog. A plugin row's size is its own entry
 * plus every skill it ships (what disabling it would remove); MCP server rows are unmeasured.
 */
function writeCatalogItems(db: Db, items: CatalogItem[], probedAt: string): void {
  const pluginSkillBytes = new Map<string, number>();
  for (const item of items) {
    if (item.kind === "skill" && item.plugin !== null && item.text !== null) {
      pluginSkillBytes.set(
        item.plugin,
        (pluginSkillBytes.get(item.plugin) ?? 0) + Buffer.byteLength(item.text, "utf8") + 1,
      );
    }
  }
  db.prepare("DELETE FROM catalog_items").run();
  const insert = db.prepare(
    `INSERT OR REPLACE INTO catalog_items
       (item_id, kind, name, plugin, usage_key, tokens, bytes, size_basis, source, probed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of items) {
    let bytes: number | null = null;
    if (item.text !== null) {
      bytes = Buffer.byteLength(item.text, "utf8");
      if (item.kind === "plugin") bytes += pluginSkillBytes.get(item.name) ?? 0;
    }
    insert.run(
      `${item.kind}|${item.name}`,
      item.kind,
      item.name,
      item.plugin,
      item.usageKey,
      bytes === null ? null : Math.ceil(bytes / 4),
      bytes,
      bytes === null ? "unmeasured" : ATTRIBUTION_VERSION,
      item.source,
      probedAt,
    );
  }
}

/** Upsert one context_inventory row. Content is discarded after sizing/hashing (SEC-101).
 *
 * Also appends a row to context_inventory_history whenever the file_hash differs from the
 * previously recorded hash (one row per distinct version — bounded change-log, not one-per-probe).
 */
function upsertInventoryRow(
  db: Db,
  workspaceId: string,
  component: Component,
  fileRef: string,
  content: string,
  probedAt: string,
  measured: MeasuredCounts | null = null,
): void {
  const fileHash = sha1Hex(content);
  const measuredTokens = measured?.counts.get(fileHash);
  const tokens = measuredTokens ?? countTokens(content);
  const attribution =
    measuredTokens === undefined ? ATTRIBUTION_VERSION : (measured?.attribution as string);
  const probeId = makeProbeId(workspaceId, component, fileRef);

  // A new version is a changed file_hash (or a new source) or a changed sizing basis for the
  // same content, so history always carries the tokens the current row claims.
  const existing = db
    .prepare("SELECT file_hash, attribution_version FROM context_inventory WHERE probe_id = ?")
    .get(probeId) as { file_hash: string; attribution_version: string } | undefined;

  if (
    existing === undefined ||
    existing.file_hash !== fileHash ||
    existing.attribution_version !== attribution
  ) {
    db.prepare(
      `INSERT INTO context_inventory_history
         (workspace_id, component, file_ref, file_hash, tokens, attribution_version, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(workspaceId, component, fileRef, fileHash, tokens, attribution, probedAt);
  }

  db.prepare(
    `INSERT OR REPLACE INTO context_inventory
       (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(probeId, workspaceId, probedAt, component, fileRef, fileHash, tokens, attribution);
}

/** Upsert a bounded metadata-only inventory row (zero context tokens). */
function upsertInventoryMetadataRow(
  db: Db,
  workspaceId: string,
  component: Component,
  fileRef: string,
  metadata: string,
  attributionVersion: string,
  probedAt: string,
): void {
  const fileHash = sha1Hex(metadata);
  const probeId = makeProbeId(workspaceId, component, fileRef);
  const existing = db
    .prepare("SELECT file_hash FROM context_inventory WHERE probe_id = ?")
    .get(probeId) as { file_hash: string } | undefined;

  if (existing === undefined || existing.file_hash !== fileHash) {
    db.prepare(
      `INSERT INTO context_inventory_history
         (workspace_id, component, file_ref, file_hash, tokens, attribution_version, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(workspaceId, component, fileRef, fileHash, 0, attributionVersion, probedAt);
  }

  db.prepare(
    `INSERT OR REPLACE INTO context_inventory
       (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(probeId, workspaceId, probedAt, component, fileRef, fileHash, 0, attributionVersion);
}

/** Ensure the __global__ sentinel workspace row exists. */
function ensureGlobalWorkspace(db: Db, now: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, ?)`,
  ).run(GLOBAL_WORKSPACE_ID, GLOBAL_PROJECT_SLUG, now);
}

interface WorkspaceRow {
  workspace_id: string;
  project_slug: string;
  repo_path: string | null;
}

export interface ProbeResult {
  /** Number of context_inventory rows written (upserted). */
  rows: number;
}

/** Options for the probe — claudeDir is injectable for testing. */
export interface ProbeOptions {
  /**
   * Root of the Claude config directory. Defaults to `os.homedir()/.claude`.
   * Override in tests by passing a temp directory.
   */
  claudeDir?: string;
  /** Measured token counts file. Defaults to `~/.agentwrangler/measured-token-counts.json`. */
  measuredCountsFile?: string;
  /** User-level Claude config (holds `claude mcp add` servers). Defaults to `~/.claude.json`. */
  claudeJsonPath?: string;
}

/**
 * Run the ContextInventoryProbe: read always-loaded prefix sources, size each in
 * tokens, and upsert into context_inventory.  Never throws — wrap call sites in
 * try/catch for best-effort semantics.
 *
 * @param db       Open database (migrations applied).
 * @param now      Injected evaluation instant (used for probed_at and registered_at).
 * @param opts     Optional overrides (claudeDir for testing).
 */
export function runContextProbe(db: Db, now: Date, opts?: ProbeOptions): ProbeResult {
  const claudeDir = opts?.claudeDir ?? path.join(os.homedir(), ".claude");
  const probedAt = now.toISOString();
  const measured = readMeasuredCounts(
    opts?.measuredCountsFile ??
      path.join(os.homedir(), ".agentwrangler", "measured-token-counts.json"),
  );
  let rows = 0;

  db.transaction(() => {
    // ── Ensure global sentinel workspace ────────────────────────────────────
    ensureGlobalWorkspace(db, probedAt);

    // ── 1. Global CLAUDE.md ─────────────────────────────────────────────────
    const globalClaudeMdPath = path.join(claudeDir, "CLAUDE.md");
    const globalClaudeMdContent = tryReadFile(globalClaudeMdPath);
    if (globalClaudeMdContent !== null) {
      upsertInventoryRow(
        db,
        GLOBAL_WORKSPACE_ID,
        "CLAUDE_MD",
        globalClaudeMdPath,
        globalClaudeMdContent,
        probedAt,
        measured,
      );
      rows++;
    }

    // ── 2. Plugin/skill catalog (ESTIMATE) ──────────────────────────────────
    const catalog = buildPluginCatalog(
      claudeDir,
      opts?.claudeJsonPath ?? path.join(os.homedir(), ".claude.json"),
    );
    writeCatalogItems(db, catalog.items, probedAt);
    const catalogRef = path.join(claudeDir, "plugins", "skill-catalog");
    if (catalog.content.length > 0) {
      // Synthetic stable file_ref — not a real file path (catalog is derived)
      upsertInventoryRow(
        db,
        GLOBAL_WORKSPACE_ID,
        "MCP_SCHEMAS",
        catalogRef,
        catalog.content,
        probedAt,
      );
      rows++;
    }

    // Store only normalized state metadata. The zero token count keeps config
    // facts out of always-loaded context totals, while the hash makes changes
    // auditable without retaining settings or catalog text.
    const toolSearchState = buildToolSearchState(claudeDir, catalog);
    const settingsRef = path.join(claudeDir, "settings.json");
    if (toolSearchState !== null) {
      upsertInventoryMetadataRow(
        db,
        GLOBAL_WORKSPACE_ID,
        "SETTINGS_SYSTEM",
        settingsRef,
        toolSearchState.encoded,
        toolSearchState.encoded,
        probedAt,
      );
      rows++;
    } else {
      // This state must not survive removal of both settings and catalog
      // inputs or D10 could report stale behavior.
      db.prepare("DELETE FROM context_inventory WHERE probe_id = ?").run(
        makeProbeId(GLOBAL_WORKSPACE_ID, "SETTINGS_SYSTEM", settingsRef),
      );
    }

    // ── 3. Per-workspace sources ─────────────────────────────────────────────
    const workspaces = db
      .prepare(
        `SELECT workspace_id, project_slug, repo_path FROM workspaces
         WHERE workspace_id != ?`,
      )
      .all(GLOBAL_WORKSPACE_ID) as WorkspaceRow[];

    for (const ws of workspaces) {
      // 3a. Project memory (capped prefix of memory/MEMORY.md)
      const memoryDir = path.join(claudeDir, "projects", ws.project_slug, "memory");
      const memoryContent = readMemoryDir(memoryDir);
      if (memoryContent !== null) {
        upsertInventoryRow(
          db,
          ws.workspace_id,
          "MEMORY",
          memoryDir,
          memoryContent,
          probedAt,
          measured,
        );
        rows++;
      }

      // 3b. Project CLAUDE.md (when repo_path is set and file exists)
      if (ws.repo_path) {
        const projectClaudeMdPath = path.join(ws.repo_path, "CLAUDE.md");
        const projectClaudeMdContent = tryReadFile(projectClaudeMdPath);
        if (projectClaudeMdContent !== null) {
          upsertInventoryRow(
            db,
            ws.workspace_id,
            "CLAUDE_MD",
            projectClaudeMdPath,
            projectClaudeMdContent,
            probedAt,
            measured,
          );
          rows++;
        }
      }
    }
  })();

  return { rows };
}
