/**
 * test/daemon/timer-static-check.ts — P0-U14 static checker (test-side helper).
 *
 * Scans TypeScript source text with the TypeScript compiler API (already a
 * dependency; no new package) for recurring-timer patterns that must go
 * through `scheduleJob` (src/daemon/schedule-job.ts):
 *
 *   - any raw `setInterval(...)`                      -> always a violation
 *   - a `setTimeout(...)` that re-arms itself         -> always a violation
 *       (its callback registers another timer, or calls / passes the
 *        enclosing named function again)
 *   - any other `setTimeout(...)` (a one-shot)        -> a violation unless the
 *       file is on the explicit one-shot allow-list with a reason, and the
 *       file's one-shot count EQUALS the listed count (fewer also fails)
 *   - importing from node:timers / timers/promises, or a bare reference to
 *     setInterval / setTimeout (alias)                -> always a violation
 *
 * There is no heuristic that silently passes: an unrecognised timer shape is
 * "unlisted" and fails. The scheduleJob helper file itself is exempt.
 */

import ts from "typescript";

export const HELPER_FILE = "src/daemon/schedule-job.ts";

export interface OneShotAllow {
  /** Repo-relative path with forward slashes. */
  file: string;
  /** Exact number of one-shot setTimeout calls allowed in that file. */
  count: number;
  reason: string;
}

export interface TimerViolation {
  file: string;
  line: number;
  kind:
    | "raw-setInterval"
    | "rearming-setTimeout"
    | "unlisted-setTimeout"
    | "over-allowlist"
    | "under-allowlist"
    | "timer-import"
    | "timer-alias";
}

export interface SourceFile {
  file: string;
  text: string;
}

type TimerFn = "setInterval" | "setTimeout";

function timerFn(call: ts.CallExpression): TimerFn | null {
  const callee = call.expression;
  let name: string | undefined;
  if (ts.isIdentifier(callee)) name = callee.text;
  // Any object: globalThis.setInterval, or a namespace import such as timers.setInterval.
  else if (ts.isPropertyAccessExpression(callee)) name = callee.name.text;
  return name === "setInterval" || name === "setTimeout" ? name : null;
}

/** `typeof setTimeout` in a type annotation is not a runtime reference. */
function inTypePosition(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p !== undefined; p = p.parent) {
    if (ts.isTypeQueryNode(p)) return true;
  }
  return false;
}

function functionName(node: ts.Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
    node.name &&
    (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name))
  ) {
    return node.name.text;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return undefined;
}

function referencedName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return expr.name.text;
  }
  return undefined;
}

function isRearming(call: ts.CallExpression, enclosingNames: Set<string>): boolean {
  const arg = call.arguments[0];
  if (arg === undefined) return false;
  const direct = referencedName(arg);
  if (direct !== undefined) return enclosingNames.has(direct);
  if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      if (timerFn(n) !== null) {
        found = true;
        return;
      }
      const called = referencedName(n.expression);
      if (called !== undefined && enclosingNames.has(called)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(arg.body, visit);
  if (ts.isCallExpression(arg.body)) visit(arg.body);
  return found;
}

/** Violations for one file, given how many one-shot setTimeouts its allow entry permits (0 = none). */
export function scanSource(file: string, text: string, allowedOneShots: number): TimerViolation[] {
  return scanDetailed(file, text, allowedOneShots).violations;
}

function scanDetailed(
  file: string,
  text: string,
  allowedOneShots: number,
): { violations: TimerViolation[]; oneShots: number } {
  if (file === HELPER_FILE) return { violations: [], oneShots: 0 };
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: TimerViolation[] = [];
  const oneShotLines: number[] = [];
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visit = (n: ts.Node, names: Set<string>): void => {
    const own = functionName(n);
    const scope = own === undefined ? names : new Set([...names, own]);
    if (
      ts.isImportDeclaration(n) &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      /^(node:)?timers(\/promises)?$/.test(n.moduleSpecifier.text)
    ) {
      out.push({ file, line: lineOf(n), kind: "timer-import" });
    }
    // An alias such as `const si = setInterval` or `f(setTimeout)`: a bare reference, not a call.
    if (
      ts.isIdentifier(n) &&
      (n.text === "setInterval" || n.text === "setTimeout") &&
      !(ts.isCallExpression(n.parent) && n.parent.expression === n) &&
      !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
      !inTypePosition(n)
    ) {
      out.push({ file, line: lineOf(n), kind: "timer-alias" });
    }
    if (ts.isCallExpression(n)) {
      const fn = timerFn(n);
      if (fn === "setInterval") out.push({ file, line: lineOf(n), kind: "raw-setInterval" });
      else if (fn === "setTimeout") {
        if (isRearming(n, scope)) out.push({ file, line: lineOf(n), kind: "rearming-setTimeout" });
        else oneShotLines.push(lineOf(n));
      }
    }
    ts.forEachChild(n, (c) => visit(c, scope));
  };
  visit(sf, new Set());

  if (allowedOneShots === 0) {
    for (const line of oneShotLines) out.push({ file, line, kind: "unlisted-setTimeout" });
  } else if (oneShotLines.length > allowedOneShots) {
    for (const line of oneShotLines.slice(allowedOneShots)) {
      out.push({ file, line, kind: "over-allowlist" });
    }
  }
  return { violations: out.sort((a, b) => a.line - b.line), oneShots: oneShotLines.length };
}

export function checkTimerSources(files: SourceFile[], allow: OneShotAllow[]): TimerViolation[] {
  const counts = new Map(allow.map((a) => [a.file, a.count]));
  return files.flatMap((f) => {
    const allowed = counts.get(f.file) ?? 0;
    const { violations, oneShots } = scanDetailed(f.file, f.text, allowed);
    // Exact match: a removed one-shot must shrink its entry, so a freed slot cannot hide a new timer.
    if (oneShots < allowed) {
      return [...violations, { file: f.file, line: 1, kind: "under-allowlist" as const }];
    }
    return violations;
  });
}

export interface ScheduleJobCall {
  file: string;
  line: number;
  /** null when the first argument is not a plain string literal. */
  name: string | null;
}

/** Every `scheduleJob(...)` call in a source text, with its literal job name. */
export function findScheduleJobCalls(file: string, text: string): ScheduleJobCall[] {
  if (file === HELPER_FILE) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: ScheduleJobCall[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "scheduleJob"
    ) {
      const a = n.arguments[0];
      out.push({
        file,
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        name: a !== undefined && ts.isStringLiteralLike(a) ? a.text : null,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
