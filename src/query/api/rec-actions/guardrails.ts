import type { CardAction, CardActions } from "./types.js";

const ADVISE_ONLY_DETECTORS = new Set(["B1", "B2", "B3", "B4"]);
const UNSAFE_PERMISSION = /\*|\b(?:write|bash|network|destructive|delete|rm\b|curl\b|wget\b)/i;
// `token(?!s)`: GITHUB_TOKEN is a secret; MAX_MCP_OUTPUT_TOKENS is a size limit.
const SECRET_ENV_KEY = /(?:secret|token(?!s)|password|api[_-]?key|credential)/i;

/**
 * Text the action recommends. An INVESTIGATE prompt only quotes evidence (for example a real
 * error excerpt), so its text is not scanned; its structured hook/permission fields still are.
 */
function actionText(action: CardAction): string {
  if (action.kind === "INVESTIGATE") return "";
  // A Copy prompt's Findings quote evidence too (the calls read back), so they are not scanned.
  const recommended = action.copy_text.replace(/\n## Findings\n[\s\S]*?\n## Fix\n/, "\n## Fix\n");
  // Detail lines that quote the user's own file (index lines, section names) are evidence too:
  // a memory line mentioning a "hook" is not a hook recommendation (U9 r2, D1 card lost its actions).
  const detail = action.detail.filter(
    (line) => !/^(?:Longest index lines|Largest sections):/.test(line),
  );
  return [action.summary, recommended, action.file_ref ?? "", ...detail].join("\n");
}

function hasHook(action: CardAction): boolean {
  return (
    action.hook !== undefined || /\b(?:pre|post)\w*hook\b|\bhooks?\b/i.test(actionText(action))
  );
}

function hasSecretSettingsEnv(action: CardAction): boolean {
  if (
    !/settings(?:\.json)?/i.test(action.file_ref ?? "") &&
    !/settings(?:\.json)?/i.test(actionText(action))
  ) {
    return false;
  }
  const envBlock = /["']?env["']?\s*:\s*\{([\s\S]*?)\}/i.exec(actionText(action));
  const envContents = envBlock?.[1];
  return envContents !== undefined && SECRET_ENV_KEY.test(envContents);
}

function actionViolations(action: CardAction, detectorId: string): string[] {
  const violations: string[] = [];
  const text = actionText(action);
  if (
    action.permission_rule?.mode === "allow" &&
    UNSAFE_PERMISSION.test(action.permission_rule.pattern)
  ) {
    violations.push("unsafe permission rules must use ask, not allow");
  }
  if (hasHook(action) && !action.min_claude_code_version) {
    violations.push("hook recommendations require min_claude_code_version");
  }
  if (/\.claudeignore\b/i.test(text)) violations.push(".claudeignore must not be recommended");
  if (
    (action.hook?.event === "PreCompact" || /precompact/i.test(text)) &&
    (action.hook?.selector !== undefined || /\bselective\b|\bonly\s+(?:for|when)\b/i.test(text))
  ) {
    violations.push("selective PreCompact hooks are forbidden");
  }
  if (hasSecretSettingsEnv(action))
    violations.push("secrets must not be placed in settings env blocks");
  if (
    ADVISE_ONLY_DETECTORS.has(detectorId) &&
    (action.kind !== "HABIT" || action.file_ref !== null)
  ) {
    violations.push(`${detectorId} must be advise-only HABIT with no file edit`);
  }
  return violations;
}

/** True when one option passes every guardrail on its own. */
export function isActionAllowed(action: CardAction, detectorId: string): boolean {
  return actionViolations(action, detectorId).length === 0;
}

/** Throws all violations so callers and unit tests can fail closed. */
export function assertCardActionsGuardrails(actions: CardActions, detectorId: string): void {
  const options = [actions.primary, ...actions.alternatives];
  const violations = options.flatMap((action) => actionViolations(action, detectorId));
  if (actions.alternatives.length > 2) violations.push("at most two alternatives are allowed");
  if (violations.length > 0) throw new Error(`Invalid card actions: ${violations.join("; ")}`);
}
