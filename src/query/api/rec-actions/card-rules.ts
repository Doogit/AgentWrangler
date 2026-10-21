/**
 * The operator's card rules (P3.1, 2026-09-25) as a check: say plainly what happened, give a
 * Copy prompt that stands on its own (context → findings → fix → steps with confirm and verify),
 * back the statement with facts, keep the title and the action in agreement, and never show a
 * detector code. Listing the actual calls and fitting the fix to them need
 * judgment, so the batch review covers those.
 */
import type { CardActions, CardTrigger } from "./types.js";

const DETECTOR_CODE = /\b[A-H]\d{1,2}\b/;
const PROMPT_SECTIONS = ["## Context", "## Findings", "## Fix", "## Steps"];

/** Our own wording: quoted evidence (a `command` or a "returned message") is the user's text. */
function ownWords(text: string): string {
  return text.replace(/`[^`\n]*`/g, "").replace(/"[^"\n]*"/g, "");
}

const PERMISSION_MODES = ["allow", "deny", "ask"] as const;

/** A title naming a permissions rule (from the contract lever) must match the rule the card proposes. */
function titleVersusAction(title: string, copyText: string): string | null {
  const named = PERMISSION_MODES.filter((mode) => title.includes(`permissions.${mode}`));
  if (named.length === 0) return null;
  const proposed = PERMISSION_MODES.filter((mode) => copyText.includes(`"${mode}": [`));
  if (named.join() === proposed.join()) return null;
  return `title names ${named.map((mode) => `permissions.${mode}`).join(" and ")} but the action proposes ${proposed.length === 0 ? "no permissions rule" : proposed.join(" and ")}`;
}

/** Numbers as written on a card: 1,234 · 1.9% · 2.6M · 68K · $2.55, commas dropped. */
const NUMBER = /\$?\d[\d,]*(?:\.\d+)?(?:%|[KMB]\b)?/g;
const numbersIn = (text: string): string[] =>
  (text.match(NUMBER) ?? []).map((n) => n.replaceAll(",", ""));

/** A source file named in backticks: code a session edits, not a look-up doc (review 3 B1). */
const SOURCE_FILE = /`([^`\s]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|rb|sql))`/;

/**
 * Review 3 rules, each one a blocker the older rules let through: every evidence row's session is
 * listed and every prompt lists the card's sessions (B8); the lead is not a file the card's own
 * detail says to leave (B1); every number in the facts appears in what's wrong or the action (B3,
 * B6); a savings figure is derived in what's wrong (B5).
 */
function reviewThreeViolations(
  actions: CardActions,
  trigger: CardTrigger,
  savingsU: number | null | undefined,
): string[] {
  const violations: string[] = [];
  for (const call of trigger.calls ?? []) {
    const first = call.session_ids[0];
    if (first !== undefined && !trigger.session_ids.includes(first))
      violations.push(`evidence session ${first} is not listed`);
  }
  for (const option of [actions.primary, ...actions.alternatives]) {
    const listings = option.copy_text
      .split("\n")
      .filter((line) => /^- Sessions(?: \([^)]*\))?: /.test(line));
    if (listings.length > 0) {
      for (const id of trigger.session_ids)
        if (!listings.some((line) => line.includes(id)))
          violations.push(`option ${option.option_id}: copy prompt does not list session ${id}`);
    }
    const lead = SOURCE_FILE.exec(option.summary)?.[1];
    if (lead !== undefined && option.detail.some((line) => /being edited/.test(line)))
      violations.push(
        `option ${option.option_id}: leads with \`${lead}\`, a file its detail says to leave`,
      );
  }
  if (trigger.problem) {
    const said = new Set(
      numbersIn(
        [
          trigger.problem,
          ...[actions.primary, ...actions.alternatives].flatMap((o) => [o.summary, o.copy_text]),
        ].join("\n"),
      ),
    );
    for (const fact of trigger.facts) {
      const missing = numbersIn(fact.value).filter((n) => n !== "0" && !said.has(n));
      if (missing.length > 0)
        violations.push(
          `fact "${fact.label}" (${fact.value}) disagrees with what's wrong: ${missing.join(", ")}`,
        );
    }
  }
  if (savingsU !== null && savingsU !== undefined && savingsU > 0) {
    const saving = `$${(savingsU / 1e6).toFixed(2)}`;
    if (!(trigger.problem ?? "").includes(`= ${saving}`))
      violations.push(`saving ${saving} a week is not derived in what's wrong`);
  }
  return violations;
}

/**
 * Result sizes a tool cuts at: such a result's size is the cap, not the content's (review 4 A1).
 * `oversizedToolCalls` leaves them out; the rule below checks the card never leads with one.
 */
export const RESULT_CAPS: Readonly<Record<string, number>> = { Artifact: 50_000 };

/**
 * Review 4 rules: the lead call is not a result cut at its tool's cap (A1), and every number in
 * the TL;DR is backed by what's wrong or the facts (C9's "3 harmless" against "14").
 */
function reviewFourViolations(trigger: CardTrigger): string[] {
  const violations: string[] = [];
  const lead = trigger.calls?.[0];
  const cap = lead === undefined ? undefined : RESULT_CAPS[lead.tool];
  if (lead !== undefined && cap !== undefined && lead.max_bytes === cap)
    violations.push(
      `lead \`${lead.target}\` is a result cut at the ${lead.tool} cap (${cap.toLocaleString("en-US")} bytes)`,
    );
  if (trigger.summary) {
    const backed = new Set(
      numbersIn([trigger.problem ?? "", ...trigger.facts.map((fact) => fact.value)].join("\n")),
    );
    for (const n of numbersIn(trigger.summary))
      if (!backed.has(n))
        violations.push(`TL;DR says ${n}, which what's wrong and the facts do not`);
  }
  return violations;
}

/** A card without a "Why this matters" text fails, so a new detector cannot ship without one. */
export const NO_WHY = "no Why this matters text";

/**
 * Review 5 "Why this matters": at most 3 sentences and 70 words, no detector code, no query text.
 * Missing is a violation (operator 2026-09-26).
 */
function whyViolations(why: string | undefined): string[] {
  if (why === undefined) return [NO_WHY];
  const violations: string[] = [];
  const sentences = why.split(/(?<=[.!?])\s+/).filter(Boolean).length;
  if (sentences > 3) violations.push(`Why this matters has ${sentences} sentences (at most 3)`);
  const words = why.split(/\s+/).filter(Boolean).length;
  if (words > 70) violations.push(`Why this matters has ${words} words (at most 70)`);
  const code = ownWords(why).match(DETECTOR_CODE);
  if (code) violations.push(`detector code "${code[0]}" in Why this matters`);
  if (/select[\s\S]*from/i.test(why))
    violations.push("Why this matters contains a query (select … from)");
  return violations;
}

export function cardRuleViolations(
  actions: CardActions,
  trigger: CardTrigger,
  title?: string,
  savingsU?: number | null,
): string[] {
  const violations: string[] = [
    ...reviewThreeViolations(actions, trigger, savingsU),
    ...reviewFourViolations(trigger),
  ];
  if (!trigger.problem) violations.push("no plain statement of what happened");
  else if (trigger.facts.length === 0) violations.push("no facts behind what's wrong");
  const code = ownWords(trigger.problem ?? "").match(DETECTOR_CODE);
  if (code) violations.push(`detector code "${code[0]}" in what's wrong`);
  const mismatch = title === undefined ? null : titleVersusAction(title, actions.primary.copy_text);
  if (mismatch) violations.push(mismatch);
  violations.push(...whyViolations(trigger.why));
  for (const option of [actions.primary, ...actions.alternatives]) {
    const at = `option ${option.option_id}`;
    for (const [field, text] of [
      ["summary", option.summary],
      ["detail", option.detail.join("\n")],
      ["copy prompt", option.copy_text],
    ] as const) {
      const found = ownWords(text).match(DETECTOR_CODE);
      if (found) violations.push(`${at}: detector code "${found[0]}" in ${field}`);
    }
    const missing = PROMPT_SECTIONS.filter((section) => !option.copy_text.includes(section));
    if (missing.length > 0) violations.push(`${at}: copy prompt lacks ${missing.join(", ")}`);
    else if (
      !/ask me to confirm/i.test(option.copy_text) ||
      !/^\d+\. Verify/m.test(option.copy_text)
    ) {
      violations.push(`${at}: steps lack a confirm or verify step`);
    }
  }
  return violations;
}
