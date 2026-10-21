/**
 * Closed, match-and-discard tool-result error classification.
 *
 * The input strings are inspected only while parsing a transcript line.  This
 * module returns fixed labels and never returns, hashes, or retains text.
 */

export const TOOL_ERROR_CLASSIFIER_VERSION = "tool-error-1";
export const INTERRUPT_CLASSIFIER_VERSION = "interrupt-1";

export type ToolErrorClass =
  | "NOT_FOUND"
  | "NOT_READ"
  | "STALE_STRING"
  | "PATCH_FAILED"
  | "MCP_CONTENT_TOO_LARGE"
  | "MODIFIED_SINCE_READ"
  | "MULTI_MATCH"
  | "READ_OUTPUT_TOO_LARGE";

/** Closed, deliberately coarse C7 grouping for Bash only. */
export type BashCommandFamily =
  | "BASH_GIT"
  | "BASH_NPM"
  | "BASH_PYTHON"
  | "BASH_TEST"
  | "BASH_BUILD"
  | "BASH_OTHER";

/** Closed result-side interruption attribution; never source prose. */
export type InterruptKind = "PURE_INTERRUPT" | "KILLED_NO_PROMPT" | "HUMAN_DENY";

// Future risk: a Claude Code 2.2.x / 3.x release makes every result unclassified (null)
// until this is widened. Not a current cause: all versions seen so far are 2.1.x.
const SUPPORTED_CC_VERSION = /^2\.1\.\d+$/;

export function supportsToolErrorClassifierCatalog(ccVersion: string | null): boolean {
  return ccVersion !== null && SUPPORTED_CC_VERSION.test(ccVersion);
}

// Claude Code wraps many tool errors as "<tool_use_error>…". Every anchored pattern
// accepts that optional leading wrapper (U2: wrapped rows were silently unclassified).
const ERROR_PATTERNS: ReadonlyArray<readonly [ToolErrorClass, RegExp]> = [
  ["MCP_CONTENT_TOO_LARGE", /^(?:<tool_use_error>)?MCPContentTooLargeError\b/],
  ["NOT_READ", /^(?:<tool_use_error>)?(?:File |The file ).*\bhas not been read\b/i],
  ["MODIFIED_SINCE_READ", /^(?:<tool_use_error>)?File has been modified since (?:it was )?read\b/i],
  [
    "MULTI_MATCH",
    /^(?:<tool_use_error>)?Found \d+ match(?:es)? of the string to replace, but replace_all is false/i,
  ],
  [
    "READ_OUTPUT_TOO_LARGE",
    /^(?:<tool_use_error>)?File content \([^)]*\) exceeds maximum allowed (?:size|tokens)\b/i,
  ],
  [
    "STALE_STRING",
    /^(?:<tool_use_error>)?(?:String to replace|Old string).*(?:not found|does not occur)/i,
  ],
  ["PATCH_FAILED", /^(?:<tool_use_error>)?(?:Patch|Apply patch) failed\b/i],
  [
    "NOT_FOUND",
    /^(?:<tool_use_error>)?(?:File|Path|Directory|Pattern|No files?).*(?:not found|does not exist)\b/i,
  ],
];

/**
 * Unknown Claude Code versions deliberately get no lexical interpretation.
 * This keeps new transcript formats from silently acquiring a false label.
 */
export function classifyToolResultError(
  content: unknown,
  ccVersion: string | null,
): ToolErrorClass | null {
  if (!supportsToolErrorClassifierCatalog(ccVersion)) return null;
  for (const text of resultTexts(content)) {
    for (const [label, pattern] of ERROR_PATTERNS) if (pattern.test(text)) return label;
  }
  return null;
}

/**
 * Attribute only documented, version-gated interruption shapes. The pure
 * marker must consume the complete result content so adjacent prose cannot be
 * mistaken for an interruption. Structural cancellation is deliberately
 * distinct from a human denial, which needs its own corroborating marker.
 */
export function classifyInterruptKind(
  toolDenialKind: unknown,
  content: unknown,
  ccVersion: string | null,
): InterruptKind | null {
  if (!supportsToolErrorClassifierCatalog(ccVersion)) return null;
  if (isPureInterruptContent(content)) return "PURE_INTERRUPT";
  if (toolDenialKind === "cancelled" || toolDenialKind === "interrupted") return "KILLED_NO_PROMPT";
  if (
    toolDenialKind === "user-rejected" &&
    resultTexts(content).some((text) =>
      text.startsWith("The user doesn't want to proceed with this tool use"),
    )
  )
    return "HUMAN_DENY";
  return null;
}

/** Classify the executable head only; arguments, paths, and command text are discarded. */
export function classifyBashCommandFamily(command: unknown): BashCommandFamily | null {
  if (typeof command !== "string") return null;
  const head = command
    .trim()
    .match(/^([A-Za-z0-9_.-]+)/)?.[1]
    ?.toLowerCase();
  if (head === undefined) return null;
  if (head === "git") return "BASH_GIT";
  if (head === "npm" || head === "pnpm" || head === "yarn" || head === "bun") return "BASH_NPM";
  if (head === "python" || head === "python3" || head === "pytest") return "BASH_PYTHON";
  if (head === "vitest" || head === "jest" || head === "mocha" || head === "cargo")
    return "BASH_TEST";
  if (head === "make" || head === "gradle" || head === "mvn" || head === "dotnet")
    return "BASH_BUILD";
  return "BASH_OTHER";
}

function resultTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      !Array.isArray(part) &&
      typeof (part as Record<string, unknown>).text === "string"
    )
      texts.push((part as Record<string, unknown>).text as string);
  }
  return texts;
}

// Both the plain and the "for tool use" variants; the whole content must be the marker.
export const PURE_INTERRUPT = /^\[Request interrupted by user(?: for tool use)?\]$/;

function isPureInterruptContent(content: unknown): boolean {
  if (typeof content === "string") return PURE_INTERRUPT.test(content);
  if (!Array.isArray(content) || content.length !== 1) return false;
  const [part] = content;
  if (typeof part !== "object" || part === null || Array.isArray(part)) return false;
  const text = (part as Record<string, unknown>).text;
  return typeof text === "string" && PURE_INTERRUPT.test(text);
}
