/**
 * src/ingest/test-seams.ts — test-only crash/clock seams (P0-U11).
 *
 * Honored ONLY when AW_TEST_HOOKS === "1"; otherwise every seam is inert and
 * the hot-path guards in the ingestor are a single `crash !== null` check on a
 * value computed once at module load.
 *
 *   AW_TEST_CRASH_AT=file:<n>        hard-exit before the tx of the first chunk of the n-th distinct file
 *                    bytes:<k>       hard-exit inside a chunk tx once >= k raw line bytes were applied
 *                    mid-tx[:<n>]    hard-exit inside the tx of the n-th multi-line chunk (default 1),
 *                                    after half of its lines were applied (uncommitted)
 *                    after-tx[:<n>]  hard-exit after the n-th chunk tx COMMITS, before its offset write
 *                    mid-reconcile   hard-exit inside the reconcile transaction, after its writes
 *   AW_TEST_NOW=<iso|ms>             fixed default clock for the Ingestor
 *   AW_TEST_TX_BUDGET_MS=<ms>        ingest write-transaction time budget (P2-U4a); 0 = one line per tx
 *
 * A "crash" is a real hard kill (SIGKILL on self): no finally blocks, no
 * graceful DB close. The harness drives it from a CHILD process.
 */

import * as fs from "node:fs";

export type CrashKind = "file" | "bytes" | "mid-tx" | "after-tx" | "mid-reconcile";

export interface CrashSpec {
  kind: CrashKind;
  n: number;
}

export interface TestSeams {
  crash: CrashSpec | null;
  nowMs: number | null;
  txBudgetMs: number | null;
}

export function parseCrashSpec(text: string): CrashSpec | null {
  const m = /^(file|bytes|mid-tx|after-tx|mid-reconcile)(?::(\d+))?$/.exec(text.trim());
  if (m === null) return null;
  const kind = m[1] as CrashKind;
  const n = m[2] === undefined ? 1 : Number(m[2]);
  if ((kind === "file" || kind === "bytes") && m[2] === undefined) return null;
  return { kind, n };
}

export function parseTestSeams(env: NodeJS.ProcessEnv): TestSeams {
  if (env.AW_TEST_HOOKS !== "1") return { crash: null, nowMs: null, txBudgetMs: null };
  const crashText = env.AW_TEST_CRASH_AT;
  const nowText = env.AW_TEST_NOW;
  let nowMs: number | null = null;
  if (nowText !== undefined && nowText !== "") {
    const parsed = /^\d+$/.test(nowText) ? Number(nowText) : Date.parse(nowText);
    if (Number.isFinite(parsed)) nowMs = parsed;
  }
  const budgetText = env.AW_TEST_TX_BUDGET_MS;
  return {
    crash: crashText === undefined ? null : parseCrashSpec(crashText),
    nowMs,
    txBudgetMs: budgetText !== undefined && /^\d+$/.test(budgetText) ? Number(budgetText) : null,
  };
}

export const testSeams: TestSeams = parseTestSeams(process.env);

/** Hard kill: no finally blocks, no graceful close. */
function hardKill(crash: CrashSpec): never {
  // Sync write to stderr so the harness can prove which seam fired (not just "the child died").
  const label = crash.kind === "mid-reconcile" ? crash.kind : `${crash.kind}:${crash.n}`;
  fs.writeSync(2, `AW_TEST_KILL ${label}\n`);
  process.kill(process.pid, "SIGKILL");
  process.exit(86);
}

let chunkOrdinal = 0;
let midTxArmed = false;
let multiLineOrdinal = 0;
let bytesApplied = 0;
const filesSeen = new Set<string>();

/** Called before a chunk's tx opens (only when a crash seam is configured). */
export function seamBeforeChunk(filePath: string, lineCount: number): void {
  const crash = testSeams.crash;
  if (crash === null) return;
  if (!filesSeen.has(filePath)) {
    filesSeen.add(filePath);
    if (crash.kind === "file" && filesSeen.size === crash.n) hardKill(crash);
  }
  chunkOrdinal++;
  midTxArmed = false;
  if (crash.kind === "mid-tx" && lineCount >= 2) {
    // Ordinal among multi-line chunks only.
    multiLineOrdinal++;
    midTxArmed = multiLineOrdinal === crash.n;
  }
}

/** Called inside the tx loop after line `index` of `total` was applied. */
export function seamAfterLine(index: number, total: number, rawBytes: number): void {
  const crash = testSeams.crash;
  if (crash === null) return;
  bytesApplied += rawBytes;
  if (crash.kind === "bytes" && bytesApplied >= crash.n) hardKill(crash);
  if (midTxArmed && index + 1 >= Math.ceil(total / 2)) hardKill(crash);
}

/** Called right after the chunk tx committed, before commitStage/saveOffset. */
export function seamAfterTx(): void {
  const crash = testSeams.crash;
  if (crash === null) return;
  if (crash.kind === "after-tx" && chunkOrdinal === crash.n) hardKill(crash);
}

/** Called inside the reconcile transaction after its writes. */
export function seamMidReconcile(): void {
  const crash = testSeams.crash;
  if (crash === null) return;
  if (crash.kind === "mid-reconcile") hardKill(crash);
}
