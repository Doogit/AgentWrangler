import { numberMetric, stringMetric } from "./accessor.js";
import { CACHE_DETECTOR_IDS, b4CardTitle, cacheHandler } from "./families/cache.js";
import { CONTEXT_DETECTOR_IDS, contextHandler } from "./families/context.js";
import { C11_READ_CARD_TITLE, ERROR_DETECTOR_IDS, errorsHandler } from "./families/errors.js";
import { ORIENTATION_DETECTOR_IDS, orientationHandler } from "./families/orientation.js";
import {
  PERMISSIONS_DETECTOR_IDS,
  h1GuardFirst,
  permissionsHandler,
} from "./families/permissions.js";
import { ROUTING_DETECTOR_IDS, routingHandler } from "./families/routing.js";
import { assertCardActionsGuardrails, isActionAllowed } from "./guardrails.js";
import { buildTrigger } from "./trigger.js";
import type { CardActionRecommendation, CardActions, FamilyHandler } from "./types.js";

function register(ids: readonly string[], handler: FamilyHandler): Map<string, FamilyHandler> {
  return new Map(ids.map((id) => [id, handler]));
}

/** All families are registered here once; family implementation never edits this map. */
export const FAMILY_HANDLERS = new Map<string, FamilyHandler>([
  ...register(CONTEXT_DETECTOR_IDS, contextHandler),
  ...register(CACHE_DETECTOR_IDS, cacheHandler),
  ...register(ERROR_DETECTOR_IDS, errorsHandler),
  ...register(PERMISSIONS_DETECTOR_IDS, permissionsHandler),
  ...register(ROUTING_DETECTOR_IDS, routingHandler),
  ...register(ORIENTATION_DETECTOR_IDS, orientationHandler),
]);

function fallback(rec: CardActionRecommendation): CardActions {
  const trigger = buildTrigger(rec);
  const question = rec.investigation_question?.trim();
  if (trigger.session_ids.length === 0 || question === undefined || question.length < 8) {
    throw new Error("Fallback INVESTIGATE requires a session id and a specific question");
  }
  return {
    primary: {
      option_id: "investigate",
      kind: "INVESTIGATE",
      summary: `Open session ${trigger.session_ids[0]}: ${question}`,
      detail: [rec.lever],
      copy_text: `Open session ${trigger.session_ids[0]} and answer: ${question}`,
      file_ref: null,
    },
    alternatives: [],
  };
}

/**
 * An alternative that fails a guardrail is hidden, not rendered (spec §2.1); a
 * failing primary is a handler bug and throws.
 */
export function buildCardActions(rec: CardActionRecommendation): CardActions {
  const trigger = buildTrigger(rec);
  const built = FAMILY_HANDLERS.get(rec.detector_id)?.(rec, { trigger }) ?? fallback(rec);
  const actions = {
    ...built,
    alternatives: built.alternatives
      .filter((alt) => isActionAllowed(alt, rec.detector_id))
      .slice(0, 2),
  };
  assertCardActionsGuardrails(actions, rec.detector_id);
  return actions;
}

/** C9's one contract lever covers three causes; each gets its own title (review 2, S4). */
const C9_TITLES: Record<string, string> = {
  HOOK_BLOCK: "Check the calls your PreToolUse guard keeps blocking.",
  USER_REJECTED: "Stop Claude proposing calls you reject.",
  DENY_RULE: "Check the calls a permission deny rule keeps blocking.",
};

/** The card's title: the contract lever, unless one lever covers cards that need their own. */
export function cardTitle(rec: CardActionRecommendation): string {
  // U9 r4: B1 owns the fix; B4 with a per-break list is its evidence table and says so.
  if (rec.detector_id === "B4" && stringMetric(rec, "EVENTS") !== null)
    return b4CardTitle(numberMetric(rec, "EVENT_COUNT"));
  if (rec.detector_id === "C9")
    return C9_TITLES[stringMetric(rec, "DENIAL_CLASS") ?? ""] ?? rec.lever;
  // U9: a C11 card that fired on Read errors only is not about MCP responses.
  if (
    rec.detector_id === "C11" &&
    (numberMetric(rec, "READ_ERROR_COUNT") ?? 0) > 0 &&
    !((numberMetric(rec, "ERROR_COUNT") ?? 0) > 0)
  )
    return C11_READ_CARD_TITLE;
  // U9 r3: a D7 loop that is a Read retried after the output-cap error is about the retry; the
  // ranges rule belongs to the C11 card.
  if (
    rec.detector_id === "D7" &&
    rec.tool_calls?.[0]?.tool === "Read" &&
    /exceeds maximum allowed/i.test(rec.tool_calls[0].result ?? "")
  )
    return "Stop retrying a Read after the output-cap error.";
  if (h1GuardFirst(rec)) return "Block risky rm -rf paths in your PreToolUse guard.";
  // Card review F8: /compact after a long break re-sends the whole history uncached. The lever is
  // the stored rec contract, so the title changes here, not there.
  if (rec.detector_id === "D8")
    return "Run /clear (with a handoff if continuing) before a break longer than the cache lifetime.";
  return rec.lever;
}

export { numberMetric, stringMetric } from "./accessor.js";
export { assertCardActionsGuardrails } from "./guardrails.js";
export { buildTrigger } from "./trigger.js";
export type {
  CardAction,
  CardActionRecommendation,
  CardActions,
  CardTrigger,
  FamilyHandler,
} from "./types.js";
