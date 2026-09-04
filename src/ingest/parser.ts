/**
 * src/ingest/parser.ts — per-line SEC-101 projection.
 *
 * projectLine() parses one JSONL line and returns a structural projection:
 * tokens, ids, sizes, model, and markers only. Content (message text, tool
 * inputs/outputs) is read solely to measure size or extract a commit SHA, then
 * discarded — nothing content-bearing is returned or stored.
 *
 * Failure handling (Spec §1.2): a line that fails JSON parse, or a usage record
 * missing a required field (dedupe key or timestamp), becomes a quarantine
 * pointer (no content). Unknown top-level fields are tolerated and counted.
 */

import * as crypto from "node:crypto";
import {
  type CommandProjection,
  PARSER_VERSION,
  type ParseResult,
  type ToolEventProjection,
  type ToolResultProjection,
  type TurnProjection,
} from "./types.js";

export { PARSER_VERSION };

export interface ParseContext {
  /** Fallback session id (filename stem) when the record carries none. */
  defaultSessionId: string;
}

/**
 * Extended record shape: fields never carry content into the projection, but a
 * `record` result additionally reports unknown top-level fields for health.
 */
export type LineProjection =
  | (Extract<ParseResult, { kind: "record" }> & {
      unknownFields: string[];
      sessionId: string;
      cwd: string | null;
    })
  | Extract<ParseResult, { kind: "quarantine" }>;

/** Top-level fields the parser recognises. Anything else is tolerated + counted. */
const KNOWN_TOP_LEVEL = new Set([
  "type",
  "subtype",
  "timestamp",
  "uuid",
  "parentUuid",
  "logicalParentUuid",
  "leafUuid",
  "sessionId",
  "session_id",
  "isSidechain",
  "message",
  "command",
  "name",
  "content",
  "summary",
  "cwd",
  "version",
  "gitBranch",
  "userType",
  "requestId",
  "toolUseResult",
  "toolUseID",
  "promptSource",
  "isMeta",
  "isCompactSummary",
  "isApiErrorMessage",
  "isVisibleInTranscriptOnly",
  "level",
]);

const SHA_RE = /\b[0-9a-f]{40}\b/;
const GIT_WRITE_RE = /\bgit\s+(commit|push)\b/;
const TEST_COMMAND_RE =
  /^(?:(?:npm|pnpm|yarn)\s+(?:test|run\s+test(?::[\w.-]+)?)|bun\s+test|(?:npx\s+)?vitest(?:\s+run)?|pytest|python\s+-m\s+pytest|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|\.\/gradlew\s+test)(?:\s|$)/;

/** Project one JSONL line into its structural parts. */
export function projectLine(rawLine: string, ctx: ParseContext): LineProjection {
  let d: unknown;
  try {
    d = JSON.parse(rawLine);
  } catch (e) {
    return { kind: "quarantine", errorClass: classifyJsonError(e) };
  }
  if (typeof d !== "object" || d === null || Array.isArray(d)) {
    return { kind: "quarantine", errorClass: "NOT_OBJECT" };
  }
  const rec = d as Record<string, unknown>;

  const unknownFields = Object.keys(rec).filter((k) => !KNOWN_TOP_LEVEL.has(k));

  const sessionId = resolveSessionId(rec, ctx);
  const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;
  const cwd = typeof rec.cwd === "string" ? rec.cwd : null;
  const message = isObject(rec.message) ? (rec.message as Record<string, unknown>) : null;
  const isCompactSummary = rec.isCompactSummary === true;
  const isApiErrorMessage = rec.isApiErrorMessage === true;
  const isInterrupt = false;

  const toolEvents: ToolEventProjection[] = [];
  const toolResults: ToolResultProjection[] = [];
  let command = extractCommand(rec, sessionId, ts);

  // Tool blocks live in message.content arrays (assistant tool_use, user tool_result).
  if (message && Array.isArray(message.content)) {
    let idx = 0;
    for (const block of message.content) {
      if (!isObject(block)) {
        idx++;
        continue;
      }
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use") {
        toolEvents.push(projectToolUse(b, sessionId, ts, idx, resolveMessageId(message, rec)));
      } else if (b.type === "tool_result") {
        toolResults.push(projectToolResult(b, sessionId));
      }
      idx++;
    }
  }

  const isUserTurn =
    rec.type === "user" &&
    (rec.promptSource === "typed" || rec.promptSource === "queued") &&
    toolResults.length === 0 &&
    rec.isMeta !== true;

  // A user record whose content is a bare slash command is also a hygiene marker.
  if (command === null && rec.type === "user" && message && typeof message.content === "string") {
    const c = message.content;
    if (c === "/clear" || c === "/compact") {
      command = { sessionId, ts: ts ?? "", command: c };
    }
  }

  // Usage record → candidate turn.
  const usage =
    message && isObject(message.usage) ? (message.usage as Record<string, unknown>) : null;
  if (usage === null) {
    return {
      kind: "record",
      sessionId,
      turn: null,
      toolEvents,
      toolResults,
      command,
      synthetic: false,
      isUserTurn,
      isCompactSummary,
      isApiErrorMessage,
      isInterrupt,
      ts,
      unknownFields,
      cwd,
    };
  }

  const model = typeof message?.model === "string" ? message.model : null;
  if (model === null || model === "" || model === "<synthetic>") {
    // Synthetic / empty-model: excluded from cost, counted in health. Not a turn.
    return {
      kind: "record",
      sessionId,
      turn: null,
      toolEvents,
      toolResults,
      command,
      synthetic: true,
      isUserTurn,
      isCompactSummary,
      isApiErrorMessage,
      isInterrupt,
      ts,
      unknownFields,
      cwd,
    };
  }

  const dedupeId =
    typeof message?.id === "string" ? message.id : typeof rec.uuid === "string" ? rec.uuid : null;
  if (dedupeId === null || ts === null) {
    return { kind: "quarantine", errorClass: "MISSING_REQUIRED" };
  }

  const turn = projectTurn(dedupeId, sessionId, ts, model, rec, usage);
  return {
    kind: "record",
    sessionId,
    turn,
    toolEvents,
    toolResults,
    command,
    synthetic: false,
    isUserTurn,
    isCompactSummary,
    isApiErrorMessage,
    isInterrupt,
    ts,
    unknownFields,
    cwd,
  };
}

function projectTurn(
  messageId: string,
  sessionId: string,
  ts: string,
  model: string,
  rec: Record<string, unknown>,
  usage: Record<string, unknown>,
): TurnProjection {
  const cacheCreation = isObject(usage.cache_creation)
    ? (usage.cache_creation as Record<string, unknown>)
    : null;
  const c5 = num(cacheCreation?.ephemeral_5m_input_tokens);
  const c1 = num(cacheCreation?.ephemeral_1h_input_tokens);
  const cwTotal = num(usage.cache_creation_input_tokens);
  const cwOther = Math.max(0, cwTotal - c5 - c1);
  const outputTokensDetails = isObject(usage.output_tokens_details)
    ? (usage.output_tokens_details as Record<string, unknown>)
    : null;

  const message = rec.message as Record<string, unknown>;
  const effort =
    typeof message.effort === "string"
      ? message.effort
      : typeof rec.effort === "string"
        ? rec.effort
        : null;

  return {
    messageId,
    sessionId,
    ts,
    model,
    isSidechain: rec.isSidechain === true,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    thinkingTokens: num(outputTokensDetails?.thinking_tokens, null),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWrite5m: c5,
    cacheWrite1h: c1,
    cacheWriteOther: cwOther,
    effort,
  };
}

function projectToolUse(
  b: Record<string, unknown>,
  sessionId: string,
  ts: string | null,
  idx: number,
  ownerMessageId: string | null,
): ToolEventProjection {
  const toolName = typeof b.name === "string" ? b.name : "";
  const toolUseId = typeof b.id === "string" ? b.id : null;
  const inputBytes = b.input != null ? JSON.stringify(b.input).length : null;
  const inputHash =
    b.input != null ? hashSha256(canonicalJson(normalizeToolInputPaths(b.input))) : null;
  const input = isObject(b.input) ? (b.input as Record<string, unknown>) : null;
  const filePathHash =
    typeof input?.file_path === "string" ? hashSha256(normalizeFilePath(input.file_path)) : null;
  let gitCommandHint = false;
  let testCommandHint = false;
  if (toolName === "Bash" && input !== null) {
    const cmd = input.command;
    if (typeof cmd === "string") gitCommandHint = GIT_WRITE_RE.test(cmd);
    if (typeof cmd === "string") testCommandHint = isTestCommand(cmd);
  }
  const eventId = toolUseId ?? hashId(`${sessionId}|${ts ?? ""}|${toolName}|${idx}`);
  return {
    eventId,
    toolUseId,
    sessionId,
    ts: ts ?? "",
    toolName,
    inputBytes,
    inputHash,
    filePathHash,
    ownerMessageId,
    blockIndex: idx,
    gitCommandHint,
    testCommandHint,
  };
}

function projectToolResult(b: Record<string, unknown>, sessionId: string): ToolResultProjection {
  const toolUseId = typeof b.tool_use_id === "string" ? b.tool_use_id : null;
  let resultBytes = 0;
  let commitSha: string | null = null;
  const content = b.content;
  if (typeof content === "string") {
    resultBytes = content.length;
    const m = SHA_RE.exec(content);
    if (m) commitSha = m[0];
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (isObject(c) && typeof (c as Record<string, unknown>).text === "string") {
        const text = (c as Record<string, unknown>).text as string;
        resultBytes += text.length;
        if (commitSha === null) {
          const m = SHA_RE.exec(text);
          if (m) commitSha = m[0];
        }
      }
    }
  }
  return { toolUseId, sessionId, resultBytes, commitSha, isError: b.is_error === true };
}

/** Deliberately anchored: prose and compound shell setup are not classified as tests. */
export function isTestCommand(command: string): boolean {
  return TEST_COMMAND_RE.test(command.trim());
}

/** Stable JSON representation for privacy-safe near-duplicate hashes. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Normalize path-bearing fields before hashing while retaining no raw projection. */
function normalizeToolInputPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeToolInputPaths(item));
  if (!isObject(value)) return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    normalized[key] =
      key === "file_path" && typeof item === "string"
        ? normalizeFilePath(item)
        : normalizeToolInputPaths(item);
  }
  return normalized;
}

/** Lexically normalize separators and dot segments without retaining the path. */
function normalizeFilePath(filePath: string): string {
  const slashPath = filePath.replace(/\\/g, "/");
  const prefix = slashPath.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of slashPath.split("/")) {
    if (part === "" || part === ".") continue;
    const atDriveRoot = parts.length === 1 && /^[A-Za-z]:$/.test(parts[0] ?? "");
    if (part === ".." && parts.length > 0 && parts.at(-1) !== ".." && !atDriveRoot) {
      parts.pop();
    } else if (part !== ".." || (prefix === "" && !atDriveRoot)) {
      parts.push(part);
    }
  }
  if (/^[A-Za-z]:$/.test(parts[0] ?? "")) parts[0] = parts[0]?.toLowerCase() ?? "";
  return `${prefix}${parts.join("/")}` || prefix;
}

function hashSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function resolveMessageId(
  message: Record<string, unknown>,
  rec: Record<string, unknown>,
): string | null {
  if (typeof message.id === "string") return message.id;
  return typeof rec.uuid === "string" ? rec.uuid : null;
}

function extractCommand(
  rec: Record<string, unknown>,
  sessionId: string,
  ts: string | null,
): CommandProjection | null {
  if (
    rec.type === "system" &&
    (rec.subtype === "local_command" || rec.subtype === "away_summary")
  ) {
    const raw = typeof rec.command === "string" ? rec.command : String(rec.subtype);
    return { sessionId, ts: ts ?? "", command: raw };
  }
  return null;
}

function resolveSessionId(rec: Record<string, unknown>, ctx: ParseContext): string {
  // Prefer session_id, then sessionId, else the filename stem.
  if (typeof rec.session_id === "string" && rec.session_id.length > 0) return rec.session_id;
  if (typeof rec.sessionId === "string" && rec.sessionId.length > 0) return rec.sessionId;
  return ctx.defaultSessionId;
}

function classifyJsonError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return `JSON_${msg.slice(0, 24).replace(/[^\w]/g, "_")}`.slice(0, 40);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number;
function num(v: unknown, fallback: null): number | null;
function num(v: unknown, fallback: number | null = 0): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function hashId(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 24);
}
