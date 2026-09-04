/**
 * src/detector/context-probe.ts — ContextInventoryProbe.
 *
 * Reads the always-loaded prefix sources, sizes each in tokens via
 * Math.ceil(utf8_bytes / 4) (attribution_version = "chars4-v1"), and writes
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
 *                                      (component: MCP_SCHEMAS)
 *     - Tool-Search config state from ~/.claude/settings.json (component:
 *       SETTINGS_SYSTEM; state metadata only, never settings content)
 *   PER-WORKSPACE (real workspace_id):
 *     - ~/.claude/projects/<slug>/memory/ * .md  (component: MEMORY; sum)
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
function tryReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Read all *.md files in `dir`, sorted, and return their concatenated content. */
function readMemoryDir(dir: string): string | null {
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const parts: string[] = [];
  for (const f of files) {
    const content = tryReadFile(path.join(dir, f));
    if (content !== null) parts.push(content);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns a flat key→value map, or null if no frontmatter block is present.
 * Values `true`/`false` are returned as booleans; everything else as strings.
 */
function parseFrontmatter(content: string): Record<string, string | boolean> | null {
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

function isRecord(value: unknown): value is Record<string, unknown> {
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
function resolveWithin(root: string, candidate: string): string | null {
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

/** Add direct child skills from a skills directory in deterministic order. */
function appendSkills(
  parts: string[],
  skillsDir: string,
  boundaryRoot: string | null,
  seenSkillFiles: Set<string>,
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
      parts.push(`skill:${name}${desc ? ` ${desc}` : ""}`);
    }
  } catch {
    // Missing/unreadable skills directories are skipped.
  }
}

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
function buildPluginCatalog(claudeDir: string): CatalogBuildResult {
  const parts: string[] = [];
  const enabledPlugins = loadEnabledPlugins(claudeDir);
  const pluginCacheRoot = path.join(claudeDir, "plugins", "cache");
  const pluginInstallPaths: string[] = [];
  const seenSkillFiles = new Set<string>();

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
              if (enabledPlugins.get(name) === false) continue;
              parts.push(`plugin:${name}${typeof desc === "string" ? ` ${desc}` : ""}`);
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
          if (enabledPlugins.get(name) === false) continue;
          parts.push(`plugin:${name}`);
          if (!Array.isArray(installs)) continue;
          for (const install of installs) {
            if (!isRecord(install) || typeof install.installPath !== "string") continue;
            const resolvedInstall = resolveWithin(pluginCacheRoot, install.installPath);
            if (resolvedInstall !== null) pluginInstallPaths.push(resolvedInstall);
          }
        }
      } else if (isRecord(parsed)) {
        for (const [name, info] of Object.entries(parsed).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        )) {
          // Exclude plugins explicitly disabled in settings.json enabledPlugins
          if (enabledPlugins.get(name) === false) continue;
          const desc = isRecord(info) ? info.description : undefined;
          parts.push(`plugin:${name}${typeof desc === "string" ? ` ${desc}` : ""}`);
        }
      }
    } catch {
      // Malformed JSON: include the raw bytes in the token estimate
      parts.push(pluginsRaw);
    }
  }

  // Plugin skills: traverse only cache installs named by installed_plugins.json.
  // Canonical-file deduplication prevents repeated installation records from counting the same skill.
  for (const installPath of [...new Set(pluginInstallPaths)].sort()) {
    appendSkills(parts, path.join(installPath, "skills"), installPath, seenSkillFiles);
  }

  // Standalone skills from ~/.claude/skills/*/SKILL.md frontmatter.
  const skillsDir = path.join(claudeDir, "skills");
  try {
    // Sort by name so the catalog string (and thus file_hash) is deterministic across
    // machines/re-probes — readdirSync order is filesystem-dependent (matches readMemoryDir).
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
      parts.push(`skill:${name}${desc ? ` ${desc}` : ""}`);
    }
  } catch {
    // skills directory missing or unreadable — skip
  }

  // Canonical-file and repeated-install deduplication happen above. Preserve distinct
  // catalog entries even when two skill files render the same name/description.
  const itemCountTruncated = parts.length > MAX_CATALOG_ITEMS;
  return {
    content: parts.sort().join("\n"),
    itemCount: Math.min(parts.length, MAX_CATALOG_ITEMS),
    itemCountTruncated,
  };
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
): void {
  const tokens = countTokens(content);
  const fileHash = sha1Hex(content);
  const probeId = makeProbeId(workspaceId, component, fileRef);

  // Check whether file_hash has changed from the stored value (or this is a new source).
  const existing = db
    .prepare("SELECT file_hash FROM context_inventory WHERE probe_id = ?")
    .get(probeId) as { file_hash: string } | undefined;

  if (existing === undefined || existing.file_hash !== fileHash) {
    db.prepare(
      `INSERT INTO context_inventory_history
         (workspace_id, component, file_ref, file_hash, tokens, attribution_version, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(workspaceId, component, fileRef, fileHash, tokens, ATTRIBUTION_VERSION, probedAt);
  }

  db.prepare(
    `INSERT OR REPLACE INTO context_inventory
       (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(probeId, workspaceId, probedAt, component, fileRef, fileHash, tokens, ATTRIBUTION_VERSION);
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
      );
      rows++;
    }

    // ── 2. Plugin/skill catalog (ESTIMATE) ──────────────────────────────────
    const catalog = buildPluginCatalog(claudeDir);
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
      // 3a. Project memory (sum of all *.md under memory/)
      const memoryDir = path.join(claudeDir, "projects", ws.project_slug, "memory");
      const memoryContent = readMemoryDir(memoryDir);
      if (memoryContent !== null) {
        upsertInventoryRow(db, ws.workspace_id, "MEMORY", memoryDir, memoryContent, probedAt);
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
          );
          rows++;
        }
      }
    }
  })();

  return { rows };
}
