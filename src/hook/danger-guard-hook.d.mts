/** Public, testable surface of the dependency-free dangerous-command guard. */

export interface DenyRule {
  re: RegExp;
  reason: string;
}
export interface CompiledRuleset {
  deny: DenyRule[];
  ask: DenyRule[];
}
export interface GuardDecision {
  action: "deny" | "ask" | "allow";
  reason?: string;
}

export const EMBEDDED_BASELINE: {
  deny: { pattern: string; reason: string }[];
  ask: { pattern: string; reason: string }[];
};
export function compileRuleset(raw: unknown): CompiledRuleset;
export function loadDenyList(filePath: string): CompiledRuleset;
export function evaluateCommand(command: unknown, ruleset: CompiledRuleset): GuardDecision;
export function decisionToStdout(decision: GuardDecision): string;
