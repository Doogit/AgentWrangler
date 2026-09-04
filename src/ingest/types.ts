/**
 * src/ingest/types.ts — shared types for the ingestion pipeline (WP1).
 *
 * SEC-101: none of these projections carry transcript content. Content is read
 * in-process for size/SHA computation and then discarded; only tokens, ids,
 * sizes, model names, and structural markers survive into these shapes.
 */

/** Parser projection version, stamped on every turn row (NFR-106 drift signal). */
export const PARSER_VERSION = "ingest-2";

/** EF3 long-gap threshold in seconds; UI declares it in its tooltip. */
export const LONG_GAP_THRESHOLD_S = 300;

/**
 * A projected assistant turn — one row destined for the `turns` table.
 * Tokens and ids only; no content.
 */
export interface TurnProjection {
  messageId: string;
  sessionId: string;
  ts: string;
  model: string;
  isSidechain: boolean;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number | null;
  cacheReadTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteOther: number;
  effort: string | null;
}

/** A projected tool-use block — destined for `tool_events`. Names/sizes only. */
export interface ToolEventProjection {
  eventId: string;
  toolUseId: string | null;
  sessionId: string;
  ts: string;
  toolName: string;
  inputBytes: number | null;
  /** SHA-256 of canonical, recursively key-sorted input JSON; never raw input. */
  inputHash: string | null;
  /** SHA-256 of input.file_path when present; never the raw path. */
  filePathHash: string | null;
  /** Structural owner/order used to reason about intervening tool calls. */
  ownerMessageId: string | null;
  blockIndex: number;
  /** git-command hint: set when the tool_use looks like `git commit`/`git push`. */
  gitCommandHint: boolean;
  /** Ephemeral classifier bit; the Bash command itself is never projected or stored. */
  testCommandHint: boolean;
}

/** A projected tool_result block — used to fill result_bytes + commit SHA by correlation. */
export interface ToolResultProjection {
  toolUseId: string | null;
  sessionId: string;
  resultBytes: number;
  /** A 40-hex commit SHA found in the result, if any (structural id, not content). */
  commitSha: string | null;
  /** Structural result status from the tool_result block's is_error flag. */
  isError: boolean;
}

/** A local_command / away_summary system record → hygiene signal. */
export interface CommandProjection {
  sessionId: string;
  ts: string;
  /** Structural command name, e.g. "/clear" or "/compact"; never free-form content. */
  command: string;
}

/**
 * The full projection of one JSONL line. A single line yields at most one turn,
 * zero-or-more tool events, and zero-or-more tool results / command markers.
 * A line that fails JSON parsing or is a usage record missing required fields
 * becomes a quarantine pointer instead.
 */
export type ParseResult =
  | {
      kind: "record";
      turn: TurnProjection | null;
      toolEvents: ToolEventProjection[];
      toolResults: ToolResultProjection[];
      command: CommandProjection | null;
      /** true when this was a usage record excluded as synthetic/empty-model. */
      synthetic: boolean;
      /** true when this is a genuine typed/queued user turn. */
      isUserTurn: boolean;
      /** Top-level transcript marker; absent/non-boolean values project as false. */
      isCompactSummary: boolean;
      /** Top-level transcript marker; absent/non-boolean values project as false. */
      isApiErrorMessage: boolean;
      /** Interrupt detection is reserved for a reliable top-level structural marker. */
      isInterrupt: boolean;
      /** Top-level line timestamp; null when absent. */
      ts: string | null;
    }
  | { kind: "quarantine"; errorClass: string };

/** Parser-health counters (NFR-106); surfaced in Settings by WP4. */
export interface HealthCounters {
  filesSeen: number;
  filesParsed: number;
  linesQuarantined: number;
  syntheticExcluded: number;
  duplicateDrops: number;
  turnsIngested: number;
  unknownFieldKinds: Record<string, number>;
  parserVersionMix: Record<string, number>;
}

/** Create a zeroed health-counter block. */
export function newHealthCounters(): HealthCounters {
  return {
    filesSeen: 0,
    filesParsed: 0,
    linesQuarantined: 0,
    syntheticExcluded: 0,
    duplicateDrops: 0,
    turnsIngested: 0,
    unknownFieldKinds: {},
    parserVersionMix: {},
  };
}
