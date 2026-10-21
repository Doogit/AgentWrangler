/**
 * "Why this matters" (review 5): a static explanation of why a card's problem costs, kept out of
 * What's wrong. No measured numbers and no detector codes; 1–3 sentences, at most 70 words. Each
 * entry cites its source in `docs/research/claude-context-optimization-research.md` (R §n, R KF n);
 * the citation is never shown. Detectors without an entry return undefined (review 5 deferred 11).
 */
import { numberMetric, stringMetric } from "./accessor.js";
import type { CardActionRecommendation } from "./types.js";

const WHY: Readonly<Record<string, string>> = {
  // R §1, R §3 line 117, R Caveats line 181.
  D2: "Each model call re-reads the whole conversation so far from the prompt cache, at a fraction of the input price. In a long session that history is large, so every call pays for it again. Anthropic has not published how much a cache read counts against a subscription's usage cap.",
  // R KF 1, KF 2 (5 minutes also for API key / cloud), KF 3.
  D8: "The prompt cache keeps the conversation for a limited time, 5 minutes or 1 hour depending on the cache tier a call writes to, counted from the start of each call. After a longer break the next call writes the whole context again at the cache-write price. Writing a handoff and running /clear before the break avoids that; /compact after the break reprocesses the whole history as uncached input.",
  // R §1 (each call re-sends the context); turn cost per detector C1 pricing; "fixed once" is judgment.
  C1: "A failed call usually costs a turn: Claude reads the error and tries something else, and each call re-sends the whole context. A cause that repeats across sessions can often be fixed once.",
  // R §2 hooks, R §1.
  C9_HOOK_BLOCK:
    "Each block makes Claude spend a turn re-planning, re-sending the whole context. Blocks the guard exists to make are worth that turn; blocks of harmless calls are pure cost.",
  // R §1; re-plan turn per detector C9 pricing (R has no section on deny rules).
  C9_DENY_RULE:
    "Each denial makes Claude spend a turn re-planning, re-sending the whole context. A rule that keeps blocking the same command is often one Claude was never told about, or broader than it needs to be.",
  // R §1, R §5; "usually" per R §3 (earlier instructions can be forgotten as context fills).
  C9_USER_REJECTED:
    "Each rejection makes Claude spend a turn re-planning, re-sending the whole context. One standing instruction in CLAUDE.md usually stops Claude proposing the kind of call you keep rejecting.",
  // R §1.
  D11: "When a shell cannot parse a command or does not have it, such as `grep` or `head` in PowerShell, the call fails and Claude spends a turn retrying. Running those commands in the shell that has them avoids the failure.",
  // R §1, R §2 line 91 (a re-read after clearing is needed). Review 5 residual: the card counts
  // every repeated read, since the detector cannot see compaction, so the Why says so.
  D7_LOOPS:
    "A repeated call adds a turn that re-sends the whole context without moving the task on. Repeats can follow an error Claude did not act on. A file read again after compaction or tool-result clearing dropped it is needed; this card cannot tell those reads apart, so it counts them too.",
  // R §5 (review 5 M15).
  D7_REREADS:
    "A new session starts without the files an earlier session read, so it reads them again; after a /clear that is expected. Pointing each task at the section it needs keeps those reads small.",
  // R §1. "Name the files up front" is Claude Code's costs doc (specific prompts), not in R.
  E1: "Every model call re-sends the whole conversation, so each call spent finding where to start costs the full context again. Naming the files, line ranges and next command up front lets a session skip that search.",
  // U5 routing study: a model switch mid-session rewrites the cache; a subagent has its own.
  E2: "Each main-session turn is priced at the main model and re-sends the main context. Running git, tests and file searches does not need the strongest model; a Sonnet subagent does them at a lower price from a smaller context. Changing the main session's model instead would rewrite its whole cache.",
  // R §2 tool-result clearing, R §5 line ranges.
  A1: "A tool result stays in the conversation and is re-sent on every later call until /clear, compaction or tool-result clearing removes it. A large result read whole, when the task needs one part, pays for the rest on every call after it.",
};

/** The card's "Why this matters" text, or undefined for a detector without one. */
export function whyText(rec: CardActionRecommendation): string | undefined {
  if (rec.detector_id === "D7")
    return numberMetric(rec, "redundant_path_count") === null ? WHY.D7_LOOPS : WHY.D7_REREADS;
  if (rec.detector_id === "C9") return WHY[`C9_${stringMetric(rec, "DENIAL_CLASS")}`];
  return WHY[rec.detector_id];
}
