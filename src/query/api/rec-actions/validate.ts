import fs from "node:fs";
import path from "node:path";
import type { RegisteredHandler } from "../../../effects/types.js";
import { type SettingsKeyEntry, settingsKeyVerdict } from "./settings-registry.js";
import type { CardAction } from "./types.js";

type Effect = "deny" | "ask" | "allow";
export type PermissionRules = Readonly<Record<Effect, readonly string[]>>;
export type ScopedPermissionRules = Readonly<Record<string, PermissionRules>>;

/** An effect outranks scope: deny > ask > allow. Scope breaks ties only. */
export function resolveEffectivePermission(
  rules: ScopedPermissionRules,
  pattern: string,
  scopes: readonly string[] = ["MANAGED", "CLI", "PROJECT_LOCAL", "PROJECT_SHARED", "USER"],
): { effect: Effect | "default"; scope: string | null } {
  for (const effect of ["deny", "ask", "allow"] as const) {
    for (const scope of scopes) {
      if (rules[scope]?.[effect].includes(pattern)) return { effect, scope };
    }
  }
  return { effect: "default", scope: null };
}

export interface ValidationOptions {
  fs?: { existsSync(path: string): boolean; statSync(path: string): { isFile(): boolean } };
  baseDir?: string;
  claudeCodeVersion?: string;
  registry?: readonly SettingsKeyEntry[];
  existingPermissions?: ScopedPermissionRules;
  /** The card's detector. Handlers are per detector, and detectors can share a metric name. */
  detectorId?: string;
}

/** `measured: false` marks a valid action whose target metric has no effect handler yet. */
export type ActionValidation = { ok: true; measured?: false } | { ok: false; reason: string };
const invalid = (reason: string): ActionValidation => ({ ok: false, reason });

function settingKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, child]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    if (name === "hooks") return [];
    if (name === "env" && child && typeof child === "object" && !Array.isArray(child)) {
      return Object.keys(child);
    }
    if (name === "permissions" && child && typeof child === "object" && !Array.isArray(child)) {
      return Object.keys(child).map((part) => `permissions.${part}`);
    }
    return settingKeys(child, name);
  });
}

function hookCommands(value: unknown): { commands: string[]; malformed: boolean } {
  if (!value || typeof value !== "object") return { commands: [], malformed: false };
  const parts = Array.isArray(value)
    ? value
    : Object.entries(value).map(([key, child]) => ({ key, child }));
  const result = { commands: [] as string[], malformed: false };
  for (const part of parts) {
    if (
      !Array.isArray(value) &&
      part &&
      typeof part === "object" &&
      "key" in part &&
      part.key === "command"
    ) {
      if (typeof part.child !== "string") result.malformed = true;
      else result.commands.push(part.child);
    } else {
      const nested = hookCommands(Array.isArray(value) ? part : (part as { child: unknown }).child);
      result.commands.push(...nested.commands);
      result.malformed ||= nested.malformed;
    }
  }
  return result;
}

function executable(command: string): string | null {
  const trimmed = command.trim();
  const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s|$)/.exec(trimmed);
  const program = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!program || !/^(?:[a-zA-Z]:[\\/]|[\\/]|\.\.?[\\/])/.test(program)) return null;
  return program;
}

function resolveFile(reference: string, baseDir: string): string | null {
  if (!reference.trim() || reference.includes("\0") || reference.startsWith("~")) return null;
  if (path.isAbsolute(reference)) return path.normalize(reference);
  const resolved = path.resolve(baseDir, reference);
  const relative = path.relative(baseDir, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return null;
  return resolved;
}

function isExistingFile(
  fileSystem: NonNullable<ValidationOptions["fs"]>,
  file: string | null,
): boolean {
  if (!file) return false;
  try {
    return fileSystem.existsSync(file) && fileSystem.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Fail closed on any missing metric, unverified setting, unresolved file, or hook command. A
 * missing effect handler does not withhold: the action is valid but reported `measured: false`.
 */
export function validateAction(
  action: CardAction,
  detectorMetric: string,
  handlers: readonly RegisteredHandler[],
  options: ValidationOptions = {},
): ActionValidation {
  if (!detectorMetric || action.target_metric !== detectorMetric)
    return invalid("target metric mismatch or missing");
  const measured = handlers.some(
    (handler) =>
      (options.detectorId === undefined || handler.detectorId === options.detectorId) &&
      (handler.target.metricId === detectorMetric || handler.aliases.includes(detectorMetric)),
  );
  const checked = checkArtifact(action, options);
  return checked.ok && !measured ? { ok: true, measured: false } : checked;
}

function checkArtifact(action: CardAction, options: ValidationOptions): ActionValidation {
  const fileSystem = options.fs ?? fs;
  const baseDir = path.resolve(options.baseDir ?? process.cwd());
  if ((action.kind === "CONFIG" || action.kind === "EDIT") && action.file_ref === null) {
    return invalid("configuration or edit action has no target file");
  }
  // A new subagent definition is created, so only its workspace must exist; it is Markdown, not JSON.
  const agentDefinition =
    action.kind === "CONFIG" &&
    /^\.claude[\\/]agents[\\/][^\\/]+\.md$/i.test(action.file_ref ?? "");
  // A new user-level skill is created under ~/.claude, which exists wherever Claude Code runs.
  const userSkill =
    action.kind === "EDIT" &&
    /^~[\\/]\.claude[\\/]skills[\\/][\w-]+[\\/]SKILL\.md$/.test(action.file_ref ?? "");
  if (action.file_ref !== null && !userSkill) {
    const file = resolveFile(action.file_ref, baseDir);
    if (
      agentDefinition
        ? file === null || !fileSystem.existsSync(baseDir)
        : !isExistingFile(fileSystem, file)
    )
      return invalid("file_ref does not resolve to an existing file");
  }

  const text = action.copy_text.trim();
  const settingsConfig = action.kind === "CONFIG" && !agentDefinition;
  const settingsEdit =
    action.kind === "EDIT" && /(?:^|[\\/])settings(?:\.local)?\.json$/i.test(action.file_ref ?? "");
  let parsed: unknown;
  // A settings change inside a Copy prompt is the prompt's ```json block.
  const fenced = /```json\n([\s\S]*?)\n```/.exec(text)?.[1]?.trim();
  const jsonText =
    (settingsConfig || settingsEdit) && !text.startsWith("{") && fenced !== undefined
      ? fenced
      : settingsEdit && !text.startsWith("{")
        ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
        : text;
  if (jsonText.startsWith("{") || jsonText.startsWith("[")) {
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return invalid("invalid settings or hook JSON");
    }
  }
  if ((settingsConfig || settingsEdit) && parsed === undefined)
    return invalid("settings artifact is not structured JSON");
  if (
    (settingsConfig || settingsEdit) &&
    (!parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length === 0)
  ) {
    return invalid("settings artifact must be a nonempty JSON object");
  }
  if (parsed !== undefined && (action.kind === "CONFIG" || action.kind === "EDIT")) {
    for (const key of settingKeys(parsed)) {
      if (settingsKeyVerdict(key, options.claudeCodeVersion, options.registry) !== "SUPPORTED") {
        return invalid(`settings key ${key} is UNKNOWN`);
      }
    }
  }
  if (
    (action.kind === "EDIT" || agentDefinition) &&
    /\bomitClaudeMd\s*:/.test(text) &&
    settingsKeyVerdict("omitClaudeMd", options.claudeCodeVersion, options.registry) !== "SUPPORTED"
  ) {
    return invalid("settings key omitClaudeMd is UNKNOWN");
  }

  if (action.hook || (parsed && typeof parsed === "object" && "hooks" in parsed)) {
    const { commands, malformed } = hookCommands(parsed);
    if (malformed) return invalid("hook command is malformed");
    if (commands.length === 0) return invalid("hook command is missing");
    for (const command of commands) {
      const program = executable(command);
      const file = program && resolveFile(program, baseDir);
      if (!isExistingFile(fileSystem, file)) return invalid("hook executable path does not exist");
    }
  }
  if (action.permission_rule && !options.existingPermissions) {
    return invalid("existing permission rules are unavailable");
  }
  if (action.permission_rule && options.existingPermissions) {
    const current = resolveEffectivePermission(
      options.existingPermissions,
      action.permission_rule.pattern,
    );
    if (
      action.permission_rule.mode === "allow" &&
      (current.effect === "deny" || current.effect === "ask")
    ) {
      return invalid(`existing ${current.effect} rule overrides permission snippet`);
    }
    if (action.permission_rule.mode === "ask" && current.effect === "deny") {
      return invalid("existing deny rule overrides permission snippet");
    }
  }
  return { ok: true };
}
