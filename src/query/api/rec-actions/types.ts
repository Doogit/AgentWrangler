/** Pure card-action contracts used by the recommendation query seam. */

export type CardActionKind = "CONFIG" | "EDIT" | "COMMAND" | "HABIT" | "INVESTIGATE";

export interface PermissionRule {
  mode: "allow" | "ask";
  pattern: string;
}

export interface HookRecommendation {
  event: string;
  /** A selector makes a PreCompact hook selective. */
  selector?: string;
}

export interface CardAction {
  kind: CardActionKind;
  /** One imperative sentence specific to the finding evidence. */
  summary: string;
  /** Zero to four short supporting lines. */
  detail: string[];
  /** Copyable config, edit, command, or seeded investigation prompt. */
  copy_text: string;
  /** Target file for CONFIG and EDIT actions, otherwise null. */
  file_ref: string | null;
  /** Metric this action is intended to move. Missing values fail artifact validation. */
  target_metric?: string;
  /** Permission changes are structured so unsafe allow rules can fail closed. */
  permission_rule?: PermissionRule;
  /** Hook metadata is structured so every hook can be version-gated. */
  hook?: HookRecommendation;
  /** Minimum compatible Claude Code version for a hook recommendation. */
  min_claude_code_version?: string;
}

export interface CardActionOption extends CardAction {
  option_id: string;
}

export interface CardActions {
  primary: CardActionOption;
  alternatives: CardActionOption[];
}

export interface CardTriggerFact {
  label: string;
  value: string;
}

export interface CardTriggerEvidence {
  /** Complete detector-eligible cohort size; null when it cannot be proven. */
  session_count: number | null;
  /** At most five sessions, ranked by claimed micro-USD then eligible turns. */
  sessions: Array<{ session_id: string; claimed_u: number | null; turn_count: number }>;
}

/** Oversized tool calls that ran on the same target, read back from the session transcripts. */
export interface CardToolCall {
  /** What the call ran on: a `~/…` file path, a command, a URL or a search pattern. */
  target: string;
  kind: "file" | "command" | "url" | "search" | "other";
  tool: string;
  calls: number;
  /** Raw persisted session IDs, at most three. */
  session_ids: string[];
  session_count: number;
  total_bytes: number;
  max_bytes: number;
  /** Every call read the whole file (a Read with no offset or limit). */
  whole_file: boolean;
  /** Every call ran inside a subagent; set on oversized-result groups only (review 5 M19). */
  is_subagent?: boolean;
  /** How many of `calls` ran inside a subagent; set on not-read Edit/Write groups only (U9 C3). */
  subagent_calls?: number;
  /** First line the call returned; set for calls read back from a card's evidence anchors. */
  result?: string;
  /** When the calls read back ran (ISO, UTC); set on a D7 loop example only. */
  at?: string[];
  /** Why a missing-path lookup's path did not exist; set on missing-path cards only. */
  cause?:
    | "GUESSED_PATH"
    | "WRONG_WORKTREE"
    | "WORKTREE_GONE"
    | "OTHER_SCRATCHPAD"
    | "NOT_ON_BRANCH"
    | "WRONG_FOLDER"
    | "PROBE";
  /** What an `rm -rf` deletes: a relative path inside the project is LOW, anything else RISKY. */
  risk?: "LOW" | "RISKY";
  /** The paths that made a RISKY `rm -rf` risky, with the command's own variables resolved. */
  risky_paths?: string[];
  /** The shape a PreToolUse guard blocked; set on guard blocks only (review 2 C9g2). */
  guard_shape?: GuardShape;
}

/**
 * A command shape a guard blocks. The first five are what such guards exist to stop; the last four
 * are false positives: a `python -c` match inside a quoted argument, a read-only `python -c`, a
 * heredoc feeding a command's input (such as `git commit -F -`), and a read-only `git stash
 * list/show`. OTHER matched no known shape (review 5 M5/M7: shown as "unclassified").
 */
export type GuardShape =
  | "CD_PREFIX"
  | "IN_PLACE_EDIT"
  | "HEREDOC_FILE"
  | "TMP_WRITE"
  | "DESTRUCTIVE_GIT"
  | "QUOTED_PATTERN"
  | "PYTHON_READ"
  | "HEREDOC_STDIN"
  | "GIT_STASH_READ"
  | "SCRATCH_TMP"
  | "QUOTED_HEREDOC"
  | "PS_NODE_FLAG"
  | "PS_SCRATCH_TMP"
  | "WORKTREE_REMOVE"
  | "MISSING_MODEL"
  | "OTHER";

export interface CardTrigger {
  /**
   * Raw persisted session IDs only, deduped: each shown call group's first session, then the
   * finding's sessions by contribution, up to five unless the call groups alone need more.
   */
  session_ids: string[];
  window: { from: string; to: string } | null;
  facts: CardTriggerFact[];
  evidence?: CardTriggerEvidence;
  /** What is wrong, in one or two sentences linking the facts to the fix. */
  problem?: string;
  /** The problem in one short line (TL;DR), with the weekly saving when there is one. */
  summary?: string;
  /**
   * Why the problem costs, in 1–3 plain sentences with no measured numbers ("Why this matters",
   * review 5). Absent for detectors without a text yet, and on cards built before it existed.
   */
  why?: string;
  /** The largest calls behind the card, grouped by target, largest total first. */
  calls?: CardToolCall[];
}

export interface CardActionRecommendation {
  detector_id: string;
  lever: string;
  evidence?: Record<string, unknown>;
  facts?: Record<string, unknown>;
  window?: { from: string; to: string } | null;
  trigger_facts?: CardTriggerFact[];
  investigation_question?: string;
  tool_calls?: CardToolCall[];
  /**
   * The workspace has a PreToolUse guard (it has a guard-block card), so the rm -rf card adds its
   * rule to that guard first (P3.1-T9, operator 2026-09-26).
   */
  guard_exists?: boolean;
  /**
   * The finding's sessions, most claimed spend first; the card and its prompt list these after the
   * evidence rows' sessions (P3.1 review 3 B8).
   */
  session_rank?: string[];
  /** The stored weekly saving (µUSD), derived on the card (P3.1 review 3). */
  savings_u_per_wk?: number;
  /** The card's savings range (µUSD/wk) when an assumed fraction sets it (review 6 R6-33). */
  savings_range_u_per_wk?: [number, number];
}

export interface CardActionContext {
  trigger: CardTrigger;
}

export type FamilyHandler = (
  rec: CardActionRecommendation,
  ctx: CardActionContext,
) => CardActions | null;
