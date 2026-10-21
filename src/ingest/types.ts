/**
 * src/ingest/types.ts — shared types for the ingestion pipeline (WP1).
 *
 * SEC-101 (rescoped, ADR-112): these projections are structural by default —
 * tokens, ids, sizes, model names, and markers. The two exceptions are the W-A
 * targeted retention slices (`ToolEventProjection.commandSlice`,
 * `ToolResultProjection.errorSlice`): bounded, secrets-filtered content that a
 * NAMED detector (C5/D7) consumes, retained only in the local DB and never
 * emitted across the distribution boundary.
 */

/** Parser projection version, stamped on every turn row (NFR-106 drift signal). */
export const PARSER_VERSION = "ingest-3";

/**
 * Classifier/boundary projection version, stamped on the U6/U7 columns only
 * (ingest_metric_events.classifier_version). Kept SEPARATE from PARSER_VERSION
 * so adding the classifier layer does not shift the `turns` parser mix and
 * spuriously CONFOUND effect cycles that straddle the upgrade (M3): the `turns`
 * projection is byte-identical to ingest-3.
 * classifier-2 (RC-D14): is_interrupt / interrupt-cancel come from the user Esc record, no longer
 * from a substring of tool_result text (interrupt-relabel.ts repairs classifier-1 rows).
 */
export const CLASSIFIER_VERSION = "classifier-2";

/** Closed, content-free classifier vocabulary. Never persist source text. */
export type ClassifierLabel =
  | "user-rejected"
  | "hook-block"
  | "deny-rule"
  | "interrupt-cancel"
  | "api-error";
export type DestructiveOp = "rm-rf" | "git-reset-hard" | "git-clean" | "sql-drop" | "truncate";
export type BoundaryKind =
  | "compact-summary"
  | "compact-boundary"
  | "legacy-summary"
  | "cache-read-collapse";
export type BoundaryVerification = "VERIFIED" | "UNVERIFIED";

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
  /** SHA-256 of canonical non-command input JSON; null for command-bearing shell tools. */
  inputHash: string | null;
  /** SHA-256 of input.file_path when present; never the raw path. */
  filePathHash: string | null;
  /** C6: SHA-256 of an Edit's old_string / new_string; null for other tools. Never the strings. */
  editOldStringHash: string | null;
  editNewStringHash: string | null;
  /** Structural owner/order used to reason about intervening tool calls. */
  ownerMessageId: string | null;
  blockIndex: number;
  /** git-command hint: set when the tool_use looks like `git commit`/`git push`. */
  gitCommandHint: boolean;
  /** Ephemeral classifier bit; the Bash command itself is never projected or stored. */
  testCommandHint: boolean;
  /** Closed C7 family; null outside Bash or for an unclassifiable command head. */
  bashCommandFamily: import("./tool-error-classifier.js").BashCommandFamily | null;
  /**
   * SEC-101 W-A retained slice: bounded, secrets-filtered shell command text for
   * loop/retry detection (C5/D7). null for non-shell tools or when absent.
   */
  commandSlice: string | null;
  /** The Skill tool's `skill` input (a catalog name, for last-used per skill); null otherwise. */
  skillName: string | null;
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
  /** Closed match-and-discard label from an error result; never result text. */
  errorClass: import("./tool-error-classifier.js").ToolErrorClass | null;
  /** Closed, result-side interruption attribution; never result text. */
  interruptKind: import("./tool-error-classifier.js").InterruptKind | null;
  /**
   * SEC-101 W-A retained slice: bounded, secrets-filtered error excerpt from an
   * error result, for loop/retry detection (C5/D7). null when not an error.
   */
  errorSlice: string | null;
}

/** A local_command / away_summary system record → hygiene signal. */
export interface CommandProjection {
  sessionId: string;
  ts: string;
  /** Existing cmd- SHA-1 identity, derived before command text is discarded. */
  eventId: string;
  /** Exact retained marker, or null for an unclassified command. */
  command: "/compact" | "/clear" | null;
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
      /** Structural source marker; absent source markers retain the established main-chain default. */
      isSidechain: boolean;
      /** Match-and-discard outputs: closed labels only, never transcript text. */
      classifierLabel: ClassifierLabel | null;
      commandShape: string | null;
      destructiveOp: DestructiveOp | null;
      ccVersion: string | null;
      boundaryKind: BoundaryKind | null;
      boundaryVerification: BoundaryVerification | null;
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
