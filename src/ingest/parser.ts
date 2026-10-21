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
import { classifyDestructiveOp } from "./destructive.js";
import { redactSecrets } from "./secrets-filter.js";
import {
  PURE_INTERRUPT,
  classifyBashCommandFamily,
  classifyInterruptKind,
  classifyToolResultError,
  supportsToolErrorClassifierCatalog,
} from "./tool-error-classifier.js";
import {
  type BoundaryKind,
  type BoundaryVerification,
  type ClassifierLabel,
  type CommandProjection,
  type DestructiveOp,
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
      title: { value: string; source: "ai" | "custom" } | null;
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
  "toolDenialKind",
  "aiTitle",
  "customTitle",
]);

const SHA_RE = /\b[0-9a-f]{40}\b/;
/** git commit's summary line, `[<branch> <short sha>] <subject>`; the sha is expanded later (commit-linker). */
const SHORT_COMMIT_RE = /^\[[^\]\n]* ([0-9a-f]{7,12})\]/m;
/** `git [-C <path>|-c <k=v>]... commit|push`. */
const GIT_WRITE_RE = /\bgit(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))*\s+(commit|push)\b/;
/** A test run, or a `verify*` script (which runs the tests). Typecheck and lint alone do not count. */
const TEST_COMMAND_RE =
  /^(?:(?:npm|pnpm|yarn)\s+(?:--prefix\s+\S+\s+)?(?:test|t|run\s+(?:test|verify)(?::[\w.-]+)?)|bun\s+test|(?:npx\s+)?(?:vitest|jest|mocha)(?:\s+run)?|npx\s+playwright\s+test|node\s+--test|deno\s+test|pytest|python3?\s+-m\s+pytest|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+(?:test|verify)|gradle\s+test|\.\/gradlew\s+test)(?:\s|$)/;

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

  const titleField =
    rec.type === "custom-title" ? rec.customTitle : rec.type === "ai-title" ? rec.aiTitle : null;
  const titleValue = typeof titleField === "string" ? titleField.trim().slice(0, 200) : "";
  const title =
    titleValue === ""
      ? null
      : {
          value: titleValue,
          source: rec.type === "custom-title" ? ("custom" as const) : ("ai" as const),
        };

  const unknownFields = Object.keys(rec).filter((k) => !KNOWN_TOP_LEVEL.has(k));

  const sessionId = resolveSessionId(rec, ctx);
  const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;
  const cwd = typeof rec.cwd === "string" ? rec.cwd : null;
  const message = isObject(rec.message) ? (rec.message as Record<string, unknown>) : null;
  const isCompactSummary = rec.isCompactSummary === true;
  const isApiErrorMessage = rec.isApiErrorMessage === true;
  const isSidechain = rec.isSidechain === true;
  const ccVersion = typeof rec.version === "string" ? rec.version : null;
  const boundary = classifyBoundary(rec);

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
        toolEvents.push(
          projectToolUse(b, sessionId, ts, idx, resolveMessageId(message, rec), ccVersion),
        );
      } else if (b.type === "tool_result") {
        toolResults.push(projectToolResult(b, sessionId, ccVersion, rec.toolDenialKind));
      }
      idx++;
    }
  }

  const classification = classifyRecord(rec, message, ccVersion);
  // RC-D14: is_interrupt counts user Esc records (both variants) only, behind the same
  // version gate as the labels. Structural cancellations keep their label but are not a user Esc.
  const isInterrupt =
    selectDenialMatcherSet(ccVersion).matcherSet === "catalog-2.1" &&
    userInterruptVariant(rec, message) !== null;

  const isUserTurn =
    rec.type === "user" &&
    (rec.promptSource === "typed" || rec.promptSource === "queued") &&
    toolResults.length === 0 &&
    rec.isMeta !== true;

  // A user record whose content is a bare slash command is also a hygiene marker.
  if (command === null && rec.type === "user" && message && typeof message.content === "string") {
    const c = message.content;
    // Current transcripts wrap it: <command-name>/clear</command-name>. Only /clear and /compact emit.
    const tagged = /<command-name>\s*(\/clear|\/compact)\s*<\/command-name>/.exec(c);
    const name = c === "/clear" || c === "/compact" ? c : (tagged?.[1] ?? null);
    if (name !== null) {
      command = projectCommand(sessionId, ts ?? "", name);
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
      isSidechain,
      classifierLabel: classification.label,
      commandShape: classification.commandShape,
      destructiveOp: classification.destructiveOp,
      ccVersion,
      boundaryKind: boundary.kind,
      boundaryVerification: boundary.verification,
      ts,
      unknownFields,
      cwd,
      title,
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
      isSidechain,
      classifierLabel: classification.label,
      commandShape: classification.commandShape,
      destructiveOp: classification.destructiveOp,
      ccVersion,
      boundaryKind: boundary.kind,
      boundaryVerification: boundary.verification,
      ts,
      unknownFields,
      cwd,
      title,
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
    isSidechain,
    classifierLabel: classification.label,
    commandShape: classification.commandShape,
    destructiveOp: classification.destructiveOp,
    ccVersion,
    boundaryKind: boundary.kind,
    boundaryVerification: boundary.verification,
    ts,
    unknownFields,
    cwd,
    title,
  };
}

export interface DenialMatcherDispatch {
  /** The catalogued matcher family selected for this transcript line. */
  matcherSet: "catalog-2.1" | "default";
  /** Unknown versions need labeled-fixture review before they gain lexical matchers. */
  driftWatch: boolean;
}

/**
 * Select the matcher set before inspecting any transcript text. The catalog only
 * supports 2.1-series string shapes. Legacy records retain the historical 2.1
 * fallback; a tagged but unrecognised version deliberately uses the empty default
 * matcher set and is surfaced to the drift check.
 */
export function selectDenialMatcherSet(ccVersion: string | null): DenialMatcherDispatch {
  if (ccVersion === null || ccVersion.startsWith("2.1."))
    return { matcherSet: "catalog-2.1", driftWatch: false };
  return { matcherSet: "default", driftWatch: true };
}

/**
 * RC-D14: a user Esc record. Its content is exactly the marker, as a string or one text block
 * (never a tool_result: one that quotes the marker is a file read, not an interrupt).
 */
export function userInterruptVariant(
  rec: Record<string, unknown>,
  message: Record<string, unknown> | null,
): "plain" | "tool-use" | null {
  if (rec.type !== "user" || message === null) return null;
  const content = message.content;
  let text: unknown = null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content) && content.length === 1) {
    const [block] = content;
    if (isObject(block) && block.type === "text") text = block.text;
  }
  if (typeof text !== "string" || !PURE_INTERRUPT.test(text)) return null;
  return text.endsWith("for tool use]") ? "tool-use" : "plain";
}

/** Version-gated lexical matching; values are inspected then immediately discarded. */
export function classifyDenial(
  rec: Record<string, unknown>,
  message: Record<string, unknown> | null,
  ccVersion: string | null,
): ClassifierLabel | null {
  // The default set intentionally contains no unvalidated lexical strings.
  if (selectDenialMatcherSet(ccVersion).matcherSet === "default") return null;
  const kind = typeof rec.toolDenialKind === "string" ? rec.toolDenialKind : "";
  const texts = contentTexts(message);
  const errored = hasErroredToolResult(message);
  // RC-D14: an Esc is its own user record. The "for tool use" variant trails a rejected
  // tool_result that already carries the denial, so it gets no label of its own.
  const esc = userInterruptVariant(rec, message);
  if (esc === "tool-use") return null;
  if (
    esc === "plain" ||
    kind === "cancelled" ||
    kind === "interrupted" ||
    texts.some((x) => x.startsWith("The user doesn't want to take this action right now"))
  )
    return "interrupt-cancel";
  if (!errored) return null;
  // user-rejected is known to be over-stamped; require its stable textual corroboration.
  if (
    kind === "user-rejected" &&
    texts.some((x) => x.startsWith("The user doesn't want to proceed with this tool use"))
  )
    return "user-rejected";
  if (texts.some((x) => x.startsWith("PreToolUse:") && x.includes("hook error")))
    return "hook-block";
  if (
    texts.some(
      (x) =>
        /^Permission to use .* has been denied\.$/.test(x) ||
        x.startsWith("File is in a directory that is denied by your permission settings."),
    )
  )
    return "deny-rule";
  return null;
}

export function classifyCommandShape(command: string, toolName = "Bash"): string {
  const count = command.trim() === "" ? 0 : command.trim().split(/\s+/).length;
  const bucket = count === 0 ? "0" : count === 1 ? "1" : count <= 3 ? "2-3" : "4+";
  return `${toolName.toLowerCase()}:args-${bucket}`;
}

/** Structural API failure classifier; it deliberately has no text fallback. */
export function classifyErrorFamily(rec: Record<string, unknown>): ClassifierLabel | null {
  return rec.isApiErrorMessage === true ? "api-error" : null;
}

function classifyRecord(
  rec: Record<string, unknown>,
  message: Record<string, unknown> | null,
  ccVersion: string | null,
): {
  label: ClassifierLabel | null;
  commandShape: string | null;
  destructiveOp: DestructiveOp | null;
} {
  let commandShape: string | null = null;
  let destructiveOp: DestructiveOp | null = null;
  if (message && Array.isArray(message.content))
    for (const block of message.content) {
      if (
        !isObject(block) ||
        block.type !== "tool_use" ||
        block.name !== "Bash" ||
        !isObject(block.input)
      )
        continue;
      const command = block.input.command;
      if (typeof command === "string") {
        commandShape ??= classifyCommandShape(command, "Bash");
        destructiveOp ??= classifyDestructiveOp(command);
      }
    }
  return {
    label: classifyDenial(rec, message, ccVersion) ?? classifyErrorFamily(rec),
    commandShape,
    destructiveOp,
  };
}

function classifyBoundary(rec: Record<string, unknown>): {
  kind: BoundaryKind | null;
  verification: BoundaryVerification | null;
} {
  if (rec.isCompactSummary === true) return { kind: "compact-summary", verification: "VERIFIED" };
  if (rec.subtype === "compact_boundary")
    return { kind: "compact-boundary", verification: "VERIFIED" };
  if (rec.type === "summary" && typeof rec.leafUuid === "string")
    return { kind: "legacy-summary", verification: "VERIFIED" };
  return { kind: null, verification: null };
}

function contentTexts(message: Record<string, unknown> | null): string[] {
  if (!message || !Array.isArray(message.content)) return [];
  const out: string[] = [];
  for (const block of message.content) {
    if (!isObject(block) || block.type !== "tool_result") continue;
    if (typeof block.content === "string") out.push(block.content);
    else if (Array.isArray(block.content))
      for (const part of block.content)
        if (isObject(part) && typeof part.text === "string") out.push(part.text);
  }
  return out;
}

function hasErroredToolResult(message: Record<string, unknown> | null): boolean {
  return Boolean(
    message &&
      Array.isArray(message.content) &&
      message.content.some(
        (block) => isObject(block) && block.type === "tool_result" && block.is_error === true,
      ),
  );
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

/**
 * SEC-101 W-A: max chars retained per content slice. Bounds the local store and
 * is enough for C5/D7 to match a repeated command or error head.
 */
const MAX_SLICE_CHARS = 4000;
/**
 * Overlap redacted past the cap so a secret straddling MAX_SLICE_CHARS is still
 * matched before truncation (redact-then-cut). Bounds the redaction input to
 * MAX_SLICE_CHARS + this, so the fix adds no unbounded work.
 */
const SLICE_REDACT_OVERLAP = 512;

/** Bound + secrets-filter a retention slice; null for empty input. */
function retentionSlice(text: string | null | undefined): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  // Redact a bounded window (cap + overlap) BEFORE truncating: a secret that
  // crosses the cap is matched whole, its placeholder kept, then we cut to cap.
  const window =
    text.length > MAX_SLICE_CHARS + SLICE_REDACT_OVERLAP
      ? text.slice(0, MAX_SLICE_CHARS + SLICE_REDACT_OVERLAP)
      : text;
  return redactSecrets(window).slice(0, MAX_SLICE_CHARS);
}

function projectToolUse(
  b: Record<string, unknown>,
  sessionId: string,
  ts: string | null,
  idx: number,
  ownerMessageId: string | null,
  ccVersion: string | null,
): ToolEventProjection {
  const toolName = typeof b.name === "string" ? b.name : "";
  const toolUseId = typeof b.id === "string" ? b.id : null;
  const inputBytes = b.input != null ? JSON.stringify(b.input).length : null;
  const input = isObject(b.input) ? (b.input as Record<string, unknown>) : null;
  const isShellTool = toolName === "Bash" || toolName === "PowerShell" || toolName === "Shell";
  const inputHash =
    b.input != null && !isShellTool
      ? hashSha256(canonicalJson(normalizeToolInputPaths(b.input)))
      : null;
  const filePathHash =
    typeof input?.file_path === "string" ? hashSha256(normalizeFilePath(input.file_path)) : null;
  const isEdit = toolName === "Edit";
  const editOldStringHash =
    isEdit && typeof input?.old_string === "string" ? hashSha256(input.old_string) : null;
  const editNewStringHash =
    isEdit && typeof input?.new_string === "string" ? hashSha256(input.new_string) : null;
  let gitCommandHint = false;
  let testCommandHint = false;
  if (toolName === "Bash" && input !== null) {
    const cmd = input.command;
    if (typeof cmd === "string") gitCommandHint = GIT_WRITE_RE.test(cmd);
  }
  if (isShellTool && typeof input?.command === "string")
    testCommandHint = isTestCommand(input.command);
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
    editOldStringHash,
    editNewStringHash,
    ownerMessageId,
    blockIndex: idx,
    gitCommandHint,
    testCommandHint,
    bashCommandFamily:
      b.name === "Bash" && isObject(b.input) && supportsToolErrorClassifierCatalog(ccVersion)
        ? classifyBashCommandFamily((b.input as Record<string, unknown>).command)
        : null,
    // SEC-101 W-A: retain the shell command text (secrets-filtered) so C5/D7 can
    // detect repeated failing invocations. Shell tools only; null otherwise.
    commandSlice:
      isShellTool && typeof input?.command === "string" ? retentionSlice(input.command) : null,
    skillName:
      toolName === "Skill" && typeof input?.skill === "string" && input.skill.trim() !== ""
        ? input.skill.trim().slice(0, 200)
        : null,
  };
}

function projectToolResult(
  b: Record<string, unknown>,
  sessionId: string,
  ccVersion: string | null,
  toolDenialKind: unknown,
): ToolResultProjection {
  const toolUseId = typeof b.tool_use_id === "string" ? b.tool_use_id : null;
  let resultBytes = 0;
  let commitSha: string | null = null;
  const content = b.content;
  if (typeof content === "string") {
    resultBytes = content.length;
    commitSha = commitShaIn(content);
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (isObject(c) && typeof (c as Record<string, unknown>).text === "string") {
        const text = (c as Record<string, unknown>).text as string;
        resultBytes += text.length;
        if (commitSha === null) commitSha = commitShaIn(text);
      }
    }
  }
  const isError = b.is_error === true;
  return {
    toolUseId,
    sessionId,
    resultBytes,
    commitSha,
    isError,
    errorClass: isError ? classifyToolResultError(content, ccVersion) : null,
    interruptKind: isError ? classifyInterruptKind(toolDenialKind, content, ccVersion) : null,
    // SEC-101 W-A: retain a bounded, secrets-filtered error excerpt for C5/D7.
    errorSlice: isError ? retentionSlice(extractResultText(content)) : null,
  };
}

/** A full 40-char sha, else git commit's short `[branch sha]` form. */
function commitShaIn(text: string): string | null {
  return SHA_RE.exec(text)?.[0] ?? SHORT_COMMIT_RE.exec(text)?.[1] ?? null;
}

/** Flatten a tool_result `content` field to text for slice retention. */
function extractResultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (isObject(c) && typeof (c as Record<string, unknown>).text === "string") {
        parts.push((c as Record<string, unknown>).text as string);
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

/** Leading `FOO=1` env assignments and a PowerShell `&` call operator, before the test runner. */
const SEGMENT_PREFIX_RE = /^(?:&\s*|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/;

/**
 * Anchored per command segment: `cd app && npm test` and `npm run verify:app` count, while prose such as
 * `echo npm test` does not. Segments split on `&&`, `||`, `;`, `|` and newlines.
 */
export function isTestCommand(command: string): boolean {
  return command
    .split(/&&|\|\||[;|\n]/)
    .some((segment) => TEST_COMMAND_RE.test(segment.trim().replace(SEGMENT_PREFIX_RE, "")));
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
    const originalCommand = typeof rec.command === "string" ? rec.command : rec.subtype;
    return projectCommand(sessionId, ts ?? "", originalCommand);
  }
  return null;
}

/** Both supported producers use this legacy identity before classification discards text. */
function projectCommand(sessionId: string, ts: string, originalCommand: string): CommandProjection {
  return {
    sessionId,
    ts,
    eventId: legacyCommandEventId(sessionId, ts, originalCommand),
    command:
      originalCommand === "/compact" || originalCommand === "/clear" ? originalCommand : null,
  };
}

function legacyCommandEventId(sessionId: string, ts: string, originalCommand: string): string {
  return `cmd-${crypto
    .createHash("sha1")
    .update(`${sessionId}|${ts}|${originalCommand}`)
    .digest("hex")
    .slice(0, 20)}`;
}

function resolveSessionId(rec: Record<string, unknown>, ctx: ParseContext): string {
  // Prefer sessionId, then session_id, else the filename stem. After /clear, Claude Code
  // writes session_id = the process's first session and sessionId = this transcript (F6).
  if (typeof rec.sessionId === "string" && rec.sessionId.length > 0) return rec.sessionId;
  if (typeof rec.session_id === "string" && rec.session_id.length > 0) return rec.session_id;
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
