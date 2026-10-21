/**
 * src/query/api/judge-payload.ts — the "Judge me" payload (JMS-P2 U8).
 *
 * The ONLY data that may leave the machine for the LLM setup review. Governed by the ADR-112
 * amendment 2026-10-13: change `ALLOW_LIST` only after that table is amended.
 *
 * Narrow by exclusion: value-bearing fields (MCP args/env/headers/URLs, full hook commands,
 * settings env values) are never read into the payload. Auto-memory and transcripts are never
 * read at all. Every free-text string left (CLAUDE.md text, names, matchers, executable and
 * script basenames, env key names) goes through detect-then-block, then the identity scrub.
 * `assertAllowListed` runs on the result and throws on any key outside the frozen shape.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { isRecord, pluginMcpServers, tryReadFile } from "../../detector/context-probe.js";
import type { SetupGrade } from "../../detector/setup-grade.js";
import {
  type IdentityContext,
  type ScrubClass,
  type SecretClass,
  detectSecrets,
  scrubIdentity,
} from "./judge-payload-scrub.js";

export const JUDGE_PAYLOAD_ALLOW_LIST_VERSION = "jms-payload-v1";
/** Safety cap only: Claude Code already loads the whole file each session, so send it whole. */
export const CLAUDE_MD_EXCERPT_MAX_CHARS = 50_000;
/** Raw text scanned for secrets past the cap, so a secret cut by the cap still blocks. */
const DETECT_OVERSCAN_CHARS = 256;
export const MAX_PROJECT_CLAUDE_MD = 5;

type Scope = "user" | "project";
type McpScope = Scope | "plugin";

export interface JudgeSources {
  settings: { scope: Scope; raw: unknown }[];
  mcp: { scope: McpScope; raw: unknown }[];
  claudeMd: { source: string; text: string }[];
}

export interface JudgePayload {
  allow_list_version: string;
  scorecard: {
    rubric_version: string;
    tier: string | null;
    tier_by_score: string | null;
    overall: number | null;
    coverage: number;
    categories: { category: string; status: string; score: number | null }[];
    checks: { check_id: string; result: string; value: number | null; sample: number }[];
    gates: { gate_id: string; satisfied: boolean }[];
    caps: { check_id: string; tier: string; binding: boolean }[];
  };
  mcp_servers: {
    name: string;
    scope: McpScope;
    transport: string;
    location: "local" | "remote";
  }[];
  hooks: {
    scope: Scope;
    event: string;
    matcher: string | null;
    executable: string | null;
    script: string | null;
  }[];
  settings_env_keys: { scope: Scope; keys: string[] }[];
  claude_md: { source: string; excerpt: string; truncated: boolean }[];
}

type Spec = true | readonly [Spec] | { readonly [key: string]: Spec };

/** Frozen allow-list: every key the payload may carry. `true` = a primitive leaf. */
const ALLOW_LIST: Spec = Object.freeze({
  allow_list_version: true,
  scorecard: {
    rubric_version: true,
    tier: true,
    tier_by_score: true,
    overall: true,
    coverage: true,
    categories: [{ category: true, status: true, score: true }],
    checks: [{ check_id: true, result: true, value: true, sample: true }],
    gates: [{ gate_id: true, satisfied: true }],
    caps: [{ check_id: true, tier: true, binding: true }],
  },
  mcp_servers: [{ name: true, scope: true, transport: true, location: true }],
  hooks: [{ scope: true, event: true, matcher: true, executable: true, script: true }],
  settings_env_keys: [{ scope: true, keys: [true] }],
  claude_md: [{ source: true, excerpt: true, truncated: true }],
} as const);

function check(value: unknown, spec: Spec, at: string): void {
  if (spec === true) {
    if (value !== null && typeof value === "object") {
      throw new Error(`judge payload: "${at}" must be a primitive`);
    }
    return;
  }
  if (Array.isArray(spec)) {
    if (!Array.isArray(value)) throw new Error(`judge payload: "${at}" must be an array`);
    value.forEach((v, i) => check(v, spec[0] as Spec, `${at}[${i}]`));
    return;
  }
  if (!isRecord(value)) throw new Error(`judge payload: "${at}" must be an object`);
  const fields = spec as { readonly [key: string]: Spec };
  for (const [key, v] of Object.entries(value)) {
    const child = fields[key];
    const where = at ? `${at}.${key}` : key;
    if (child === undefined) {
      throw new Error(`judge payload: field "${where}" is not in the allow-list (ADR-112)`);
    }
    check(v, child, where);
  }
}

/** Throws on any key outside the frozen allow-list (fail closed). */
export function assertAllowListed(payload: unknown): asserts payload is JudgePayload {
  check(payload, ALLOW_LIST, "");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface JudgeBlock {
  source: string;
  match_class: SecretClass;
}

export type JudgeBuildResult =
  | {
      ok: true;
      payload: JudgePayload;
      /** Canonical bytes: what is shown on the consent screen and sent. */
      bytes: string;
      /** Per-run hash over `bytes`. */
      payloadHash: string;
      /** Don't-ask-again hash: config excerpts + versions + model, never scorecard numbers. */
      standingHash: string;
    }
  | { ok: false; blocked: JudgeBlock[] };

export interface JudgePayloadInput {
  grade: SetupGrade;
  rubricVersion: string;
  sources: JudgeSources;
  identity: IdentityContext;
  /** Operator-added names to scrub (e.g. a first name the OS and git identity miss). */
  extraNames?: readonly string[];
  modelId: string;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function mcpServer(config: Record<string, unknown>): {
  transport: string;
  location: "local" | "remote";
} {
  const declared = str(config.type);
  const url = str(config.url);
  const transport =
    declared === "stdio" || declared === "http" || declared === "sse"
      ? declared
      : str(config.command) !== null
        ? "stdio"
        : url !== null
          ? "http"
          : "unknown";
  if (transport === "stdio") return { transport, location: "local" };
  let host = "";
  try {
    host = url === null ? "" : new URL(url).hostname;
  } catch {
    // unparseable URL: treat as remote
  }
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  return { transport, location: local ? "local" : "remote" };
}

const SCRIPT_EXT = /\.(?:js|mjs|cjs|ts|py|sh|ps1)$/i;

function plainBasename(token: string): string | null {
  const base =
    token
      .replace(/^["']|["']$/g, "")
      .split(/[\\/]/)
      .at(-1) ?? "";
  return /^[A-Za-z0-9_][\w.+-]*$/.test(base) ? base : null;
}

/**
 * Basename of the program a hook command runs, plus the basename of its first script-file
 * argument (in the command or its `args` array); inline `VAR=value` prefixes, other args, paths
 * and URLs dropped. Both null when the first token is not a plain program name (inline shell
 * scripts, flags).
 */
function hookCommandParts(
  command: string,
  args: unknown,
): { executable: string | null; script: string | null } {
  const tokens = [
    ...(command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []),
    ...(Array.isArray(args) ? args.filter((a): a is string => typeof a === "string") : []),
  ];
  const at = tokens.findIndex((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) && t !== "env");
  const executable = at < 0 ? null : plainBasename(tokens[at] as string);
  if (executable === null) return { executable: null, script: null };
  for (const arg of tokens.slice(at + 1)) {
    if (arg.includes("://")) continue;
    const base = plainBasename(arg);
    if (base !== null && SCRIPT_EXT.test(base)) return { executable, script: base };
  }
  return { executable, script: null };
}

/** Build the payload, or report the secret classes that block it. Pure: no I/O. */
export function buildJudgePayload(input: JudgePayloadInput): JudgeBuildResult {
  const blocked: JudgeBlock[] = [];
  const redaction: Partial<Record<ScrubClass, number>> = {};
  const identity: IdentityContext = {
    home: input.identity.home,
    usernames: [...input.identity.usernames, ...(input.extraNames ?? [])],
  };
  const clean = (source: string, raw: string, scrubbed: string = raw): string => {
    for (const cls of detectSecrets(raw)) {
      if (!blocked.some((b) => b.source === source && b.match_class === cls)) {
        blocked.push({ source, match_class: cls });
      }
    }
    const r = scrubIdentity(scrubbed, identity);
    for (const [cls, n] of Object.entries(r.counts) as [ScrubClass, number][]) {
      redaction[cls] = (redaction[cls] ?? 0) + n;
    }
    return r.text;
  };

  const g = input.grade;
  const scorecard: JudgePayload["scorecard"] = {
    rubric_version: input.rubricVersion,
    tier: g.tier,
    tier_by_score: g.tier_by_score,
    overall: g.overall,
    coverage: g.coverage,
    categories: g.categories.map((c) => ({
      category: c.category,
      status: c.status,
      score: c.score,
    })),
    checks: g.checks.map((c) => ({
      check_id: c.check_id,
      result: c.result,
      value: c.value,
      sample: c.sample,
    })),
    gates: g.gates.map((x) => ({ gate_id: x.gate_id, satisfied: x.satisfied })),
    caps: g.caps.map((x) => ({ check_id: x.check_id, tier: x.tier, binding: x.binding })),
  };

  const mcp_servers: JudgePayload["mcp_servers"] = [];
  for (const { scope, raw } of input.sources.mcp) {
    if (!isRecord(raw) || !isRecord(raw.mcpServers)) continue;
    for (const [name, config] of Object.entries(raw.mcpServers)) {
      if (!isRecord(config)) continue;
      mcp_servers.push({
        name: clean(`MCP server name (${scope})`, name),
        scope,
        ...mcpServer(config),
      });
    }
  }

  const hooks: JudgePayload["hooks"] = [];
  const settings_env_keys: JudgePayload["settings_env_keys"] = [];
  for (const { scope, raw } of input.sources.settings) {
    if (!isRecord(raw)) continue;
    if (isRecord(raw.hooks)) {
      for (const [event, groups] of Object.entries(raw.hooks)) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
          if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
          const matcher = str(group.matcher);
          for (const hook of group.hooks) {
            if (!isRecord(hook)) continue;
            const command = hook.type === "command" ? str(hook.command) : null;
            const parts =
              command === null
                ? { executable: null, script: null }
                : hookCommandParts(command, hook.args);
            hooks.push({
              scope,
              event: clean(`hook event (${scope})`, event),
              matcher: matcher === null ? null : clean(`hook matcher (${scope})`, matcher),
              executable:
                parts.executable === null
                  ? null
                  : clean(`hook executable (${scope})`, parts.executable),
              script: parts.script === null ? null : clean(`hook script (${scope})`, parts.script),
            });
          }
        }
      }
    }
    if (isRecord(raw.env)) {
      settings_env_keys.push({
        scope,
        keys: Object.keys(raw.env).map((k) => clean(`settings env key (${scope})`, k)),
      });
    }
  }

  const claude_md: JudgePayload["claude_md"] = input.sources.claudeMd.map(({ source, text }) => {
    const label = `CLAUDE.md (${source})`;
    const window = text.slice(0, CLAUDE_MD_EXCERPT_MAX_CHARS + DETECT_OVERSCAN_CHARS);
    const scrubbed = clean(label, window, text.slice(0, CLAUDE_MD_EXCERPT_MAX_CHARS));
    const excerpt = scrubbed.slice(0, CLAUDE_MD_EXCERPT_MAX_CHARS);
    return {
      source,
      excerpt,
      truncated: text.length > CLAUDE_MD_EXCERPT_MAX_CHARS || scrubbed.length > excerpt.length,
    };
  });

  if (blocked.length > 0) return { ok: false, blocked };

  const payload: JudgePayload = {
    allow_list_version: JUDGE_PAYLOAD_ALLOW_LIST_VERSION,
    scorecard,
    mcp_servers,
    hooks,
    settings_env_keys,
    claude_md,
  };
  assertAllowListed(payload);

  const config = { mcp_servers, hooks, settings_env_keys, claude_md };
  const sourceClasses = Object.entries(config)
    .filter(([, v]) => v.length > 0)
    .map(([k]) => k);
  const bytes = canonical(payload);
  return {
    ok: true,
    payload,
    bytes,
    payloadHash: sha256(bytes),
    standingHash: sha256(
      canonical({
        allow_list_version: JUDGE_PAYLOAD_ALLOW_LIST_VERSION,
        rubric_version: input.rubricVersion,
        model_id: input.modelId,
        source_classes: sourceClasses,
        redaction_state: redaction,
        config,
      }),
    ),
  };
}

function readJson(filePath: string): unknown {
  const raw = tryReadFile(filePath);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export interface JudgeSourceOptions {
  claudeDir: string;
  claudeJsonPath: string;
  /** Scanned workspaces' repo roots, in scan order. */
  projectRepoPaths: readonly string[];
  /** Operator's included repos; when set, other repos send nothing. Unset = all scanned. */
  includedRepos?: readonly string[];
}

/** Read the raw config the payload is projected from. Never reads memory dirs or transcripts. */
export function readJudgeSources(opts: JudgeSourceOptions): JudgeSources {
  const sources: JudgeSources = { settings: [], mcp: [], claudeMd: [] };
  const userSettings = readJson(path.join(opts.claudeDir, "settings.json"));
  if (userSettings !== undefined) sources.settings.push({ scope: "user", raw: userSettings });
  const claudeJson = readJson(opts.claudeJsonPath);
  if (claudeJson !== undefined) sources.mcp.push({ scope: "user", raw: claudeJson });
  const plugin = pluginMcpServers(opts.claudeDir, opts.claudeJsonPath);
  if (plugin.length > 0) {
    const mcpServers = Object.fromEntries(plugin.map((s) => [s.name, s.config]));
    sources.mcp.push({ scope: "plugin", raw: { mcpServers } });
  }
  const userMd = tryReadFile(path.join(opts.claudeDir, "CLAUDE.md"));
  if (userMd !== null) sources.claudeMd.push({ source: "user", text: userMd });

  // ~/.claude.json keys projects by repo path, possibly with forward slashes on Windows.
  const norm = (p: string): string => {
    const s = path.resolve(p).replace(/\\/g, "/");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  const projects = new Map<string, unknown>();
  if (isRecord(claudeJson) && isRecord(claudeJson.projects)) {
    for (const [key, entry] of Object.entries(claudeJson.projects)) projects.set(norm(key), entry);
  }

  const included = opts.includedRepos === undefined ? null : new Set(opts.includedRepos.map(norm));
  let projectMd = 0;
  for (const repo of opts.projectRepoPaths) {
    if (included !== null && !included.has(norm(repo))) continue;
    const settings = readJson(path.join(repo, ".claude", "settings.json"));
    if (settings !== undefined) sources.settings.push({ scope: "project", raw: settings });
    const mcp = readJson(path.join(repo, ".mcp.json"));
    if (mcp !== undefined) sources.mcp.push({ scope: "project", raw: mcp });
    const project = projects.get(norm(repo));
    if (project !== undefined) sources.mcp.push({ scope: "project", raw: project });
    if (projectMd < MAX_PROJECT_CLAUDE_MD) {
      const text = tryReadFile(path.join(repo, "CLAUDE.md"));
      if (text !== null) sources.claudeMd.push({ source: `project ${++projectMd}`, text });
    }
  }
  return sources;
}
